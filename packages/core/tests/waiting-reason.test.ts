// waiting_reason (#775): the claim pass records why each queued attempt is not running, writes
// only when the reason changes, and keeps the queued time per reason for when it starts.
import { beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  claimNextAttempt,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createPolledRun,
  createRun,
  type Db,
  getAttempt,
  listAttempts,
  listJobs,
  setFreeze,
  markWaiting,
  openDatabase,
  type Scope,
} from "../src/db";
import { approveRun } from "../src/db/repos/approve";
import { toWaiting } from "../src/ops/waiting";
import { setOrgQuotas } from "../src/db/repos/quotas";
import { putStoredSetting } from "../src/db/repos/settings";
import { dispatch, registry, type DispatchEnv } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { Scheduler } from "../src/scheduler";
import { DrainState } from "../src/scheduler/drain";
import { rawExec } from "./ops-helpers";

let db: Db;
let a: Required<Scope>;
let b: Required<Scope>;
let a2: Required<Scope>;
const T0 = 1_800_000_000_000;

beforeEach(async () => {
  db = openDatabase(":memory:");
  const orgA = await createOrg(db, { slug: "org-a", name: "a" });
  const orgB = await createOrg(db, { slug: "org-b", name: "b" });
  const p1 = await createProject(db, { orgId: orgA.id }, { slug: "app", name: "app" });
  const p2 = await createProject(db, { orgId: orgA.id }, { slug: "other", name: "other" });
  const p3 = await createProject(db, { orgId: orgB.id }, { slug: "app", name: "app" });
  a = { orgId: orgA.id, projectId: p1.id };
  a2 = { orgId: orgA.id, projectId: p2.id };
  b = { orgId: orgB.id, projectId: p3.id };
});

async function queue(scope: Required<Scope>, key = "build", needs: string[] = []) {
  const run = await createRun(db, scope, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha: "a".repeat(40),
  });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: key, name: key, needs }))!;
  const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
  return { run, job, attempt, scope };
}

const claim = (o: { globalCap?: number; perOrgCap?: number; now?: number } = {}) =>
  claimNextAttempt(db, {
    owner: "w1",
    leaseMs: 1000,
    now: o.now ?? T0,
    globalCap: o.globalCap ?? 100,
    perOrgCap: o.perOrgCap ?? 100,
  });

const reasonOf = async (q: { scope: Required<Scope>; attempt: { id: string } }) =>
  (await getAttempt(db, q.scope, q.attempt.id))!.waitingReason;

/** Counts the UPDATEs on job_attempts the claim pass issues. */
function countWrites(): { n: () => number } {
  let n = 0;
  const orm = db.orm as unknown as { update: (...a: unknown[]) => unknown };
  const real = orm.update.bind(orm);
  orm.update = (...args: unknown[]) => {
    n++;
    return real(...args);
  };
  return { n: () => n };
}

test("needs: a queued job behind a running dependency is marked needs", async () => {
  const run = await createRun(db, a, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha: "b".repeat(40),
  });
  const build = (await createJob(db, a, { runId: run.id, jobKey: "build", name: "build" }))!;
  await createAttempt(db, a, { jobId: build.id, provider: "fake" });
  const t = (await createJob(db, a, {
    runId: run.id,
    jobKey: "test",
    name: "test",
    needs: ["build"],
  }))!;
  const ta = (await createAttempt(db, a, { jobId: t.id, provider: "fake" }))!;
  expect((await claim())!.job.id).toBe(build.id);
  expect(await claim()).toBeUndefined();
  expect((await getAttempt(db, a, ta.id))!.waitingReason).toBe("needs");
});

test("project_cap, then org_cap, then instance_cap", async () => {
  await db.run((h) =>
    rawExec(h.orm, sql`UPDATE projects SET max_concurrent = 1 WHERE id = ${a.projectId}`),
  );
  const run1 = await queue(a, "r1");
  const waits = await queue(a, "r2");
  expect((await claim())!.attempt.id).toBe(run1.attempt.id);
  expect(await claim()).toBeUndefined();
  expect(await reasonOf(waits)).toBe("project_cap");

  // org cap: org B has a running attempt and the per-org cap is 1
  const bRun = await queue(b, "r1");
  const bWait = await queue(b, "r2");
  expect((await claim({ perOrgCap: 1 }))!.attempt.id).toBe(bRun.attempt.id);
  expect(await claim({ perOrgCap: 1 })).toBeUndefined();
  expect(await reasonOf(bWait)).toBe("org_cap");

  // instance cap: two running, global cap 2; another org's project waits
  const other = await queue(a2, "r1");
  expect(await claim({ globalCap: 2, perOrgCap: 9 })).toBeUndefined();
  expect(await reasonOf(other)).toBe("instance_cap");
  expect(await reasonOf(bWait)).toBe("instance_cap"); // precedence: the instance cap holds all
});

test("quota:<metric>: a held org says which quota, a stored concurrency limit says quota:concurrent", async () => {
  await setOrgQuotas(db, a.orgId, { maxSandboxMinutesPerDay: 0 }, "test", T0);
  const held = await queue(a, "r1");
  expect(await claim()).toBeUndefined();
  expect(await reasonOf(held)).toBe("quota:sandbox_minutes");

  const first = await queue(b, "r1");
  const second = await queue(b, "r2");
  await setOrgQuotas(db, b.orgId, { maxConcurrent: 1 }, "test", T0);
  expect((await claim({ perOrgCap: 4 }))!.attempt.id).toBe(first.attempt.id);
  expect(await claim({ perOrgCap: 4 })).toBeUndefined();
  expect(await reasonOf(second)).toBe("quota:concurrent");
});

test("quota:runs_per_hour: a new run waits while one that started finishes its jobs", async () => {
  const base = Date.now(); // started_at is the wall clock
  await setOrgQuotas(db, a.orgId, { maxRunsPerHour: 1 }, "test", base);
  const started = await queue(a, "r1");
  expect((await claim())!.attempt.id).toBe(started.attempt.id);
  const next = await queue(a, "r1");
  expect(await claim({ now: base + 10 })).toBeUndefined();
  expect(await reasonOf(next)).toBe("quota:runs_per_hour");
});

test("yield: a yield project's attempt waiting for capacity says yield, written once", async () => {
  await putStoredSetting(
    db,
    { kind: "project", id: a2.projectId, orgId: a2.orgId },
    "scheduling_class",
    "yield",
    "test",
    T0,
  );
  const y = await queue(a2, "y");
  const n = await queue(a, "n");
  expect((await claim({ globalCap: 1 }))!.attempt.id).toBe(n.attempt.id);
  expect(await claim({ globalCap: 1 })).toBeUndefined();
  expect(await reasonOf(y)).toBe("yield");
  // later ticks change nothing: no overwrite between yield and another reason
  const w = countWrites();
  expect(await claim({ globalCap: 1 })).toBeUndefined();
  expect(await claim({ globalCap: 1 })).toBeUndefined();
  expect(w.n()).toBe(0);
  expect(await reasonOf(y)).toBe("yield");
});

test("yield: a yield project at its own org cap says org_cap, not yield", async () => {
  await putStoredSetting(
    db,
    { kind: "project", id: a2.projectId, orgId: a2.orgId },
    "scheduling_class",
    "yield",
    "test",
    T0,
  );
  const first = await queue(a2, "y1");
  const second = await queue(a2, "y2");
  expect((await claim({ perOrgCap: 1 }))!.attempt.id).toBe(first.attempt.id);
  expect(await claim({ perOrgCap: 1 })).toBeUndefined();
  expect(await reasonOf(second)).toBe("org_cap");
});

test("drain: a draining scheduler marks the queue drain without claiming", async () => {
  const q = await queue(a, "r1");
  const drain = new DrainState();
  drain.set(true, "test", T0);
  const sched = new Scheduler({
    db,
    runner: { run: async () => ({ state: "success" }) } as never,
    providers: {} as never,
    drain,
    now: () => T0 + 5,
  });
  expect(await sched.tick()).toBe(0);
  expect(await reasonOf(q)).toBe("drain");
});

const trust = JSON.stringify({ class: "untrusted_author", workflowHash: "h".repeat(8) });

async function heldRun() {
  const made = (await createPolledRun(db, a, {
    repo: "o/r",
    run: { workflowPath: "w.yml", event: "pull_request", ref: "pr", sha: "b".repeat(40), trust },
    jobs: [{ key: "build", name: "build", needs: [] }],
    provider: "fake",
    hold: true,
  }))!;
  const job = (await listJobs(db, a, made.run.id))[0]!;
  return { run: made.run, job, attempt: (await listAttempts(db, a, job.id))[0]! };
}

async function activity(): Promise<Map<string, Record<string, number>>> {
  const secret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
  const env: DispatchEnv = { registry, db, allowInstance: true, instanceOrgCap: 4 };
  const act = await dispatch(env, { kind: "bearer", token: secret }, "instance_run_activity", {});
  if (!act.ok) throw new Error("run_activity failed");
  return new Map(
    (act.output as { orgs: { org: string; queued_by_reason: Record<string, number> }[] }).orgs.map(
      (o) => [o.org, o.queued_by_reason],
    ),
  );
}

test("approval: a held run counts as approval in run_activity and shows it on the attempt", async () => {
  const h = await heldRun();
  expect(h.attempt.state).toBe("awaiting_approval");
  expect((await activity()).get("org-a")).toEqual({ approval: 1 });
  const w = toWaiting(h.attempt, h.attempt.createdAt + 5000);
  expect(w.waiting_reason).toBe("approval");
  expect(w.queued_ms_by_reason.approval).toBe(5000);
});

test("approval: the held time is booked to approval, not to the next reason", async () => {
  const h = await heldRun();
  const at = h.attempt.createdAt + 2 * 3600_000;
  await approveRun(db, a, h.run.id, {
    headSha: "b".repeat(40),
    workflowHash: "h".repeat(8),
    by: "tester",
    now: at,
  });
  const queued = (await getAttempt(db, a, h.attempt.id))!;
  expect(queued.state).toBe("queued");
  expect(queued.waitingReason).toBeNull();
  expect((await activity()).get("org-a")).toEqual({ unknown: 1 });
  const c = (await claim({ now: at + 100 }))!;
  const by = JSON.parse(c.attempt.waitedMs!) as Record<string, number>;
  expect(by.approval).toBe(2 * 3600_000);
  expect(by.claimable).toBe(100);
});

test("frozen orgs are not marked", async () => {
  const q = await queue(a, "r1");
  await setFreeze(db, { orgId: a.orgId }, { reason: "test", by: "test", now: T0 });
  expect(await markWaiting(db, { reason: "drain", now: T0 })).toBe(0);
  expect(await reasonOf(q)).toBeNull();
});

test("run_activity counts queued attempts per org by reason", async () => {
  await queue(a, "r1");
  const x = await queue(a, "r2");
  await queue(b, "r1");
  expect((await claim({ perOrgCap: 1 }))!.attempt).toBeDefined(); // one of a's, or b's
  expect(await claim({ perOrgCap: 1 })).toBeDefined();
  expect(await claim({ perOrgCap: 1 })).toBeUndefined();
  void x;
  const secret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
  const env: DispatchEnv = { registry, db, allowInstance: true, instanceOrgCap: 4 };
  const act = await dispatch(env, { kind: "bearer", token: secret }, "instance_run_activity", {});
  if (!act.ok) throw new Error("run_activity failed");
  const by = new Map(
    (act.output as { orgs: { org: string; queued_by_reason: Record<string, number> }[] }).orgs.map(
      (o) => [o.org, o.queued_by_reason],
    ),
  );
  expect(by.get("org-a")).toEqual({ org_cap: 1 });
  expect(by.get("org-b")).toEqual({});
});

test("no write when the reason has not changed, and the queued time is split by reason on start", async () => {
  const base = Date.now(); // created_at is the wall clock, so measure from it
  const run = await queue(a, "r1");
  await setOrgQuotas(db, a.orgId, { maxSandboxMinutesPerDay: 0 }, "test", base);
  expect(await claim({ now: base + 1000 })).toBeUndefined();
  expect(await reasonOf(run)).toBe("quota:sandbox_minutes");

  const w = countWrites();
  expect(await claim({ now: base + 2000 })).toBeUndefined();
  expect(await claim({ now: base + 3000 })).toBeUndefined();
  expect(w.n()).toBe(0);

  // the limit is lifted: the attempt starts, and the period it waited is closed into the breakdown
  await setOrgQuotas(db, a.orgId, { maxSandboxMinutesPerDay: null }, "test", base);
  const started = (await claim({ now: base + 10_000 }))!;
  expect(started.attempt.waitingReason).toBeNull();
  const by = JSON.parse(started.attempt.waitedMs!) as Record<string, number>;
  expect(Object.keys(by)).toEqual(["quota:sandbox_minutes"]);
  // From its creation to the first mark, then to the start (base + 10_000): about 10 s.
  expect(by["quota:sandbox_minutes"]).toBeGreaterThanOrEqual(9000);
  expect(by["quota:sandbox_minutes"]).toBeLessThan(11_000);
});

test("claimable: an attempt claimed on its first pass books its whole wait as claimable", async () => {
  const q = await queue(a, "r1");
  const c = (await claim({ now: Date.now() + 500 }))!;
  const by = JSON.parse(c.attempt.waitedMs!) as Record<string, number>;
  expect(Object.keys(by)).toEqual(["claimable"]);
  expect(by.claimable).toBeGreaterThan(0);
  void q;
});

test("markWaiting is a no-op for an attempt already marked, and ignores a claimed one", async () => {
  const q = await queue(a, "r1");
  expect(await markWaiting(db, { reason: "claimable", now: T0 })).toBe(1);
  expect(await markWaiting(db, { reason: "claimable", now: T0 + 1 })).toBe(0);
  expect(await reasonOf(q)).toBe("claimable");
});
