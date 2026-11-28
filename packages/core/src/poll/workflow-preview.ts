// The dry run behind `preview_workflows`: what Turntable would do with each job of one workflow
// file, decided by the real planner and the real refusal rules, never by running anything. Pure:
// text in, verdicts out. The output carries ids, names and fixed words only, never file content.
import { planWorkflow, type PlannedJob, type WorkflowEvent } from "@turntable/act-runner";
import { parse } from "yaml";
import { refusalFor } from "../scheduler/sandbox-size";
import type { ContainerJobs } from "./onboarding-forge";

/** Events Turntable ingests today (a tag push is a `push`). `schedule` is not ingested yet. */
export const INGESTED_EVENTS: readonly string[] = [
  "push",
  "pull_request",
  "merge_group",
  "workflow_dispatch",
];

export type RefusalKind =
  | "other_os"
  | "arm"
  | "docker"
  | "reusable"
  | "matrix_expression"
  | "environment_expression"
  | "expression"
  | "plan_error"
  | "other";

const GATE = "add `if: vars.TURNTABLE_CI != 'true'` to the job to skip it on Turntable";

/** The fix for each refusal kind. Fixed text: nothing from the workflow is ever put in it. */
export const FIX_BY_KIND: Readonly<Record<RefusalKind, string>> = {
  other_os: GATE,
  arm: GATE,
  docker: `${GATE}, or ask the instance operator for a Docker-capable size class`,
  reusable: `${GATE}, or inline the called workflow's jobs`,
  matrix_expression: `${GATE}, or write the matrix out as a literal list`,
  environment_expression: `${GATE}, or name the environment literally`,
  expression: `${GATE}, or simplify the expression`,
  plan_error: "fix the workflow so it parses and plans, then preview again",
  other: GATE,
};

/** Which refusal a planner `unsupported` text is. Keyed on the planner's own fixed phrases. */
export function refusalKind(why: string): RefusalKind {
  if (/runner \(`/.test(why) && /macOS|Windows/.test(why)) return "other_os";
  if (/arm64 runner/.test(why)) return "arm";
  if (/reusable workflow/.test(why)) return "reusable";
  if (/matrix built from an expression/.test(why)) return "matrix_expression";
  if (/^unsupported: environment:|^environment:/.test(why)) return "environment_expression";
  if (/docker|services:|container:/i.test(why)) return "docker";
  if (/if:|continue-on-error expression/.test(why)) return "expression";
  return "other";
}

/** One `secrets.*` or `vars.*` name a job refers to. A name and fixed words only, never a value. */
export type PreviewRef = {
  kind: "secret" | "var";
  name: string;
  /** Where it is used, for example "job env", "step with", "step if". */
  where: string[];
  /** True for `secrets.GITHUB_TOKEN`, which Turntable provides: it is never needed. */
  provided: boolean;
};

export type PreviewJob = {
  job_id: string;
  name: string | null;
  verdict: "run" | "skip" | "fail";
  reason?: string;
  fix?: string;
  /** For `run`: host mode, or act's container mode for a job with services: or container: (#796). */
  mode?: "host" | "container";
  refs: PreviewRef[];
};

const REF =
  /\b(secrets|vars)(?:\.([A-Za-z_][A-Za-z0-9_-]{0,99})|\[\s*['"]([A-Za-z_][A-Za-z0-9_-]{0,99})['"]\s*\])/g;
const MAX_REFS = 100;

type Found = Map<string, PreviewRef>;

function scanText(text: string, where: string, out: Found): void {
  for (const m of text.matchAll(REF)) {
    const kind = m[1] === "secrets" ? "secret" : "var";
    const name = (m[2] ?? m[3])!;
    const key = `${kind}:${name.toUpperCase()}`;
    const cur = out.get(key);
    if (cur) {
      if (!cur.where.includes(where)) cur.where.push(where);
    } else if (out.size < MAX_REFS) {
      out.set(key, {
        kind,
        name: kind === "secret" ? name.toUpperCase() : name,
        where: [where],
        provided: kind === "secret" && name.toUpperCase() === "GITHUB_TOKEN",
      });
    }
  }
}

function scanValue(v: unknown, where: string, out: Found, depth = 0): void {
  if (typeof v === "string") scanText(v, where, out);
  else if (depth < 6 && v !== null && typeof v === "object") {
    for (const x of Object.values(v)) scanValue(x, where, out, depth + 1);
  }
}

/** Every secret and var reference of one job: env, with, if and run at job and step level. */
export function jobRefs(job: unknown, workflowEnv: unknown): PreviewRef[] {
  const out: Found = new Map();
  scanValue(workflowEnv, "workflow env", out);
  if (job === null || typeof job !== "object") return [];
  const j = job as Record<string, unknown>;
  scanValue(j.env, "job env", out);
  scanValue(j.with, "job with", out);
  scanValue(j.if, "job if", out);
  scanValue(j["runs-on"], "job runs-on", out);
  scanValue(j.container, "job container", out);
  scanValue(j.services, "job services", out);
  if (Array.isArray(j.steps)) {
    for (const st of j.steps) {
      if (st === null || typeof st !== "object") continue;
      const s = st as Record<string, unknown>;
      scanValue(s.env, "step env", out);
      scanValue(s.with, "step with", out);
      scanValue(s.if, "step if", out);
      scanValue(s.run, "step run", out);
    }
  }
  return [...out.values()];
}

export type WorkflowPreview = {
  name: string | null;
  triggers: string[];
  /** True when a trigger Turntable ingests is present. */
  hasIngestedTrigger: boolean;
  jobs: PreviewJob[];
};

const clip = (s: string, n: number): string => s.replaceAll(/[\r\n]+/g, " ").slice(0, n);

function triggerNames(on: unknown): string[] {
  const names =
    typeof on === "string"
      ? [on]
      : Array.isArray(on)
        ? on.filter((x): x is string => typeof x === "string")
        : on !== null && typeof on === "object"
          ? Object.keys(on)
          : [];
  return names.slice(0, 20).map((n) => clip(n, 64));
}

export function previewWorkflow(
  yaml: string,
  o: { defaultBranch: string; vars: Record<string, string>; containerJobs?: ContainerJobs },
): WorkflowPreview | undefined {
  let doc: unknown;
  try {
    doc = parse(yaml, { merge: true });
  } catch {
    return undefined;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return undefined;
  const root = doc as {
    name?: unknown;
    on?: unknown;
    true?: unknown;
    jobs?: unknown;
    env?: unknown;
  };
  if (root.jobs === null || typeof root.jobs !== "object") return undefined;
  const triggers = triggerNames(root.on ?? root.true);
  const hasIngestedTrigger = triggers.some((t) => INGESTED_EVENTS.includes(t));
  const base = {
    name: typeof root.name === "string" ? clip(root.name, 200) : null,
    triggers,
    hasIngestedTrigger,
  };
  const ids = Object.keys(root.jobs as object);
  const jobNames = new Map<string, string | null>(
    ids.map((id) => {
      const j = (root.jobs as Record<string, { name?: unknown } | null>)[id];
      return [id, typeof j?.name === "string" ? clip(j.name, 200) : null];
    }),
  );
  const row = (
    id: string,
    rest: Partial<PreviewJob> & Pick<PreviewJob, "verdict">,
  ): PreviewJob => ({
    job_id: clip(id, 100),
    name: jobNames.get(id) ?? null,
    refs: jobRefs((root.jobs as Record<string, unknown>)[id], root.env),
    ...rest,
  });
  if (!hasIngestedTrigger) {
    return {
      ...base,
      jobs: ids.map((id) =>
        row(id, { verdict: "skip", reason: "this workflow has no trigger Turntable ingests" }),
      ),
    };
  }
  // Plan with the event the workflow would most likely get on the default branch.
  const name =
    ["push", "pull_request", "merge_group", "workflow_dispatch"].find((e) =>
      triggers.includes(e),
    ) ?? "push";
  const event: WorkflowEvent = {
    name,
    ref: name === "pull_request" ? "refs/pull/1/head" : `refs/heads/${o.defaultBranch}`,
    ...(name === "pull_request" || name === "merge_group" ? { baseRef: o.defaultBranch } : {}),
  };
  let nodes: PlannedJob[];
  try {
    nodes = planWorkflow(yaml, event, {
      // Local composite actions are not fetched: a docker step inside one is not seen here.
      readFile: () => undefined,
      vars: o.vars,
      github: { sha: "0".repeat(40), actor: "preview" },
    }).jobs;
  } catch {
    // The planner's message can quote the file; the preview says only that it cannot plan.
    return {
      ...base,
      jobs: ids.map((id) =>
        row(id, {
          verdict: "fail",
          reason: "the planner cannot read this workflow",
          fix: FIX_BY_KIND.plan_error,
        }),
      ),
    };
  }
  const jobs = ids.map((id): PreviewJob => {
    const legs = nodes.filter((n) => n.id === id);
    let container = false;
    for (const n of legs) {
      // The provider's arch is unknown here: assume amd64 only, as the default providers are.
      let why = refusalFor(n, ["amd64"]);
      if (why === undefined && n.needsDocker !== undefined) {
        // The scheduler's own rule for a trusted run (default branch): a Docker-capable class
        // on a provider that can host Docker runs it in container mode, else the same refusal.
        const v = o.containerJobs?.(n.needsDocker);
        if (v?.runnable) container = true;
        else
          why =
            v?.reason ??
            `unsupported: ${clip(n.needsDocker, 80)}; this server cannot tell whether a Docker-capable size class exists (it runs no worker)`;
      }
      if (why) {
        return row(id, {
          verdict: "fail",
          reason: clip(why, 300),
          fix: FIX_BY_KIND[refusalKind(why)],
        });
      }
    }
    if (legs.length > 0 && legs.every((n) => n.staticSkip)) {
      return row(id, {
        verdict: "skip",
        reason: "its `if:` condition is false on Turntable before the job starts",
      });
    }
    return row(id, { verdict: "run", mode: container ? "container" : "host" });
  });
  return { ...base, jobs };
}
