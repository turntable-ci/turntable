// Expands a queued job whose `strategy.matrix` is built from an expression, once its needs are
// done: the placeholder row becomes the first leg, the others are new jobs with their own
// queued attempts (so each gets its own check run), and jobs that waited on the placeholder now
// wait on every leg. A matrix that cannot be built, or has no combinations, fails the job.
import { eq } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { createAttempt, createJob, listAttempts, listJobs } from "./index";
import type { Job } from "./index";
import { scoped, type Scope } from "./scope";

/** What expanding a dynamic matrix decided. The legs are planned jobs (see `PlannedJob`). */
export type Expansion =
  | {
      kind: "legs";
      legs: readonly {
        key: string;
        name: string;
        matrix: Record<string, unknown>;
        planned: unknown;
      }[];
    }
  | { kind: "error"; message: string };

/**
 * Applies an expansion to the queued placeholder `job`. Call inside a transaction. Returns `claim`
 * when the job is still queued and should be claimed as it is (a matrix that could not be built),
 * else `done`.
 */
export async function applyExpansion(
  db: Db,
  scope: Scope,
  job: Job,
  expansion: Expansion,
): Promise<"claim" | "done"> {
  const attempts = await listAttempts(db, scope, job.id);
  const live = attempts.findLast((a) => a.state === "queued");
  if (expansion.kind === "error") {
    // The job stays queued and is claimed as it is, marked unsupported: the runner ends it as a
    // failure with this reason, like any job that cannot run, so it has a check run and never
    // reads as skipped (a skipped required check counts as passing).
    const { dynamicMatrix: _drop, ...planned } = JSON.parse(job.planned ?? "{}") as Record<
      string,
      unknown
    >;
    await db.orm
      .update(s.jobs)
      .set({ planned: JSON.stringify({ ...planned, unsupported: expansion.message }) })
      .where(
        scoped(scope, { orgId: s.jobs.orgId, projectId: s.jobs.projectId }, eq(s.jobs.id, job.id)),
      );
    return "claim";
  }

  const [first, ...rest] = expansion.legs;
  if (!first) return "done";
  const keys = expansion.legs.map((l) => l.key);
  await db.orm
    .update(s.jobs)
    .set({
      jobKey: first.key,
      name: first.name,
      matrix: JSON.stringify(first.matrix),
      planned: JSON.stringify(first.planned),
    })
    .where(
      scoped(scope, { orgId: s.jobs.orgId, projectId: s.jobs.projectId }, eq(s.jobs.id, job.id)),
    );
  const provider = (live ?? attempts.at(-1))?.provider ?? "";
  const needs = JSON.parse(job.needs) as string[];
  for (const leg of rest) {
    const made = await createJob(db, scope, {
      runId: job.runId,
      jobKey: leg.key,
      name: leg.name,
      needs,
      matrix: leg.matrix,
      planned: leg.planned,
      approvalKind: (job.approvalKind ?? undefined) as s.ApprovalKind | undefined,
    });
    if (made) await createAttempt(db, scope, { jobId: made.id, provider });
  }
  // Dependents named the placeholder's key: they now wait for every leg.
  for (const dep of await listJobs(db, scope, job.runId)) {
    const dn = JSON.parse(dep.needs) as string[];
    if (!dn.includes(job.jobKey)) continue;
    const swap = (list: string[]): string[] => list.flatMap((k) => (k === job.jobKey ? keys : [k]));
    let planned = dep.planned;
    if (planned) {
      const p = JSON.parse(planned) as { needs?: string[] };
      if (Array.isArray(p.needs)) planned = JSON.stringify({ ...p, needs: swap(p.needs) });
    }
    await db.orm
      .update(s.jobs)
      .set({ needs: JSON.stringify(swap(dn)), planned })
      .where(
        scoped(scope, { orgId: s.jobs.orgId, projectId: s.jobs.projectId }, eq(s.jobs.id, dep.id)),
      );
  }
  return "done";
}
