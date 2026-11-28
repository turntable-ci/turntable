import {
  aggregateNeed,
  expandDynamicMatrix,
  jobReadiness,
  type PlannedJob,
  type Value,
} from "@turntable/act-runner";
import { defaultReadiness, type Readiness } from "../db/repos";

/**
 * The scheduler's readiness: `jobReadiness` of the multi-job engine, fed the planned job stored
 * on the job row, the states and outputs of its needs, and the run's `if:` contexts. It knows
 * `if: always()` / `failure()`, a false `if:`, unsupported jobs, `continue-on-error` and
 * outputs. A job with no stored plan (a legacy or hand-made one) falls back to plain `needs`.
 */
export const workflowReadiness: Readiness = (job, deps, run) => {
  if (job.planned === null) return defaultReadiness(job, deps, run);
  const planned = JSON.parse(job.planned) as PlannedJob;
  const ctx = run?.plan
    ? (JSON.parse(run.plan) as {
        github?: Record<string, never>;
        vars?: Record<string, never>;
        env?: Record<string, never>;
        inputs?: Record<string, never>;
      })
    : {};
  const needs = Object.fromEntries(
    deps.map((d) => [
      d.key,
      {
        // A key that names no job reads as still queued, so the job waits rather than runs.
        state: d.state === "missing" ? ("queued" as const) : d.state,
        ...(d.outputs ? { outputs: d.outputs } : {}),
        ...(d.continueOnError ? { continueOnError: true } : {}),
      },
    ]),
  );
  const contexts = {
    github: ctx.github ?? {},
    vars: ctx.vars ?? {},
    // The typed `inputs` of a workflow_dispatch run, stored at dispatch.
    inputs: ctx.inputs ?? {},
    env: ctx.env ?? {},
    secrets: {},
  };
  const verdict = jobReadiness(planned, needs, {
    contexts,
    cancelled: run?.status === "cancelled",
  });
  // A job whose matrix is built from an expression is expanded the moment it would otherwise run,
  // from its needs' outputs; its own `if:` has been decided by then.
  if (verdict.decision !== "ready" || !planned.dynamicMatrix) return verdict;
  const needsCtx: Record<string, Value> = {};
  for (const id of planned.needsIds) {
    const legs = planned.needs.filter((k) => k === id || k.startsWith(`${id}[`));
    const agg = aggregateNeed(legs.map((k) => needs[k] ?? { state: "queued" as const }));
    needsCtx[id] = { result: agg.result, outputs: agg.outputs };
  }
  const out = expandDynamicMatrix(planned, contexts as Record<string, Value>, needsCtx);
  if (out.kind !== "legs") return { decision: "expand", expansion: out };
  return {
    decision: "expand",
    expansion: {
      kind: "legs",
      legs: out.legs.map((l) => ({ key: l.key, name: l.name, matrix: l.matrix ?? {}, planned: l })),
    },
  };
};
