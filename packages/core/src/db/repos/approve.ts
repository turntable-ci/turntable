// Approving a run held for a human (untrusted author). Part of the only code that names tenant
// tables. An approval is bound to the run's head sha and workflow hash, it releases jobs and
// records who approved what, and it never touches the run's trust class.
import { eq } from "drizzle-orm";
import type { Db } from "..";
import { aggregateRunStatus } from "../job-state";
import * as s from "../schema";
import {
  getRun,
  listAttempts,
  listJobs,
  setRunStatus,
  transitionJob,
  updateAttempt,
} from "./index";
import { getEnvPolicy, plannedEnvironment } from "./approvals";
import { supersedeOlderRuns } from "./poll";
import { effectiveStates } from "./readiness";
import { type Scope, scoped } from "./scope";
import { releasedPatch } from "./waiting";

export type RunApproval = {
  by: string;
  at: number;
  head_sha: string;
  workflow_hash: string;
  /** Set when a pull request label approved the run: the label and its `labeled` event id. */
  via?: { kind: "label"; label: string; event_id: string };
};

export class ApproveError extends Error {
  readonly code: "conflict";
  constructor(message: string) {
    super(message);
    this.code = "conflict";
  }
}

/** The stored trust decision of a run, or undefined when it has none or it does not parse. */
export function parseTrust(run: {
  trust: string | null;
}): { class: string; workflowHash: string } | undefined {
  if (run.trust === null) return undefined;
  try {
    const t = JSON.parse(run.trust) as { class?: unknown; workflowHash?: unknown };
    return typeof t.class === "string" && typeof t.workflowHash === "string"
      ? { class: t.class, workflowHash: t.workflowHash }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The workflow's own concurrency group, from the plan the poller stored. */
function realGroup(plan: string | null): { group: string; cancelInProgress: boolean } | undefined {
  if (plan === null) return undefined;
  try {
    const c = (
      JSON.parse(plan) as { concurrency?: { group?: unknown; cancelInProgress?: unknown } }
    ).concurrency;
    return typeof c?.group === "string" && c.group !== ""
      ? { group: c.group, cancelInProgress: c.cancelInProgress === true }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Releases the jobs of a run that wait for an untrusted author. `headSha` and `workflowHash` must
 * equal what the run was decided on: approving is "I read this commit and this workflow", and
 * anything else (a newer push is a different run) is refused. Works again on a run that already
 * holds an approval (a rerun sends jobs back to waiting). Returns undefined when the run is not
 * in scope.
 */
export function approveRun(
  db: Db,
  scope: Scope,
  runId: string,
  input: {
    headSha: string;
    workflowHash: string;
    by: string;
    via?: { kind: "label"; label: string; event_id: string };
    now?: number;
  },
): Promise<{ released: number; approval: RunApproval; state: string } | undefined> {
  return db.transaction(async (tx) => {
    const run = await getRun(tx, scope, runId);
    if (!run) return undefined;
    const trust = parseTrust(run);
    if (!trust) throw new ApproveError("the run has no recorded trust decision");
    if (run.sha === null || run.sha.toLowerCase() !== input.headSha.toLowerCase()) {
      throw new ApproveError("head_sha is not the sha of this run");
    }
    if (trust.workflowHash !== input.workflowHash.toLowerCase()) {
      throw new ApproveError("workflow_hash is not the hash of this run's workflow");
    }
    const jobs = (await listJobs(tx, scope, runId)).filter(
      (j) => j.state === "awaiting_approval" && j.approvalKind === "untrusted_author",
    );
    if (jobs.length === 0) throw new ApproveError("no job of this run is waiting for approval");
    let released = 0;
    for (const job of jobs) {
      // A held run that is NOT untrusted (a release tag no ruleset protects) still has its
      // environment's own gate to pass: approving the hold does not stand in for the quorum.
      // The job stays waiting, now for the environment. (An untrusted run's jobs are released
      // whole, as before.)
      const environment = plannedEnvironment(job.planned);
      if (
        trust.class !== "untrusted_pr" &&
        environment !== undefined &&
        (await getEnvPolicy(tx, scope.orgId, environment)).gated
      ) {
        await tx.orm
          .update(s.jobs)
          .set({ approvalKind: "environment" })
          .where(
            scoped(
              scope,
              { orgId: s.jobs.orgId, projectId: s.jobs.projectId },
              eq(s.jobs.id, job.id),
            ),
          );
        continue;
      }
      await transitionJob(tx, scope, job.id, "queued");
      const waiting = (await listAttempts(tx, scope, job.id)).findLast(
        (a) => a.state === "awaiting_approval",
      );
      if (waiting) {
        await updateAttempt(tx, scope, waiting.id, {
          state: "queued",
          ...releasedPatch(waiting, input.now ?? Date.now()),
        });
      }
      released += 1;
    }
    const approval: RunApproval = {
      by: input.by,
      at: input.now ?? Date.now(),
      head_sha: run.sha.toLowerCase(),
      workflow_hash: trust.workflowHash,
      ...(input.via ? { via: input.via } : {}),
    };
    // Only the approval is written: the trust column (the class) is left exactly as decided.
    await tx.orm
      .update(s.runs)
      .set({ approval: JSON.stringify(approval) })
      .where(
        scoped(scope, { orgId: s.runs.orgId, projectId: s.runs.projectId }, eq(s.runs.id, runId)),
      );
    // A held run waited in a group of its own, so that a run that may never start could not cancel
    // or queue behind real work. Approved, it joins the workflow's real group.
    if (run.concurrencyGroup?.startsWith("held:")) {
      const real = realGroup(run.plan);
      await tx.orm
        .update(s.runs)
        .set({ concurrencyGroup: real?.group ?? null })
        .where(
          scoped(scope, { orgId: s.runs.orgId, projectId: s.runs.projectId }, eq(s.runs.id, runId)),
        );
      // Older runs are cancelled only when jobs actually start now; one still waiting on its
      // environment's own gate has taken no one's place yet.
      if (real && released > 0) {
        const joined = await getRun(tx, scope, runId);
        if (joined)
          await supersedeOlderRuns(tx, scope, joined, real.cancelInProgress ? "all" : "pending");
      }
    }
    const all = await listJobs(tx, scope, runId);
    const status = aggregateRunStatus(effectiveStates(all));
    await setRunStatus(tx, scope, runId, status);
    return { released, approval, state: status };
  });
}
