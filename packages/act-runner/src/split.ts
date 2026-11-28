import { parse, stringify } from "yaml";
import { interpolate, type ExprContext, type Value } from "./expr";
import { layoutFor } from "./layout";
import { PlanError } from "./plan";
import { prepareServices } from "./services";
import { stepMatches, type PlannedJob } from "./workflow-plan";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export type NeedResultValue = "success" | "failure" | "skipped" | "cancelled";

/** What a finished (or skipped) needed job contributes to its dependents. */
export interface NeedResult {
  result: NeedResultValue;
  outputs: Record<string, string>;
}

export interface SplitOptions {
  /** act event name; the generated workflow triggers on exactly this. */
  event: string;
  /** Sandbox root, so the export step writes where runJob reads. */
  root?: string;
}

export const EXPORT_STEP_NAME = "tt:export-outputs";
const OUTPUT_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** A string that evaluates to exactly `value`, whatever it contains. */
const literal = (value: string): string => `\${{ '${value.replaceAll("'", "''")}' }}`;

/**
 * The generated workflow's trigger. For workflow_dispatch it keeps the declared `inputs`: act
 * builds the typed `inputs.*` context (and applies defaults) only for inputs the workflow declares,
 * so a bare `on: workflow_dispatch` left every `inputs.*` empty in the job (#780).
 */
function onFor(doc: Obj, event: string): unknown {
  if (event !== "workflow_dispatch") return event;
  const on = doc.on ?? doc["true"];
  const cfg = isObj(on) ? on.workflow_dispatch : undefined;
  return isObj(cfg) && isObj(cfg.inputs) ? { workflow_dispatch: { inputs: cfg.inputs } } : event;
}

/**
 * Generates a single-job workflow for one job (one matrix leg):
 *  - the other jobs are replaced by stub need jobs that carry the real outputs as literals and
 *    the real result, so `needs.x.outputs.y`, `needs.x.result`, `!cancelled()` and friends
 *    resolve inside act;
 *  - the matrix becomes one literal leg;
 *  - a final `if: always()` step writes each declared job output to a file, because act's JSON
 *    stream does not carry outputs.
 *  - `services:` ports are bound to 127.0.0.1 with fixed host ports, and each
 *    `job.services.<id>.ports` reference becomes its literal value (see services.ts).
 * The job's other fields (steps, env, if, runs-on ...) are untouched.
 */
export function splitJob(
  yaml: string,
  job: PlannedJob,
  needResults: Readonly<Record<string, NeedResult>>,
  opts: SplitOptions,
): string {
  const doc = parse(yaml, { merge: true }) as unknown;
  if (!isObj(doc) || !isObj(doc.jobs)) throw new PlanError("jobs", "workflow has no jobs");
  const src = doc.jobs[job.id];
  if (!isObj(src)) throw new PlanError("job", `no job "${job.id}" in workflow`);
  const outDir = layoutFor(opts.root).outputsDir;

  const leg = job.matrix ?? {};
  const ctx: ExprContext = {
    contexts: { matrix: leg as Value, github: {}, vars: {}, env: {}, inputs: {} },
    status: { needs: [], cancelled: false },
  };
  // runs-on may read the matrix; stubs reuse it so one `-P` mapping covers every job.
  const resolveRunsOn = (v: unknown): unknown => {
    if (typeof v === "string") return v.includes("${{") ? interpolate(v, ctx) : v;
    if (Array.isArray(v)) return v.map(resolveRunsOn);
    return v;
  };
  const runsOn = resolveRunsOn(src["runs-on"]);

  // Services bind loopback only and their `job.services.<id>.ports` become literals (#796).
  const target: Obj = prepareServices({ ...src, "runs-on": runsOn }, (s) =>
    s.includes("${{") ? interpolate(s, ctx) : s,
  );
  delete target.strategy;
  delete target.concurrency;
  if (job.matrix) {
    target.strategy = {
      matrix: Object.fromEntries(Object.entries(job.matrix).map(([k, v]) => [k, [v]])),
    };
  }
  // A leg of an operator's split: the steps another shard owns are turned off. Nothing else is
  // touched and no step is added, so the repository's workflow stays the only source of commands.
  if (job.shard && Array.isArray(target.steps)) {
    const mine = job.shard.index;
    const others = job.shard.partition.flatMap((names, i) => (i === mine ? [] : names));
    target.steps = (target.steps as unknown[]).map((s, i) =>
      isObj(s) && others.some((n) => stepMatches(s, i, n)) ? { ...s, if: false } : s,
    );
  }
  const stubs: Obj = {};
  for (const id of job.needsIds) {
    const r = needResults[id] ?? { result: "skipped" as const, outputs: {} };
    const stub: Obj = {
      "runs-on": runsOn,
      steps: [{ run: r.result === "failure" || r.result === "cancelled" ? "exit 1" : "true" }],
    };
    if (r.result === "skipped") stub.if = "${{ false }}";
    if (Object.keys(r.outputs).length > 0) {
      stub.outputs = Object.fromEntries(Object.entries(r.outputs).map(([k, v]) => [k, literal(v)]));
    }
    stubs[id] = stub;
  }
  target.needs = job.needsIds;

  const names = Object.keys(job.outputs);
  for (const n of names) {
    if (!OUTPUT_NAME.test(n)) throw new PlanError("outputs", `unsupported output name "${n}"`);
  }
  if (names.length > 0) {
    const env = Object.fromEntries(names.map((n, i) => [`TT_OUT_${i}`, job.outputs[n] as string]));
    const writes = names.map((n, i) => `printf '%s' "$TT_OUT_${i}" > '${outDir}/${n}'`).join("\n");
    const steps = Array.isArray(target.steps) ? [...target.steps] : [];
    steps.push({
      name: EXPORT_STEP_NAME,
      if: "${{ always() }}",
      shell: "bash",
      env,
      run: `mkdir -p '${outDir}'\n${writes}\n`,
    });
    target.steps = steps;
  }

  const out: Obj = {
    name: typeof doc.name === "string" ? doc.name : "workflow",
    on: onFor(doc, opts.event),
    ...(isObj(doc.env) ? { env: doc.env } : {}),
    ...(isObj(doc.defaults) ? { defaults: doc.defaults } : {}),
    ...(doc.permissions !== undefined ? { permissions: doc.permissions } : {}),
    jobs: { ...stubs, [job.id]: target },
  };
  return stringify(out);
}
