// Rerun: puts finished jobs of a run back in the queue with a new attempt. Part of the only code
// that names tenant tables. It is the one explicit way out of a finished state; the transition
// table still forbids implicit ones (a `failure` is never retried on its own).
import { and, eq } from "drizzle-orm";
import type { Db } from "..";
import { aggregateRunStatus, FINISHED_STATES } from "../job-state";
import * as s from "../schema";
import type { JobState } from "../schema";
import { appendEvent } from "./events";
import { DEPENDENCY_SKIP_PREFIX } from "./readiness";
import { listRunAttempts } from "./api";
import { createAttempt, getRun, type Job, listAttempts, listJobs, type Run } from "./index";
import { type Scope, scoped } from "./scope";
import { HELD_FOR_APPROVAL } from "./waiting";

/** Reruns allowed per job key on one commit. The limit is the point: it stops retry loops. */
export const MAX_RERUNS_PER_JOB_PER_SHA = 2;

/**
 * Reruns allowed per job key on one commit after `infra_error` attempts. Those do not use the
 * budget above (an unhealthy instance must not cost a customer their retries), but a job that
 * keeps failing as infra is still bounded.
 */
export const MAX_INFRA_RERUNS_PER_JOB_PER_SHA = 5;

export class RerunError extends Error {
  readonly code:
    "unknown_job" | "not_finished" | "never_ran" | "limit" | "nothing_to_rerun" | "conflict";
  constructor(code: RerunError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export type RerunResult = {
  run: Run;
  reruns: {
    job: Job;
    attempt: number;
    previousState: JobState;
    /** `queued`, or `awaiting_approval` when the job needs a human before it may run. */
    state: JobState;
    /** Job-outcome reruns used for this job key on this commit (infra reruns are not counted). */
    rerunsUsed: number;
  }[];
};

/** Reruns already made of a job key on this commit (or in this run when it has no sha). */
type RerunCounts = { user: number; infra: number };

/**
 * An attempt is infra-caused when it ended in `infra_error`, or it never started (skipped or
 * cancelled) because a dependency ended in `infra_error`. Neither is the user's fault, so a rerun
 * that replaces one uses the infra budget.
 */
export function isInfraCaused(a: {
  state: string;
  errorClass: string | null;
  startedAt: number | null;
}): boolean {
  if (a.state === "infra_error") return true;
  return (
    (a.state === "skipped" || a.state === "cancelled") &&
    a.startedAt === null &&
    a.errorClass === `${DEPENDENCY_SKIP_PREFIX}infra_error`
  );
}

/**
 * A rerun counts against the infra budget when the attempt it replaced was infra-caused (the
 * instance's fault), and against the user budget otherwise.
 */
async function rerunsUsed(db: Db, scope: Scope, run: Run, jobKey: string): Promise<RerunCounts> {
  const rows = await db.orm
    .select({
      jobId: s.jobAttempts.jobId,
      attempt: s.jobAttempts.attempt,
      state: s.jobAttempts.state,
      errorClass: s.jobAttempts.errorClass,
      startedAt: s.jobAttempts.startedAt,
      rerunReason: s.jobAttempts.rerunReason,
    })
    .from(s.jobAttempts)
    .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
    .innerJoin(s.runs, eq(s.runs.id, s.jobs.runId))
    .where(
      scoped(
        scope,
        { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
        eq(s.jobs.jobKey, jobKey),
        run.sha === null ? eq(s.runs.id, run.id) : eq(s.runs.sha, run.sha),
      ),
    );
  const prev = new Map<string, (typeof rows)[number]>();
  for (const r of rows) prev.set(`${r.jobId}:${r.attempt}`, r);
  const counts: RerunCounts = { user: 0, infra: 0 };
  for (const r of rows) {
    if (r.rerunReason === null) continue;
    const replaced = prev.get(`${r.jobId}:${r.attempt - 1}`);
    if (replaced && isInfraCaused(replaced)) counts.infra++;
    else counts.user++;
  }
  return counts;
}

/**
 * Reruns `jobs` of a run: `"failed"` means every job in failure or infra_error. Each selected
 * job goes back to `queued` with a new attempt carrying `reason`. All or nothing: any refusal
 * (unknown key, job still active, a job that never ran and needs approval, cap reached) changes
 * nothing.
 *
 * A rerun never bypasses approval: a job with an `approval_kind` goes to `awaiting_approval`
 * whatever its previous state (approval is per attempt), and one that never started (skipped, or
 * cancelled before it started) is refused if it needs approval at all. Returns undefined when the run
 * is not in scope. Executing the queued attempts is the scheduler's job, not this function's.
 */
export function rerunJobs(
  db: Db,
  scope: Scope,
  input: { runId: string; jobs: "failed" | readonly string[]; reason: string },
): Promise<RerunResult | undefined> {
  return db.transaction(async (h) => {
    const run = await getRun(h, scope, input.runId);
    if (!run) return undefined;
    const all = await listJobs(h, scope, run.id);

    let selected: Job[];
    if (input.jobs === "failed") {
      selected = all.filter((j) => j.state === "failure" || j.state === "infra_error");
      if (selected.length === 0) {
        throw new RerunError("nothing_to_rerun", "no failed jobs to rerun in this run");
      }
    } else {
      const byKey = new Map(all.map((j) => [j.jobKey, j]));
      const unknown = input.jobs.filter((k) => !byKey.has(k));
      if (unknown.length > 0) {
        throw new RerunError("unknown_job", `no such job in this run: ${unknown.join(", ")}`);
      }
      selected = [...new Set(input.jobs)].map((k) => byKey.get(k)!);
    }
    for (const job of selected) {
      if (!FINISHED_STATES.includes(job.state as JobState)) {
        throw new RerunError("not_finished", `job ${job.jobKey} is ${job.state}, not finished`);
      }
    }
    // Jobs skipped only because a dependency failed come back with it (transitively), so a rerun
    // of the failed job can finish the run. A job a filter skipped (`if:`) stays skipped.
    const auto = new Set<string>();
    const attempts = await listRunAttempts(h, scope, run.id);
    const latestClass = (jobId: string): string | null =>
      attempts.filter((a) => a.jobId === jobId).at(-1)?.errorClass ?? null;
    for (let grew = true; grew;) {
      grew = false;
      const keys = new Set(selected.map((j) => j.jobKey));
      for (const job of all) {
        if (keys.has(job.jobKey) || (job.state !== "skipped" && job.state !== "cancelled"))
          continue;
        if (!latestClass(job.id)?.startsWith(DEPENDENCY_SKIP_PREFIX)) continue;
        if ((JSON.parse(job.needs) as string[]).some((k) => keys.has(k))) {
          selected.push(job);
          auto.add(job.id);
          grew = true;
        }
      }
    }
    for (const job of selected) {
      if (auto.has(job.id)) continue; // dependents of a rerun job: gated ones wait for approval
      const neverRan =
        (job.state === "skipped" || job.state === "cancelled") && job.startedAt === null;
      if (neverRan && job.approvalKind !== null) {
        throw new RerunError(
          "never_ran",
          `job ${job.jobKey} never ran and needs approval (${job.approvalKind}); it cannot be rerun`,
        );
      }
    }
    const used = new Map<string, number>();
    for (const job of selected) {
      const n = await rerunsUsed(h, scope, run, job.jobKey);
      const infra = isInfraCaused({
        state: job.state,
        errorClass: latestClass(job.id),
        startedAt: job.startedAt,
      });
      const left = `${Math.max(0, MAX_RERUNS_PER_JOB_PER_SHA - n.user)} of ${MAX_RERUNS_PER_JOB_PER_SHA} job-outcome reruns and ${Math.max(0, MAX_INFRA_RERUNS_PER_JOB_PER_SHA - n.infra)} of ${MAX_INFRA_RERUNS_PER_JOB_PER_SHA} infra-error reruns remain`;
      if (
        infra ? n.infra >= MAX_INFRA_RERUNS_PER_JOB_PER_SHA : n.user >= MAX_RERUNS_PER_JOB_PER_SHA
      ) {
        throw new RerunError(
          "limit",
          infra
            ? `job ${job.jobKey} was already rerun ${n.infra} times after infra errors on this commit (infra limit ${MAX_INFRA_RERUNS_PER_JOB_PER_SHA}); ${left}`
            : `job ${job.jobKey} was already rerun ${n.user} times on this commit (limit ${MAX_RERUNS_PER_JOB_PER_SHA}); ${left}`,
        );
      }
      used.set(job.id, infra ? n.user : n.user + 1);
    }

    // Writes below use the run's own project: the caller may hold an org-wide grant.
    const evScope = { orgId: run.orgId, projectId: run.projectId };
    const reruns: RerunResult["reruns"] = [];
    for (const job of selected) {
      // Approval is per attempt: a gated job waits for a human again, never straight to queued.
      const target: JobState = job.approvalKind === null ? "queued" : "awaiting_approval";
      const rows = await h.orm
        .update(s.jobs)
        .set({ state: target, exitCode: null, startedAt: null, finishedAt: null })
        .where(
          scoped(
            scope,
            { orgId: s.jobs.orgId, projectId: s.jobs.projectId },
            eq(s.jobs.id, job.id),
            eq(s.jobs.state, job.state),
          ),
        )
        .returning({ id: s.jobs.id });
      if (rows.length === 0) {
        throw new RerunError("conflict", `job ${job.jobKey} changed while rerunning; try again`);
      }
      const previous = (await listAttempts(h, scope, job.id)).at(-1);
      const attempt = await createAttempt(h, evScope, {
        jobId: job.id,
        provider: previous?.provider ?? "unscheduled",
        rerunReason: input.reason,
      });
      if (attempt && target === "awaiting_approval") {
        await h.orm
          .update(s.jobAttempts)
          .set({ state: "awaiting_approval", ...HELD_FOR_APPROVAL })
          .where(
            scoped(
              scope,
              { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
              eq(s.jobAttempts.id, attempt.id),
            ),
          );
      }
      await appendEvent(h, evScope, {
        type: "job.state_changed",
        runId: run.id,
        jobId: job.id,
        attemptId: attempt?.id,
        payload: { from: job.state, to: target, rerun: true, reason: input.reason },
      });
      if (target === "awaiting_approval") {
        await appendEvent(h, evScope, {
          type: "approval.required",
          runId: run.id,
          jobId: job.id,
          attemptId: attempt?.id,
          payload: { approval_kind: job.approvalKind, rerun: true },
        });
      }
      reruns.push({
        state: target,
        job: { ...job, state: target, exitCode: null, startedAt: null, finishedAt: null },
        attempt: attempt?.attempt ?? 0,
        previousState: job.state as JobState,
        rerunsUsed: used.get(job.id)!,
      });
    }

    // The run is no longer finished: recompute from its jobs and clear the finish time.
    const states = (await listJobs(h, scope, run.id)).map((j) => j.state as JobState);
    const status = aggregateRunStatus(states);
    await h.orm
      .update(s.runs)
      .set({ status, finishedAt: null })
      .where(
        and(
          scoped(
            scope,
            { orgId: s.runs.orgId, projectId: s.runs.projectId },
            eq(s.runs.id, run.id),
          ),
        ),
      );
    if (run.status !== status) {
      await appendEvent(h, evScope, {
        type: "run.queued",
        runId: run.id,
        payload: { rerun: true, from: run.status, status, reason: input.reason },
      });
    }
    return { run: (await getRun(h, scope, run.id))!, reruns };
  });
}
