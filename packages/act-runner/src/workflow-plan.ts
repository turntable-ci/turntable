import { parse } from "yaml";
import {
  ExprError,
  evaluateCondition,
  evaluate,
  interpolate,
  referencedContexts,
  wholeExpression,
  type ExprContext,
  type Value,
} from "./expr";
import { lintError, localActionDir, PlanError, type PlanWarning, untrustedIn } from "./plan";
import { wantsIdTokenIn } from "./permissions";
import { findHeadCheckouts, isPrivilegedEvent } from "./taint";
import {
  matchesPatterns,
  matchTrigger,
  patternToRegExp,
  type TriggerResult,
  type WorkflowEvent,
} from "./triggers";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The one answer to "did this job ask for an ID token": the stored plan's `idToken`. The scheduler
 * (the job's request variables) and the proxy (its mint rule) both ask here, so they cannot drift.
 * A missing, unreadable or legacy plan means no: both fail closed.
 */
export function plannedIdToken(planned: string | PlannedJob | null | undefined): boolean {
  if (!planned) return false;
  try {
    const p = typeof planned === "string" ? (JSON.parse(planned) as unknown) : planned;
    return typeof p === "object" && p !== null && (p as { idToken?: unknown }).idToken === true;
  } catch {
    return false;
  }
}

/**
 * Whether the stored plan says the job uploads artifacts (it has an `actions/upload-artifact`
 * step). The control plane gives such a job, when its sandbox has no network of its own, a narrow
 * upload-only route to the artifact service through the proxy; a job that does not ask gets no
 * route. A missing, unreadable or legacy plan means no.
 */
export function plannedArtifactUpload(planned: string | PlannedJob | null | undefined): boolean {
  if (!planned) return false;
  try {
    const p = typeof planned === "string" ? (JSON.parse(planned) as unknown) : planned;
    return (
      typeof p === "object" &&
      p !== null &&
      (p as { artifactUpload?: unknown }).artifactUpload === true
    );
  } catch {
    return false;
  }
}

/**
 * Whether the stored plan rules out artifact use: every `uses:` step is a known-safe remote action (checkout, setup-*, cache) and there is no
 * local action, reusable workflow or other remote action (a composite could call upload-artifact). Only an explicit
 * `artifactAccess: false` says so; a missing, unreadable or older plan means the job may use them,
 * so a run planned before this field keeps its artifact credential.
 */
export function plannedNoArtifactAccess(planned: string | PlannedJob | null | undefined): boolean {
  if (!planned) return false;
  try {
    const p = typeof planned === "string" ? (JSON.parse(planned) as unknown) : planned;
    return (
      typeof p === "object" &&
      p !== null &&
      (p as { artifactAccess?: unknown }).artifactAccess === false
    );
  } catch {
    return false;
  }
}

/** A step that is `actions/upload-artifact` (any ref), the one action that writes artifacts. */
const UPLOAD_ARTIFACT = /^actions\/upload-artifact(\/[^@\s]*)?@/i;
/**
 * Remote actions known not to touch the artifact service. Any other remote action (a Pages upload,
 * a deploy, a third-party wrapper) may be a composite that calls upload-artifact, so it keeps the
 * grant.
 */
const NO_ARTIFACT_ACTION =
  /^(actions\/(checkout|setup-[a-z0-9-]+|cache(\/(restore|save))?)|oven-sh\/setup-bun|dtolnay\/rust-toolchain|docker\/setup-[a-z0-9-]+)(@|$)/i;

/** What a dynamic-matrix placeholder keeps to expand later: the workflow's own text, unevaluated. */
export interface DynamicMatrix {
  matrix: unknown;
  name?: string;
  runsOn?: unknown;
  continueOnError?: unknown;
}

export interface PlannedJob {
  /** Unique within the run: the job id, or `id[n]` for a matrix leg. */
  key: string;
  /** The workflow's job id. */
  id: string;
  /** Display name: the interpolated `name:` (or the id), with matrix values for legs. */
  name: string;
  /** Keys of the jobs this one waits for. A need on a matrix job waits for every leg. */
  needs: string[];
  /** The job ids named in `needs:`. */
  needsIds: string[];
  matrix?: Record<string, Value>;
  /**
   * Set on a job whose `strategy.matrix` is built from an expression (`fromJSON(needs.x.outputs.m)`).
   * It is one placeholder until its needs finish; the scheduler then calls `expandDynamicMatrix`
   * and replaces it with one job per combination. Holds the raw matrix and the fields a leg's
   * matrix values can change.
   */
  dynamicMatrix?: DynamicMatrix;
  /** The job's `if:` as written. Evaluated at schedule time with the needs results. */
  ifExpr?: string | boolean;
  /** False when `if:` depends only on plan-time data and is false: the job is skipped. */
  staticSkip?: { reason: string };
  /** The job cannot run here (docker, non-Linux ...). Reported, not failed. */
  unsupported?: string;
  /**
   * The job needs a container runtime for `services:` or `container:` (the reason). It can run in
   * act's container mode on a Docker-capable size class; where there is none the scheduler fails
   * it with this reason. Not set with `unsupported` for the same cause.
   */
  needsDocker?: string;
  continueOnError: boolean;
  /** Output name to expression. */
  outputs: Record<string, string>;
  /** strategy.fail-fast (default true). */
  failFast: boolean;
  /** strategy.max-parallel, when set. */
  maxParallel?: number;
  /** The job's `environment:` (a name, or `name` of the mapping), when it is a literal. */
  environment?: string;
  /**
   * The job asked for an OIDC token (`permissions: id-token: write`, a job's own block replacing
   * the workflow's, `write-all` counting). The control plane registers its proxy rule for the
   * mint endpoint only for such a job.
   */
  idToken?: boolean;
  /** The job has an `actions/upload-artifact` step (see `plannedArtifactUpload`). */
  artifactUpload?: boolean;
  /** `false`: no artifact step and no local action, so the job needs no artifact credential. */
  artifactAccess?: false;
  /**
   * Set on a leg made by an operator's `splits` rule (not by `strategy.matrix`): this leg runs
   * shard `index` of `total`. `partition[i]` is shard i's named steps (names, or `#<n>` for the
   * nth step, counted from 1). Steps named for another shard are turned off in this leg.
   */
  shard?: { index: number; total: number; partition: string[][] };
  /** The job's `runs-on` labels, interpolated at plan time. The operator's sandbox size map reads these. */
  runsOn?: string[];
  /**
   * The run's `vars.*` the planner evaluated with, as strings. Stored with the job so act is given
   * the same values (see JobPlan.vars) and a resumed job uses what was stored, not a fresh read.
   */
  vars?: Record<string, string>;
}

/**
 * An operator's rule to run one job as several shards, each in its own sandbox, without editing
 * the workflow: `job` is the job id; `shards[i].steps` are the steps (by `name`, or `#<n>`) that
 * run only in shard i. A step no shard names runs in every shard.
 */
export interface SplitRule {
  job: string;
  /**
   * `paths` (optional) limits a shard to runs whose changed files match: workflow path-filter
   * globs, `!` negation included. A shard with no `paths` always runs.
   */
  shards: { steps: string[]; paths?: string[] | undefined }[];
}

/** The most `paths` globs one shard may list, and the longest glob. */
export const MAX_SHARD_PATHS = 50;
const MAX_PATH_GLOB = 200;

/** Why a shard's `paths` list is not valid, or undefined. */
function shardPathsProblem(paths: readonly string[]): string | undefined {
  if (paths.length === 0) return "an empty paths list (leave paths out to always run)";
  if (paths.length > MAX_SHARD_PATHS) return `more than ${MAX_SHARD_PATHS} paths`;
  for (const p of paths) {
    if (typeof p !== "string" || p === "" || p.length > MAX_PATH_GLOB)
      return "a path glob is empty or too long";
    const body = p.startsWith("!") ? p.slice(1) : p;
    if (body === "") return `path ${JSON.stringify(p)} negates nothing`;
    if (/\0|\n|\r/.test(body)) return `path ${JSON.stringify(p)} has a control character`;
    // An unclosed `[` is a literal in the matcher, so it is almost certainly a typo.
    if (body.includes("[") && body.indexOf("]", body.indexOf("[") + 1) < 0)
      return `path ${JSON.stringify(p)} has an unclosed [`;
    try {
      patternToRegExp(body);
    } catch {
      return `path ${JSON.stringify(p)} is not a valid glob`;
    }
  }
  if (!paths.some((p) => !p.startsWith("!")))
    return "paths needs one pattern that is not a !negation";
  return undefined;
}

/** The most shards one job may be split into. */
export const MAX_SHARDS = 8;

/** Why a rule is not valid, or undefined. Names and counts only; the workflow is not looked at. */
export function splitRuleProblem(rule: SplitRule): string | undefined {
  if (typeof rule.job !== "string" || rule.job === "") return "a split rule needs a job id";
  if (rule.shards.length < 2 || rule.shards.length > MAX_SHARDS)
    return `split ${rule.job}: 2 to ${MAX_SHARDS} shards`;
  const seen = new Set<string>();
  for (const [i, s] of rule.shards.entries()) {
    if (s.steps.length === 0) return `split ${rule.job}: shard ${i + 1} names no step`;
    if (s.paths !== undefined) {
      const why = shardPathsProblem(s.paths);
      if (why) return `split ${rule.job}: shard ${i + 1}: ${why}`;
    }
    for (const name of s.steps) {
      if (name === "" || name.length > 200)
        return `split ${rule.job}: a step name is empty or too long`;
      if (name.startsWith("#") && !/^#[1-9][0-9]{0,3}$/.test(name))
        return `split ${rule.job}: ${JSON.stringify(name)} is not a step name or #<number>`;
      if (seen.has(name)) return `split ${rule.job}: step ${JSON.stringify(name)} is in two shards`;
      seen.add(name);
    }
  }
  return undefined;
}

/** The result of one job across its shards: what its single check and its dependents see. */
export function foldShardStates(states: readonly string[]): string {
  const terminal = ["success", "failure", "infra_error", "cancelled", "skipped"];
  if (states.some((s) => !terminal.includes(s)))
    return states.includes("running") ? "running" : "queued";
  if (states.includes("failure")) return "failure";
  if (states.includes("infra_error")) return "infra_error";
  if (states.includes("cancelled")) return "cancelled";
  if (states.every((s) => s === "skipped")) return "skipped";
  return "success";
}

export interface WorkflowPlan {
  name?: string;
  /** The workflow's `run-name`, evaluated with the `github` and `inputs` contexts; absent when none or invalid. */
  runName?: string;
  /** Why a declared `run-name` was not used (the default title applies). */
  runNameWarning?: string;
  event: WorkflowEvent;
  trigger: TriggerResult;
  /** Workflow-level env, literal strings only (expressions are evaluated by act per job). */
  env: Record<string, string>;
  concurrency?: { group: string; cancelInProgress: boolean };
  /** Jobs in dependency order. */
  jobs: PlannedJob[];
  warnings: PlanWarning[];
  /** What the operator's split rules did or could not do, one line each (not lint findings). */
  splitNotices: string[];
}

export interface PlanWorkflowOptions {
  /** github context fields beyond the event (sha, actor, repository, event payload ...). */
  github?: Record<string, Value>;
  vars?: Record<string, Value>;
  inputs?: Record<string, Value>;
  /** Reads repo files so local composite actions can be checked for docker. */
  readFile: (path: string) => string | undefined;
  /** Fail the plan on lint findings (outside text in a script, a privileged job taking the PR head). */
  failOnLint?: boolean;
  /** Operator rules that split a job into shards (see SplitRule). Never read from the repository. */
  splits?: readonly SplitRule[];
  /** The files shard selection reads, when they differ from `event.changedFiles` (a merge group). */
  shardChangedFiles?: readonly string[];
  /** Where the event's changed files came from, for the shard-selection notice and skip reason. */
  changedSource?: string;
}

export function githubContext(
  event: WorkflowEvent,
  extra: Record<string, Value> = {},
): Record<string, Value> {
  const ref = event.ref ?? "";
  const refName = ref.replace(/^refs\/(heads|tags)\//, "");
  // `github.repository` and `github.repository_owner`, as act derives them, from the event's own
  // repository so a job-level `if: github.repository == 'owner/name'` agrees with act.
  const evRepo = (extra.event as { repository?: { full_name?: unknown } } | undefined)?.repository;
  const fullName = typeof evRepo?.full_name === "string" ? evRepo.full_name : "";
  return {
    ...(fullName ? { repository: fullName, repository_owner: fullName.split("/")[0] ?? "" } : {}),
    event_name: event.name,
    ref,
    ref_name: refName,
    ref_type: ref.startsWith("refs/tags/") ? "tag" : "branch",
    base_ref: event.baseRef ?? "",
    event: {},
    ...extra,
  };
}

// ---- matrix ----

type Combo = Record<string, Value>;

/**
 * Compares values by their JSON form without re-serializing: every distinct value gets an id once
 * (objects by reference, then by their JSON text; primitives by value), so a subset check costs
 * one lookup per key however large a value is. Matrix values from a needs output can be large and
 * are shared by every combination.
 */
function valueIds(): (v: unknown) => number {
  const byRef = new WeakMap<object, number>();
  const byText = new Map<string, number>();
  const byPrim = new Map<unknown, number>();
  let next = 0;
  return (v) => {
    if (typeof v === "object" && v !== null) {
      let id = byRef.get(v);
      if (id === undefined) {
        const text = JSON.stringify(v);
        id = byText.get(text);
        if (id === undefined) byText.set(text, (id = next++));
        byRef.set(v, id);
      }
      return id;
    }
    let id = byPrim.get(v);
    if (id === undefined) byPrim.set(v, (id = next++));
    return id;
  };
}

/** GitHub's cap on the combinations of one matrix. */
export const MAX_MATRIX_COMBINATIONS = 256;

/**
 * Expands a matrix with GitHub's rules: the cartesian product of the axes, minus `exclude`
 * entries (each removes every combination it is a subset of), then `include` entries. An include
 * is merged into every original combination whose original axis values it matches (all of them
 * when it names no axis), adding only keys that are not original axes, so a later include can
 * overwrite an earlier include's added keys but never an axis value; an include that matches no
 * original combination becomes a combination of its own. May return no combinations.
 */
export function matrixCombos(
  matrix: unknown,
  limits: {
    maxProduct: number;
    maxEntries: number;
    /** Keys allowed in one include or exclude entry, and axes in a matrix. */
    maxKeys?: number;
    /** Fail as soon as the combinations left after `exclude` exceed this (includes only add). */
    maxBase?: number;
  } = {
    maxProduct: MAX_MATRIX_COMBINATIONS * 64,
    maxEntries: Number.POSITIVE_INFINITY,
  },
): Combo[] {
  if (!isObj(matrix)) throw new PlanError("matrix", "strategy.matrix must be a mapping");
  const listOf = (k: string, v: unknown): Combo[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new PlanError("matrix", `matrix ${k} must be a list of mappings`);
    return v.filter(isObj) as Combo[];
  };
  const idOf = valueIds();
  const subsetMatch = (small: Combo, big: Combo): boolean =>
    Object.entries(small).every(([k, v]) => k in big && idOf(big[k]) === idOf(v));
  const include = listOf("include", matrix.include);
  const exclude = listOf("exclude", matrix.exclude);
  if (include.length > limits.maxEntries || exclude.length > limits.maxEntries)
    throw new PlanError("matrix", `matrix include and exclude are limited to ${limits.maxEntries}`);
  const maxKeys = limits.maxKeys ?? Number.POSITIVE_INFINITY;
  for (const e of [...include, ...exclude])
    if (Object.keys(e).length > maxKeys)
      throw new PlanError(
        "matrix",
        `a matrix include or exclude entry is limited to ${maxKeys} keys`,
      );
  const axes = Object.entries(matrix).filter(([k]) => k !== "include" && k !== "exclude");
  if (axes.length > maxKeys)
    throw new PlanError("matrix", `a matrix is limited to ${maxKeys} axes`);
  let combos: Combo[] = [];
  if (axes.length > 0) {
    combos = [{}];
    for (const [k, vals] of axes) {
      if (!Array.isArray(vals)) {
        throw new PlanError(
          "matrix",
          `matrix axis "${k}" must be a list (expressions are not supported)`,
        );
      }
      if (combos.length * vals.length > limits.maxProduct) {
        throw new PlanError("matrix", "matrix is far over the 256 combination limit");
      }
      combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [k]: v as Value })));
    }
    combos = combos.filter((c) => !exclude.some((e) => subsetMatch(e, c)));
  }
  if (limits.maxBase !== undefined && combos.length > limits.maxBase)
    throw new PlanError(
      "matrix",
      `matrix expands to ${combos.length} jobs; the limit is ${limits.maxBase}`,
    );
  const original = new Set(axes.map(([k]) => k));
  const base = combos;
  const added: Combo[] = [];
  for (const inc of include) {
    const originalPart: Combo = Object.fromEntries(
      Object.entries(inc).filter(([k]) => original.has(k)),
    );
    let matched = false;
    for (const c of base) {
      if (subsetMatch(originalPart, c)) {
        matched = true;
        for (const [k, v] of Object.entries(inc)) if (!original.has(k)) c[k] = v;
      }
    }
    if (!matched) added.push({ ...inc });
  }
  return [...base, ...added];
}

/** Expands a static matrix. A matrix with no combinations or over 256 is a plan error. */
export function expandMatrix(matrix: unknown): Combo[] {
  const combos = matrixCombos(matrix);
  if (combos.length === 0) throw new PlanError("matrix", "matrix expands to no jobs");
  if (combos.length > MAX_MATRIX_COMBINATIONS)
    throw new PlanError(
      "matrix",
      `matrix expands to ${combos.length} jobs; the limit is ${MAX_MATRIX_COMBINATIONS}`,
    );
  return combos;
}

// ---- docker detection ----

const DOCKER_CMD = /(^|[\s;&|(`])docker(\s|$)/m;
const DOCKER_OWNERS = /^docker\//i;

/**
 * Why a local composite action (a directory of the repo) needs docker, looking through the local
 * actions it uses in turn, to a bounded depth. Undefined when it does not, or cannot be read.
 */
function localActionDockerReason(
  uses: string,
  readFile: (p: string) => string | undefined,
  depth: number,
  seen: Set<string>,
): string | undefined {
  const dir = localActionDir(uses);
  if (dir === undefined) return `step uses ${uses}, a path outside the repository`;
  if (depth > 5 || seen.has(dir)) return undefined;
  seen.add(dir);
  for (const f of ["action.yml", "action.yaml"]) {
    const text = readFile(dir === "" ? f : `${dir}/${f}`);
    if (text === undefined) continue;
    try {
      const doc: unknown = parse(text);
      const runs = isObj(doc) ? doc.runs : undefined;
      if (isObj(runs) && String(runs.using).trim().toLowerCase() === "docker")
        return `local action ${uses} is a docker action`;
      if (isObj(runs) && Array.isArray(runs.steps)) {
        for (const cs of runs.steps) {
          if (!isObj(cs)) continue;
          if (typeof cs.run === "string" && DOCKER_CMD.test(cs.run)) {
            return `local action ${uses} runs docker`;
          }
          if (typeof cs.uses === "string") {
            const u = cs.uses.trim();
            if (u.startsWith("docker://")) return `local action ${uses} uses ${u}`;
            if (u.startsWith("./") || u.startsWith("../")) {
              const inner = localActionDockerReason(u, readFile, depth + 1, seen);
              if (inner) return `local action ${uses} uses ${inner.replace(/^step uses /, "")}`;
            }
          }
        }
      }
    } catch {
      // an unparsable action fails loudly at run time
    }
    break;
  }
  return undefined;
}

/**
 * Why a job needs a container daemon for `services:` or `container:`, or undefined. These can run
 * in act's container mode on a Docker-capable sandbox; every other docker use is `dockerReason`.
 */
function containerModeReason(job: Obj): string | undefined {
  if (job.container !== undefined) return "uses container:";
  if (job.services !== undefined) return "uses services:";
  return undefined;
}

/**
 * Why a job needs docker in a way container mode does not cover (a docker command, a docker
 * action), or undefined. Container mode hands a job no daemon socket, so these stay refused.
 */
function dockerReason(job: Obj, readFile: (p: string) => string | undefined): string | undefined {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const s of steps) {
    if (!isObj(s)) continue;
    if (typeof s.uses === "string") {
      const u = s.uses.trim();
      if (u.startsWith("docker://")) return `step uses ${u}`;
      if (DOCKER_OWNERS.test(u)) return `step uses ${u}, which needs a docker daemon`;
      if (u.startsWith("./") || u.startsWith("../")) {
        const why = localActionDockerReason(u, readFile, 0, new Set());
        if (why) return why;
      }
    }
    if (typeof s.run === "string" && DOCKER_CMD.test(s.run))
      return "a step runs the docker command";
  }
  return undefined;
}

/** A label with a macOS or Windows meaning (`macos-14`, `macOS`, `windows-2022`, `Windows`). */
const OS_LABEL = /^(macos|windows)/i;

const labelText = (v: string): string => v.replaceAll(/[`\r\n]+/g, " ").slice(0, 60);

function runsOnReason(runsOn: unknown, ctx: ExprContext): string | undefined {
  let labels: unknown[];
  if (typeof runsOn === "string") labels = [runsOn];
  else if (Array.isArray(runsOn)) labels = runsOn;
  else if (isObj(runsOn) && runsOn.labels !== undefined) labels = [runsOn.labels].flat();
  else return "runs-on is missing or has an unsupported shape";
  for (const l of labels) {
    if (typeof l !== "string") return "runs-on has a non-string label";
    const v = l.includes("${{") ? interpolate(l, ctx) : l;
    // Only labels that name another OS are refused. A custom label (`boat`, `large`) has no OS
    // meaning: the operator's size map decides its sandbox, and it is Linux.
    const os = OS_LABEL.exec(v)?.[1]?.toLowerCase();
    if (os) {
      const name = os === "macos" ? "macOS" : "Windows";
      return `This job asks for a ${name} runner (\`${labelText(v)}\`). Turntable runs Linux sandboxes only; ${name} runners are not supported yet.`;
    }
  }
  return undefined;
}

/** The runs-on labels as strings, interpolated; an expression that cannot be evaluated is left out. */
function runsOnLabelList(runsOn: unknown, ctx: ExprContext): string[] {
  let labels: unknown[];
  if (typeof runsOn === "string") labels = [runsOn];
  else if (Array.isArray(runsOn)) labels = runsOn;
  else if (isObj(runsOn) && runsOn.labels !== undefined) labels = [runsOn.labels].flat();
  else return [];
  const out: string[] = [];
  for (const l of labels) {
    if (typeof l !== "string") continue;
    try {
      out.push(l.includes("${{") ? interpolate(l, ctx) : l);
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
    }
  }
  return out;
}

/** A job's display name: its interpolated `name:`, else `id (v1, v2)` for a matrix leg. */
function legName(id: string, rawName: unknown, leg: Combo | undefined, ctx: ExprContext): string {
  try {
    if (typeof rawName === "string") return interpolate(rawName, ctx);
    if (leg)
      return `${id} (${Object.values(leg)
        .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))
        .join(", ")})`;
  } catch (e) {
    if (!(e instanceof ExprError)) throw e;
    return rawName as string;
  }
  return id;
}

function clipName(n: string): string {
  return n.length > MAX_LEG_NAME_LENGTH ? `${n.slice(0, MAX_LEG_NAME_LENGTH - 3)}...` : n;
}

/** Resolves the `${{ }}` in a matrix's raw value: a whole expression keeps its type, text is interpolated. */
function resolveMatrixValue(v: unknown, ctx: ExprContext): Value {
  if (typeof v === "string") {
    const whole = wholeExpression(v);
    if (whole !== undefined) return evaluate(whole, ctx);
    return v.includes("${{") ? interpolate(v, ctx) : v;
  }
  if (Array.isArray(v)) return v.map((x) => resolveMatrixValue(x, ctx));
  if (isObj(v))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveMatrixValue(x, ctx)]));
  return v as Value;
}

/** The first string in a value (key or leaf) that holds `${{`, or undefined. */
function findExpression(v: unknown): string | undefined {
  if (typeof v === "string") return v.includes("${{") ? "${{" : undefined;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = findExpression(x);
      if (r !== undefined) return r;
    }
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      const r = findExpression(k) ?? findExpression(x);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

/** Bounds on a matrix built from a needs output: its size, keys per entry, and size per leg. */
export const MAX_DYNAMIC_MATRIX_BYTES = 64 * 1024;
export const MAX_DYNAMIC_MATRIX_KEYS = 64;
export const MAX_DYNAMIC_LEG_BYTES = 16 * 1024;
/** A leg's job name is cut to this many characters (check run names come from it). */
export const MAX_LEG_NAME_LENGTH = 256;

export type DynamicExpansion =
  | { kind: "legs"; legs: PlannedJob[] }
  /** The matrix could not be built (bad JSON, wrong shape, no combinations, over the limit): the job fails. */
  | { kind: "error"; message: string };

/**
 * Expands a dynamic-matrix placeholder once its needs are done. `contexts` are the run's github,
 * vars, inputs and env; `needs` is the `needs` context (result and outputs per job id). Never
 * throws for a bad matrix: the outcome says why the job fails. Each leg is the
 * placeholder with its own key `id[n]`, matrix values, name, and the fields matrix values can
 * change (runs-on, continue-on-error).
 */
export function expandDynamicMatrix(
  job: PlannedJob,
  contexts: Readonly<Record<string, Value>>,
  needs: Readonly<Record<string, Value>>,
): DynamicExpansion {
  const dyn = job.dynamicMatrix;
  if (!dyn) return { kind: "error", message: "job has no dynamic matrix" };
  const base: ExprContext = {
    contexts: { ...contexts, needs, matrix: {}, runner: { os: "Linux", arch: "X64" } },
    status: { needs: [], cancelled: false },
  };
  let combos: Combo[];
  try {
    const resolved = resolveMatrixValue(dyn.matrix, base);
    if (!isObj(resolved))
      return {
        kind: "error",
        message: `strategy.matrix did not evaluate to an object (got ${Array.isArray(resolved) ? "a list" : typeof resolved})`,
      };
    const bad = findExpression(resolved);
    if (bad !== undefined)
      return {
        kind: "error",
        message: `strategy.matrix value contains an expression (${bad}); values from needs outputs are data and are never evaluated`,
      };
    // A needs output is untrusted data: bound the resolved matrix before expanding it, since
    // this runs inside the claim transaction.
    if (JSON.stringify(resolved).length > MAX_DYNAMIC_MATRIX_BYTES)
      return {
        kind: "error",
        message: `strategy.matrix is larger than ${MAX_DYNAMIC_MATRIX_BYTES} bytes`,
      };
    combos = matrixCombos(resolved, {
      maxProduct: MAX_MATRIX_COMBINATIONS * 4,
      maxEntries: MAX_MATRIX_COMBINATIONS * 4,
      maxKeys: MAX_DYNAMIC_MATRIX_KEYS,
      maxBase: MAX_MATRIX_COMBINATIONS,
    });
  } catch (e) {
    if (e instanceof ExprError || e instanceof PlanError)
      return { kind: "error", message: `strategy.matrix is not valid: ${e.message}` };
    throw e;
  }
  for (const c of combos)
    for (const k of ["include", "exclude"])
      if (k in c)
        return {
          kind: "error",
          message: `strategy.matrix has a key named "${k}" inside a combination; that name is reserved`,
        };
  if (combos.length === 0)
    return { kind: "error", message: "Matrix vector does not contain any values" };
  if (combos.length > MAX_MATRIX_COMBINATIONS)
    return {
      kind: "error",
      message: `matrix expands to ${combos.length} jobs; the limit is ${MAX_MATRIX_COMBINATIONS}`,
    };
  for (const c of combos)
    if (JSON.stringify(c).length > MAX_DYNAMIC_LEG_BYTES)
      return {
        kind: "error",
        message: `a matrix combination is larger than ${MAX_DYNAMIC_LEG_BYTES} bytes`,
      };
  const { dynamicMatrix: _drop, ...rest } = job;
  const legs = combos.map((leg, i): PlannedJob => {
    const ctx: ExprContext = {
      contexts: {
        ...contexts,
        needs,
        runner: { os: "Linux", arch: "X64" },
        matrix: leg,
        strategy: { "job-index": i, "job-total": combos.length, "fail-fast": job.failFast },
      },
      status: { needs: [], cancelled: false },
    };
    const out: PlannedJob = {
      ...rest,
      key: `${job.id}[${i}]`,
      name: clipName(legName(job.id, dyn.name, leg, ctx)),
      matrix: leg,
    };
    let unsupported: string | undefined;
    try {
      unsupported = runsOnReason(dyn.runsOn, ctx);
      const v = dyn.continueOnError;
      if (v !== undefined)
        out.continueOnError = typeof v === "boolean" ? v : evaluateCondition(String(v), ctx);
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      unsupported ??= `continue-on-error expression: ${e.message}`;
    }
    const labels = runsOnLabelList(dyn.runsOn, ctx);
    if (labels.length > 0) out.runsOn = labels;
    if (unsupported && out.unsupported === undefined) {
      out.unsupported = unsupported;
      delete out.needsDocker;
    }
    return out;
  });
  return { kind: "legs", legs };
}

// ---- planning ----

/** True when the expression reads only data known at plan time. */
function isStatic(expr: string): boolean {
  const refs = referencedContexts(expr);
  return !["needs", "status", "steps", "job"].some((c) => refs.has(c));
}

/**
 * Plans a whole workflow: trigger match, the job graph with matrices expanded, static `if:`
 * results, and jobs that cannot run here marked unsupported. Job `if:` that reads needs is kept
 * for schedule time (evaluateCondition with the real needs results).
 */
export function planWorkflow(
  yaml: string,
  event: WorkflowEvent,
  opts: PlanWorkflowOptions,
): WorkflowPlan {
  let doc: unknown;
  try {
    doc = parse(yaml, { merge: true });
  } catch (e) {
    throw new PlanError("yaml", `workflow is not valid YAML: ${(e as Error).message}`);
  }
  if (!isObj(doc) || !isObj(doc.jobs)) throw new PlanError("jobs", "workflow has no jobs");
  const on = doc.on ?? (doc as Obj)["true"];
  const trigger = matchTrigger(on, event);
  const github = githubContext(event, opts.github);
  const base: Record<string, Value> = {
    github,
    vars: opts.vars ?? {},
    inputs: opts.inputs ?? {},
    env: {},
    secrets: {},
    runner: { os: "Linux", arch: "X64" },
  };
  const wfCtx: ExprContext = { contexts: base, status: { needs: [], cancelled: false } };

  const runNameResult = evaluateRunName(doc["run-name"], github, opts.inputs ?? {});

  const warnings: PlanWarning[] = [];
  const env: Record<string, string> = {};
  if (isObj(doc.env)) {
    for (const [k, v] of Object.entries(doc.env))
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
        env[k] = String(v);
  }
  base.env = env;

  let concurrency: WorkflowPlan["concurrency"];
  if (doc.concurrency !== undefined) {
    const c = doc.concurrency;
    const groupRaw = typeof c === "string" ? c : isObj(c) ? c.group : undefined;
    if (typeof groupRaw !== "string")
      throw new PlanError("concurrency", "concurrency needs a group");
    let cancel = false;
    if (isObj(c) && c["cancel-in-progress"] !== undefined) {
      const v = c["cancel-in-progress"];
      cancel = typeof v === "boolean" ? v : evaluateCondition(String(v), wfCtx);
    }
    concurrency = { group: interpolate(groupRaw, wfCtx), cancelInProgress: cancel };
  }

  const splitNotices: string[] = [];
  const rules = new Map<string, SplitRule>();
  for (const r of opts.splits ?? []) {
    const problem = splitRuleProblem(r);
    if (problem) splitNotices.push(`split rule ignored: ${problem}`);
    else if (rules.has(r.job)) splitNotices.push(`split rule ignored: job ${r.job} has two rules`);
    else rules.set(r.job, r);
  }
  for (const id of rules.keys())
    if (!Object.keys(doc.jobs).includes(id))
      splitNotices.push(`split rule for job ${id}: the workflow has no such job`);

  const changed = opts.shardChangedFiles ?? event.changedFiles;
  const source = opts.changedSource ?? event.name;
  if ([...rules.values()].some((r) => r.shards.some((sh) => sh.paths))) {
    splitNotices.push(
      changed === undefined || changed.length === 0
        ? `shards selected by changed paths: changed files unknown (${source}), so every shard runs`
        : `shards selected by changed paths (${source}, ${changed.length} files)`,
    );
  }

  const rawJobs = doc.jobs;
  const ids = Object.keys(rawJobs);
  const legsOf = new Map<string, string[]>();
  const nodes: PlannedJob[] = [];

  for (const id of ids) {
    const job = rawJobs[id];
    if (!isObj(job)) throw new PlanError("job", `job "${id}" is not a mapping`);
    const needsIds = job.needs === undefined ? [] : ([job.needs].flat() as unknown[]).map(String);
    for (const n of needsIds) {
      if (!ids.includes(n)) throw new PlanError("needs", `job "${id}" needs unknown job "${n}"`);
    }
    const strategy = isObj(job.strategy) ? job.strategy : {};
    let combos: Combo[] | undefined;
    let dynamicMatrix = false;
    if (strategy.matrix !== undefined) {
      if (typeof strategy.matrix === "string" || JSON.stringify(strategy.matrix).includes("${{")) {
        dynamicMatrix = true;
      } else {
        combos = expandMatrix(strategy.matrix);
      }
    }
    const failFast = strategy["fail-fast"] === undefined ? true : strategy["fail-fast"] !== false;
    const maxParallel =
      typeof strategy["max-parallel"] === "number" ? strategy["max-parallel"] : undefined;
    const outputs = isObj(job.outputs)
      ? Object.fromEntries(Object.entries(job.outputs).map(([k, v]) => [k, String(v)]))
      : {};

    let rule = rules.get(id);
    if (rule) {
      const why = splitUnusable(job, rule, strategy.matrix !== undefined);
      if (why) {
        splitNotices.push(`job ${id} is not split: ${why}`);
        rule = undefined;
      } else {
        for (const n of unmatchedStepNames(job, rule))
          splitNotices.push(
            `job ${id}: split step ${JSON.stringify(n)} matches no step, so no shard owns it`,
          );
      }
    }
    const legs: (Combo | undefined)[] = rule
      ? rule.shards.map(() => undefined)
      : (combos ?? [undefined]);
    const keys: string[] = [];
    for (const [i, leg] of legs.entries()) {
      const key = leg === undefined && !rule ? id : `${id}[${i}]`;
      keys.push(key);
      const ctx: ExprContext = {
        contexts: {
          ...base,
          matrix: leg ?? {},
          strategy: { "job-index": i, "job-total": legs.length, "fail-fast": failFast },
        },
        status: { needs: [], cancelled: false },
      };
      const name = legName(id, job.name, leg, ctx);
      const containerReason = containerModeReason(job);
      // A dynamic matrix's legs read `matrix.*` in runs-on, so the placeholder leaves runs-on to
      // the expansion (see `expandDynamicMatrix`).
      let unsupported: string | undefined =
        dockerReason(job, opts.readFile) ??
        (job.uses !== undefined ? "calls a reusable workflow (uses:)" : undefined) ??
        (dynamicMatrix ? undefined : runsOnReason(job["runs-on"], ctx));
      // A literal environment can be gated by approval policy. One built from an expression
      // cannot be known at plan time, so the job is refused rather than run ungated.
      let environment: string | undefined;
      if (job.environment !== undefined) {
        const raw = isObj(job.environment) ? job.environment.name : job.environment;
        if (typeof raw === "string" && raw !== "" && !raw.includes("${{")) environment = raw;
        else unsupported ??= "environment: must be a literal name (an expression cannot be gated)";
      }
      let coe = false;
      if (job["continue-on-error"] !== undefined) {
        const v = job["continue-on-error"];
        try {
          coe = typeof v === "boolean" ? v : evaluateCondition(String(v), ctx);
        } catch (e) {
          if (!(e instanceof ExprError)) throw e;
          // A dynamic matrix's legs evaluate it with their own matrix values.
          if (!dynamicMatrix) unsupported ??= `continue-on-error expression: ${e.message}`;
        }
      }
      const node: PlannedJob = {
        key,
        id,
        name,
        needs: [],
        needsIds,
        ...(leg ? { matrix: leg } : {}),
        ...(dynamicMatrix
          ? {
              dynamicMatrix: {
                matrix: strategy.matrix,
                ...(typeof job.name === "string" ? { name: job.name } : {}),
                runsOn: job["runs-on"],
                ...(job["continue-on-error"] !== undefined
                  ? { continueOnError: job["continue-on-error"] }
                  : {}),
              },
            }
          : {}),
        ...(job.if !== undefined ? { ifExpr: job.if as string | boolean } : {}),
        ...(unsupported ? { unsupported } : {}),
        ...(containerReason && !unsupported ? { needsDocker: containerReason } : {}),
        continueOnError: coe,
        outputs,
        // Shards of one job always all run: the workflow's own steps run every suite even when
        // one is red, and the job's result is the fold of the shards.
        ...(Object.keys(opts.vars ?? {}).length > 0
          ? {
              vars: Object.fromEntries(
                Object.entries(opts.vars ?? {}).map(([k, v]) => [k, String(v)]),
              ),
            }
          : {}),
        failFast: rule ? false : failFast,
        ...(rule
          ? {
              shard: {
                index: i,
                total: legs.length,
                partition: rule.shards.map((s) => [...s.steps]),
              },
            }
          : {}),
        ...(maxParallel !== undefined ? { maxParallel } : {}),
        ...(environment !== undefined ? { environment } : {}),
        ...(wantsIdTokenIn(doc, id) ? { idToken: true } : {}),
        ...(stepsOf(job).some((st) => typeof st.uses === "string" && UPLOAD_ARTIFACT.test(st.uses))
          ? { artifactUpload: true }
          : {}),
        ...(stepsOf(job).every(
          (st) => typeof st.uses !== "string" || NO_ARTIFACT_ACTION.test(st.uses.trim()),
        ) && job.uses === undefined
          ? { artifactAccess: false as const }
          : {}),
        ...(() => {
          const runsOn = dynamicMatrix ? [] : runsOnLabelList(job["runs-on"], ctx);
          return runsOn.length > 0 ? { runsOn } : {};
        })(),
      };
      // A shard limited by `paths` runs only when a changed file matches. Unknown, an empty list
      // and a partial list all mean the shard runs: the changed set is never guessed.
      const shardPaths = rule?.shards[i]?.paths;
      if (shardPaths && changed !== undefined && changed.length > 0) {
        const hit = changed.some((f) => matchesPatterns(shardPaths, f));
        if (!hit) {
          node.staticSkip = {
            reason: `no shard paths changed: none of ${changed.length} changed files match ${shardPaths.join(", ")} (${source})`,
          };
        }
      }
      // Static `if:` is decided now; one that reads needs waits for schedule time.
      if (job.if !== undefined) {
        const cond = job.if as string | boolean;
        try {
          const isStat = typeof cond === "boolean" || isStatic(wholeExpression(cond) ?? cond);
          if (isStat && !evaluateCondition(cond, ctx)) {
            node.staticSkip ??= { reason: `if: ${String(cond).trim()} is false` };
          }
        } catch (e) {
          if (e instanceof ExprError) node.unsupported ??= `if: ${e.message}`;
          else throw e;
        }
      }
      for (const w of untrustedStepWarnings(job, id, event.name)) warnings.push(w);
      nodes.push(node);
    }
    legsOf.set(id, keys);
  }

  for (const n of nodes) n.needs = n.needsIds.flatMap((i) => legsOf.get(i) ?? []);
  if (opts.failOnLint && warnings.length > 0) throw lintError(warnings);
  return {
    ...(typeof doc.name === "string" ? { name: doc.name } : {}),
    ...(runNameResult.runName !== undefined ? { runName: runNameResult.runName } : {}),
    ...(runNameResult.warning ? { runNameWarning: runNameResult.warning } : {}),
    event,
    trigger,
    env,
    ...(concurrency ? { concurrency } : {}),
    jobs: topoSort(nodes),
    warnings,
    splitNotices,
  };
}

/** The longest display title kept for a run. */
export const RUN_NAME_MAX = 200;

/**
 * A workflow's `run-name` (GitHub's rules: only the `github` and `inputs` contexts). An expression
 * that reads anything else, or fails to evaluate, falls back to the default title (the reason is returned as `runNameWarning`; the docs call the fallback silent because nothing surfaces it yet).
 */
function evaluateRunName(
  raw: unknown,
  github: Record<string, Value>,
  inputs: Record<string, Value>,
): { runName?: string; warning?: string } {
  if (raw === undefined) return {};
  if (typeof raw !== "string")
    return { warning: "run-name is not a string; using the default title" };
  try {
    for (const m of raw.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
      const bad = [...referencedContexts((m[1] ?? "").trim())].filter(
        (c) => c !== "github" && c !== "inputs",
      );
      if (bad.length > 0)
        return {
          warning: `run-name may only use the github and inputs contexts (found ${bad.join(", ")}); using the default title`,
        };
    }
    const text = interpolate(raw, {
      contexts: { github, inputs },
      status: { needs: [], cancelled: false },
    });
    const title = text
      .replaceAll(/[\r\n]+/g, " ")
      .slice(0, RUN_NAME_MAX)
      .trim();
    return title === "" ? {} : { runName: title };
  } catch (e) {
    if (!(e instanceof ExprError)) throw e;
    return { warning: `run-name could not be evaluated (${e.message}); using the default title` };
  }
}

/** The steps of a job that are objects, in order. */
const stepsOf = (job: Obj): Obj[] =>
  (Array.isArray(job.steps) ? job.steps : []).map((s) => (isObj(s) ? s : {}));

/** Whether a step is named by `name` (its literal `name:`) or `#<n>` (its place, from 1). */
export function stepMatches(step: Obj, index: number, name: string): boolean {
  return name.startsWith("#") ? name === `#${index + 1}` : step.name === name;
}

/** Step names in the rule that no step of the job answers to. */
function unmatchedStepNames(job: Obj, rule: SplitRule): string[] {
  const steps = stepsOf(job);
  return rule.shards
    .flatMap((s) => s.steps)
    .filter((n) => !steps.some((s, i) => stepMatches(s, i, n)));
}

/**
 * Why a rule cannot be applied to this job (it then runs whole), or undefined: a job that has a
 * matrix or calls a reusable workflow, or whose declared outputs read a step that a shard owns
 * (another shard would not have it).
 */
function splitUnusable(job: Obj, rule: SplitRule, hasMatrix: boolean): string | undefined {
  if (hasMatrix) return "it has strategy.matrix";
  if (job.uses !== undefined) return "it calls a reusable workflow";
  const owned = stepsOf(job).flatMap((s, i) =>
    typeof s.id === "string" && rule.shards.some((sh) => sh.steps.some((n) => stepMatches(s, i, n)))
      ? [s.id]
      : [],
  );
  const outs = isObj(job.outputs) ? Object.values(job.outputs).map(String) : [];
  for (const id of owned)
    if (outs.some((o) => new RegExp(`steps\\.${id.replace(/[^A-Za-z0-9_-]/g, "\\$&")}\\.`).test(o)))
      return `its outputs read the output of step ${id}, which only one shard runs`;
  return undefined;
}

function untrustedStepWarnings(job: Obj, id: string, event: string): PlanWarning[] {
  const out: PlanWarning[] = [];
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const [i, s] of steps.entries()) {
    if (!isObj(s)) continue;
    const name = typeof s.name === "string" ? s.name : `step ${i + 1}`;
    if (typeof s.run === "string") out.push(...untrustedIn(`${id}: ${name}`, s.run));
  }
  if (isPrivilegedEvent(event)) {
    for (const h of findHeadCheckouts(steps)) {
      out.push({
        code: "privileged-head-checkout",
        step: `${id}: ${h.step}`,
        expression: h.expression,
        message: `step "${id}: ${h.step}" takes ${h.field} from the pull request head (${h.expression}) in a ${event} job; a privileged job must work from a protected ref`,
      });
    }
  }
  return out;
}

/** Orders jobs so every job follows its needs. Throws on a cycle. */
export function topoSort(nodes: readonly PlannedJob[]): PlannedJob[] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const out: PlannedJob[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (n: PlannedJob, path: string[]): void => {
    if (state.get(n.key) === 2) return;
    if (state.get(n.key) === 1)
      throw new PlanError("needs", `needs cycle: ${[...path, n.key].join(" -> ")}`);
    state.set(n.key, 1);
    for (const k of n.needs) visit(byKey.get(k) as PlannedJob, [...path, n.key]);
    state.set(n.key, 2);
    out.push(n);
  };
  for (const n of nodes) visit(n, []);
  return out;
}
