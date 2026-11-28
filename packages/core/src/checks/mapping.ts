// What a check run says. Pure functions: the mode decides the name, the conclusion and the text.
import { INFRA_KINDS, isInfraKind } from "@turntable/act-runner";
import type { ChecksMode } from "../db/repos";

export type AttemptResult = "success" | "failure" | "skipped" | "infra_error" | "cancelled";
export type Conclusion = "success" | "failure" | "neutral" | "cancelled" | "skipped";

/** A name from the workflow: one line, no markup-breaking characters, bounded. */
export function plain(text: string, max = 100): string {
  return text
    .replaceAll(/[\r\n\t`]+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * What a non-primary workflow's checks are named under (#549): the workflow's `name:`, or its
 * file name without the extension. Undefined for the primary workflow, whose checks keep the plain
 * names. Stored in the run's plan when the run is made; repo text, so cleaned like any other.
 */
export function checkScopeFor(
  primary: boolean | undefined,
  workflowPath: string,
  workflowName: string | null | undefined,
): string | undefined {
  if (primary !== false) return undefined;
  const file = (workflowPath.split("/").pop() ?? workflowPath).replace(/\.ya?ml$/i, "");
  return plain(workflowName?.trim() || file, 60) || plain(file, 60);
}

/** The `checkScope` a run's stored plan carries, cleaned; undefined when it has none. */
export function checkScopeOf(plan: string | null | undefined): string | undefined {
  if (!plan) return undefined;
  try {
    const v = (JSON.parse(plan) as { checkScope?: unknown }).checkScope;
    return typeof v === "string" && plain(v, 60) !== "" ? plain(v, 60) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The check name: `shadow / <job>` in shadow mode (so a required-check rule never matches it),
 * `turntable / <job>` in live mode, plus the matrix leg when the job has one.
 */
export function checkName(
  mode: Exclude<ChecksMode, "off">,
  job: { name: string; matrix: string | null },
  /** A non-primary workflow's name (`checkScopeOf` its run's plan): `turntable / <scope> / <job>`. */
  scope?: string | undefined,
): string {
  let leg = "";
  if (job.matrix) {
    try {
      const values = Object.values(JSON.parse(job.matrix) as Record<string, unknown>).map(String);
      const label = values.join(", ");
      if (label !== "" && !job.name.includes(label)) leg = ` (${plain(label, 60)})`;
    } catch {
      // an unreadable matrix adds no leg
    }
  }
  const mid = scope ? `${plain(scope, 60)} / ` : "";
  return `${mode === "shadow" ? "shadow" : "turntable"} / ${mid}${plain(job.name)}${leg}`;
}

const WORD: Record<AttemptResult, string> = {
  success: "success",
  failure: "failure",
  skipped: "skipped",
  cancelled: "cancelled",
  infra_error: "infrastructure error",
};

/**
 * Shadow mode is always `neutral`: it can never gate a merge, whatever happened. Live maps the
 * result; an infrastructure error is a `failure` with an infrastructure title, because nothing
 * trustworthy passed.
 */
export function conclusionFor(
  mode: Exclude<ChecksMode, "off">,
  result: AttemptResult | NoAttemptSkip,
): Conclusion {
  if (mode === "shadow") return "neutral";
  if (typeof result === "object") return "skipped";
  return result === "infra_error" ? "failure" : result;
}

/**
 * A job that ended `skipped` without ever running an attempt (a false `if:`, a failed or skipped
 * `needs`, every shard path-skipped). GitHub posts a `skipped` check for it, and branch protection
 * counts a skipped required check as satisfied, so a required context never stays pending.
 */
export type NoAttemptSkip = { result: "skipped"; attempt: false };
export const NO_ATTEMPT_SKIP: NoAttemptSkip = { result: "skipped", attempt: false };

/**
 * One rule per way a job can be skipped without running: the reason the scheduler stored on the
 * skipped attempt (the text after `skipped: `) in, a fixed public sentence out. Add a rule here for
 * a new reason; the first one to answer wins. Only fixed words and the changed-set source ever
 * reach a check run, never the raw `if:` text.
 */
export const SKIP_REASON_RULES: ((reason: string) => string | undefined)[] = [
  // Every shard limited by `paths` was skipped: `no shard paths changed: ... (<changed-set source>)`.
  (reason) => {
    if (!reason.startsWith("no shard paths changed")) return undefined;
    const source = /\(([^()]+)\)$/.exec(reason)?.[1];
    return source ? `no shard's paths changed: ${plain(source, 80)}` : "no shard's paths changed";
  },
];

export type SkipInput = {
  /** The skipped attempt's error class: `dependency:<state>` or `skipped: <reason>`. */
  errorClass: string | null;
  /** The job's `needs`, with the state each ended in. */
  needs: readonly { name: string; state: string }[];
};

const needsWas = (n: { name: string; state: string }): string =>
  `needs ${plain(n.name, 60)} was ${n.state}`;

/** Why a job ended skipped without an attempt, as a fixed sentence for the check summary. */
export function skipReasonFor(i: SkipInput): string {
  const ec = i.errorClass ?? "";
  const bad = (state?: string) =>
    i.needs.find((n) => (state ? n.state === state : n.state !== "success"));
  if (ec.startsWith("dependency:")) {
    const n = bad(ec.slice("dependency:".length)) ?? bad();
    if (n) return needsWas(n);
  }
  const reason = ec.startsWith("skipped: ") ? ec.slice("skipped: ".length) : "";
  for (const rule of SKIP_REASON_RULES) {
    const text = rule(reason);
    if (text !== undefined) return text;
  }
  if (/^cannot evaluate if:/.test(reason)) return "the if: expression could not be evaluated";
  if (/^if: .* is false$/s.test(reason)) {
    // The default `if: success()` is false because a need did not succeed.
    const n = reason === "if: success() is false" ? bad() : undefined;
    return n ? needsWas(n) : "the if: expression was false";
  }
  if (reason.startsWith("unsupported:")) return "the job uses a feature Turntable does not support";
  return "the job was skipped before it started";
}

/** The run's display title (run-name) as a title suffix: one line, no backticks, capped. */
function withRunName(title: string, runName?: string | null): string {
  const name = runName ? plain(runName, 100) : "";
  return name ? `${title} (${name})` : title;
}

export function titleFor(
  mode: Exclude<ChecksMode, "off">,
  result: AttemptResult | NoAttemptSkip,
  refused = false,
  runName?: string | null,
): string {
  const prefix = mode === "shadow" ? "Shadow" : "Turntable";
  if (refused) return withRunName(`${prefix}: cannot run this job`, runName);
  return withRunName(
    `${prefix}: ${typeof result === "object" ? "skipped" : WORD[result]}`,
    runName,
  );
}

export const RUNNING_TITLE = (mode: Exclude<ChecksMode, "off">, runName?: string | null): string =>
  withRunName(`${mode === "shadow" ? "Shadow" : "Turntable"}: running`, runName);

/** A code fence longer than any fence in the text, so the text cannot close it. */
export function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/**
 * Why an infrastructure error happened, as a fixed word. The raw reason is an exception message
 * (hostnames, paths, provider detail) and a check run is public on a public repo, so only this
 * class is ever published.
 */
export type InfraClass =
  | "sandbox_create_failed"
  | "exec_lost"
  | "provider_unavailable"
  | "timeout"
  | "isolation_policy"
  | "egress_policy"
  | "approval_required"
  | "plan_rejected"
  | "workflow_missing"
  | "runner_error"
  | "internal";

export function classifyInfra(reason: string | undefined): InfraClass {
  const r = (reason ?? "").toLowerCase();
  if (r.startsWith("isolation:")) return "isolation_policy";
  if (r.startsWith("egress:")) return "egress_policy";
  if (r.includes("approval")) return "approval_required";
  if (r.includes("plan rejected") || r.startsWith("lint") || r.startsWith("policy")) {
    return "plan_rejected";
  }
  if (r.includes("not found at")) return "workflow_missing";
  if (/timeout|timed out|deadline/.test(r)) return "timeout";
  if (/lost|controller_lost|probe|no exec|exec status|failed to resolve container ip/.test(r))
    return "exec_lost";
  if (/cannot prepare sandbox|sandbox.*(create|start|fail)|create.*sandbox/.test(r)) {
    return "sandbox_create_failed";
  }
  if (/provider|unreachable|econn|enotfound|network|fetch failed|dns|502|503|504/.test(r)) {
    return "provider_unavailable";
  }
  if (/act (exited|install)|without a job result/.test(r)) return "runner_error";
  return "internal";
}

/**
 * The line a check summary shows for a job on its infra retry (#517). Fixed words only: the kind
 * is looked up in the closed table, so nothing from the failed attempt reaches the text.
 */
export function infraRetryLine(kind: string | null | undefined): string | undefined {
  if (!isInfraKind(kind)) return undefined;
  return `**Retry:** this is the job's second attempt. The first one ended with an infrastructure error (${INFRA_KINDS[kind].label}) and its log is kept under that attempt.`;
}

export type SummaryInput = {
  mode: Exclude<ChecksMode, "off">;
  result: AttemptResult | NoAttemptSkip;
  runUrl: string | undefined;
  failingStep?: string | undefined;
  /** Already redacted and capped by the digest. */
  excerpt?: string | undefined;
  /** For infra_error: the classified reason. Never the raw text. */
  infraClass?: InfraClass | undefined;
  /** For a job split across sandboxes: one line per shard (fixed words and numbers only). */
  shards?: readonly string[] | undefined;
  /** For a job skipped without an attempt: the fixed reason sentence. */
  skipReason?: string | undefined;
  /** For a job Turntable refused to run: the stored `unsupported: ...` reason. */
  refusal?: string | undefined;
  /** The run's evaluated `run-name`, shown on the summary when the workflow has one. */
  runName?: string | null | undefined;
  /** The kind of the infra failure this attempt is the retry of (#517), when it is one. */
  retryOf?: string | null | undefined;
};

/** The fix a refused job's summary always offers. */
export const REFUSAL_FIX =
  "If this job should stay on another CI, gate it with `if: vars.TURNTABLE_CI != 'true'`.";

/**
 * A refusal reason (`unsupported: <text>`) as the sentence for a check summary, or undefined when
 * the reason is not one. The OS and arch texts are full sentences already; any other planner
 * reason (docker, services, ...) is wrapped. One line, no mentions, bounded.
 */
export function refusalSentence(reason: string | undefined): string | undefined {
  if (!reason?.startsWith("unsupported: ")) return undefined;
  const text = reason.slice("unsupported: ".length);
  // The OS and arch refusals are rebuilt from fixed words; only the label is workflow data, and it
  // goes inside a code span with its backticks stripped (`plain`), so no markup in it survives.
  const m = /^This job asks for (?:a (macOS|Windows)|an (arm64)) runner \(`([^`]*)`\)\./.exec(text);
  if (m) {
    const label = `\`${plain(m[3] ?? "", 60)}\``;
    if (m[2]) {
      return `This job asks for an arm64 runner (${label}). The sandbox provider offers amd64 only; arm runners are not supported by it.`;
    }
    return `This job asks for a ${m[1]} runner (${label}). Turntable runs Linux sandboxes only; ${m[1]} runners are not supported yet.`;
  }
  // Any other planner reason may quote workflow text (an action name, an image): inert in a span.
  return `Turntable cannot run this job: \`${plain(text, 200)}\`.`;
}

/**
 * The summary. Fixed text, the real result, the failing step and the digest excerpt in a code
 * fence (so markdown, links and mentions in log text stay inert). Never more log than the digest.
 */
export function summaryFor(i: SummaryInput): string {
  const word = typeof i.result === "object" ? "skipped" : WORD[i.result];
  const lines: string[] = [`**Result:** ${word}`];
  if (i.runName) lines.push(`**Run:** ${plain(i.runName, 200)}`);
  if (i.skipReason) lines.push(`**Reason:** ${i.skipReason}`);
  if (i.mode === "shadow") {
    lines.push(
      "This is a shadow check: it is always neutral and never gates a merge. The result above is what Turntable found.",
    );
  }
  if (i.refusal) lines.push(`${i.refusal}\n\n${REFUSAL_FIX}`);
  const retry = infraRetryLine(i.retryOf);
  if (retry) lines.push(retry);
  if (i.result === "infra_error") {
    lines.push(
      "Infrastructure error: the sandbox or the runner failed, so this says nothing about the code.",
    );
    lines.push(`Reason: ${i.infraClass ?? "internal"}. See the Turntable run for details.`);
  }
  if (i.shards && i.shards.length > 0)
    lines.push(`**Shards:**\n${i.shards.map((s) => `- ${s}`).join("\n")}`);
  if (i.failingStep) lines.push(`**Failing step:** ${plain(i.failingStep, 120)}`);
  if (i.runUrl) lines.push(`[Open the run in Turntable](${i.runUrl})`);
  if (i.excerpt) lines.push(fenced(i.excerpt));
  return lines.join("\n\n");
}
