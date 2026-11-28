import { beforeEach, expect, test } from "bun:test";
import {
  addCut,
  addNotice,
  createAttempt,
  createJob,
  createProject,
  createRun,
  type Db,
  setRunStatus,
  transitionJob,
  upsertStep,
} from "../src/db";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { waiterLimits, waitingCount } from "../src/ops/definitions/events";
import { createRestApi } from "../src/ops/rest";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let token: string;
let env: DispatchEnv;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  env = { registry, db };
  token = (await mintToken(db, { orgId: a.orgId }, "reader")).secret;
});

async function run<T = any>(op: string, input: unknown = {}, tok = token): Promise<T> {
  const res = await dispatch(env, { kind: "bearer", token: tok }, op, input);
  if (!res.ok) throw new Error(`${op}: ${res.error.code} ${res.error.message}`);
  return res.output as T;
}

test("events: ordered feed, cursor continuation, type filter, limit", async () => {
  await transitionJob(db, a.scope, a.jobId, "running");
  await setRunStatus(db, a.scope, a.runId, "running");
  const all = await run("events");
  expect(all.events.map((e: { type: string }) => e.type)).toEqual([
    "run.queued",
    "job.state_changed",
    "run.started",
  ]);
  expect(all.events[0]).toMatchObject({ project: "app", run_id: a.runId, job_id: null });
  expect(all.events[1]).toMatchObject({
    job_id: a.jobId,
    payload: { from: "queued", to: "running" },
  });
  expect(all.next_after).toBe(all.events[2].cursor);
  const cursors = all.events.map((e: { cursor: number }) => e.cursor);
  expect(cursors).toEqual(cursors.toSorted((x: number, y: number) => x - y));

  // continue from the cursor: nothing new, and the cursor is unchanged
  const none = await run("events", { after: all.next_after });
  expect(none).toEqual({ events: [], next_after: all.next_after });

  await transitionJob(db, a.scope, a.jobId, "success", { exitCode: 0 });
  const more = await run("events", { after: all.next_after });
  expect(more.events).toHaveLength(1);
  expect(more.events[0].payload).toMatchObject({ to: "success", exit_code: 0 });

  // resuming from any saved cursor replays exactly what followed it
  const replay = await run("events", { after: all.events[0].cursor });
  expect(replay.events.map((e: { type: string }) => e.type)).toEqual([
    "job.state_changed",
    "run.started",
    "job.state_changed",
  ]);

  expect((await run("events", { types: ["run.started"] })).events).toHaveLength(1);
  expect((await run("events", { types: ["run.started", "run.queued"] })).events).toHaveLength(2);
  const page = await run("events", { limit: 2 });
  expect(page.events).toHaveLength(2);
  expect((await run("events", { after: page.next_after, limit: 10 })).events).toHaveLength(2);
});

test("events: tenant and project scoping", async () => {
  const other = await createProject(db, { orgId: a.orgId }, { slug: "other", name: "other" });
  const otherRun = await createRun(
    db,
    { orgId: a.orgId, projectId: other.id },
    { workflowPath: "w", event: "push", ref: "main" },
  );
  await transitionJob(db, b.scope, b.jobId, "running");

  const orgWide = await run("events");
  expect(orgWide.events.map((e: { run_id: string }) => e.run_id).toSorted()).toEqual(
    [a.runId, otherRun.id].toSorted(),
  );
  expect(orgWide.events.every((e: { run_id: string }) => e.run_id !== b.runId)).toBe(true);

  const pinned = (await mintToken(db, a.scope, "reader")).secret;
  const mine = await run("events", {}, pinned);
  expect(mine.events.map((e: { run_id: string }) => e.run_id)).toEqual([a.runId]);
  const narrowed = await run("events", { project: "other" });
  expect(narrowed.events.map((e: { run_id: string }) => e.run_id)).toEqual([otherRun.id]);
  const out = await dispatch(env, { kind: "bearer", token: pinned }, "events", {
    project: "other",
  });
  expect(!out.ok && out.error.code).toBe("not_found");
  const cross = await dispatch(env, { kind: "bearer", token }, "events", { org: b.slug });
  expect(!cross.ok && cross.error.code).toBe("not_found");
});

test("events: long-poll returns as soon as an event lands, and times out empty", async () => {
  const cursor = (await run("events")).next_after;

  const started = Date.now();
  const waiting = run("events", { after: cursor, wait_ms: 5000 });
  await Bun.sleep(80);
  expect(waitingCount()).toBe(1);
  await transitionJob(db, a.scope, a.jobId, "running");
  const got = await waiting;
  expect(got.events).toHaveLength(1);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(waitingCount()).toBe(0);

  const t0 = Date.now();
  const empty = await run("events", { after: got.next_after, wait_ms: 200 });
  expect(empty).toEqual({ events: [], next_after: got.next_after });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(180);
  expect(waitingCount()).toBe(0);
});

test("events: another org's events and non-matching types do not end the wait", async () => {
  const cursor = (await run("events")).next_after;
  const t0 = Date.now();
  const waiting = run("events", { after: cursor, wait_ms: 400, types: ["run.finished"] });
  await Bun.sleep(50);
  await transitionJob(db, b.scope, b.jobId, "running"); // other org
  await transitionJob(db, a.scope, a.jobId, "running"); // other type
  const res = await waiting;
  expect(res.events).toEqual([]);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(380);
  // a matching event does end it
  const again = run("events", { after: cursor, wait_ms: 3000, types: ["run.finished"] });
  await Bun.sleep(50);
  await setRunStatus(db, a.scope, a.runId, "success");
  expect((await again).events.map((e: { type: string }) => e.type)).toEqual(["run.finished"]);
});

test("events: a rolled-back change never wakes or reaches a waiter", async () => {
  const cursor = (await run("events")).next_after;
  const waiting = run("events", { after: cursor, wait_ms: 300 });
  await Bun.sleep(30);
  await expect(
    db.transaction(async (tx) => {
      await transitionJob(tx, a.scope, a.jobId, "running");
      throw new Error("rollback");
    }),
  ).rejects.toThrow();
  expect((await waiting).events).toEqual([]);
});

test("events: the number of concurrent waiters is capped", async () => {
  const saved = { ...waiterLimits };
  waiterLimits.perOrg = 1000; // this test is about the global cap
  const cursor = (await run("events")).next_after;
  const waiters = Array.from({ length: waiterLimits.global }, () =>
    run("events", { after: cursor, wait_ms: 3000 }),
  );
  // Wait for registration instead of a fixed sleep: under CPU load the waiters
  // can take longer than 100 ms to park.
  for (let i = 0; i < 400 && waitingCount() < waiterLimits.global; i++) await Bun.sleep(25);
  expect(waitingCount()).toBe(waiterLimits.global);
  const t0 = Date.now();
  const over = await run("events", { after: cursor, wait_ms: 15000 });
  expect(over.events).toEqual([]);
  expect(Date.now() - t0).toBeLessThan(10_000); // returned at once instead of waiting 15 s
  await Promise.all(waiters);
  expect(waitingCount()).toBe(0);
  Object.assign(waiterLimits, saved);
}, 30_000);

test("job_steps and job_cuts: contents, attempts, empty cases, tenancy", async () => {
  expect(await run("job_steps", { job_id: a.jobId })).toEqual({
    job_id: a.jobId,
    attempt: 1,
    waiting_reason: null,
    queued_ms_by_reason: {},
    cancel_reason: null,
    log_incomplete: false,
    steps: [],
  });
  expect(await run("job_cuts", { job_id: a.jobId })).toEqual({
    job_id: a.jobId,
    attempt: 1,
    cuts: [],
    notices: [],
  });

  await upsertStep(db, a.scope, {
    attemptId: a.attemptId,
    stepKey: "checkout",
    stage: "main",
    index: 1,
    name: "Checkout",
    startedAt: 1000,
    finishedAt: 3500,
    result: "success",
    logOffset: 120,
  });
  await upsertStep(db, a.scope, {
    attemptId: a.attemptId,
    stepKey: "setup",
    stage: "pre",
    index: 0,
    name: "Set up job",
    logOffset: 0,
  });
  await addCut(db, a.scope, {
    attemptId: a.attemptId,
    atOffset: 4096,
    omittedBytes: 9000,
    reason: "head-cap",
  });

  const steps = await run("job_steps", { job_id: a.jobId });
  // A cut makes the log incomplete, on job_steps and on every get_run attempt of that attempt.
  expect(steps.log_incomplete).toBe(true);
  const gr = await run("get_run", { run_id: a.runId });
  expect(gr.jobs.find((x: { id: string }) => x.id === a.jobId).attempts[0].log_incomplete).toBe(
    true,
  );
  expect(steps.steps.map((s: { key: string }) => s.key)).toEqual(["setup", "checkout"]);
  expect(steps.steps[1]).toMatchObject({
    stage: "main",
    result: "success",
    duration_ms: 2500,
    log_offset: 120,
  });
  expect(steps.steps[0]).toMatchObject({ result: null, started_at: null, duration_ms: null });
  // A system notice is recorded apart from the log and comes back next to the cuts.
  await addNotice(db, a.scope, {
    attemptId: a.attemptId,
    source: "cache",
    text: "cache: 2 entries dropped (denied paths)",
  });
  expect(await run("job_cuts", { job_id: a.jobId })).toEqual({
    job_id: a.jobId,
    attempt: 1,
    cuts: [{ at_offset: 4096, omitted_bytes: 9000, reason: "head-cap" }],
    notices: [{ at_offset: 0, source: "cache", text: "cache: 2 entries dropped (denied paths)" }],
  });

  // a second attempt starts empty; the first stays addressable
  const second = (await createAttempt(db, a.scope, { jobId: a.jobId, provider: "p" }))!;
  expect((await run("job_steps", { job_id: a.jobId })).steps).toEqual([]);
  expect((await run("job_steps", { job_id: a.jobId })).log_incomplete).toBe(false);
  expect((await run("job_steps", { job_id: a.jobId, attempt: 1 })).steps).toHaveLength(2);
  expect((await run("job_cuts", { job_id: a.jobId, attempt: 2 })).cuts).toEqual([]);
  expect(second.attempt).toBe(2);
  const missing = await dispatch(env, { kind: "bearer", token }, "job_steps", {
    job_id: a.jobId,
    attempt: 9,
  });
  expect(!missing.ok && missing.error.code).toBe("not_found");

  // a job with no attempt yet
  const j = (await createJob(db, a.scope, { runId: a.runId, jobKey: "x", name: "x" }))!;
  expect(await run("job_steps", { job_id: j.id })).toEqual({
    job_id: j.id,
    attempt: null,
    waiting_reason: null,
    queued_ms_by_reason: {},
    cancel_reason: null,
    log_incomplete: false,
    steps: [],
  });

  // another org cannot read them
  for (const op of ["job_steps", "job_cuts"]) {
    const bTok = (await mintToken(db, { orgId: b.orgId }, "reader")).secret;
    const res = await dispatch(env, { kind: "bearer", token: bTok }, op, { job_id: a.jobId });
    expect(!res.ok && res.error.code).toBe("not_found");
  }
});

test("REST: events query string carries types as a comma list and long-polls", async () => {
  const api = createRestApi(env);
  const get = (path: string) =>
    api(new Request(`http://x/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } }))!;
  await transitionJob(db, a.scope, a.jobId, "running");
  const res = (await get("/events?types=run.queued,job.state_changed&limit=10"))!;
  expect(res.status).toBe(200);
  expect(res.headers.get("x-turntable-untrusted-content")).toBe("true");
  const body = (await res.json()) as { events: { type: string }[]; next_after: number };
  expect(body.events.map((e) => e.type)).toEqual(["run.queued", "job.state_changed"]);
  const bad = (await get("/events?types=nope"))!;
  expect(bad.status).toBe(400);
  const poll = get(`/events?after=${body.next_after}&wait_ms=3000`);
  await Bun.sleep(50);
  await setRunStatus(db, a.scope, a.runId, "running");
  const polled = (await (await poll)!.json()) as { events: { type: string }[] };
  expect(polled.events.map((e) => e.type)).toEqual(["run.started"]);
  expect((await get(`/jobs/${a.jobId}/steps`))!.status).toBe(200);
  expect((await get(`/jobs/${a.jobId}/cuts`))!.status).toBe(200);
});

test('events: after "now" returns nothing and starts at the tip; numeric cursors still work over REST', async () => {
  await transitionJob(db, a.scope, a.jobId, "running");
  const all = await run("events");
  const tip = await run("events", { after: "now" });
  expect(tip).toEqual({ events: [], next_after: all.next_after });

  // Org scoped: another org's events do not move this org's tip.
  const none = await run("events", { after: "now", types: ["run.finished"] });
  expect(none.next_after).toBe(all.next_after);

  // A subscriber that starts at the tip sees only what comes next.
  await setRunStatus(db, a.scope, a.runId, "running");
  const next = await run("events", { after: tip.next_after });
  expect(next.events.map((e: { type: string }) => e.type)).toEqual(["run.started"]);

  // Empty feed: tip is 0.
  const fresh = await mintToken(db, { orgId: b.orgId }, "reader");
  const bTip = await run("events", { after: "now" }, fresh.secret);
  expect(bTip.events).toEqual([]);
  expect(bTip.next_after).toBeGreaterThan(0); // org b has its own seeded events

  const api = createRestApi(env);
  const get = (path: string) =>
    api(new Request(`http://x/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } }))!;
  const viaRest = (await (await get("/events?after=now"))!.json()) as {
    events: unknown[];
    next_after: number;
  };
  expect(viaRest).toEqual({ events: [], next_after: next.next_after });
  const numeric = (await (await get(`/events?after=${all.next_after}`))!.json()) as {
    events: { type: string }[];
  };
  expect(numeric.events.map((e) => e.type)).toEqual(["run.started"]);
  expect((await get("/events?after=later"))!.status).toBe(400);
  expect((await get("/events?after=-1"))!.status).toBe(400);
});
