// The ONLY place tenant-owned tables are queried. Every function takes a Scope and filters on
// org_id (and project_id when the scope has one). tests/tenancy-guard.test.ts enforces this.
//
// Every public function is async and wraps its body in `db.run` (see `Db` in ../index.ts). Inside
// the callback, use the handle it receives (`h`) for nested repo calls. Queries are written
// `await orm.select()...` with no `.get()/.all()/.run()` so they run on sync and async drivers.
import { clearRecentDismissals } from "./dismissals";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "..";
import { canTransition, exitCodeValid, FINISHED_STATES } from "../job-state";
import * as s from "../schema";
import type { JobState } from "../schema";
import { ulid } from "../ulid";
import { ratchetApprovalDefault } from "./approval-default";
import { logStoreFor } from "../../logstore/registry";
import type { LogKey } from "../../logstore/types";
import { appendEvent, notifyLogAppended } from "./events";
import { logKey, requireProject, type Scope, scoped } from "./scope";

export type { Scope } from "./scope";
export * from "./activity";
export * from "./api";
export * from "./approve";
export * from "./artifacts";
export * from "./quotas";
export * from "./log-migrate";
export * from "./settings";
export * from "./project-settings";
export * from "./approvals";
export * from "./proxy-rules";
export * from "./github";
export * from "./incident";
export * from "./audit";
export * from "./vault";
export * from "./release";
export * from "./cache";
export * from "./cancel";
export * from "./pins";
export * from "./verdicts";
export * from "./events";
export * from "./lease";
export * from "./waiting";
export * from "./org-summary";
export * from "./run-summary";
export * from "./instance-tokens";
export * from "./poll";
export * from "./onboardings";
export * from "./project-delete";
export * from "./dismissals";
export * from "./readiness";
export * from "./usage";
export * from "./rerun";
export * from "./web-auth";
export * from "./pending-approvals";
export * from "./pending-approvals";

export type Project = typeof s.projects.$inferSelect;
export type ProjectRepo = typeof s.projectRepos.$inferSelect;
export type Run = typeof s.runs.$inferSelect;
export type Job = typeof s.jobs.$inferSelect;
export type JobAttempt = typeof s.jobAttempts.$inferSelect;

const now = () => Date.now();

/** Metadata `turntable run` or the forge supplies with a run. Free text is length-capped. */
export type RunInput = {
  workflowPath: string;
  event: string;
  ref: string;
  sha?: string;
  workflowName?: string | undefined;
  /** The evaluated `run-name`, the run's display title. */
  runName?: string | undefined;
  commitMessage?: string | undefined;
  actor?: string | undefined;
  headBranch?: string | undefined;
  prNumber?: number | undefined;
  /** Run-level planning facts (JSON text); see `runs.plan`. */
  plan?: string | undefined;
  concurrencyGroup?: string | undefined;
  /** Started by `turntable run`; see `runs.local`. */
  local?: boolean | undefined;
  /** `owner/name`, lower case, for runs the poller creates; see `runs.repo`. */
  repo?: string | undefined;
  /** The trust decision (JSON text); see `runs.trust`. */
  trust?: string | undefined;
};

const cap = (value: string | undefined, max: number): string | null =>
  value === undefined ? null : value.slice(0, max);

// ---- tenancy ----

export type ApproveRunRole = "operator" | "release_operator";
export const APPROVE_RUN_ROLES: readonly ApproveRunRole[] = ["operator", "release_operator"];

/** The org's `approve_run` minimum role; the strict default when unset or unknown. */
export function getApproveRunMinRole(db: Db, orgId: string): Promise<ApproveRunRole> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ role: s.orgs.approveRunMinRole })
      .from(s.orgs)
      .where(eq(s.orgs.id, orgId))
      .limit(1);
    return row?.role === "operator" ? "operator" : "release_operator";
  });
}

export function setApproveRunMinRole(db: Db, orgId: string, role: ApproveRunRole): Promise<void> {
  return db.run(async (h) => {
    await h.orm.update(s.orgs).set({ approveRunMinRole: role }).where(eq(s.orgs.id, orgId));
  });
}

export function createOrg(db: Db, input: { slug: string; name: string }) {
  return db.run(async (h) => {
    const row = { id: ulid(), ...input };
    await h.orm.insert(s.orgs).values(row);
    const [org] = await h.orm.select().from(s.orgs).where(eq(s.orgs.id, row.id)).limit(1);
    return org!;
  });
}

export function getOrgBySlug(db: Db, slug: string) {
  return db.run(async (h) => {
    const [org] = await h.orm.select().from(s.orgs).where(eq(s.orgs.slug, slug)).limit(1);
    return org;
  });
}

export function createProject(
  db: Db,
  scope: Scope,
  /** `maxConcurrent` 0 creates the project paused: it holds every job until someone raises it. */
  input: { slug: string; name: string; maxConcurrent?: number; addedAt?: number },
): Promise<Project> {
  return db.run(async (h) => {
    const id = ulid();
    await h.orm.insert(s.projects).values({ id, orgId: scope.orgId, ...input });
    return (await getProject(h, { orgId: scope.orgId }, id))!;
  });
}

export function getProject(db: Db, scope: Scope, id: string): Promise<Project | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.projects)
      .where(scoped(scope, { orgId: s.projects.orgId }, eq(s.projects.id, id)))
      .limit(1);
    return row;
  });
}

export function getProjectBySlug(db: Db, scope: Scope, slug: string): Promise<Project | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.projects)
      .where(scoped(scope, { orgId: s.projects.orgId }, eq(s.projects.slug, slug)))
      .limit(1);
    return row;
  });
}

export function listProjects(db: Db, scope: Scope): Promise<Project[]> {
  return db.run(async (h) => {
    // A project-narrowed scope lists only that project.
    const where =
      scope.projectId === undefined
        ? scoped(scope, { orgId: s.projects.orgId })
        : scoped(scope, { orgId: s.projects.orgId }, eq(s.projects.id, scope.projectId));
    return h.orm.select().from(s.projects).where(where).orderBy(asc(s.projects.slug));
  });
}

export function renameProject(
  db: Db,
  scope: Scope,
  id: string,
  name: string,
): Promise<Project | undefined> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.projects)
      .set({ name })
      .where(scoped(scope, { orgId: s.projects.orgId }, eq(s.projects.id, id)))
      .returning({ id: s.projects.id });
    return rows.length ? getProject(h, scope, id) : undefined;
  });
}

// TODO(#19): prove the caller controls this repo/installation at bind time (GitHub App work).
export function bindRepo(
  db: Db,
  scope: Scope,
  input: {
    forge: s.Forge;
    owner: string;
    repo: string;
    installationId?: string;
    forgeRepoId?: string;
  },
): Promise<ProjectRepo> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const id = ulid();
    await h.orm.insert(s.projectRepos).values({
      id,
      orgId: scope.orgId,
      projectId,
      forge: input.forge,
      owner: input.owner.toLowerCase(),
      repo: input.repo.toLowerCase(),
      installationId: input.installationId ?? null,
      forgeRepoId: input.forgeRepoId ?? null,
    });
    // Bound again: the project no longer waits for a re-grant.
    await h.orm
      .update(s.projects)
      .set({ lastForgeRepoId: null, unboundAt: null })
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)));
    const [row] = await h.orm
      .select()
      .from(s.projectRepos)
      .where(eq(s.projectRepos.id, id))
      .limit(1);
    // A claimed repo can now post checks: skips dismissed for lack of a binding get theirs.
    if (input.installationId) {
      await clearRecentDismissals(h, { ...scope, projectId }, ["no_binding", "no_installation"]);
    }
    return row!;
  });
}

export function listRepos(db: Db, scope: Scope): Promise<ProjectRepo[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.projectRepos)
      .where(scoped(scope, { orgId: s.projectRepos.orgId, projectId: s.projectRepos.projectId })),
  );
}

/**
 * Webhook routing: resolves a forge repo to its owning scope. Intentionally unscoped (the
 * caller has no tenant yet); the unique(forge, owner, repo) constraint makes it unambiguous.
 */
export function resolveRepoScope(
  db: Db,
  input: {
    forge: s.Forge;
    owner: string;
    repo: string;
    forgeRepoId?: string;
    /** Installation the event came from. Required to match when the binding has one. */
    installationId?: string;
  },
): Promise<Required<Scope> | undefined> {
  return db.run(async (h) => {
    // Prefer the stable forge id (survives renames); fall back to case-insensitive owner/repo.
    const [byId] = input.forgeRepoId
      ? await h.orm
          .select()
          .from(s.projectRepos)
          .where(
            and(
              eq(s.projectRepos.forge, input.forge),
              eq(s.projectRepos.forgeRepoId, input.forgeRepoId),
            ),
          )
          .limit(1)
      : [];
    const row =
      byId ??
      (
        await h.orm
          .select()
          .from(s.projectRepos)
          .where(
            and(
              eq(s.projectRepos.forge, input.forge),
              eq(s.projectRepos.owner, input.owner.toLowerCase()),
              eq(s.projectRepos.repo, input.repo.toLowerCase()),
            ),
          )
          .limit(1)
      )[0];
    if (!row) return undefined;
    // Name fallback only for rows with no stable id. A row bound to a different forge repo id
    // means the repo was deleted and recreated, or the name was taken over: do not route.
    if (row.forgeRepoId !== null && row.forgeRepoId !== input.forgeRepoId) return undefined;
    // A bound installation must match: a same-named repo under another installation must not
    // route into this org. A missing incoming installation counts as a mismatch.
    if (row.installationId !== null && row.installationId !== input.installationId) {
      return undefined;
    }
    return { orgId: row.orgId, projectId: row.projectId };
  });
}

export function addMember(
  db: Db,
  scope: Scope,
  input: { userId: string; role: s.MemberRole },
): Promise<void> {
  // The strict ratchet shares the transaction: a second owner or admin is never visible without it.
  return db.transaction(async (tx) => {
    await tx.run(async (h) => {
      await h.orm.insert(s.orgMembers).values({ orgId: scope.orgId, ...input });
    });
    await ratchetApprovalDefault(tx, scope.orgId);
  });
}

export function listMembers(db: Db, scope: Scope) {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.orgMembers)
      .where(scoped(scope, { orgId: s.orgMembers.orgId })),
  );
}

export function createUser(db: Db, input: { email?: string; displayName: string }) {
  return db.run(async (h) => {
    const id = ulid();
    await h.orm
      .insert(s.users)
      .values({ id, email: input.email ?? null, displayName: input.displayName });
    const [user] = await h.orm.select().from(s.users).where(eq(s.users.id, id)).limit(1);
    return user!;
  });
}

/**
 * Idempotently creates the built-in `local` org and project used by local runs. Uses a
 * transaction, so call it with the root handle and never from inside `db.run`.
 */
export async function ensureLocalTenant(db: Db): Promise<Required<Scope>> {
  try {
    return await ensureLocalTenantOnce(db);
  } catch {
    // A concurrent boot created the rows between our read and insert: reread.
    return await ensureLocalTenantOnce(db);
  }
}

function ensureLocalTenantOnce(db: Db): Promise<Required<Scope>> {
  return db.transaction(async (tx) => {
    let org = await getOrgBySlug(tx, "local");
    if (!org) org = await createOrg(tx, { slug: "local", name: "Local" });
    const scope = { orgId: org.id };
    let project = await getProjectBySlug(tx, scope, "local");
    if (!project) project = await createProject(tx, scope, { slug: "local", name: "Local" });
    return { orgId: org.id, projectId: project.id };
  });
}

// ---- runs ----

export function createRun(db: Db, scope: Scope, input: RunInput): Promise<Run> {
  return db.transaction(async (h) => {
    const { projectId } = requireProject(scope);
    const id = ulid();
    await h.orm.insert(s.runs).values({
      id,
      orgId: scope.orgId,
      projectId,
      workflowPath: input.workflowPath,
      event: input.event,
      ref: input.ref,
      sha: input.sha ?? null,
      workflowName: cap(input.workflowName, 200),
      runName: cap(input.runName, 200),
      commitMessage: cap(input.commitMessage, 2000),
      actor: cap(input.actor, 100),
      headBranch: cap(input.headBranch, 255),
      prNumber: input.prNumber ?? null,
      plan: input.plan ?? null,
      concurrencyGroup: input.concurrencyGroup ?? null,
      local: input.local ?? false,
      repo: input.repo?.toLowerCase() ?? null,
      trust: input.trust ?? null,
    });
    await appendEvent(h, scope, {
      type: "run.queued",
      runId: id,
      payload: {
        workflow_path: input.workflowPath,
        event: input.event,
        ref: input.ref,
        sha: input.sha ?? null,
      },
    });
    return (await getRun(h, scope, id))!;
  });
}

export function getRun(db: Db, scope: Scope, id: string): Promise<Run | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.runs)
      .where(scoped(scope, { orgId: s.runs.orgId, projectId: s.runs.projectId }, eq(s.runs.id, id)))
      .limit(1);
    return row;
  });
}

export function listRuns(db: Db, scope: Scope, opts: { limit?: number } = {}): Promise<Run[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.runs)
      .where(scoped(scope, { orgId: s.runs.orgId, projectId: s.runs.projectId }))
      .orderBy(desc(s.runs.id))
      .limit(opts.limit ?? 50),
  );
}

export function setRunStatus(
  db: Db,
  scope: Scope,
  id: string,
  status: JobState,
): Promise<Run | undefined> {
  // One transaction: the status change and its event commit together or not at all.
  return db.transaction(async (h) => {
    const prev = await getRun(h, scope, id);
    if (!prev) return undefined;
    const t = now();
    const rows = await h.orm
      .update(s.runs)
      .set({
        status,
        startedAt: status === "running" ? t : undefined,
        finishedAt: FINISHED_STATES.includes(status) ? t : undefined,
      })
      .where(scoped(scope, { orgId: s.runs.orgId, projectId: s.runs.projectId }, eq(s.runs.id, id)))
      .returning({ id: s.runs.id });
    if (!rows.length) return undefined;
    if (prev.status !== status) {
      const runScope = { orgId: prev.orgId, projectId: prev.projectId };
      if (status === "running") {
        await appendEvent(h, runScope, { type: "run.started", runId: id, payload: { status } });
      } else if (FINISHED_STATES.includes(status)) {
        await appendEvent(h, runScope, {
          type: "run.finished",
          runId: id,
          payload: { status, from: prev.status },
        });
      }
    }
    return getRun(h, scope, id);
  });
}

// ---- jobs ----

export class InvalidTransitionError extends Error {
  from: JobState;
  to: JobState;
  constructor(from: JobState, to: JobState, detail?: string) {
    super(`invalid job transition ${from} -> ${to}${detail ? `: ${detail}` : ""}`);
    this.from = from;
    this.to = to;
  }
}

export function createJob(
  db: Db,
  scope: Scope,
  input: {
    runId: string;
    jobKey: string;
    name: string;
    /** Job keys this job waits for. */
    needs?: readonly string[] | undefined;
    /** This leg's matrix values. */
    matrix?: Record<string, unknown> | undefined;
    approvalKind?: s.ApprovalKind | undefined;
    /** The planned job (key, ids, if:, outputs, continue-on-error ...), stored as JSON. */
    planned?: unknown;
  },
): Promise<Job | undefined> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    if (input.approvalKind !== undefined && !s.APPROVAL_KINDS.includes(input.approvalKind)) {
      throw new Error(`invalid approval kind: ${String(input.approvalKind)}`);
    }
    // Parent must be in scope; the composite FK is the backstop, this gives a clean undefined.
    if (!(await getRun(h, scope, input.runId))) return undefined;
    const id = ulid();
    await h.orm.insert(s.jobs).values({
      id,
      orgId: scope.orgId,
      projectId,
      runId: input.runId,
      jobKey: input.jobKey,
      name: input.name,
      needs: JSON.stringify(input.needs ?? []),
      matrix: input.matrix === undefined ? null : JSON.stringify(input.matrix),
      approvalKind: input.approvalKind ?? null,
      planned: input.planned === undefined ? null : JSON.stringify(input.planned),
    });
    return getJob(h, scope, id);
  });
}

export function getJob(db: Db, scope: Scope, id: string): Promise<Job | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.jobs)
      .where(scoped(scope, { orgId: s.jobs.orgId, projectId: s.jobs.projectId }, eq(s.jobs.id, id)))
      .limit(1);
    return row;
  });
}

export function listJobs(db: Db, scope: Scope, runId: string): Promise<Job[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.jobs)
      .where(
        scoped(
          scope,
          { orgId: s.jobs.orgId, projectId: s.jobs.projectId },
          eq(s.jobs.runId, runId),
        ),
      )
      .orderBy(asc(s.jobs.id)),
  );
}

/**
 * Moves a job to a new state, enforcing the transition table and exit-code invariants.
 * Returns undefined when the job is not in scope. Compare-and-set on the current state, so a
 * concurrent writer cannot be silently overwritten.
 */
export function transitionJob(
  db: Db,
  scope: Scope,
  id: string,
  to: JobState,
  opts: { exitCode?: number | null; reason?: string } = {},
): Promise<Job | undefined> {
  return db.transaction(async (h) => {
    const job = await getJob(h, scope, id);
    if (!job) return undefined;
    const from = job.state as JobState;
    if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
    if (!exitCodeValid(to, opts.exitCode)) {
      throw new InvalidTransitionError(from, to, `exit code ${String(opts.exitCode)} invalid`);
    }
    const t = now();
    const rows = await h.orm
      .update(s.jobs)
      .set({
        state: to,
        exitCode: opts.exitCode ?? null,
        startedAt: to === "running" ? t : undefined,
        finishedAt: FINISHED_STATES.includes(to) ? t : null,
      })
      .where(
        scoped(
          scope,
          { orgId: s.jobs.orgId, projectId: s.jobs.projectId },
          eq(s.jobs.id, id),
          eq(s.jobs.state, from),
        ),
      )
      .returning({ id: s.jobs.id });
    if (!rows.length) throw new InvalidTransitionError(from, to, "state changed concurrently");
    const evScope = { orgId: job.orgId, projectId: job.projectId };
    await appendEvent(h, evScope, {
      type: "job.state_changed",
      runId: job.runId,
      jobId: id,
      payload: {
        from,
        to,
        exit_code: opts.exitCode ?? null,
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
    });
    if (to === "awaiting_approval") {
      await appendEvent(h, evScope, { type: "approval.required", runId: job.runId, jobId: id });
    }
    if (to === "infra_error") {
      await appendEvent(h, evScope, { type: "infra.error", runId: job.runId, jobId: id });
    }
    return getJob(h, scope, id);
  });
}

// ---- attempts ----

const ATTEMPT_COLS = { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId };

export function createAttempt(
  db: Db,
  scope: Scope,
  input: {
    jobId: string;
    provider: string;
    rerunReason?: string | undefined;
    /** Keeps an earlier attempt's place in the claim order (ids sort by time): a network requeue (#698). */
    sortLike?: string | undefined;
  },
): Promise<JobAttempt | undefined> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    if (!(await getJob(h, scope, input.jobId))) return undefined;
    const [last] = await h.orm
      .select({ attempt: s.jobAttempts.attempt })
      .from(s.jobAttempts)
      .where(scoped(scope, ATTEMPT_COLS, eq(s.jobAttempts.jobId, input.jobId)))
      .orderBy(desc(s.jobAttempts.attempt))
      .limit(1);
    const id = input.sortLike ? input.sortLike.slice(0, 10) + ulid().slice(10) : ulid();
    await h.orm.insert(s.jobAttempts).values({
      id,
      orgId: scope.orgId,
      projectId,
      jobId: input.jobId,
      attempt: (last?.attempt ?? 0) + 1,
      provider: input.provider,
      rerunReason: input.rerunReason ?? null,
    });
    return getAttempt(h, scope, id);
  });
}

export function getAttempt(db: Db, scope: Scope, id: string): Promise<JobAttempt | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.jobAttempts)
      .where(scoped(scope, ATTEMPT_COLS, eq(s.jobAttempts.id, id)))
      .limit(1);
    return row;
  });
}

export function listAttempts(db: Db, scope: Scope, jobId: string): Promise<JobAttempt[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.jobAttempts)
      .where(scoped(scope, ATTEMPT_COLS, eq(s.jobAttempts.jobId, jobId)))
      .orderBy(asc(s.jobAttempts.attempt)),
  );
}

const isoOrNull = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

export function updateAttempt(
  db: Db,
  scope: Scope,
  id: string,
  patch: {
    state?: JobState;
    sandboxId?: string | null;
    execId?: string | null;
    exitCode?: number | null;
    errorClass?: string | null;
    infraKind?: string | null;
    /** Not a column: the underlying error's name and code, kept on the `infra.error` event. */
    errorDetail?: { name?: string; code?: string };
    sandboxCreatedAt?: number | null;
    sandboxDestroyedAt?: number | null;
    sandboxTtlSeconds?: number | null;
    /** Cleared and closed when the attempt starts (#775). */
    waitingReason?: string | null;
    waitingSince?: number | null;
    waitedMs?: string;
  },
): Promise<JobAttempt | undefined> {
  const { errorDetail, ...cols } = patch;
  return db.transaction(async (h) => {
    const cur = await getAttempt(h, scope, id);
    if (!cur) return undefined;
    if (patch.state) {
      const from = cur.state as JobState;
      if (!canTransition(from, patch.state)) throw new InvalidTransitionError(from, patch.state);
      if (!exitCodeValid(patch.state, patch.exitCode)) {
        throw new InvalidTransitionError(from, patch.state, "exit code invalid");
      }
    }
    const t = now();
    const from = cur.state as JobState;
    const rows = await h.orm
      .update(s.jobAttempts)
      .set({
        ...cols,
        startedAt: patch.state === "running" ? t : undefined,
        finishedAt: patch.state && FINISHED_STATES.includes(patch.state) ? t : undefined,
      })
      .where(
        scoped(
          scope,
          ATTEMPT_COLS,
          eq(s.jobAttempts.id, id),
          // Compare-and-set on state so heartbeat and reconcile cannot overwrite each other.
          patch.state ? eq(s.jobAttempts.state, from) : undefined,
        ),
      )
      .returning({ id: s.jobAttempts.id });
    if (!rows.length) {
      throw new InvalidTransitionError(from, patch.state ?? from, "state changed concurrently");
    }
    if (patch.state) {
      const evScope = { orgId: cur.orgId, projectId: cur.projectId };
      await appendEvent(h, evScope, {
        type: "job.state_changed",
        jobId: cur.jobId,
        attemptId: id,
        payload: {
          level: "attempt",
          from,
          to: patch.state,
          exit_code: patch.exitCode ?? null,
          error_class: patch.errorClass ?? null,
          // When the sandbox existed, from the provider's create to its confirmed destroy: what
          // sandbox-minutes are counted from (null when not known, or not confirmed destroyed).
          sandbox_created_at: isoOrNull(patch.sandboxCreatedAt ?? cur.sandboxCreatedAt),
          sandbox_destroyed_at: isoOrNull(patch.sandboxDestroyedAt ?? cur.sandboxDestroyedAt),
        },
      });
      if (patch.state === "infra_error") {
        await appendEvent(h, evScope, {
          type: "infra.error",
          jobId: cur.jobId,
          attemptId: id,
          payload: {
            error_class: patch.errorClass ?? null,
            ...(errorDetail?.name ? { error_name: errorDetail.name } : {}),
            ...(errorDetail?.code ? { error_code: errorDetail.code } : {}),
          },
        });
      }
    }
    return getAttempt(h, scope, id);
  });
}

// ---- logs ----

/**
 * The store key for reading an attempt's log. An org-wide scope looks the project up, which also
 * proves the attempt is the scope's. Undefined when it is not.
 */
export async function readableLogKey(
  h: Db,
  scope: Scope,
  attemptId: string,
): Promise<LogKey | undefined> {
  if (scope.projectId) return logKey(scope, attemptId);
  const a = await getAttempt(h, scope, attemptId);
  return a ? { orgId: scope.orgId, projectId: a.projectId, attemptId } : undefined;
}

/** Appends a chunk at a byte offset. Returns false when the attempt is not in scope. */
export function appendLog(
  db: Db,
  scope: Scope,
  attemptId: string,
  offset: number,
  bytes: Uint8Array,
): Promise<boolean> {
  return db.run(async (h) => {
    if (!(await getAttempt(h, scope, attemptId))) return false;
    await logStoreFor(h).append(logKey(scope, attemptId), offset, bytes);
    notifyLogAppended(h, scope.orgId, attemptId);
    return true;
  });
}

/** Chunks with offset >= `fromOffset`, in order. Empty when the attempt is not in scope. */
export function readLog(
  db: Db,
  scope: Scope,
  attemptId: string,
  fromOffset = 0,
): Promise<{ offset: number; bytes: Buffer }[]> {
  // The key is resolved in the database; the store is called after, so a slow store never holds
  // the database gate.
  return db
    .run((h) => readableLogKey(h, scope, attemptId))
    .then((key) => (key ? logStoreFor(db).read(key, fromOffset) : []));
}

export * from "./webhooks";
export * from "./notifications";
