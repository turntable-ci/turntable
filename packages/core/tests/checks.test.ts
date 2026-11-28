import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAttempt,
  type Db,
  getAttemptCheckRunId,
  getRun,
  listAttempts,
  setAttemptCheckRunId,
  setProjectChecksMode,
} from "../src/db";
import * as s from "../src/db/schema";
import type { Claim } from "../src/db/repos";
import { CheckReporter, type TokenMinter } from "../src/checks/reporter";
import {
  type CheckRunBody,
  type CheckRunsApi,
  CheckRunsError,
  githubCheckRunsApi,
} from "../src/checks/client";
import {
  checkName,
  classifyInfra,
  conclusionFor,
  fenced,
  REFUSAL_FIX,
  refusalSentence,
  summaryFor,
} from "../src/checks/mapping";
import { AppAuth } from "../src/github/app-auth";
import { Scheduler } from "../src/scheduler";
import { setupChecksWorld } from "./checks-helpers";

type Call = { op: "create" | "update" | "find"; id?: string; body?: CheckRunBody; repo: string };

/** An in-memory stand-in for GitHub's check-runs API, with switchable outages. */
function fakeApi() {
  const calls: Call[] = [];
  const runs = new Map<string, CheckRunBody>();
  let next = 100;
  const state = { failures: 0, status: 503 };
  const api: CheckRunsApi = {
    async create(_token, repo, body) {
      calls.push({ op: "create", repo, body });
      if (state.failures > 0) {
        state.failures--;
        throw new CheckRunsError(state.status, "create check run");
      }
      const id = String(next++);
      runs.set(id, { ...body });
      return id;
    },
    async update(_token, repo, id, body) {
      calls.push({ op: "update", id, repo, body });
      if (state.failures > 0) {
        state.failures--;
        throw new CheckRunsError(state.status, "update check run");
      }
      runs.set(id, { ...runs.get(id), ...body });
    },
    async findByExternalId(_token, repo, _sha, name, externalId) {
      calls.push({ op: "find", repo });
      for (const [id, b] of runs) if (b.external_id === externalId && b.name === name) return id;
      return undefined;
    },
  };
  return { api, calls, runs, state };
}

function minter() {
  const minted: { installationId: string; scope: unknown }[] = [];
  const auth: TokenMinter = {
    async mint(installationId, scope) {
      minted.push({ installationId, scope });
      return { token: "stub-installation-token" };
    },
  };
  return { auth, minted };
}

let db: Db;
let claim: (state?: string) => Promise<Claim>;
let world: Awaited<ReturnType<typeof setupChecksWorld>>;

beforeEach(async () => {
  world = await setupChecksWorld();
  db = world.db;
  claim = world.claim;
});

const reporterFor = (
  api: CheckRunsApi,
  auth: TokenMinter,
  over: Partial<ConstructorParameters<typeof CheckReporter>[0]> = {},
) =>
  new CheckReporter({
    db,
    auth,
    api,
    publicUrl: "https://ci.example.com",
    sleep: async () => {},
    ...over,
  });

describe("mapping", () => {
  test("shadow is always neutral; live maps the result and infra_error is a failure", () => {
    for (const r of ["success", "failure", "cancelled", "skipped", "infra_error"] as const) {
      expect(conclusionFor("shadow", r)).toBe("neutral");
    }
    expect(conclusionFor("live", "success")).toBe("success");
    expect(conclusionFor("live", "failure")).toBe("failure");
    expect(conclusionFor("live", "cancelled")).toBe("cancelled");
    expect(conclusionFor("live", "skipped")).toBe("skipped");
    expect(conclusionFor("live", "infra_error")).toBe("failure");
  });

  test("names: shadow / <job>, with the matrix leg", () => {
    expect(checkName("shadow", { name: "test", matrix: null })).toBe("shadow / test");
    expect(
      checkName("shadow", { name: "test", matrix: JSON.stringify({ os: "linux", n: 2 }) }),
    ).toBe("shadow / test (linux, 2)");
    // A name that already carries the leg is not doubled; markup characters are stripped.
    expect(
      checkName("live", { name: "test (linux)", matrix: JSON.stringify({ os: "linux" }) }),
    ).toBe("turntable / test (linux)");
    expect(checkName("shadow", { name: "a`b\nc", matrix: null })).toBe("shadow / a b c");
  });

  test("log text cannot break out of its fence", () => {
    const text = "```\n[click](http://evil) @everyone\n````\n";
    const out = fenced(text);
    const fence = /^(`+)text/.exec(out)![1]!;
    expect(fence.length).toBeGreaterThan(4);
    expect(out.endsWith(fence)).toBe(true);
    expect(
      summaryFor({ mode: "live", result: "failure", runUrl: undefined, excerpt: text }),
    ).toContain(fence);
  });
});

describe("reporter", () => {
  test("shadow: in_progress at start, then neutral with the real result in the text", async () => {
    await setProjectChecksMode(db, world.scope, "shadow");
    const c = await claim();
    await world.addFailingLog(c, "bun test");
    const { api, calls, runs } = fakeApi();
    const { auth } = minter();
    const rep = reporterFor(api, auth);
    rep.started(c);
    await rep.idle();
    const created = calls.find((x) => x.op === "create")!;
    expect(created.body).toMatchObject({
      name: "shadow / build",
      head_sha: world.sha,
      status: "in_progress",
      external_id: c.attempt.id,
      details_url: `https://ci.example.com/acme/app/runs/${c.run.id}`,
    });
    expect(created.body!.conclusion).toBeUndefined();

    rep.finished(c, { state: "failure", reason: "exit 1" });
    await rep.idle();
    const done = [...runs.values()][0]!;
    expect(done).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      output: { title: "Shadow: failure" },
    });
    expect(done.output!.summary).toContain("**Result:** failure");
    expect(done.output!.summary).toContain("**Failing step:** bun test");
    expect(done.output!.summary).toContain("expected 1 to be 2");
    expect(done.output!.summary).toContain(`/runs/${c.run.id}`);
    // One check run, updated: not a second one.
    expect(calls.filter((x) => x.op === "create")).toHaveLength(1);
  });

  test("the run's run-name is in the check title and summary, and the check name is unchanged", async () => {
    await setProjectChecksMode(db, world.scope, "live");
    const c = await claim();
    c.run.runName = "Deploy admin\n`prod`";
    const { api, runs } = fakeApi();
    const rep = reporterFor(api, minter().auth);
    rep.started(c);
    rep.finished(c, { state: "success", reason: "" });
    await rep.idle();
    const run = [...runs.values()][0]!;
    expect(run.name).toBe("turntable / build");
    expect(run.output!.title).toBe("Turntable: success (Deploy admin prod)");
    expect(run.output!.summary).toContain("**Run:** Deploy admin prod");
  });

  test("live maps success, failure, cancelled, skipped and infra_error", async () => {
    await setProjectChecksMode(db, world.scope, "live");
    const cases = [
      ["success", "success", "Turntable: success"],
      ["failure", "failure", "Turntable: failure"],
      ["cancelled", "cancelled", "Turntable: cancelled"],
      ["skipped", "skipped", "Turntable: skipped"],
      ["infra_error", "failure", "Turntable: infrastructure error"],
    ] as const;
    for (const [state, conclusion, title] of cases) {
      const c = await claim();
      const { api, runs } = fakeApi();
      const rep = reporterFor(api, minter().auth);
      rep.started(c);
      rep.finished(c, { state, reason: "cannot prepare sandbox: the sandbox did not start" });
      await rep.idle();
      const run = [...runs.values()][0]!;
      expect(run.name).toBe("turntable / build");
      expect(run).toMatchObject({ status: "completed", conclusion, output: { title } });
      if (state === "infra_error") {
        expect(run.output!.summary).toContain("Infrastructure error");
        expect(run.output!.summary).toContain("Reason: sandbox_create_failed.");
        expect(run.output!.summary).toContain("See the Turntable run for details.");
        expect(run.output!.summary).not.toContain("the sandbox did not start");
      }
    }
  });

  test("a job on its infra retry keeps its one check and shows the retry (#517)", async () => {
    await setProjectChecksMode(db, world.scope, "live");
    const first = await claim();
    const { api, runs, calls } = fakeApi();
    const rep = reporterFor(api, minter().auth);
    rep.started(first);
    await rep.idle();
    // The scheduler ended the first attempt with a kind and queued a new one that inherits the check.
    const checkId = await getAttemptCheckRunId(world.db, world.scope, first.attempt.id);
    await world.db.run(async (h) => {
      await h.orm
        .update(s.jobAttempts)
        .set({ state: "infra_error", infraKind: "docker_daemon_unavailable" })
        .where(eq(s.jobAttempts.id, first.attempt.id));
    });
    const next = (await createAttempt(world.db, world.scope, {
      jobId: first.job.id,
      provider: "fake",
    }))!;
    await setAttemptCheckRunId(world.db, world.scope, next.id, checkId!);
    const retry: Claim = { ...first, attempt: next };
    rep.started(retry);
    await rep.idle();
    const run = [...runs.values()][0]!;
    expect(runs.size).toBe(1);
    expect(calls.filter((x) => x.op === "create")).toHaveLength(1);
    expect(run.status).toBe("in_progress");
    expect(run.output!.summary).toContain("second attempt");
    expect(run.output!.summary).toContain("Docker daemon was unavailable");
  });

  test("the summary excerpt is redacted and capped at 1 KiB", async () => {
    await setProjectChecksMode(db, world.scope, "shadow");
    const c = await claim();
    const secret = `ghp_${"a1b2".repeat(9)}`;
    await world.addFailingLog(c, "build", `error: bad token ${secret}\n${"x".repeat(5000)}\n`);
    const { api, runs } = fakeApi();
    const rep = reporterFor(api, minter().auth);
    rep.started(c);
    rep.finished(c, { state: "failure", reason: "exit 1" });
    await rep.idle();
    const summary = [...runs.values()][0]!.output!.summary;
    expect(summary).not.toContain(secret);
    const excerpt = /```text\n([\s\S]*)\n```/.exec(summary)![1]!;
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(1024);
  });

  test("an infra_error publishes a classified reason only, never the raw text", async () => {
    for (const mode of ["shadow", "live"] as const) {
      await setProjectChecksMode(db, world.scope, mode);
      const secret = `ghp_${"q9z8".repeat(9)}`;
      const raw = `ECONNREFUSED db.internal.corp.example:5432 at /home/runner/work/app/src/x.ts using ${secret}`;
      const c = await claim();
      // The sandbox's own log has hostnames and paths too; an infra_error must not post it.
      await world.addFailingLog(
        c,
        "setup",
        `connect failed to db.internal.corp.example /etc/secret-path ${secret}\n`,
      );
      const { api, calls } = fakeApi();
      const rep = reporterFor(api, minter().auth);
      rep.started(c);
      rep.finished(c, { state: "infra_error", reason: raw });
      await rep.idle();
      const payload = JSON.stringify(calls.map((x) => x.body));
      for (const leak of [
        secret,
        "db.internal.corp.example",
        "/home/runner",
        "/etc/secret-path",
        "ECONNREFUSED",
      ]) {
        expect(payload).not.toContain(leak);
      }
      expect(payload).toContain("Reason: provider_unavailable.");
      expect(payload).toContain("See the Turntable run for details.");
    }
  });

  test("infra reasons classify to a fixed enum", () => {
    const cases: [string, string][] = [
      ["cannot prepare sandbox: tt: fork failed", "sandbox_create_failed"],
      ["act process lost", "exec_lost"],
      ["controller_lost (probe failed)", "exec_lost"],
      [
        "isolation: provider x is container; untrusted runs need gvisor or stronger",
        "isolation_policy",
      ],
      ["egress: provider p cannot enforce egress none", "egress_policy"],
      ["untrusted run has no approval", "approval_required"],
      ["plan rejected: step uses docker", "plan_rejected"],
      ["workflow .github/workflows/ci.yml not found at abc", "workflow_missing"],
      ["job timed out after 3600s", "timeout"],
      ["act exited 128 without a job result", "runner_error"],
      ["getaddrinfo ENOTFOUND api.example", "provider_unavailable"],
      ["something nobody planned for at /srv/x", "internal"],
      ["", "internal"],
    ];
    for (const [raw, want] of cases) expect(classifyInfra(raw) as string).toBe(want);
  });

  test("a failing step name is redacted and the excerpt capped, with a secret in the step name", async () => {
    await setProjectChecksMode(db, world.scope, "shadow");
    const secret = `ghp_${"m3n4".repeat(9)}`;
    const c = await claim();
    await world.addFailingLog(c, `deploy with ${secret}`, "error: nope\n");
    const { api, runs } = fakeApi();
    const rep = reporterFor(api, minter().auth);
    rep.started(c);
    rep.finished(c, { state: "failure", reason: "exit 1" });
    await rep.idle();
    expect(JSON.stringify([...runs.values()])).not.toContain(secret);
  });

  test("off posts nothing and mints nothing", async () => {
    const c = await claim();
    const { api, calls } = fakeApi();
    const { auth, minted } = minter();
    const rep = reporterFor(api, auth);
    rep.started(c);
    rep.finished(c, { state: "success", reason: "ok" });
    await rep.idle();
    expect(calls).toHaveLength(0);
    expect(minted).toHaveLength(0);
  });

  test("local runs and repos not installed through the App post nothing", async () => {
    await setProjectChecksMode(db, world.scope, "shadow");
    const { api, calls } = fakeApi();
    const rep = reporterFor(api, minter().auth);
    const local = await claim();
    rep.started({ ...local, run: { ...local.run, repo: null } });
    const other = await claim();
    rep.started({ ...other, run: { ...other.run, repo: "someone/else" } });
    await rep.idle();
    expect(calls).toHaveLength(0);
  });

  test("idempotent across a restart: the stored id is updated, never duplicated", async () => {
    await setProjectChecksMode(db, world.scope, "shadow");
    const c = await claim();
    const { api, calls, runs } = fakeApi();
    const first = reporterFor(api, minter().auth);
    first.started(c);
    await first.idle();
    expect(await getAttemptCheckRunId(db, world.scope, c.attempt.id)).toBe("100");

    // A new process re-attaches to the same attempt: started again, then finished.
    const second = reporterFor(api, minter().auth);
    second.started(c);
    second.finished(c, { state: "success", reason: "ok" });
    await second.idle();
    expect(calls.filter((x) => x.op === "create")).toHaveLength(1);
    expect(runs.size).toBe(1);
    expect([...runs.values()][0]).toMatchObject({ status: "completed", conclusion: "neutral" });
  });

  test("a check created by a worker that died before storing its id is found, not duplicated", async () => {
    await setProjectChecksMode(db, world.scope, "shadow");
    const c = await claim();
    const { api, calls, runs } = fakeApi();
    // The previous worker created it at GitHub, then died.
    runs.set("77", { name: "shadow / build", external_id: c.attempt.id, status: "in_progress" });
    const rep = reporterFor(api, minter().auth);
    rep.started(c);
    await rep.idle();
    expect(calls.filter((x) => x.op === "create")).toHaveLength(0);
    expect(await getAttemptCheckRunId(db, world.scope, c.attempt.id)).toBe("77");
  });

  test("a finish with no recorded start creates the check already completed", async () => {
    await setProjectChecksMode(db, world.scope, "shadow");
    const c = await claim();
    const { api, runs } = fakeApi();
    const rep = reporterFor(api, minter().auth);
    rep.finished(c, { state: "success", reason: "ok" });
    await rep.idle();
    expect([...runs.values()]).toHaveLength(1);
    expect([...runs.values()][0]).toMatchObject({ status: "completed", conclusion: "neutral" });
  });

  test("an outage is retried with backoff and never throws; a refusal is not retried", async () => {
    await setProjectChecksMode(db, world.scope, "shadow");
    const delays: number[] = [];
    const c = await claim();
    const outage = fakeApi();
    outage.state.failures = 2;
    const rep = reporterFor(outage.api, minter().auth, {
      sleep: async (ms) => void delays.push(ms),
      baseDelayMs: 10,
    });
    rep.started(c);
    await rep.idle();
    expect(outage.runs.size).toBe(1);
    expect(delays).toEqual([10, 20]);

    // Down for good: gives up after the retry budget, logs, and returns.
    const dead = fakeApi();
    dead.state.failures = 99;
    const logs: string[] = [];
    const c2 = await claim();
    const rep2 = reporterFor(dead.api, minter().auth, { retries: 3, log: (m) => logs.push(m) });
    rep2.started(c2);
    await rep2.idle();
    expect(dead.calls.filter((x) => x.op === "create")).toHaveLength(3);
    expect(logs.join("\n")).toContain("not reported");
    expect(await getAttemptCheckRunId(db, world.scope, c2.attempt.id)).toBeNull();

    // A refusal (the App lacks the permission) is final.
    const refused = fakeApi();
    refused.state.failures = 99;
    refused.state.status = 403;
    const c3 = await claim();
    const rep3 = reporterFor(refused.api, minter().auth);
    rep3.started(c3);
    await rep3.idle();
    expect(refused.calls.filter((x) => x.op === "create")).toHaveLength(1);
  });

  test("the token is minted for the one repo with checks: write only", async () => {
    await setProjectChecksMode(db, world.scope, "shadow");
    const c = await claim();
    const { api } = fakeApi();
    const { auth, minted } = minter();
    const rep = reporterFor(api, auth);
    rep.started(c);
    await rep.idle();
    expect(minted).toEqual([
      {
        installationId: world.installationId,
        scope: { repositories: ["web"], permissions: { checks: "write" } },
      },
    ]);
  });

  test("with the real AppAuth the access-token request names one repo and checks: write", async () => {
    await setProjectChecksMode(db, world.scope, "shadow");
    const requests: { url: string; body: unknown }[] = [];
    const realAuth = new AppAuth({
      db,
      store: world.store,
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return Response.json({
          token: `ghs_${"x".repeat(30)}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }) as unknown as typeof fetch,
    });
    const c = await claim();
    const { api } = fakeApi();
    const rep = reporterFor(api, realAuth);
    rep.started(c);
    await rep.idle();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain(`/app/installations/${world.installationId}/access_tokens`);
    expect(requests[0]!.body).toEqual({ repositories: ["web"], permissions: { checks: "write" } });
  });
});

describe("githubCheckRunsApi", () => {
  test("sends the token only in the header, the right methods and bodies, and classifies errors", async () => {
    const seen: { url: string; method: string; auth: string | null; body: string | undefined }[] =
      [];
    let status = 200;
    const api = githubCheckRunsApi({
      baseUrl: "https://api.example.test",
      fetch: async (input, init = {}) => {
        seen.push({
          url: String(input),
          method: init.method!,
          auth: new Headers(init.headers).get("authorization"),
          body: init.body as string | undefined,
        });
        if (status !== 200) return new Response("no", { status });
        if (init.method === "GET")
          return Response.json({ check_runs: [{ id: 9, external_id: "att" }] });
        return Response.json({ id: 55 });
      },
    });
    const token = "stub-installation-token";
    expect(await api.create(token, "acme/web", { name: "n", status: "in_progress" })).toBe("55");
    await api.update(token, "acme/web", "55", { status: "completed", conclusion: "neutral" });
    expect(await api.findByExternalId(token, "acme/web", "a".repeat(40), "n x", "att")).toBe("9");
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      "POST /repos/acme/web/check-runs",
      "PATCH /repos/acme/web/check-runs/55",
      `GET /repos/acme/web/commits/${"a".repeat(40)}/check-runs`,
    ]);
    for (const s of seen) {
      expect(s.auth).toBe(`Bearer ${token}`);
      expect(s.url).not.toContain(token);
      expect(s.body ?? "").not.toContain(token);
    }
    for (const bad of ["../x/y", "a/b/c", "a b/c"]) {
      await expect(api.create(token, bad, { status: "in_progress" })).rejects.toBeInstanceOf(
        CheckRunsError,
      );
    }
    await expect(api.update(token, "acme/web", "../1", { status: "completed" })).rejects.toThrow();
    status = 503;
    const e = await api.create(token, "acme/web", { status: "in_progress" }).catch((x) => x);
    expect(e).toMatchObject({ status: 503, retryable: true });
    status = 422;
    const f = await api.create(token, "acme/web", { status: "in_progress" }).catch((x) => x);
    expect(f).toMatchObject({ status: 422, retryable: false });
  });
});

describe("scheduler hooks", () => {
  async function runThrough(api: CheckRunsApi, reporter: CheckReporter) {
    const c = await claim();
    const sched = new Scheduler({
      db,
      providers: () => ({}) as never,
      runner: async () => ({ state: "success", reason: "ok" }),
      observer: reporter,
      pollMs: 10,
    });
    expect(await sched.tick()).toBe(1);
    await sched.idle();
    void api;
    return c;
  }

  test("a job that runs is reported at start and at finish", async () => {
    await setProjectChecksMode(db, world.scope, "shadow");
    const { api, calls, runs } = fakeApi();
    const reporter = reporterFor(api, minter().auth);
    const c = await runThrough(api, reporter);
    await reporter.idle();
    expect(calls.map((x) => x.op)).toEqual(["find", "create", "update"]);
    expect([...runs.values()][0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect((await getRun(db, world.scope, c.run.id))!.status).toBe("success");
  });

  test("a GitHub outage never blocks the run", async () => {
    await setProjectChecksMode(db, world.scope, "live");
    const down = fakeApi();
    down.state.failures = 999;
    const reporter = reporterFor(down.api, minter().auth, { retries: 2 });
    const c = await runThrough(down.api, reporter);
    // The run is already finished and recorded while reporting is still failing or retrying.
    expect((await getRun(db, world.scope, c.run.id))!.status).toBe("success");
    await reporter.idle();
    expect(
      await getAttemptCheckRunId(
        db,
        world.scope,
        (await listAttempts(db, world.scope, c.job.id))[0]!.id,
      ),
    ).toBeNull();
  });

  test("an observer that throws cannot affect the scheduler", async () => {
    const { claim: mk } = world;
    const c = await mk();
    const sched = new Scheduler({
      db,
      providers: () => ({}) as never,
      runner: async () => ({ state: "success", reason: "ok" }),
      observer: {
        started: () => {
          throw new Error("boom");
        },
        finished: () => {
          throw new Error("boom");
        },
      },
    });
    expect(await sched.tick()).toBe(1);
    await sched.idle();
    expect((await getRun(db, world.scope, c.run.id))!.status).toBe("success");
  });
});

describe("checks mode policy", () => {
  test("only the CLI sets it, per project, audited; off by default; bad values refused", async () => {
    const { getProjectChecksMode, listAudit } = await import("../src/db");
    const { setChecksModePolicy, showChecksMode } = await import("../src/ops/policy-cli");
    expect(await getProjectChecksMode(db, world.scope)).toBe("off");
    await expect(setChecksModePolicy(db, "acme", undefined, "loud")).rejects.toThrow();
    await expect(setChecksModePolicy(db, "acme", "nope", "shadow")).rejects.toThrow();
    expect(await setChecksModePolicy(db, "acme", "app", "shadow")).toEqual([
      { project: "app", from: "off", to: "shadow" },
    ]);
    expect(await showChecksMode(db, "acme")).toEqual([{ project: "app", mode: "shadow" }]);
    expect(
      (await listAudit(db, world.scope)).filter((a) => a.op === "policy_set").map((a) => a.input),
    ).toEqual([expect.stringContaining('"to":"shadow"')]);
    // No registered operation can change it: live is reachable from the CLI alone.
    const { registry } = await import("../src/ops");
    expect(
      registry.ops
        .map((o) => o.name)
        .filter(
          (n) =>
            /checks_mode|check_run|policy/.test(n) &&
            !n.includes("key_policy") &&
            !n.includes("approval_policy") &&
            !n.includes("pr_policy"),
        ),
    ).toEqual([]);
    // approval_policy is a different setting (#664): an owner edits it from a web session, with
    // step-up. It never touches checks_mode, and its ops are the only policy ops left.
    expect(
      registry.ops
        .map((o) => o.name)
        .filter((n) => n.includes("approval_policy"))
        .toSorted(),
    ).toEqual([
      "approval_policy_challenge",
      "approve_approval_policy",
      "get_approval_policy",
      "set_approval_policy",
    ]);
  });
});

describe("a job Turntable cannot run", () => {
  const reason =
    "unsupported: This job asks for a macOS runner (`macos-latest`). Turntable runs Linux sandboxes only; macOS runners are not supported yet.";
  test("a refusal is a failure in live mode, never skipped or neutral", () => {
    expect(conclusionFor("live", "failure")).toBe("failure");
    expect(conclusionFor("live", "failure")).not.toBe("skipped");
    expect(conclusionFor("live", "failure")).not.toBe("neutral");
  });

  test("the summary carries the reason and the fix", () => {
    const summary = summaryFor({
      mode: "live",
      result: "failure",
      runUrl: undefined,
      refusal: refusalSentence(reason),
    });
    expect(summary).toContain("This job asks for a macOS runner (`macos-latest`)");
    expect(summary).toContain(REFUSAL_FIX);
    expect(REFUSAL_FIX).toContain("if: vars.TURNTABLE_CI != 'true'");
  });

  test("workflow-controlled text is inert: no link or image syntax outside a code span", () => {
    const evil = "macos-latest](https://evil)![x](y)";
    const sentences = [
      refusalSentence(
        `unsupported: This job asks for a macOS runner (\`${evil}\`). Turntable runs Linux sandboxes only; macOS runners are not supported yet.`,
      ),
      refusalSentence(`unsupported: step uses ${evil}\`[a](b)`),
    ];
    for (const s of sentences) {
      expect(s).toBeDefined();
      const outside = (s ?? "").replaceAll(/`[^`]*`/g, "");
      expect(outside).not.toContain("](");
      expect(outside).not.toContain("![");
      expect(outside).not.toContain("<");
      expect((s ?? "").split("`").length % 2).toBe(1); // spans are balanced, none can be closed early
    }
    expect(sentences[0]).toContain("`macos-latest](https://evil)![x](y)`");
  });

  test("a planner reason (docker) is wrapped; a non-refusal is not one", () => {
    expect(refusalSentence("unsupported: uses services:")).toBe(
      "Turntable cannot run this job: `uses services:`.",
    );
    expect(refusalSentence("exit 1")).toBeUndefined();
    expect(refusalSentence(undefined)).toBeUndefined();
  });
});
