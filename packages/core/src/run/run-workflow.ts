import {
  githubContext,
  planWorkflow,
  type ActTarball,
  type ActionFetcher,
  type ActionRefResolver,
  type Value,
  type WorkflowEvent,
} from "@turntable/act-runner";
import type { SafeFetch } from "@turntable/net";
import type { Provider } from "@turntable/provider-sdk";
import { type Db } from "../db";
import {
  appendAudit,
  cancelRunJobs,
  createLocalRun,
  getRun,
  listAttempts,
  listJobs,
  readLog,
  type PolledJob,
  type Scope,
} from "../db/repos";
import { createForgeToken } from "../pins/forge-token";
import type { ReachabilityChecker } from "../pins/reachability";
import { createActRunner, localRepoSource } from "../scheduler/act-runner";
import { Scheduler } from "../scheduler/scheduler";
import type { AttemptRunner } from "../scheduler/types";
import { EXIT, type ExitCode, type Verdict } from "./job-exec";
import { workflowNameOf } from "./run-local";

export interface RunWorkflowOptions {
  provider: Provider;
  providerName: string;
  db: Db;
  scope: Required<Scope>;
  /** Workflow path relative to the repo root. */
  workflowPath: string;
  workflowYaml: string;
  event: WorkflowEvent;
  /** The base branch commit, for `github.event.pull_request.base.sha`. */
  baseSha?: string;
  sha?: string;
  commitMessage?: string;
  actor?: string;
  headBranch?: string;
  repoTarball: Uint8Array;
  image: string;
  out: (text: string) => void;
  readFile: (path: string) => string | undefined;
  resolver?: ActionRefResolver;
  /**
   * The operator's GitHub token (default: TURNTABLE_GITHUB_TOKEN) for resolving and verifying
   * actions. A local run is the operator's own checkout, so it is used for any action that
   * passes the public check (a private or missing repo is refused with the same words).
   */
  githubToken?: string;
  /** Test seams for action verification. */
  reachable?: ReachabilityChecker;
  fetch?: SafeFetch;
  egress?: "none" | "open";
  /** Probe each `none` sandbox for a real network path before its job runs. */
  canary?: boolean;
  /** Aborting cancels the run: running jobs stop and their sandboxes are destroyed. */
  signal?: AbortSignal;
  /** Jobs running at once, one sandbox each. Default 2. */
  maxParallel?: number;
  vars?: Record<string, Value>;
  // Test seams.
  planRoot?: string;
  act?: ActTarball;
  fetchAction?: ActionFetcher;
  pollMs?: number;
  timeoutSeconds?: number;
}

export interface WorkflowJobResult {
  key: string;
  name: string;
  state: Verdict;
  reason: string;
  outputs?: Record<string, string>;
}

export interface RunWorkflowResult {
  /** False when the workflow's `on:` does not trigger for this event: nothing ran. */
  triggered: boolean;
  triggerReason: string;
  state: Verdict;
  exitCode: ExitCode;
  runId?: string;
  jobs: WorkflowJobResult[];
}

function eventPayload(o: RunWorkflowOptions): Value {
  const e = o.event;
  if (e.name === "pull_request" || e.name === "pull_request_target") {
    return {
      ...(e.action ? { action: e.action } : {}),
      pull_request: {
        base: { ref: e.baseRef ?? "", ...(o.baseSha ? { sha: o.baseSha } : {}) },
        head: { ref: o.headBranch ?? "", sha: o.sha ?? "" },
        draft: false,
      },
    };
  }
  return e.action ? { action: e.action } : {};
}

/** The reason a job was skipped or cancelled, from the line the scheduler stored as its log. */
async function storedReason(db: Db, scope: Required<Scope>, jobId: string): Promise<string> {
  const attempt = (await listAttempts(db, scope, jobId)).at(-1);
  if (!attempt) return "";
  const log = Buffer.concat((await readLog(db, scope, attempt.id)).map((c) => c.bytes)).toString();
  const line = log.split("\n", 1)[0] ?? "";
  // An infrastructure error that left no log (a crash before the job ran) is kept as the
  // attempt's error class.
  if (line === "" && attempt.errorClass) return attempt.errorClass;
  return line.replace(/^(skipped|cancelled): /, "");
}

const TERMINAL = new Set(["success", "failure", "infra_error", "cancelled", "skipped"]);

/**
 * Runs a whole workflow through the same scheduler path as the server: the plan is stored as a
 * local run (see `runs.local`), and an in-process scheduler claims its jobs as their needs
 * finish, one sandbox per job (at most `maxParallel` at once), runs each with act through the
 * shared job runner and records the outcome. Jobs that cannot run here (docker) or whose `if:`
 * is false are recorded as skipped with the reason; their dependents see `skipped`. A workflow
 * that does not trigger for the event runs nothing. Aborting the signal cancels the run through
 * the same path as a manual cancel.
 */
export async function runWorkflowLocal(o: RunWorkflowOptions): Promise<RunWorkflowResult> {
  const workflowName = workflowNameOf(o.workflowYaml);
  const githubExtra: Record<string, Value> = {
    ...(o.sha ? { sha: o.sha } : {}),
    ...(o.actor ? { actor: o.actor } : {}),
    ...(o.headBranch ? { head_ref: o.headBranch } : {}),
    ...(workflowName ? { workflow: workflowName } : {}),
    event: eventPayload(o),
  };
  const wp = planWorkflow(o.workflowYaml, o.event, {
    readFile: o.readFile,
    github: githubExtra,
    ...(o.vars ? { vars: o.vars } : {}),
  });
  if (!wp.trigger.matched) {
    return {
      triggered: false,
      triggerReason: wp.trigger.reason,
      state: "skipped",
      exitCode: 0,
      jobs: [],
    };
  }
  for (const w of wp.warnings) o.out(`warning: ${w.message}\n`);
  if (wp.trigger.pathsUnknown) o.out(`note: ${wp.trigger.reason}\n`);

  // A supplied resolver (a test seam) is used as is, with refs memoised per run. Otherwise the
  // runner resolves with the operator's token and keeps verdicts in the database.
  const resolver: ActionRefResolver | undefined = o.resolver
    ? (() => {
        const base = o.resolver;
        const memo = new Map<string, Promise<string>>();
        return (owner: string, repo: string, ref: string): Promise<string> => {
          const k = `${owner}/${repo}@${ref}`;
          let p = memo.get(k);
          if (!p) {
            p = base(owner, repo, ref);
            memo.set(k, p);
          }
          return p;
        };
      })()
    : undefined;

  const jobs: PolledJob[] = wp.jobs.map((n) => ({
    key: n.key,
    name: n.name,
    needs: n.needs,
    ...(n.matrix ? { matrix: n.matrix } : {}),
    planned: n,
  }));
  const run = await createLocalRun(o.db, o.scope, {
    provider: o.providerName,
    jobs,
    run: {
      workflowPath: o.workflowPath,
      event: o.event.name,
      ref: o.event.ref ?? "refs/heads/main",
      ...(o.sha ? { sha: o.sha } : {}),
      workflowName,
      commitMessage: o.commitMessage,
      actor: o.actor,
      headBranch: o.headBranch,
      plan: JSON.stringify({
        env: wp.env,
        github: githubContext(o.event, githubExtra),
        vars: o.vars ?? {},
        ...(wp.concurrency ? { concurrency: wp.concurrency } : {}),
      }),
    },
  });
  const runId = run.id;
  await appendAudit(o.db, o.scope, {
    principalKind: "cli",
    principalId: "local",
    op: "run_local",
    effect: "write",
    outcome: "ok",
    input: {
      runId,
      workflow: o.workflowPath,
      jobs: wp.jobs.map((j) => j.key),
      provider: o.providerName,
      image: o.image,
      egress: o.egress ?? "none",
      ...(wp.concurrency ? { concurrency: wp.concurrency } : {}),
    },
  });

  const inner = createActRunner({
    db: o.db,
    source: localRepoSource({
      tarball: o.repoTarball,
      workflowPath: o.workflowPath,
      workflowYaml: o.workflowYaml,
      readFile: o.readFile,
    }),
    image: o.image,
    ...(resolver ? { resolver } : {}),
    forgeToken: createForgeToken({
      db: o.db,
      envToken: o.githubToken ?? (process.env.TURNTABLE_GITHUB_TOKEN?.trim() || undefined),
      log: (m) => o.out(`warning: ${m}\n`),
    }),
    ...(o.reachable ? { reachable: o.reachable } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.egress ? { egress: o.egress } : {}),
    ...(o.canary ? { canary: true } : {}),
    ...(o.timeoutSeconds !== undefined ? { timeoutSeconds: o.timeoutSeconds } : {}),
    ...(o.act ? { act: o.act } : {}),
    ...(o.fetchAction ? { fetchAction: o.fetchAction } : {}),
    ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
    ...(o.planRoot ? { planRoot: o.planRoot } : {}),
    out: (_key, text) => o.out(text),
  });
  // What each job's runner reported, for the summary (the database keeps only infra reasons).
  const reasons = new Map<string, string>();
  const runner: AttemptRunner = async (ctx) => {
    try {
      const outcome = await inner(ctx);
      reasons.set(ctx.job.jobKey, outcome.reason);
      return outcome;
    } catch (err) {
      // The scheduler records a thrown error as an infrastructure error with its message; the
      // summary and the terminal must say the same, never an empty reason.
      const reason = err instanceof Error ? err.message : String(err);
      reasons.set(ctx.job.jobKey, reason);
      o.out(`[${ctx.job.jobKey}] ${reason}\n`);
      throw err;
    }
  };

  const cap = Math.max(1, o.maxParallel ?? 2);
  const sched = new Scheduler({
    db: o.db,
    runner,
    providers: (name) => (name === o.providerName ? o.provider : undefined),
    onlyRun: runId,
    globalCap: cap,
    perOrgCap: cap,
    pollMs: 50,
  });
  const cancel = (): void => {
    void cancelRunJobs(o.db, o.scope, runId);
  };
  o.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (o.signal?.aborted) await cancelRunJobs(o.db, o.scope, runId);
    sched.start();
    for (;;) {
      const current = await getRun(o.db, o.scope, runId);
      if (current && TERMINAL.has(current.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    o.signal?.removeEventListener("abort", cancel);
    // Waits for running attempts, so a cancelled job's sandbox is gone before this returns.
    await sched.stop({ abort: true });
  }

  const rows = await listJobs(o.db, o.scope, runId);
  const results: WorkflowJobResult[] = [];
  for (const n of wp.jobs) {
    // A job with a run-time matrix is renamed to its first leg `id[0]`, and more legs follow.
    const exact = rows.filter((r) => r.jobKey === n.key);
    const matched = exact.length > 0 ? exact : rows.filter((r) => r.jobKey.startsWith(`${n.key}[`));
    for (const row of matched.length > 0 ? matched : [undefined]) {
      const key = row?.jobKey ?? n.key;
      const state: Verdict = row && TERMINAL.has(row.state) ? (row.state as Verdict) : "cancelled";
      const reason = reasons.get(key) ?? (row ? await storedReason(o.db, o.scope, row.id) : "");
      if (state === "skipped") o.out(`[${key}] skipped: ${reason}\n`);
      results.push({
        key,
        name: row && row.jobKey !== n.key ? row.name : n.name,
        state,
        reason,
        ...(row?.outputs ? { outputs: JSON.parse(row.outputs) as Record<string, string> } : {}),
      });
    }
  }
  const status = (await getRun(o.db, o.scope, runId))?.status ?? "cancelled";
  const state: Verdict = TERMINAL.has(status) ? (status as Verdict) : "cancelled";
  return {
    triggered: true,
    triggerReason: wp.trigger.reason,
    state,
    exitCode: EXIT[state],
    runId,
    jobs: results,
  };
}
