import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, staticResolver, tarDirectory } from "@turntable/act-runner";
import type { SafeFetch } from "@turntable/net";
import { InfraError } from "@turntable/provider-sdk";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import {
  claimNextAttempt,
  createLocalRun,
  ensureLocalTenant,
  listAttempts,
  listJobs,
  listRuns,
  openDatabase,
  readLog,
} from "../src/db";
import { runWorkflowLocal } from "../src/run/run-workflow";

const tmp = mkdtempSync(join(tmpdir(), "tt-wf-test-"));
const world = new FakeWorld({ hostPaths: [tmp], exec: { tickSeconds: 1 } });
afterAll(() => {
  world.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A stand-in for act. It reads `-j <job>` and `-W <workflow>`, keeps a copy of the generated
 * workflow, prints act-style JSON events (for the job and for a stub need, which runJob must
 * ignore), writes declared outputs, and exits per job id.
 */
const FAKE_ACT = String.raw`#!/bin/sh
J=""; W=""
while [ $# -gt 0 ]; do
  case "$1" in -j) J=$2; shift;; -W) W=$2; shift;; esac
  shift
done
R=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$R/seen" "$R/outputs"
cp "$W" "$R/seen/$J.yml"
ev() { printf '{"jobID":"%s","level":"info","msg":"%s","step":"%s","stepid":["--setup-job"],"time":"t"%s}\n' "$1" "$2" "$3" "$4"; }
ev stubjob "stub" "Set up job" ',"stepResult":"success"'
ev "$J" "Run" "Set up job" ""
ev "$J" "ok" "Set up job" ',"stepResult":"success"'
case "$J" in
  build) printf '%s' '1.2.3' > "$R/outputs/version" ;;
  gen) printf '%s' '{"n":[1,2]}' > "$R/outputs/m" ;;
esac
case "$J" in
  fail|mfail|flaky)
    printf '{"jobID":"%s","level":"info","msg":"boom\\n","raw_output":true,"stage":"Main","step":"x","stepID":["0"],"time":"t"}\n' "$J"
    printf '{"jobID":"%s","jobResult":"failure","msg":"failed","time":"t"}\n' "$J"
    exit 1 ;;
esac
printf '{"jobID":"%s","jobResult":"success","msg":"ok","time":"t"}\n' "$J"
exit 0
`;

async function actTarball() {
  const d = mkdtempSync(join(tmp, "a-"));
  writeFileSync(join(d, "act"), FAKE_ACT, { mode: 0o755 });
  const bytes = await tarDirectory(d, ["act"]);
  return { bytes, sha256: sha256Hex(bytes) };
}

async function repoTarball() {
  const d = mkdtempSync(join(tmp, "r-"));
  writeFileSync(join(d, "README.md"), "hi\n");
  return tarDirectory(d, ["README.md"]);
}

const PIPELINE = `name: pipeline
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.v.outputs.version }}
    steps:
      - id: v
        run: echo "version=1.2.3" >> "$GITHUB_OUTPUT"
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ needs.build.outputs.version }}
  skipme:
    needs: build
    if: \${{ needs.build.outputs.version == 'nope' }}
    runs-on: ubuntu-latest
    steps:
      - run: echo never
  images:
    runs-on: ubuntu-latest
    steps:
      - run: docker build .
  fail:
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
  after-fail:
    needs: fail
    runs-on: ubuntu-latest
    steps:
      - run: echo never
  cleanup:
    needs: fail
    if: \${{ always() }}
    runs-on: ubuntu-latest
    steps:
      - run: echo cleanup
`;

async function go(
  yaml: string,
  extra: Partial<Parameters<typeof runWorkflowLocal>[0]> = {},
  event: Parameters<typeof runWorkflowLocal>[0]["event"] = { name: "push", ref: "refs/heads/main" },
  /** Leave the resolver unset: the runner then resolves with the operator's token, like the CLI. */
  defaultResolver = false,
) {
  const db = openDatabase(":memory:");
  const scope = await ensureLocalTenant(db);
  const root = join(mkdtempSync(join(tmp, "root-")), "tt");
  const out: string[] = [];
  const opts: Parameters<typeof runWorkflowLocal>[0] = {
    provider: world.provider(),
    providerName: "fake",
    db,
    scope,
    workflowPath: ".github/workflows/ci.yml",
    workflowYaml: yaml,
    event,
    sha: "a".repeat(40),
    repoTarball: await repoTarball(),
    image: "unused",
    out: (t) => out.push(t),
    readFile: () => undefined,
    resolver: staticResolver({}),
    planRoot: root,
    act: await actTarball(),
    pollMs: 30,
    maxParallel: 1,
    ...extra,
  };
  if (defaultResolver) delete opts.resolver;
  const result = await runWorkflowLocal(opts);
  const seen = (id: string): string => readFileSync(join(root, "seen", `${id}.yml`), "utf8");
  return { db, scope, root, result, out: out.join(""), seen };
}

describe("runWorkflowLocal", () => {
  test("graph: outputs flow into stub needs, skips, docker, failure and always()", async () => {
    const { db, scope, result, out, seen } = await go(PIPELINE);
    const by = Object.fromEntries(result.jobs.map((j) => [j.key, j]));
    expect(by.build).toMatchObject({ state: "success", outputs: { version: "1.2.3" } });
    expect(by.test?.state).toBe("success");
    expect(by.skipme).toMatchObject({ state: "skipped" });
    expect(by.skipme?.reason).toContain("is false");
    expect(by.images?.state).toBe("failure");
    expect(by.images?.reason).toContain("unsupported");
    expect(by.images?.reason).toContain("docker");
    expect(by.fail?.state).toBe("failure");
    expect(by["after-fail"]?.state).toBe("skipped");
    expect(by.cleanup?.state).toBe("success");
    expect(result).toMatchObject({ triggered: true, state: "failure", exitCode: 1 });

    // The dependent job ran from a workflow whose stub carries the real output as a literal.
    expect(seen("test")).toContain("${{ '1.2.3' }}");
    // The stub need that failed fails, so cleanup's needs.fail.result is really failure.
    expect(seen("cleanup")).toContain("exit 1");

    // Stored: needs, states, and the reason of skipped jobs as their log.
    const [run] = await listRuns(db, scope);
    expect(run?.status).toBe("failure");
    const jobs = await listJobs(db, scope, result.runId as string);
    const row = (k: string) => jobs.find((j) => j.jobKey === k);
    expect(JSON.parse(row("test")?.needs ?? "[]")).toEqual(["build"]);
    expect(row("skipme")?.state).toBe("skipped");
    expect(row("images")?.state).toBe("failure");
    expect(row("fail")).toMatchObject({ state: "failure" });
    const [att] = await listAttempts(db, scope, row("images")?.id as string);
    const log = await readLog(db, scope, att?.id as string);
    expect(Buffer.concat(log.map((c) => c.bytes)).toString()).toContain("unsupported");
    expect(out).toContain("[test] ");
    expect(out).not.toContain("stub"); // events of stub need jobs are not shown
  });

  test("a workflow that does not trigger runs nothing", async () => {
    const { db, scope, result } = await go(PIPELINE, {}, { name: "push", ref: "refs/heads/dev" });
    expect(result).toMatchObject({ triggered: false, jobs: [] });
    expect(result.triggerReason).toContain("branch dev");
    expect(await listRuns(db, scope)).toHaveLength(0);
  });

  test("path filters use the changed files", async () => {
    const wf =
      "on:\n  push:\n    paths: ['src/**']\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n";
    const ev = (files: string[]) => ({ name: "push", ref: "refs/heads/main", changedFiles: files });
    expect((await go(wf, {}, ev(["README.md"]))).result.triggered).toBe(false);
    expect((await go(wf, {}, ev(["src/a.ts"]))).result.triggered).toBe(true);
  });

  test("matrix legs are separate jobs; fail-fast cancels queued legs, fail-fast false does not", async () => {
    const mk = (ff: boolean) => `on: push
jobs:
  mfail:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: ${ff}
      matrix:
        n: [1, 2, 3]
    steps:
      - run: exit 1
`;
    const a = await go(mk(true));
    expect(a.result.jobs.map((j) => [j.key, j.state])).toEqual([
      ["mfail[0]", "failure"],
      ["mfail[1]", "cancelled"],
      ["mfail[2]", "cancelled"],
    ]);
    const b = await go(mk(false));
    expect(b.result.jobs.map((j) => j.state)).toEqual(["failure", "failure", "failure"]);
    const jobs = await listJobs(b.db, b.scope, b.result.runId as string);
    expect(jobs.map((j) => JSON.parse(j.matrix ?? "null"))).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    // each leg's generated workflow has just its own literal leg
    expect(existsSync(join(b.root, "repo/.turntable/jobs/mfail_2_.yml"))).toBe(true);
  });

  test("a run-time matrix is reported as one result per leg, named after the leg", async () => {
    const a = await go(`on: push
jobs:
  gen:
    runs-on: ubuntu-latest
    outputs:
      m: \${{ steps.g.outputs.m }}
    steps:
      - id: g
        run: echo 'm={"n":[1,2]}' >> "$GITHUB_OUTPUT"
  use:
    needs: gen
    runs-on: ubuntu-latest
    strategy:
      matrix: \${{ fromJSON(needs.gen.outputs.m) }}
    steps:
      - run: echo \${{ matrix.n }}
`);
    expect(a.result.jobs.map((j) => [j.key, j.name, j.state])).toEqual([
      ["gen", "gen", "success"],
      ["use[0]", "use (1)", "success"],
      ["use[1]", "use (2)", "success"],
    ]);
  });

  test("continue-on-error: a failed job still counts as success for dependents and the run", async () => {
    const wf = `on: push
jobs:
  flaky:
    continue-on-error: true
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
  after:
    needs: flaky
    runs-on: ubuntu-latest
    steps:
      - run: echo
`;
    const { db, scope, result } = await go(wf);
    expect(result.jobs.map((j) => j.state)).toEqual(["failure", "success"]);
    expect(result).toMatchObject({ state: "success", exitCode: 0 });
    const [run] = await listRuns(db, scope);
    expect(run?.status).toBe("success");
  });

  test("a cancelled run cancels queued jobs and exits 130", async () => {
    const ac = new AbortController();
    ac.abort();
    const { result } = await go(PIPELINE, { signal: ac.signal });
    expect(result.state).toBe("cancelled");
    expect(result.exitCode).toBe(130);
    expect(result.jobs.every((j) => j.state === "cancelled" || j.state === "skipped")).toBe(true);
  });

  test("launch metadata records egress", async () => {
    const { db, scope } = await go(PIPELINE, { egress: "open" });
    const { listAudit } = await import("../src/db");
    const audit = await listAudit(db, scope);
    expect(audit[0]?.op).toBe("run_local");
    expect(audit[0]?.input).toContain('"egress":"open"');
  });

  test("a local run is only claimed by its own process", async () => {
    const db = openDatabase(":memory:");
    const scope = await ensureLocalTenant(db);
    const run = await createLocalRun(db, scope, {
      provider: "fake",
      jobs: [{ key: "a", name: "a", needs: [] }],
      run: { workflowPath: ".github/workflows/ci.yml", event: "push", ref: "refs/heads/main" },
    });
    expect(run.local).toBe(true);
    const base = { owner: "server", leaseMs: 30_000, now: Date.now(), globalCap: 4, perOrgCap: 4 };
    // A server's worker (no onlyRun) never takes it; the starting process does.
    expect(await claimNextAttempt(db, base)).toBeUndefined();
    expect(await claimNextAttempt(db, { ...base, onlyRun: "other" })).toBeUndefined();
    const mine = await claimNextAttempt(db, { ...base, owner: "cli", onlyRun: run.id });
    expect(mine?.run.id).toBe(run.id);
  });

  test("a step that uses a path outside the repo fails the job with the reason, not run; its own false if: skips it", async () => {
    const wf = `on: push
jobs:
  bad:
    runs-on: ubuntu-latest
    steps:
      - uses: ./../outside
`;
    const { db, scope, result, out } = await go(wf);
    expect(result.jobs[0]).toMatchObject({ state: "failure" });
    expect(result.jobs[0]?.reason).toContain("outside the repository");
    expect(out).toContain("[bad] unsupported:");
    const [run] = await listRuns(db, scope);
    expect(run?.status).toBe("failure");
    // the workflow's own gate is the opt-out: false, so a legitimate skip
    const gated = await go(
      wf.replace("  bad:\n", "  bad:\n    if: vars.TURNTABLE_CI != 'true'\n"),
      {
        vars: { TURNTABLE_CI: "true" },
      },
    );
    expect(gated.result.jobs[0]).toMatchObject({ state: "skipped" });
  });

  test("an infrastructure error that is thrown keeps its reason: printed, returned and stored", async () => {
    const yaml = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: acme/tool@${"b".repeat(40)}
`;
    const reason = "verifying an action commit: rate limited (HTTP 403)";
    const { db, scope, result, out } = await go(yaml, {
      reachable: async () => {
        throw new InfraError(reason);
      },
    });
    expect(result.jobs[0]).toMatchObject({ state: "infra_error" });
    expect(result.jobs[0]!.reason).toContain("rate limited");
    expect(out).toContain("[build] ");
    expect(out).toContain("rate limited");
    const jobs = await listJobs(db, scope, result.runId as string);
    const [att] = await listAttempts(db, scope, jobs[0]!.id);
    expect(att!.errorClass).toContain("rate limited");
  });

  describe("actions of a local run use the operator's token", () => {
    const TOKEN = "operator-token-value";
    const wf = (uses: string) => `on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: ${uses}
`;
    /** A GitHub that hides private repos from anonymous calls and 404s the unknown. */
    function github(priv: string[]) {
      const calls: { path: string; auth: string | null }[] = [];
      const impl: SafeFetch = async (input, init) => {
        const url = new URL(String(input));
        calls.push({ path: url.pathname, auth: new Headers(init?.headers).get("authorization") });
        const name = /^\/repos\/([^/]+\/[^/]+)/.exec(url.pathname)?.[1]?.toLowerCase();
        const authed = new Headers(init?.headers).get("authorization") !== null;
        const known = name === "stranger/tool" || (name !== undefined && priv.includes(name));
        if (!known || (priv.includes(name!) && !authed)) return new Response("no", { status: 404 });
        if (url.pathname.endsWith("/commits/v1")) return new Response("c".repeat(40));
        if (/\/compare\//.test(url.pathname)) return Response.json({ status: "identical" });
        return Response.json({ default_branch: "main", private: priv.includes(name!) });
      };
      return { impl, calls };
    }
    const tarball = async (): Promise<Uint8Array> => {
      const d = mkdtempSync(join(tmp, "act-"));
      const top = "x-y-abc123";
      mkdirSync(join(d, top), { recursive: true });
      writeFileSync(
        join(d, top, "action.yml"),
        "name: n\nruns:\n  using: node20\n  main: index.js\n",
      );
      return tarDirectory(d, [top]);
    };

    test("any public action is resolved and verified with the token, not the shared anonymous limit", async () => {
      const gh = github([]);
      const { result } = await go(
        wf("stranger/tool@v1"),
        { githubToken: TOKEN, fetch: gh.impl, fetchAction: tarball },
        { name: "push", ref: "refs/heads/main" },
        true,
      );
      expect(result.jobs[0]?.state).toBe("success");
      expect(gh.calls.length).toBeGreaterThanOrEqual(3);
      for (const c of gh.calls) expect(c.auth).toBe(`Bearer ${TOKEN}`);
    });

    test("a local run that simulates a pull request is still the operator's own", async () => {
      const gh = github([]);
      const { result } = await go(
        wf("stranger/tool@v1"),
        { githubToken: TOKEN, fetch: gh.impl, fetchAction: tarball },
        { name: "pull_request", ref: "refs/pull/1/head" },
        true,
      );
      expect(result.jobs[0]?.state).toBe("success");
      for (const c of gh.calls) expect(c.auth).toBe(`Bearer ${TOKEN}`);
    });

    test("a private repo and one that does not exist are refused with the same words", async () => {
      const gh = github(["secret-org/private-thing"]);
      const run = (uses: string) =>
        go(
          wf(uses),
          { githubToken: TOKEN, fetch: gh.impl, fetchAction: tarball },
          { name: "push", ref: "refs/heads/main" },
          true,
        );
      const priv = (await run("secret-org/private-thing@v1")).result.jobs[0]!;
      const ghost = (await run("ghost-org/none@v1")).result.jobs[0]!;
      expect(priv.state).toBe("failure");
      expect(ghost.state).toBe("failure");
      const norm = (r: string, name: string) => r.replaceAll(name, "<repo>");
      expect(priv.reason).toContain("action not available: secret-org/private-thing");
      expect(norm(priv.reason, "secret-org/private-thing")).toBe(
        norm(ghost.reason, "ghost-org/none"),
      );
      // Nothing of the private repo leaked: no sha, no mention that it is private.
      expect(priv.reason.replace("secret-org/private-thing", "")).not.toMatch(
        /private|[0-9a-f]{40}/,
      );
    });

    test("without a token nothing is authenticated, and the run still works for public actions", async () => {
      const gh = github([]);
      const saved = process.env.TURNTABLE_GITHUB_TOKEN;
      delete process.env.TURNTABLE_GITHUB_TOKEN;
      try {
        const { result } = await go(
          wf("stranger/tool@v1"),
          { fetch: gh.impl, fetchAction: tarball },
          { name: "push", ref: "refs/heads/main" },
          true,
        );
        expect(result.jobs[0]?.state).toBe("success");
        for (const c of gh.calls) expect(c.auth).toBeNull();
      } finally {
        if (saved !== undefined) process.env.TURNTABLE_GITHUB_TOKEN = saved;
      }
    });
  });
});
