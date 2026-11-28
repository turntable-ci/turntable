// Adoption hardening (#789), after #787: an adoption is compared on the attempt's policy inputs,
// not on the rules this build makes of them; withEgressPolicy releases an inherited sandbox it
// refuses; a controller whose lease lapsed by its own clock stops using the attempt's credentials,
// so a takeover never leaves two usable GitHub tokens; a read-only re-issue gets exactly contents
// and metadata read.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";
import { eq } from "drizzle-orm";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import type { Rule } from "@turntable/proxy";
import {
  claimNextAttempt,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  openDatabase,
} from "../src/db";
import { getAttempt, getJob, getRun, setProxyRule } from "../src/db/repos";
import * as s from "../src/db/schema";
import { JobTokens, type TokenAuthority } from "../src/github/job-token";
import {
  PROXY_POLICY_VERSION,
  proxyPolicyHash,
  SecretsProxy,
  withSecretsProxy,
  type ProxyAccess,
} from "../src/proxy";
import { createActRunner, Scheduler, withEgressPolicy } from "../src/scheduler";
import {
  type AdoptSpec,
  attemptSeeds,
  type AttemptSeeds,
  specHash,
} from "../src/scheduler/adopt-credentials";
import { DrainState } from "../src/scheduler/drain";
import type { AttemptContext, AttemptOutcome, AttemptStore } from "../src/scheduler/types";
import { SecretVault } from "../src/secrets/vault";
import { seedWorld, type Tenant } from "./ops-helpers";

// Built at runtime: no secret-like literal in the repository.
const VALUE = `harden-${randomBytes(8).toString("hex")}`;
const HOST = "api.example.test";
const ADVERTISE = { advertiseHost: "proxy.example.test", advertisePort: 8443 };
const GH = { owner: "acme", repo: "web", installationId: "42" };

/** A request a job's step makes through the proxy, with the sandbox's credential and CA. */
async function through(
  port: number,
  cred: { username: string; password: string; caPem: string },
  host: string,
  path: string,
): Promise<number> {
  const raw = net.connect(port, "127.0.0.1");
  await new Promise<void>((r) => raw.once("connect", () => r()));
  const basic = Buffer.from(`${cred.username}:${cred.password}`).toString("base64");
  raw.write(
    `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: Basic ${basic}\r\n\r\n`,
  );
  const answer = await new Promise<string>((r) => raw.once("data", (d) => r(d.toString())));
  if (!answer.startsWith("HTTP/1.1 200")) {
    raw.destroy();
    return Number(/^HTTP\/1\.1 (\d+)/.exec(answer)?.[1]);
  }
  const secure = tls.connect({ socket: raw, servername: host, ca: cred.caPem });
  await new Promise<void>((resolve, reject) => {
    secure.once("secureConnect", () => resolve());
    secure.once("error", reject);
  });
  secure.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  const chunks: Buffer[] = [];
  for await (const d of secure) chunks.push(d as Buffer);
  return Number(/^HTTP\/1\.1 (\d+)/.exec(Buffer.concat(chunks).toString())?.[1]);
}

describe("adoption behind the proxy", () => {
  let db: Db;
  let a: Tenant;
  let vault: SecretVault;
  let master: Buffer;
  let seeds: AttemptSeeds;
  let upstreamSaw: string[];
  const proxies: SecretsProxy[] = [];

  beforeEach(async () => {
    ({ db, a } = await seedWorld());
    master = randomBytes(32);
    seeds = attemptSeeds(master);
    vault = new SecretVault({ db, masterKey: master });
    upstreamSaw = [];
    await db.orm
      .update(s.runs)
      .set({ trust: JSON.stringify({ class: "protected", workflowHash: "h" }) })
      .where(eq(s.runs.id, a.runId));
    await db.orm
      .update(s.jobAttempts)
      .set({ state: "running", trustClass: "protected" })
      .where(eq(s.jobAttempts.id, a.attemptId));
    await vault.set(a.orgId, "t", { name: "NPM_TOKEN", projectId: a.projectId }, VALUE, {
      destinations: [HOST],
    });
    await setProxyRule(db, a.scope, "t", {
      name: "npm",
      secret: "NPM_TOKEN",
      host: HOST,
      port: 443,
      methods: ["GET"],
      pathPrefix: "/v1/",
      inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
    });
  });
  afterEach(async () => {
    for (const p of proxies.splice(0)) await p.stop();
    db.close();
  });

  const start = async (o: { seeds?: AttemptSeeds } = {}) => {
    const p = await SecretsProxy.start({
      db,
      vault,
      bindHost: "127.0.0.1",
      ...ADVERTISE,
      ...(o.seeds ? { seeds: o.seeds } : {}),
      upstream: async (_u, init) => {
        upstreamSaw.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response("ok");
      },
      tunnel: async () => {
        throw new Error("no passthrough here");
      },
    });
    proxies.push(p);
    return p;
  };

  const ctxOf = async (extra: Partial<AttemptContext> = {}): Promise<AttemptContext> => ({
    run: (await getRun(db, a.scope, a.runId))!,
    job: (await getJob(db, a.scope, a.jobId))!,
    attempt: (await getAttempt(db, a.scope, a.attemptId))!,
    scope: a.scope,
    provider: {} as AttemptContext["provider"],
    signal: new AbortController().signal,
    store: {} as AttemptContext["store"],
    ...extra,
  });

  const resumedWith = async (proxy: AdoptSpec["proxy"], extra: Partial<AttemptContext> = {}) =>
    ctxOf({
      resume: { sandboxId: "sb", execId: "ex" },
      attempt: {
        ...(await getAttempt(db, a.scope, a.attemptId))!,
        adoptSpec: JSON.stringify({ v: 1, proxy: proxy! } satisfies AdoptSpec),
      },
      ...extra,
    });

  const done: AttemptOutcome = { state: "success", reason: "ok" };

  describe("compared on the policy inputs, not the rules this build makes (#789)", () => {
    test("a recorded spec holds the versioned policy hash of the inputs, not of the built rules", async () => {
      const p = await start({ seeds });
      let access: ProxyAccess | undefined;
      await withSecretsProxy(async (c) => ((access = c.proxy), done), { proxy: p })(await ctxOf());
      const { inputs } = await p.vaultPolicy(a.scope);
      const expected = proxyPolicyHash({
        vault: inputs,
        passthrough: [],
        github: undefined,
        oidc: undefined,
        artifact: undefined,
      });
      expect(expected.startsWith(`policy${PROXY_POLICY_VERSION}:`)).toBe(true);
      expect(access?.adopt?.rules).toBe(expected);
      // No secret value in it: a rule names its secret, it never holds it.
      expect(JSON.stringify(access?.adopt)).not.toContain(VALUE);
    });

    test("a deploy that changes how rules are built (another Rule shape) still adopts: same inputs, same credential", async () => {
      const p = await start({ seeds });
      const { rules, inputs } = await p.vaultPolicy(a.scope);
      const policy = proxyPolicyHash({
        vault: inputs,
        passthrough: [],
        github: undefined,
        oidc: undefined,
        artifact: undefined,
      });
      const first = p.register(await ctxOf(), rules, {
        passthroughHosts: [],
        ttlMs: 60_000,
        policy,
      });
      p.release(a.attemptId);
      // The next build makes other rules of the same inputs: other ids and a narrower method
      // list, so the hash of the built rules differs.
      const rebuilt: Rule[] = rules.map((r) => ({ ...r, id: `v2-${r.id}`, methods: ["GET"] }));
      expect(specHash({ rules: rebuilt, passthrough: [] })).not.toBe(
        specHash({ rules, passthrough: [] }),
      );
      const next = await start({ seeds });
      const r = next.adopt(await ctxOf(), first.access.adopt!, rebuilt, {
        passthroughHosts: [],
        policy,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.access.credential.password).toBe(first.access.credential.password);
      // The sandbox's step still gets its secret, through the next controller's proxy.
      expect(await through(next.port, first.access.credential, HOST, "/v1/pkg")).toBe(200);
      expect(upstreamSaw).toEqual([`Bearer ${VALUE}`]);
    });

    test("through withSecretsProxy: the re-attached attempt runs, and a spec from before #789 (rules hash) is still accepted", async () => {
      const p = await start({ seeds });
      let access: ProxyAccess | undefined;
      await withSecretsProxy(async (c) => ((access = c.proxy), done), { proxy: p })(await ctxOf());
      const next = await start({ seeds });
      let ran = 0;
      const runner = async (c: AttemptContext): Promise<AttemptOutcome> => {
        if (c.refuseResume) return { state: "infra_error", reason: c.refuseResume };
        ran++;
        return done;
      };
      expect(
        (await withSecretsProxy(runner, { proxy: next })(await resumedWith(access!.adopt))).state,
      ).toBe("success");
      // A spec an older controller recorded: the hash of the rules it built, which this build
      // still makes from the same inputs.
      const legacy = specHash({ rules: await next.rulesFor(a.scope), passthrough: [] });
      const out = await withSecretsProxy(runner, { proxy: next })(
        await resumedWith({ ...access!.adopt!, rules: legacy }),
      );
      expect(out.state).toBe("success");
      expect(ran).toBe(2);
    });

    test("a real policy change, or a bumped policy version, is still refused", async () => {
      const p = await start({ seeds });
      let access: ProxyAccess | undefined;
      await withSecretsProxy(async (c) => ((access = c.proxy), done), { proxy: p })(await ctxOf());
      const next = await start({ seeds });
      const refused = async (spec: AdoptSpec["proxy"]): Promise<AttemptOutcome> => {
        let ran = false;
        const out = await withSecretsProxy(
          async (c) => {
            if (c.refuseResume) return { state: "infra_error", reason: c.refuseResume };
            ran = true;
            return done;
          },
          { proxy: next },
        )(await resumedWith(spec));
        expect(ran).toBe(false);
        return out;
      };
      // Recorded under another builder version: refused.
      const bumped = access!.adopt!.rules.replace(
        /^policy\d+:/,
        `policy${PROXY_POLICY_VERSION + 1}:`,
      );
      expect((await refused({ ...access!.adopt!, rules: bumped })).reason).toContain(
        "rules changed",
      );
      // The project's rule was changed while the job ran: refused.
      await setProxyRule(db, a.scope, "t", {
        name: "npm",
        secret: "NPM_TOKEN",
        host: HOST,
        port: 443,
        methods: ["GET", "POST"],
        pathPrefix: "/v1/",
        inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
      });
      const out = await refused(access!.adopt);
      expect(out.state).toBe("infra_error");
      expect(out.reason).toContain("rules changed");
    });
  });

  describe("one usable GitHub token per attempt on a takeover (#789)", () => {
    test("a stalled but live controller's registration stops injecting once its lease lapses; the adopter's token is the only one used", async () => {
      const github = async () => GH;
      const tokenOf = (h: string) => h.replace(/^Basic |^Bearer /, "");
      // Controller A: registered, holds token A behind its proxy, and keeps running (stalled).
      const proxyA = await start({ seeds });
      let leaseA = true;
      let accessA: ProxyAccess | undefined;
      let releaseA: () => void = () => {};
      const stalled = new Promise<void>((r) => (releaseA = r));
      let registeredA: () => void = () => {};
      const isRegistered = new Promise<void>((r) => (registeredA = r));
      const runA = withSecretsProxy(
        async (c) => {
          accessA = c.proxy;
          c.proxy!.setGithubToken("token-of-a");
          registeredA();
          await stalled;
          return done;
        },
        { proxy: proxyA, github },
      )(await ctxOf({ leaseValid: () => leaseA }));
      await isRegistered;
      const path = `/repos/${GH.owner}/${GH.repo}/issues`;
      expect(await through(proxyA.port, accessA!.credential, "api.github.com", path)).toBe(200);
      expect(upstreamSaw.map(tokenOf)).toEqual(["token-of-a"]);

      // A's lease lapses by its own clock (no heartbeat landed): from then on A's proxy uses
      // nothing of the attempt's, before B can take the expired lease and mint its own token.
      leaseA = false;
      expect(await through(proxyA.port, accessA!.credential, "api.github.com", path)).toBe(502);
      expect(await through(proxyA.port, accessA!.credential, HOST, "/v1/pkg")).toBe(502);
      expect(upstreamSaw).toHaveLength(1);

      // Controller B adopts, with token B.
      const proxyB = await start({ seeds });
      let codes: number[] = [];
      const out = await withSecretsProxy(
        async (c) => {
          if (c.refuseResume) return { state: "infra_error", reason: c.refuseResume };
          c.proxy!.setGithubToken("token-of-b");
          codes = [
            await through(proxyB.port, accessA!.credential, "api.github.com", path),
            await through(proxyA.port, accessA!.credential, "api.github.com", path),
          ];
          return done;
        },
        { proxy: proxyB, github },
      )(await resumedWith(accessA!.adopt, { leaseValid: () => true }));
      expect(out.state).toBe("success");
      expect(codes).toEqual([200, 502]);
      // Only B's token was used after the takeover.
      expect(upstreamSaw.slice(1).map(tokenOf)).toEqual(["token-of-b"]);
      releaseA();
      await runA;
      expect(proxyA.active).toBe(0);
    });

    test("a heartbeat that renews the lease in time lets the controller use its credential again", async () => {
      const p = await start({ seeds });
      let valid = false;
      const codes: number[] = [];
      await withSecretsProxy(
        async (c) => {
          codes.push(await through(p.port, c.proxy!.credential, HOST, "/v1/pkg"));
          valid = true;
          codes.push(await through(p.port, c.proxy!.credential, HOST, "/v1/pkg"));
          return done;
        },
        { proxy: p },
      )(await ctxOf({ leaseValid: () => valid }));
      expect(codes).toEqual([502, 200]);
    });
  });
});

describe("the scheduler's lease clock (#789)", () => {
  test("leaseValid follows the lease the database holds: false past it, less the margin", async () => {
    const db = openDatabase(":memory:");
    const org = await createOrg(db, { slug: "o", name: "o" });
    const project = await createProject(db, { orgId: org.id }, { slug: "p", name: "p" });
    const scope = { orgId: org.id, projectId: project.id };
    const run = await createRun(db, scope, {
      workflowPath: "w.yml",
      event: "push",
      ref: "main",
      sha: "a".repeat(40),
    });
    const job = (await createJob(db, scope, { runId: run.id, jobKey: "j", name: "j" }))!;
    await createAttempt(db, scope, { jobId: job.id, provider: "fake" });
    let now = 1_000_000;
    let seen: (() => boolean) | undefined;
    let finish: () => void = () => {};
    const held = new Promise<void>((r) => (finish = r));
    const world = new FakeWorld();
    const sched = new Scheduler({
      db,
      providers: () => world.provider(),
      leaseMs: 1_000,
      heartbeatMs: 3_600_000,
      globalCap: 9,
      perOrgCap: 9,
      drain: new DrainState(),
      now: () => now,
      runner: async (c) => {
        seen = c.leaseValid;
        await held;
        return { state: "success", reason: "ok" };
      },
    });
    try {
      await sched.tick();
      const deadline = Date.now() + 5_000;
      while (!seen && Date.now() < deadline) await Bun.sleep(10);
      expect(seen).toBeDefined();
      // Claimed at `now` with a 1 s lease; the margin is a tenth of it.
      expect(seen!()).toBe(true);
      now += 899;
      expect(seen!()).toBe(true);
      now += 1;
      expect(seen!()).toBe(false);
    } finally {
      finish();
      await sched.idle();
      await sched.stop();
      world.dispose();
      db.close();
    }
  });

  test("a heartbeat that lands renews it", async () => {
    const db = openDatabase(":memory:");
    const org = await createOrg(db, { slug: "o", name: "o" });
    const project = await createProject(db, { orgId: org.id }, { slug: "p", name: "p" });
    const scope = { orgId: org.id, projectId: project.id };
    const run = await createRun(db, scope, {
      workflowPath: "w.yml",
      event: "push",
      ref: "main",
      sha: "a".repeat(40),
    });
    const job = (await createJob(db, scope, { runId: run.id, jobKey: "j", name: "j" }))!;
    await createAttempt(db, scope, { jobId: job.id, provider: "fake" });
    let now = 1_000_000;
    let seen: (() => boolean) | undefined;
    let finish: () => void = () => {};
    const held = new Promise<void>((r) => (finish = r));
    const world = new FakeWorld();
    const sched = new Scheduler({
      db,
      providers: () => world.provider(),
      leaseMs: 1_000,
      heartbeatMs: 20,
      globalCap: 9,
      perOrgCap: 9,
      drain: new DrainState(),
      now: () => now,
      runner: async (c) => {
        seen = c.leaseValid;
        await held;
        return { state: "success", reason: "ok" };
      },
    });
    try {
      await sched.tick();
      const deadline = Date.now() + 5_000;
      while (!seen && Date.now() < deadline) await Bun.sleep(10);
      now += 950;
      // Lapsed now (synchronously, before any heartbeat at the new time can land) ...
      expect(seen!()).toBe(false);
      // ... and valid again once one does.
      while (!seen!() && Date.now() < deadline) await Bun.sleep(10);
      expect(seen!()).toBe(true);
    } finally {
      finish();
      await sched.idle();
      await sched.stop();
      world.dispose();
      db.close();
    }
  });
});

describe("withEgressPolicy on a refused resume (#789)", () => {
  const WORKFLOW =
    "name: t\non: push\njobs:\n  hello:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n";
  const FIXTURE = join(import.meta.dir, "../../act-runner/tests/fixtures/success.jsonl");
  let world: FakeWorld;
  let db: Db;
  beforeEach(() => {
    world = new FakeWorld();
    db = openDatabase(":memory:");
  });
  afterEach(() => {
    world.dispose();
    db.close();
  });

  async function resumed(extra: Partial<AttemptContext> = {}) {
    const provider = world.provider();
    const org = await createOrg(db, { slug: "o", name: "o" });
    const project = await createProject(db, { orgId: org.id }, { slug: "p", name: "p" });
    const scope = { orgId: org.id, projectId: project.id };
    const run = await createRun(db, scope, {
      workflowPath: "w.yml",
      event: "push",
      ref: "main",
      sha: "a".repeat(40),
    });
    const job = (await createJob(db, scope, { runId: run.id, jobKey: "hello", name: "hello" }))!;
    await createAttempt(db, scope, { jobId: job.id, provider: "fake" });
    const claim = (await claimNextAttempt(db, {
      owner: "w",
      leaseMs: 60_000,
      now: Date.now(),
      globalCap: 9,
      perOrgCap: 9,
    }))!;
    const sb = await provider.create({
      name: "job",
      labels: {},
      ttlSeconds: 600,
      network: { egress: "none" },
    });
    const { execId } = await provider.exec.start(sb.id, {
      argv: ["sh", "-c", `cat '${FIXTURE}'; sleep 5`],
      timeoutSeconds: 30,
    });
    let destroyedAt: number | undefined;
    const logs: string[] = [];
    const store = {
      setExec: async (w: { sandboxDestroyedAt?: number }) =>
        void (destroyedAt = w.sandboxDestroyedAt),
      setPlan: async () => {},
      setTrustClass: async () => {},
      reset: async () => {},
      appendLog: async (_o: number, b: Uint8Array) => void logs.push(new TextDecoder().decode(b)),
      recordStep: async () => {},
      addCut: async () => {},
    } as unknown as AttemptStore;
    const ctx: AttemptContext = {
      attempt: { ...claim.attempt, trustClass: "protected" },
      job: claim.job,
      run: claim.run,
      scope,
      provider,
      signal: new AbortController().signal,
      store,
      resume: { sandboxId: sb.id, execId },
      ...extra,
    };
    return { ctx, provider, logs, destroyedAt: () => destroyedAt };
  }

  const runner = () =>
    createActRunner({
      db,
      source: {
        checkout: async () => ({
          tarball: new Uint8Array(),
          readFile: (p: string) => (p === "w.yml" ? WORKFLOW : undefined),
        }),
      },
      pollMs: 25,
    });

  test("the egress refusal reaches the runner as refuseResume: the exec is stopped, the sandbox released, nothing run", async () => {
    const r = await resumed();
    expect(await r.provider.list({})).toHaveLength(1);
    // The fake provider can enforce only `open`; the run's egress is `none`.
    const out = await withEgressPolicy(runner())(r.ctx);
    expect(out.state).toBe("infra_error");
    expect(out.reason).toContain("cannot enforce egress none");
    expect(await r.provider.list({})).toEqual([]);
    expect(r.destroyedAt()).toBeGreaterThan(0);
    expect(r.logs.join("")).toContain(`released sandbox ${r.ctx.resume!.sandboxId}`);
  });

  test("a refusal an outer wrapper already made is kept, and the sandbox is still released", async () => {
    const reason = "re-attached attempt lost its secrets-proxy credential (test); not resumed";
    const r = await resumed({ refuseResume: reason });
    const out = await withEgressPolicy(runner())(r.ctx);
    expect(out).toEqual({ state: "infra_error", reason });
    expect(await r.provider.list({})).toEqual([]);
  });

  test("a fresh attempt is refused as before, without calling the runner", async () => {
    let called = false;
    const r = await resumed();
    const { resume: _drop, ...fresh } = r.ctx;
    const out = await withEgressPolicy(async () => {
      called = true;
      return { state: "success", reason: "" };
    })(fresh);
    expect(out.state).toBe("infra_error");
    expect(called).toBe(false);
  });
});

describe("a read-only re-issue (#789)", () => {
  test("gets exactly contents and metadata read, never every stored scope at read", async () => {
    const minted: Record<string, string>[] = [];
    const auth: TokenAuthority = {
      mintFresh: async (_i, scope) => {
        minted.push({ ...scope.permissions });
        return { token: `tok-${minted.length}`, expiresAt: Date.now() + 3600_000 };
      },
      installationPermissions: async () => ({}),
      revoke: async () => true,
    };
    const tokens = new JobTokens(auth);
    const stored = {
      contents: "write",
      metadata: "read",
      issues: "write",
      pull_requests: "write",
      statuses: "read",
    } as const;
    const r = await tokens.reissue({
      installationId: "1",
      repo: "web",
      permissions: stored,
      readOnly: true,
    });
    expect(r.permissions).toEqual({ contents: "read", metadata: "read" });
    expect(minted).toEqual([{ contents: "read", metadata: "read" }]);
    // Live: the stored permissions, as they were.
    const live = await tokens.reissue({ installationId: "1", repo: "web", permissions: stored });
    expect(live.permissions).toEqual(stored);
    // An unknown level is still refused, read-only or not.
    await expect(
      tokens.reissue({
        installationId: "1",
        repo: "web",
        permissions: { contents: "admin" },
        readOnly: true,
      }),
    ).rejects.toThrow();
  });
});
