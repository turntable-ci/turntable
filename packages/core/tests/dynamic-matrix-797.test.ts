// #797: a job whose matrix is `fromJSON(needs.x.outputs.m)` expands once x finishes, into one job
// per combination, each with its own check run; an empty matrix and bad JSON fail.
import { beforeEach, describe, expect, test } from "bun:test";
import { planWorkflow } from "@turntable/act-runner";
import {
  createAttempt,
  createJob,
  createRun,
  type Db,
  listJobs,
  setProjectChecksMode,
} from "../src/db";
import { CheckReporter, type TokenMinter } from "../src/checks/reporter";
import type { CheckRunBody, CheckRunsApi } from "../src/checks/client";
import { Scheduler } from "../src/scheduler";
import { refusalFor } from "../src/scheduler/sandbox-size";
import { previewWorkflow } from "../src/poll/workflow-preview";
import { setupChecksWorld } from "./checks-helpers";

const WORKFLOW = `on: push
jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      matrix: \${{ steps.m.outputs.matrix }}
    steps: []
  test:
    needs: changes
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: \${{ fromJSON(needs.changes.outputs.matrix) }}
    steps: []
  done:
    needs: test
    if: always()
    runs-on: ubuntu-latest
    steps: []
`;

function fakeApi() {
  const runs = new Map<string, CheckRunBody>();
  let next = 900;
  const api: CheckRunsApi = {
    async create(_t, _repo, body) {
      const id = String(next++);
      runs.set(id, { ...body });
      return id;
    },
    async update(_t, _repo, id, body) {
      runs.set(id, { ...runs.get(id), ...body });
    },
    async findByExternalId() {
      return undefined;
    },
  };
  return { api, runs };
}
const auth: TokenMinter = { mint: async () => ({ token: "t" }) };

let db: Db;
let world: Awaited<ReturnType<typeof setupChecksWorld>>;
beforeEach(async () => {
  world = await setupChecksWorld();
  db = world.db;
  await setProjectChecksMode(db, world.scope, "live");
});

async function makeRun(approvalKind?: "untrusted_author" | "environment") {
  const wp = planWorkflow(
    WORKFLOW,
    { name: "push", ref: "refs/heads/main" },
    { readFile: () => undefined },
  );
  const run = await createRun(db, world.scope, {
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    ref: "refs/heads/main",
    sha: world.sha,
    repo: "acme/web",
  });
  for (const n of wp.jobs) {
    const job = (await createJob(db, world.scope, {
      runId: run.id,
      jobKey: n.key,
      name: n.name,
      needs: n.needs,
      planned: n,
      ...(approvalKind && n.key === "test" ? { approvalKind } : {}),
    }))!;
    await createAttempt(db, world.scope, { jobId: job.id, provider: "fake" });
  }
  return run;
}

const reasons = new Map<string, string>();

async function drive(matrix: string, reporter: CheckReporter) {
  const ran: string[] = [];
  reasons.clear();
  const sched = new Scheduler({
    db,
    providers: () => ({}) as never,
    runner: async (ctx) => {
      ran.push(ctx.job.jobKey);
      // What the act runner does first with every job (see createActRunner).
      const why = refusalFor(
        ctx.job.planned ? (JSON.parse(ctx.job.planned) as { unsupported?: string }) : undefined,
        ["amd64"],
      );
      if (why) {
        reasons.set(ctx.job.jobKey, why);
        return { state: "failure", reason: why };
      }
      return ctx.job.jobKey === "changes"
        ? { state: "success", exitCode: 0, reason: "ok", outputs: { matrix } }
        : { state: "success", exitCode: 0, reason: "ok" };
    },
    observer: reporter,
    pollMs: 10,
  });
  for (let i = 0; i < 10; i++) {
    await sched.tick();
    await sched.idle();
  }
  await reporter.idle();
  return ran;
}

describe("#797 dynamic matrix at run time", () => {
  test("expands after the needed job finishes: one job and one check run per combination", async () => {
    const { api, runs } = fakeApi();
    const run = await makeRun();
    const matrix = JSON.stringify({ os: ["ubuntu-latest"], pkg: ["api", "web"] });
    const ran = await drive(matrix, new CheckReporter({ db, auth, api, sleep: async () => {} }));
    const jobs = await listJobs(db, world.scope, run.id);
    expect(jobs.map((j) => j.jobKey).sort()).toEqual(["changes", "done", "test[0]", "test[1]"]);
    expect(jobs.find((j) => j.jobKey === "test[1]")?.name).toBe("test (ubuntu-latest, web)");
    expect(jobs.every((j) => j.state === "success")).toBe(true);
    // The dependent waited for both legs: it ran last.
    expect(ran.at(-1)).toBe("done");
    expect(ran.filter((k) => k.startsWith("test[")).sort()).toEqual(["test[0]", "test[1]"]);
    const names = [...runs.values()].map((b) => `${b.name}:${b.conclusion}`).sort();
    expect(names).toEqual([
      "turntable / changes:success",
      "turntable / done:success",
      "turntable / test (ubuntu-latest, api):success",
      "turntable / test (ubuntu-latest, web):success",
    ]);
    const done = jobs.find((j) => j.jobKey === "done")!;
    expect(JSON.parse(done.needs)).toEqual(["test[0]", "test[1]"]);
  });

  test("an empty matrix fails the job, and its dependent sees the failure", async () => {
    const { api } = fakeApi();
    const run = await makeRun();
    await drive('{"include":[]}', new CheckReporter({ db, auth, api, sleep: async () => {} }));
    const jobs = await listJobs(db, world.scope, run.id);
    expect(Object.fromEntries(jobs.map((j) => [j.jobKey, j.state]))).toEqual({
      changes: "success",
      test: "failure",
      // `if: always()` runs it regardless.
      done: "success",
    });
    expect(reasons.get("test")).toBe("unsupported: Matrix vector does not contain any values");
  });

  test("invalid JSON fails the job with a clear message", async () => {
    const { api, runs } = fakeApi();
    const run = await makeRun();
    await drive("{oops", new CheckReporter({ db, auth, api, sleep: async () => {} }));
    const jobs = await listJobs(db, world.scope, run.id);
    const test = jobs.find((j) => j.jobKey === "test")!;
    expect(test.state).toBe("failure");
    expect(reasons.get("test")).toBe(
      "unsupported: strategy.matrix is not valid: fromJSON() got invalid JSON",
    );
    expect([...runs.values()].find((b) => b.name === "turntable / test")?.conclusion).toBe(
      "failure",
    );
  });

  test("a deeply nested needs output fails the job and the needed job still finishes", async () => {
    const { api } = fakeApi();
    const run = await makeRun();
    const depth = 30_000;
    const nested = `{"a":${"[".repeat(depth)}${"]".repeat(depth)}}`;
    await drive(nested, new CheckReporter({ db, auth, api, sleep: async () => {} }));
    const jobs = await listJobs(db, world.scope, run.id);
    expect(jobs.find((j) => j.jobKey === "test")!.state).toBe("failure");
    expect(reasons.get("test")).toContain("nested");
    expect(jobs.find((j) => j.jobKey !== "test" && !j.jobKey.startsWith("test["))!.state).toBe(
      "success",
    );
  });

  test("every leg keeps the placeholder's approval kind", async () => {
    for (const kind of ["untrusted_author", "environment"] as const) {
      const { api } = fakeApi();
      const run = await makeRun(kind);
      const matrix = JSON.stringify({ pkg: ["a", "b", "c"] });
      await drive(matrix, new CheckReporter({ db, auth, api, sleep: async () => {} }));
      const legs = (await listJobs(db, world.scope, run.id)).filter((j) =>
        j.jobKey.startsWith("test["),
      );
      expect(legs.length).toBe(3);
      expect(legs.map((j) => j.approvalKind)).toEqual([kind, kind, kind]);
    }
  });

  test("over 256 combinations fails the job", async () => {
    const { api } = fakeApi();
    const run = await makeRun();
    const include = Array.from({ length: 257 }, (_, i) => ({ i }));
    await drive(
      JSON.stringify({ include }),
      new CheckReporter({ db, auth, api, sleep: async () => {} }),
    );
    const jobs = await listJobs(db, world.scope, run.id);
    expect(jobs.find((j) => j.jobKey === "test")?.state).toBe("failure");
    expect(jobs.length).toBe(3);
  });
});

describe("#797 preview", () => {
  test("a job with a dynamic matrix is shown as expanded at run time, not unsupported", () => {
    const p = previewWorkflow(WORKFLOW, { defaultBranch: "main", vars: {} });
    const test = p?.jobs.find((j) => j.job_id === "test");
    expect(test).toMatchObject({ verdict: "run", reason: "expanded at run time" });
    expect(test?.fix).toBeUndefined();
  });
});
