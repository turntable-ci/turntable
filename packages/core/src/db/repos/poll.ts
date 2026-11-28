// Poll ingest persistence. Part of the only code that names tenant tables.
import { and, count, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import {
  cancelRunJobs,
  createAttempt,
  createJob,
  createRun,
  type Job,
  type JobAttempt,
  type Run,
  type RunInput,
  setRunStatus,
  transitionJob,
  updateAttempt,
} from "./index";
import { clearRecentDismissals, type DismissReason } from "./dismissals";
import { getEnvPolicy, plannedEnvironment } from "./approvals";
import { requireProject, type Scope, scoped } from "./scope";
import { HELD_FOR_APPROVAL } from "./waiting";

const SEEN_COLS = { orgId: s.pollSeen.orgId, projectId: s.pollSeen.projectId };

/** Most jobs one run may have. A workflow with more is refused at ingest. */
export const MAX_JOBS_PER_RUN = 256;

/**
 * Checks a run's job graph: at most MAX_JOBS_PER_RUN jobs, unique keys, every `needs` entry names
 * a job of the run, and no cycles (a self-dependency is one). Returns the first problem, or
 * undefined when the graph is sound.
 */
export function validateJobGraph(
  jobs: readonly { key: string; needs: readonly string[] }[],
): string | undefined {
  if (jobs.length > MAX_JOBS_PER_RUN) {
    return `workflow has ${jobs.length} jobs; the limit is ${MAX_JOBS_PER_RUN}`;
  }
  const byKey = new Map<string, readonly string[]>();
  for (const job of jobs) {
    if (byKey.has(job.key)) return `duplicate job key ${job.key}`;
    byKey.set(job.key, job.needs);
  }
  for (const job of jobs) {
    for (const need of job.needs) {
      if (!byKey.has(need)) return `job ${job.key} needs unknown job ${need}`;
    }
  }
  // Depth-first search with colours: grey on the current path, black when finished.
  const colour = new Map<string, "grey" | "black">();
  const visit = (key: string, path: string[]): string | undefined => {
    colour.set(key, "grey");
    for (const need of byKey.get(key) ?? []) {
      if (colour.get(need) === "grey")
        return `dependency cycle: ${[...path, key, need].join(" -> ")}`;
      if (!colour.has(need)) {
        const found = visit(need, [...path, key]);
        if (found) return found;
      }
    }
    colour.set(key, "black");
    return undefined;
  };
  for (const job of jobs) {
    if (!colour.has(job.key)) {
      const found = visit(job.key, []);
      if (found) return found;
    }
  }
  return undefined;
}

export type PolledJob = {
  key: string;
  name: string;
  needs: readonly string[];
  matrix?: Record<string, unknown> | undefined;
  /** The planned job (see PlannedJob in act-runner), kept as JSON for the scheduler. */
  planned?: unknown;
};

/** What a newer run took from older ones in its concurrency group. */
export type Superseded = {
  runIds: string[];
  /** Attempts that were running: their workers must stop and their sandboxes be destroyed. */
  running: { attemptId: string; sandboxId: string | null; provider: string }[];
};

/** The run, its jobs and a queued attempt per job. Shared by the poller and `turntable run`. */
async function insertPlannedRun(
  tx: Db,
  scope: Scope,
  input: {
    run: RunInput;
    jobs: readonly PolledJob[];
    provider: string;
    hold?: boolean | undefined;
  },
): Promise<Run> {
  const run = await createRun(tx, scope, input.run);
  for (const job of input.jobs) {
    // A job in a protected environment waits for human approval from the moment it exists (an
    // untrusted run is already held whole). A local run is the developer's own and is not gated.
    const environment = plannedEnvironment(job.planned);
    const gated =
      !input.hold &&
      !input.run.local &&
      environment !== undefined &&
      (await getEnvPolicy(tx, scope.orgId, environment)).gated;
    const created = await createJob(tx, scope, {
      runId: run.id,
      jobKey: job.key,
      name: job.name,
      needs: job.needs,
      ...(job.matrix ? { matrix: job.matrix } : {}),
      ...(job.planned === undefined ? {} : { planned: job.planned }),
      // A held run's jobs wait for a human, from the moment they exist: in this same transaction,
      // so no scheduler tick can claim one in between.
      ...(input.hold ? { approvalKind: "untrusted_author" as const } : {}),
      ...(gated ? { approvalKind: "environment" as const } : {}),
    });
    if (!created) continue;
    const attempt = await createAttempt(tx, scope, { jobId: created.id, provider: input.provider });
    if ((input.hold || gated) && attempt) {
      await transitionJob(tx, scope, created.id, "awaiting_approval");
      await updateAttempt(tx, scope, attempt.id, {
        state: "awaiting_approval",
        ...HELD_FOR_APPROVAL,
      });
    }
  }
  if (input.hold) return (await setRunStatus(tx, scope, run.id, "awaiting_approval")) ?? run;
  return run;
}

/**
 * Creates a run started by `turntable run`: the planned jobs with queued attempts, marked
 * `local` so only the starting process runs them. No poll marker, no concurrency group (a local
 * run never waits for, or cancels, another).
 */
export function createLocalRun(
  db: Db,
  scope: Scope,
  input: { run: RunInput; jobs: readonly PolledJob[]; provider: string },
): Promise<Run> {
  const invalid = validateJobGraph(input.jobs);
  if (invalid) return Promise.reject(new Error(`invalid job graph: ${invalid}`));
  return db.transaction((tx) =>
    insertPlannedRun(tx, scope, {
      ...input,
      run: { ...input.run, local: true, concurrencyGroup: undefined },
    }),
  );
}

/**
 * Creates the run, its jobs and a queued attempt per job for something the poller found, once
 * per (repo, workflow, event, sha): a second call for the same key returns `undefined` and
 * changes nothing. The key check, the rows and the marker commit in one transaction.
 */
export function createPolledRun(
  db: Db,
  scope: Scope,
  input: {
    /** `owner/name`, any case. */
    repo: string;
    run: RunInput & { sha: string };
    jobs: readonly PolledJob[];
    provider: string;
    /** Epoch ms stamped on the marker; the hourly cap counts by it. Default: the clock. */
    now?: number | undefined;
    /** Cancel older runs of the same concurrency group (cancel-in-progress). */
    cancelInProgress?: boolean | undefined;
    /** Hold every job for approval (an untrusted class): nothing can start until approved. */
    hold?: boolean | undefined;
    /**
     * What the dedupe marker is keyed on instead of the run's event: a tag run is keyed
     * `tag:<name>` so a tag at the same commit as the default branch head is still its own run.
     */
    seenEvent?: string | undefined;
  },
): Promise<{ run: Run; superseded: Superseded } | undefined> {
  const invalid = validateJobGraph(input.jobs);
  if (invalid) return Promise.reject(new Error(`invalid job graph: ${invalid}`));
  return db.transaction(async (tx) => {
    const { projectId } = requireProject(scope);
    const key = {
      projectId,
      repo: input.repo.toLowerCase(),
      workflowPath: input.run.workflowPath,
      event: input.seenEvent ?? input.run.event,
      sha: input.run.sha,
    };
    const [seen] = await tx.orm
      .select({ n: count() })
      .from(s.pollSeen)
      .where(
        and(
          eq(s.pollSeen.projectId, key.projectId),
          eq(s.pollSeen.repo, key.repo),
          eq(s.pollSeen.workflowPath, key.workflowPath),
          eq(s.pollSeen.event, key.event),
          eq(s.pollSeen.sha, key.sha),
        ),
      );
    if (Number(seen?.n ?? 0) > 0) return undefined;
    const run = await insertPlannedRun(tx, scope, {
      ...input,
      run: { ...input.run, repo: input.repo },
    });
    await tx.orm.insert(s.pollSeen).values({
      orgId: scope.orgId,
      ...key,
      runId: run.id,
      ...(input.now === undefined ? {} : { createdAt: input.now }),
    });
    // The new run exists (rows and marker) before anything is cancelled: if this transaction
    // fails, nothing was superseded, and no moment has neither run (reliability rule R3).
    const superseded = run.concurrencyGroup
      ? await supersedeOlderRuns(tx, scope, run, input.cancelInProgress ? "all" : "pending")
      : { runIds: [], running: [] };
    // A new head sha of a pull request makes older runs of it that still wait for approval
    // stale: an approval is for one sha, so they could never be used.
    if (run.prNumber !== null) {
      for (const stale of await olderWaitingForPr(tx, run)) {
        const res = await cancelRunJobs(tx, scope, stale.id, {
          errorClass: "replaced by a newer push to the pull request",
        });
        if (res) superseded.runIds.push(stale.id);
      }
    }
    return { run, superseded };
  });
}

/** Runs the poller created for a repo since `since` (epoch ms): the per-hour cap counts these. */
export function countPolledSince(
  db: Db,
  scope: Scope,
  repo: string,
  since: number,
): Promise<number> {
  return db.run(async (h) => {
    // Runs held for approval are not counted: strangers' pull requests must not use up the cap
    // that the default branch's own runs depend on (they have their own cap, see countWaitingRuns).
    const [row] = await h.orm
      .select({ n: count() })
      .from(s.pollSeen)
      .leftJoin(s.runs, and(eq(s.runs.id, s.pollSeen.runId), eq(s.runs.orgId, s.pollSeen.orgId)))
      .where(
        and(
          scoped(
            scope,
            SEEN_COLS,
            eq(s.pollSeen.repo, repo.toLowerCase()),
            gte(s.pollSeen.createdAt, since),
          ),
          // Pushes always count. A pull request counts only when its run is classified and not
          // untrusted: an untrusted or not-yet-classified marker must never use the trusted budget.
          sql`(${s.pollSeen.event} = 'push' OR (${s.runs.id} IS NOT NULL AND (${s.runs.trust} IS NULL OR ${s.runs.trust} NOT LIKE '{"class":"untrusted_pr"%')))`,
        ),
      );
    return Number(row?.n ?? 0);
  });
}

/** Matches runs of the same repo as `run` (a run with no repo matches only runs with none). */
const sameRepoAs = (run: Run) =>
  run.repo === null ? isNull(s.runs.repo) : eq(s.runs.repo, run.repo);

/** Unfinished runs of a run's concurrency group that are older than it. */
async function olderUnfinished(db: Db, run: Run): Promise<Run[]> {
  if (!run.concurrencyGroup) return [];
  return db.orm
    .select()
    .from(s.runs)
    .where(
      and(
        eq(s.runs.orgId, run.orgId),
        eq(s.runs.projectId, run.projectId),
        eq(s.runs.concurrencyGroup, run.concurrencyGroup),
        // A group is per repo: a project can bind several, and one must not touch another's.
        sameRepoAs(run),
        lt(s.runs.id, run.id),
        inArray(s.runs.status, ["queued", "running", "awaiting_approval"]),
      ),
    );
}

/** Older runs of the same pull request and workflow that wait for approval. */
async function olderWaitingForPr(db: Db, run: Run): Promise<Run[]> {
  return db.orm
    .select()
    .from(s.runs)
    .where(
      and(
        eq(s.runs.orgId, run.orgId),
        eq(s.runs.projectId, run.projectId),
        eq(s.runs.workflowPath, run.workflowPath),
        sameRepoAs(run),
        run.prNumber === null ? sql`0` : eq(s.runs.prNumber, run.prNumber),
        lt(s.runs.id, run.id),
        eq(s.runs.status, "awaiting_approval"),
      ),
    );
}

/** Runs of one repo waiting for approval. A cap on this keeps strangers from filling the queue. */
export function countWaitingRuns(
  db: Db,
  scope: Scope,
  repo: string,
  /** A pull request whose waiting runs a new push is about to replace: not counted. */
  exceptPr?: number,
): Promise<number> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const [row] = await h.orm
      .select({ n: count() })
      .from(s.runs)
      .where(
        and(
          eq(s.runs.orgId, scope.orgId),
          eq(s.runs.projectId, projectId),
          eq(s.runs.repo, repo.toLowerCase()),
          eq(s.runs.status, "awaiting_approval"),
          ...(exceptPr === undefined
            ? []
            : [sql`(${s.runs.prNumber} IS NULL OR ${s.runs.prNumber} != ${exceptPr})`]),
        ),
      );
    return Number(row?.n ?? 0);
  });
}

/**
 * The pull request runs of one repo that wait for approval, oldest first. Only runs made for a
 * pull request: a label can never release a held tag or any other run.
 */
export function listWaitingPrRuns(db: Db, scope: Scope, repo: string): Promise<Run[]> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    return h.orm
      .select()
      .from(s.runs)
      .where(
        and(
          eq(s.runs.orgId, scope.orgId),
          eq(s.runs.projectId, projectId),
          eq(s.runs.repo, repo.toLowerCase()),
          eq(s.runs.status, "awaiting_approval"),
          eq(s.runs.event, "pull_request"),
          sql`${s.runs.prNumber} IS NOT NULL`,
        ),
      )
      .orderBy(s.runs.createdAt, s.runs.id);
  });
}

export type EgressMode = "none" | "open" | "allowlist";

/** The project's default sandbox egress (`projects.egress`); `none` when the project is unknown. */
export function getProjectEgress(db: Db, scope: Scope): Promise<EgressMode> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const [row] = await h.orm
      .select({ egress: s.projects.egress })
      .from(s.projects)
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)))
      .limit(1);
    const v = row?.egress;
    return v === "open" || v === "allowlist" ? v : "none";
  });
}

export type ChecksMode = "off" | "shadow" | "live";
export const CHECKS_MODES: readonly ChecksMode[] = ["off", "shadow", "live"];

/** The project's check-run reporting mode; `off` when unset or unknown. */
export function getProjectChecksMode(db: Db, scope: Scope): Promise<ChecksMode> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const [row] = await h.orm
      .select({ mode: s.projects.checksMode })
      .from(s.projects)
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)))
      .limit(1);
    return row?.mode === "shadow" || row?.mode === "live" ? row.mode : "off";
  });
}

export function setProjectChecksMode(db: Db, scope: Scope, mode: ChecksMode): Promise<void> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const [cur] = await h.orm
      .select({ mode: s.projects.checksMode })
      .from(s.projects)
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)))
      .limit(1);
    const before: ChecksMode = cur?.mode === "shadow" || cur?.mode === "live" ? cur.mode : "off";
    await h.orm
      .update(s.projects)
      .set({ checksMode: mode })
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)));
    // Checks turned on: skips dismissed while they were off get their check on the next sweep.
    if (mode !== "off") await clearRecentDismissals(h, { ...scope, projectId }, ["checks_off"]);
    // Off to on, or shadow to live: the latest run of each ref gets every job's current state
    // posted under the new mode (#630). A flip to off, or to the same mode, posts nothing.
    if (before !== mode && (mode === "live" || (mode === "shadow" && before === "off"))) {
      await markChecksBackfill(h, { ...scope, projectId }, before === "shadow");
    }
  });
}

/** The marker on an attempt whose current state is still to be posted after a mode flip. */
export const BACKFILL_MARKER = "backfill";
/** Runs older than this are not backfilled (the same bound as the skipped-check sweep). */
export const BACKFILL_WINDOW_MS = 3 * 24 * 3600_000;

/**
 * Marks, for the reporter's next sweep, the jobs of the project's latest run per repo, ref and
 * workflow (within the window) that ran or are running. Skipped-without-attempt jobs need no mark:
 * the skip sweep posts them. Moving to `live` from `shadow` also forgets the stored check ids of
 * those attempts (and skips), so the real `turntable / <job>` checks are created, not the neutral
 * ones updated. The marker is the bookkeeping: it is cleared once the check is posted, so a
 * restart neither loses nor repeats the backfill.
 */
async function markChecksBackfill(
  h: Db,
  scope: Required<Scope>,
  forgetIds: boolean,
  now = Date.now(),
): Promise<number> {
  const runs = await h.run((x) =>
    x.orm
      .select({
        id: s.runs.id,
        repo: s.runs.repo,
        ref: s.runs.ref,
        workflowPath: s.runs.workflowPath,
      })
      .from(s.runs)
      .where(
        and(
          eq(s.runs.orgId, scope.orgId),
          eq(s.runs.projectId, scope.projectId),
          eq(s.runs.local, false),
          gte(s.runs.createdAt, now - BACKFILL_WINDOW_MS),
        ),
      )
      .orderBy(desc(s.runs.createdAt), desc(s.runs.id)),
  );
  const latest = new Map<string, string>();
  for (const r of runs) {
    if (!r.repo) continue;
    const key = JSON.stringify([r.repo, r.ref, r.workflowPath]);
    if (!latest.has(key)) latest.set(key, r.id);
  }
  const runIds = [...latest.values()];
  if (runIds.length === 0) return 0;
  const rows = await h.run((x) =>
    x.orm
      .select({ attempt: s.jobAttempts })
      .from(s.jobAttempts)
      .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
      .where(and(eq(s.jobs.projectId, scope.projectId), inArray(s.jobs.runId, runIds))),
  );
  const newest = new Map<string, JobAttempt>();
  for (const { attempt } of rows) {
    const cur = newest.get(attempt.jobId);
    if (!cur || attempt.attempt > cur.attempt) newest.set(attempt.jobId, attempt);
  }
  const ran: string[] = [];
  const skipped: string[] = [];
  for (const a of newest.values()) {
    if (a.state === "queued") continue; // its start event posts it
    if (a.state === "skipped" && a.startedAt === null) skipped.push(a.id);
    else ran.push(a.id);
  }
  for (let i = 0; i < ran.length; i += 200) {
    const ids = ran.slice(i, i + 200);
    await h.run((x) =>
      x.orm
        .update(s.jobAttempts)
        .set({
          checkDismissedAt: null,
          checkDismissedReason: BACKFILL_MARKER,
          ...(forgetIds ? { checkRunId: null } : {}),
        })
        .where(and(eq(s.jobAttempts.projectId, scope.projectId), inArray(s.jobAttempts.id, ids))),
    );
  }
  if (forgetIds) {
    for (let i = 0; i < skipped.length; i += 200) {
      const ids = skipped.slice(i, i + 200);
      await h.run((x) =>
        x.orm
          .update(s.jobAttempts)
          .set({ checkRunId: null, skipCheckClaimedAt: null, checkDismissedAt: null })
          .where(and(eq(s.jobAttempts.projectId, scope.projectId), inArray(s.jobAttempts.id, ids))),
      );
    }
  }
  return ran.length + (forgetIds ? skipped.length : 0);
}

/** Attempts marked for backfill and not yet settled, newest first. */
export function listBackfillAttempts(
  db: Db,
  opts: { limit: number },
): Promise<{ attempt: JobAttempt; job: Job; run: Run }[]> {
  return db.run((h) =>
    h.orm
      .select({ attempt: s.jobAttempts, job: s.jobs, run: s.runs })
      .from(s.jobAttempts)
      .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
      .innerJoin(s.runs, eq(s.runs.id, s.jobs.runId))
      .where(
        and(
          eq(s.jobAttempts.checkDismissedReason, BACKFILL_MARKER),
          isNull(s.jobAttempts.checkDismissedAt),
        ),
      )
      .orderBy(desc(s.jobAttempts.id))
      .limit(opts.limit),
  );
}

/** Settles a backfill mark: the check is posted (no reason) or there is nothing to post (why). */
export function settleBackfill(
  db: Db,
  scope: Scope,
  attemptId: string,
  now: number,
  nothing?: DismissReason,
): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .update(s.jobAttempts)
      .set(
        nothing
          ? { checkDismissedAt: now, checkDismissedReason: nothing }
          : { checkDismissedAt: null, checkDismissedReason: null },
      )
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          and(
            eq(s.jobAttempts.id, attemptId),
            eq(s.jobAttempts.checkDismissedReason, BACKFILL_MARKER),
          )!,
        ),
      );
  });
}

/** The audiences the project's jobs may mint OIDC tokens for, or null when any audience is allowed. */
export function getProjectOidcAudiences(db: Db, scope: Scope): Promise<string[] | null> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const [row] = await h.orm
      .select({ a: s.projects.oidcAudiences })
      .from(s.projects)
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)))
      .limit(1);
    if (!row?.a) return null;
    try {
      const v: unknown = JSON.parse(row.a);
      // A stored value that is not a list of strings is treated as a list that allows nothing,
      // never as "any audience": a damaged restriction must not widen access.
      return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : [];
    } catch {
      return [];
    }
  });
}

/** Sets the allowed audiences, or clears the restriction with null. Returns false for no such project. */
export function setProjectOidcAudiences(
  db: Db,
  scope: Scope,
  audiences: readonly string[] | null,
): Promise<boolean> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const rows = await h.orm
      .update(s.projects)
      .set({ oidcAudiences: audiences === null ? null : JSON.stringify([...audiences]) })
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)))
      .returning({ id: s.projects.id });
    return rows.length > 0;
  });
}

/** The forge check run stored on an attempt, if one was created. */
export function getAttemptCheckRunId(
  db: Db,
  scope: Scope,
  attemptId: string,
): Promise<string | null> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ id: s.jobAttempts.checkRunId })
      .from(s.jobAttempts)
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, attemptId),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  });
}

/**
 * Attempts that ended `skipped` without ever starting (the scheduler resolved the job: a false
 * `if:`, a failed need, every shard path-skipped) and have no forge check yet and were not dismissed, newest first, across
 * every org (system work for the check reporter). An attempt that ran and was skipped by its
 * runner has `started_at` and is reported through the observer instead.
 */
export function listUnreportedSkips(
  db: Db,
  opts: { since: number; limit: number },
): Promise<{ attempt: JobAttempt; job: Job; run: Run }[]> {
  return db.run((h) =>
    h.orm
      .select({ attempt: s.jobAttempts, job: s.jobs, run: s.runs })
      .from(s.jobAttempts)
      .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
      .innerJoin(s.runs, eq(s.runs.id, s.jobs.runId))
      .where(
        and(
          eq(s.jobAttempts.state, "skipped"),
          isNull(s.jobAttempts.startedAt),
          isNull(s.jobAttempts.checkRunId),
          isNull(s.jobAttempts.checkDismissedAt),
          eq(s.runs.local, false),
          gte(s.jobAttempts.createdAt, opts.since),
        ),
      )
      .orderBy(desc(s.jobAttempts.id))
      .limit(opts.limit),
  );
}

/**
 * True when a run has been superseded (#648): a job of it was cancelled by a newer run of its
 * concurrency group, or a newer run exists for the same repo, sha and workflow file (for example
 * the re-ingest after a draft PR is marked ready). Its skipped checks must not be posted: the
 * newer run owns the check names on that sha, and GitHub shows the newest check run per name.
 */
export function isRunSuperseded(db: Db, run: Run): Promise<boolean> {
  return db.run(async (h) => {
    const [newer] = await h.orm
      .select({ id: s.runs.id })
      .from(s.runs)
      .where(
        and(
          eq(s.runs.orgId, run.orgId),
          eq(s.runs.projectId, run.projectId),
          eq(s.runs.workflowPath, run.workflowPath),
          sameRepoAs(run),
          run.sha === null ? isNull(s.runs.sha) : eq(s.runs.sha, run.sha),
          sql`${s.runs.id} > ${run.id}`,
          eq(s.runs.local, false),
        ),
      )
      .limit(1);
    if (newer) return true;
    const [cut] = await h.orm
      .select({ id: s.jobAttempts.id })
      .from(s.jobAttempts)
      .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
      .where(
        and(
          eq(s.jobs.runId, run.id),
          eq(s.jobAttempts.state, "cancelled"),
          or(
            eq(s.jobAttempts.errorClass, "superseded by a newer run"),
            eq(s.jobAttempts.errorClass, "replaced by a newer pending run"),
          ),
        ),
      )
      .limit(1);
    return cut !== undefined;
  });
}

/**
 * The jobs of NEWER runs of the same repo and sha (any workflow) that already hold a check run
 * (#648). A check for a (sha, name) one of them holds must not be created by an older run: GitHub
 * shows the most recently created check run per name.
 */
export function listNewerCheckedJobs(db: Db, run: Run): Promise<{ job: Job; run: Run }[]> {
  return db.run((h) =>
    h.orm
      .selectDistinct({ job: s.jobs, run: s.runs })
      .from(s.jobAttempts)
      .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
      .innerJoin(s.runs, eq(s.runs.id, s.jobs.runId))
      .where(
        and(
          eq(s.runs.orgId, run.orgId),
          eq(s.runs.projectId, run.projectId),
          sameRepoAs(run),
          run.sha === null ? isNull(s.runs.sha) : eq(s.runs.sha, run.sha),
          sql`${s.runs.id} > ${run.id}`,
          sql`${s.jobAttempts.checkRunId} is not null`,
        ),
      ),
  );
}

/** Marks a skipped attempt as having nothing to post (and why), so the sweep stops selecting it. */
export function dismissSkippedCheck(
  db: Db,
  scope: Scope,
  attemptId: string,
  now: number,
  reason: DismissReason,
): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .update(s.jobAttempts)
      .set({ checkDismissedAt: now, checkDismissedReason: reason })
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, attemptId),
        ),
      );
  });
}

/**
 * Takes the exclusive claim to post an attempt's skipped check: one conditional UPDATE, atomic on
 * both dialects. It wins only while the attempt has no check and no live claim (none, or one
 * older than `ttlMs`, whose holder is presumed dead). The winner alone creates the check, and
 * gets back its claim stamp (`now`) to release with. `null` means the claim was not won.
 */
export function claimSkippedCheck(
  db: Db,
  scope: Scope,
  attemptId: string,
  now: number,
  ttlMs: number,
): Promise<number | null> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.jobAttempts)
      .set({ skipCheckClaimedAt: now })
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          and(
            eq(s.jobAttempts.id, attemptId),
            isNull(s.jobAttempts.checkRunId),
            or(
              isNull(s.jobAttempts.skipCheckClaimedAt),
              lt(s.jobAttempts.skipCheckClaimedAt, now - ttlMs),
            ),
          ),
        ),
      )
      .returning({ id: s.jobAttempts.id });
    return rows.length > 0 ? now : null;
  });
}

/**
 * Drops a claim whose post failed, so the next sweep retries without waiting out the TTL. It
 * clears only the claim stamped `claimedAt`: if this holder stalled past the TTL and another
 * worker retook the claim, that live claim is left alone.
 */
export function releaseSkippedCheckClaim(
  db: Db,
  scope: Scope,
  attemptId: string,
  claimedAt: number,
): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .update(s.jobAttempts)
      .set({ skipCheckClaimedAt: null })
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          and(
            eq(s.jobAttempts.id, attemptId),
            isNull(s.jobAttempts.checkRunId),
            eq(s.jobAttempts.skipCheckClaimedAt, claimedAt),
          ),
        ),
      );
  });
}

export function setAttemptCheckRunId(
  db: Db,
  scope: Scope,
  attemptId: string,
  checkRunId: string,
): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .update(s.jobAttempts)
      .set({ checkRunId })
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, attemptId),
        ),
      );
  });
}

export function setProjectEgress(db: Db, scope: Scope, egress: EgressMode): Promise<void> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    await h.orm
      .update(s.projects)
      .set({ egress })
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)));
  });
}

/**
 * Applies a concurrency group to a run that was just created (call it in the same transaction,
 * after the run exists, so there is no moment with neither run).
 *
 * - `all` (`cancel-in-progress: true`): every older unfinished run of the group is cancelled,
 *   queued and running jobs alike.
 * - `pending` (no cancel-in-progress, GitHub's semantics): a group has at most one running run
 *   and one pending run. If a run is running, an older PENDING run (one that has not started) is
 *   replaced, that is cancelled, and this run waits as the new pending one. The running run is
 *   left alone, and this run's jobs are not claimed until it finishes (see `groupBlocked`).
 *
 * Running attempts that were cancelled are reported (and announced on the abort bus after
 * commit) so their workers stop and their sandboxes are destroyed.
 */
export async function supersedeOlderRuns(
  db: Db,
  scope: Scope,
  run: Run,
  mode: "all" | "pending" = "all",
): Promise<Superseded> {
  const out: Superseded = { runIds: [], running: [] };
  const older = await olderUnfinished(db, run);
  // "Started" means the aggregate is anything but queued: some job ran or is waiting on approval.
  const anyStarted = older.some((r) => r.status !== "queued");
  for (const old of older) {
    if (mode === "pending" && (old.status !== "queued" || !anyStarted)) continue;
    const res = await cancelRunJobs(db, scope, old.id, {
      errorClass: mode === "all" ? "superseded by a newer run" : "replaced by a newer pending run",
    });
    if (!res) continue;
    out.runIds.push(old.id);
    out.running.push(...res.running);
  }
  return out;
}

/**
 * True when a run must wait for its concurrency group: it has not started and an older run of the
 * same group is still unfinished. The scheduler does not claim its jobs until then.
 */
export async function groupBlocked(db: Db, run: Run): Promise<boolean> {
  if (!run.concurrencyGroup || run.status !== "queued") return false;
  return (await olderUnfinished(db, run)).length > 0;
}

/**
 * Remembers a (repo, workflow, event, sha) the poller looked at and decided not to run (the
 * workflow's triggers did not match, e.g. a path filter), so it is not looked at again. No run is
 * created. Returns false when the key was already recorded.
 */
export function markPollSkipped(
  db: Db,
  scope: Scope,
  input: {
    repo: string;
    workflowPath: string;
    event: string;
    sha: string;
    now?: number | undefined;
    /** Sentinel stored as the run id; default "skipped". The PR baseline uses "baseline". */
    runId?: string | undefined;
  },
): Promise<boolean> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const rows = await h.orm
      .insert(s.pollSeen)
      .values({
        orgId: scope.orgId,
        projectId,
        repo: input.repo.toLowerCase(),
        workflowPath: input.workflowPath,
        event: input.event,
        sha: input.sha,
        // Sentinel for "no run" (a binding move writes "moved", see MOVED_RUN_ID in repos/github.ts).
        runId: input.runId ?? "skipped",
        ...(input.now === undefined ? {} : { createdAt: input.now }),
      })
      .onConflictDoNothing()
      .returning({ sha: s.pollSeen.sha });
    return rows.length > 0;
  });
}

/** When a marker was first written (epoch ms), or undefined when there is none. */
export function pollMarkedAt(
  db: Db,
  scope: Scope,
  input: { repo: string; workflowPath: string; event: string; sha: string },
): Promise<number | undefined> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const [row] = await h.orm
      .select({ at: s.pollSeen.createdAt })
      .from(s.pollSeen)
      .where(
        and(
          eq(s.pollSeen.projectId, projectId),
          eq(s.pollSeen.repo, input.repo.toLowerCase()),
          eq(s.pollSeen.workflowPath, input.workflowPath),
          eq(s.pollSeen.event, input.event),
          eq(s.pollSeen.sha, input.sha),
        ),
      )
      .limit(1);
    return row?.at;
  });
}

/** Removes a marker written by `markPollSkipped` (only ones that are state, never ones that made a run). */
export function clearPollMarker(
  db: Db,
  scope: Scope,
  input: { repo: string; workflowPath: string; event: string; sha: string },
): Promise<void> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    await h.orm
      .delete(s.pollSeen)
      .where(
        and(
          eq(s.pollSeen.projectId, projectId),
          eq(s.pollSeen.repo, input.repo.toLowerCase()),
          eq(s.pollSeen.workflowPath, input.workflowPath),
          eq(s.pollSeen.event, input.event),
          eq(s.pollSeen.sha, input.sha),
          eq(s.pollSeen.runId, "skipped"),
        ),
      );
  });
}

/** Whether the key was already handled (run created or deliberately skipped). */
export function pollSeen(
  db: Db,
  scope: Scope,
  input: { repo: string; workflowPath: string; event: string; sha: string },
): Promise<boolean> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const [row] = await h.orm
      .select({ n: count() })
      .from(s.pollSeen)
      .where(
        and(
          eq(s.pollSeen.projectId, projectId),
          eq(s.pollSeen.repo, input.repo.toLowerCase()),
          eq(s.pollSeen.workflowPath, input.workflowPath),
          eq(s.pollSeen.event, input.event),
          eq(s.pollSeen.sha, input.sha),
        ),
      );
    return Number(row?.n ?? 0) > 0;
  });
}

/** The sha the poller last handled for a repo and event (the `before` of the next push). */
export function lastPolledSha(
  db: Db,
  scope: Scope,
  repo: string,
  workflowPath: string,
  event: string,
): Promise<string | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ sha: s.pollSeen.sha })
      .from(s.pollSeen)
      .where(
        scoped(
          scope,
          SEEN_COLS,
          eq(s.pollSeen.repo, repo.toLowerCase()),
          eq(s.pollSeen.workflowPath, workflowPath),
          eq(s.pollSeen.event, event),
        ),
      )
      .orderBy(desc(s.pollSeen.createdAt), desc(s.pollSeen.sha))
      .limit(1);
    return row?.sha;
  });
}

// ---- ingest from installation bindings ----

/** The project's ingest settings as stored (JSON text), or null when it is not ingested. */
export function getProjectIngest(db: Db, scope: Scope): Promise<string | null> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const [row] = await h.orm
      .select({ v: s.projects.ingestConfig })
      .from(s.projects)
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)))
      .limit(1);
    return row?.v ?? null;
  });
}

export function setProjectIngest(db: Db, scope: Scope, json: string | null): Promise<void> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    await h.orm
      .update(s.projects)
      .set({ ingestConfig: json })
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)));
  });
}

/**
 * Every GitHub repo bound to a project that has ingest settings, with the org and project slugs
 * the poller targets. Intentionally unscoped (the poller serves every tenant); a project without
 * settings contributes nothing, so binding a repo never makes it ingested by itself.
 */
export function listIngestBindings(db: Db): Promise<
  {
    orgId: string;
    projectId: string;
    orgSlug: string;
    projectSlug: string;
    owner: string;
    repo: string;
    config: string;
  }[]
> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({
        orgId: s.orgs.id,
        projectId: s.projects.id,
        orgSlug: s.orgs.slug,
        projectSlug: s.projects.slug,
        owner: s.projectRepos.owner,
        repo: s.projectRepos.repo,
        config: s.projects.ingestConfig,
        forge: s.projectRepos.forge,
      })
      .from(s.projectRepos)
      .innerJoin(
        s.projects,
        and(
          eq(s.projects.id, s.projectRepos.projectId),
          eq(s.projects.orgId, s.projectRepos.orgId),
        ),
      )
      .innerJoin(s.orgs, eq(s.orgs.id, s.projects.orgId));
    return rows.flatMap((r) =>
      r.forge === "github" && r.config !== null
        ? [
            {
              orgId: r.orgId,
              projectId: r.projectId,
              orgSlug: r.orgSlug,
              projectSlug: r.projectSlug,
              owner: r.owner,
              repo: r.repo,
              config: r.config,
            },
          ]
        : [],
    );
  });
}

/**
 * GitHub repos bound through an App installation, across every tenant (the poller serves all of
 * them), so the poller can read each with a token minted for that one repo.
 */
export function listInstalledRepos(db: Db): Promise<
  {
    orgSlug: string;
    projectSlug: string;
    owner: string;
    repo: string;
    installationId: string;
    forgeRepoId: string | null;
  }[]
> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({
        orgSlug: s.orgs.slug,
        projectSlug: s.projects.slug,
        owner: s.projectRepos.owner,
        repo: s.projectRepos.repo,
        forge: s.projectRepos.forge,
        installationId: s.projectRepos.installationId,
        forgeRepoId: s.projectRepos.forgeRepoId,
      })
      .from(s.projectRepos)
      .innerJoin(
        s.projects,
        and(
          eq(s.projects.id, s.projectRepos.projectId),
          eq(s.projects.orgId, s.projectRepos.orgId),
        ),
      )
      .innerJoin(s.orgs, eq(s.orgs.id, s.projects.orgId));
    return rows.flatMap((r) =>
      r.forge === "github" && r.installationId !== null
        ? [
            {
              orgSlug: r.orgSlug,
              projectSlug: r.projectSlug,
              owner: r.owner,
              repo: r.repo,
              installationId: r.installationId,
              forgeRepoId: r.forgeRepoId,
            },
          ]
        : [],
    );
  });
}
