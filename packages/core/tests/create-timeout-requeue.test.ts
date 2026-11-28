// A sandbox create that timed out (#814) is a pre-sandbox failure: requeued with backoff without
// spending the job's infra retry, up to a bounded total wait, then infra_error with a clear reason.
// "failed to resolve container IP" is a lost sandbox. Doctor shows the recent timeout rate.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import {
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  getJob,
  listAttempts,
  openDatabase,
  type Scope,
} from "../src/db";
import { checkCreateTimeouts } from "../src/doctor/checks";
import { NetworkHealth } from "../src/network";
import { type AttemptOutcome, type AttemptRunner, DrainState, Scheduler } from "../src/scheduler";
import { CreateStats, isCreateTimeout, isSandboxLostMessage } from "../src/scheduler/create-stats";
import { classifyInfra } from "../src/checks/mapping";

setDefaultTimeout(30_000);
const world = new FakeWorld();
const opened: Db[] = [];
afterAll(() => {
  world.dispose();
  for (const d of opened) d.close();
});

const timeout: AttemptOutcome = {
  state: "infra_error",
  infraKind: "sandbox_create_failed",
  reason: "Daytona request timed out (POST /sandbox)",
};
const ok: AttemptOutcome = { state: "success", reason: "" };

async function setup(maxWait?: number) {
  const db = openDatabase(":memory:");
  opened.push(db);
  const org = await createOrg(db, { slug: "org-a", name: "org-a" });
  const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "app" });
  const scope: Required<Scope> = { orgId: org.id, projectId: project.id };
  const run = await createRun(db, scope, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha: "a".repeat(40),
  });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: "build", name: "build" }))!;
  await createAttempt(db, scope, { jobId: job.id, provider: "fake" });
  const clock = { t: Date.now() };
  const sched = (runner: AttemptRunner) =>
    new Scheduler({
      db,
      runner,
      providers: () => world.provider(),
      globalCap: 5,
      perOrgCap: 5,
      drain: new DrainState(),
      network: new NetworkHealth({ probe: async () => ({ ok: true, targets: [] }) }),
      infraRetryBackoffMs: 0,
      now: () => clock.t,
      ...(maxWait !== undefined ? { createTimeoutMaxWaitMs: maxWait } : {}),
    });
  const drive = async (s: Scheduler) => {
    for (let i = 0; i < 12; i++) {
      const n = await s.tick();
      await s.idle();
      if (n === 0) break;
    }
  };
  return { db, scope, job, clock, sched, drive };
}

describe("create timeout requeue", () => {
  test("a create timeout is requeued without using the infra retry, then the job runs", async () => {
    const t = await setup();
    const outcomes = [timeout, timeout, ok];
    let n = 0;
    const s = t.sched(async (ctx) => {
      await ctx.store.setTrustClass("protected").catch(() => undefined);
      return outcomes[n++]!;
    });
    await t.drive(s);
    const all = await listAttempts(t.db, t.scope, t.job.id);
    expect(all.map((a) => a.state)).toEqual(["infra_error", "infra_error", "success"]);
    expect(all[0]!.errorClass).toStartWith("sandbox_create_timeout");
    expect(all[0]!.infraKind).toBeNull();
    expect(all[1]!.infraKind).toBeNull();
  });

  test("a lost sandbox at create (failed to resolve container IP) is requeued too", async () => {
    const t = await setup();
    const lost: AttemptOutcome = {
      state: "infra_error",
      infraKind: "sandbox_create_failed",
      reason:
        "Daytona 400: failed to resolve container IP after 3 attempts. Is the Sandbox started?",
    };
    const outcomes = [lost, ok];
    let n = 0;
    const s = t.sched(async () => outcomes[n++]!);
    await t.drive(s);
    const all = await listAttempts(t.db, t.scope, t.job.id);
    expect(all.map((a) => a.state)).toEqual(["infra_error", "success"]);
    expect(all[0]!.errorClass).toStartWith("sandbox_create_timeout");
  });

  test("past the total wait the job ends infra_error with a clear reason", async () => {
    const t = await setup(1);
    t.clock.t += 0;
    let n = 0;
    const s = t.sched(async () => {
      t.clock.t += 5_000; // each create burns time on the clock
      n++;
      return timeout;
    });
    await t.drive(s);
    expect(n).toBeGreaterThanOrEqual(1);
    const job = await getJob(t.db, t.scope, t.job.id);
    expect(job?.state).toBe("infra_error");
    const all = await listAttempts(t.db, t.scope, t.job.id);
    expect(all.at(-1)!.errorClass ?? "").not.toStartWith("sandbox_create_timeout");
  });

  test("a failure that is not a timeout keeps the old path", async () => {
    const t = await setup();
    const other: AttemptOutcome = {
      state: "infra_error",
      infraKind: "sandbox_create_failed",
      reason: "Daytona rejected the key",
    };
    const outcomes = [other, ok];
    let n = 0;
    const s = t.sched(async () => outcomes[n++]!);
    await t.drive(s);
    const all = await listAttempts(t.db, t.scope, t.job.id);
    expect(all[0]!.infraKind).toBe("sandbox_create_failed");
  });
});

describe("classification and rate", () => {
  test("message classifiers", () => {
    expect(isCreateTimeout("request timed out")).toBe(true);
    expect(isCreateTimeout("Daytona sandbox did not start within 180000 ms (creating)")).toBe(true);
    expect(isCreateTimeout("key rejected")).toBe(false);
    expect(isSandboxLostMessage("failed to resolve container IP: no IP address found")).toBe(true);
    expect(classifyInfra("Daytona 400: failed to resolve container IP")).toBe("exec_lost");
  });

  test("doctor shows the recent create-timeout rate per provider", () => {
    const clock = { t: 1_000_000 };
    const stats = new CreateStats(() => clock.t);
    expect(checkCreateTimeouts(stats).status).toBe("pass");
    for (const to of [true, true, false, false]) stats.record("daytona", to);
    const c = checkCreateTimeouts(stats);
    expect(c.status).toBe("warn");
    expect(c.summary).toContain("daytona 2/4 (50%)");
    clock.t += 2 * 60 * 60_000; // older than the hour window
    expect(checkCreateTimeouts(stats).summary).toContain("no sandbox create");
  });
});
