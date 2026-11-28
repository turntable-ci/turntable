// Scheduler persistence: claiming queued attempts under a lease, heartbeats, fenced finishing,
// and finding abandoned work. Claim and reconcile are instance-level (a worker has no tenant
// until it has claimed something), so they are intentionally unscoped; everything they return
// carries the tenant scope the caller then uses.
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  type SQL,
  sql,
} from "drizzle-orm";
import { retryableAfterSteps } from "@turntable/act-runner";
import type { Db } from "..";
import { sanitizeInfraError } from "../../infra-error-text";
import { announceCancelled } from "../abort-bus";
import { aggregateRunStatus } from "../job-state";
import * as s from "../schema";
import { externalLogStore, logStoreFor } from "../../logstore/registry";
import {
  appendLog,
  createAttempt,
  getJob,
  getRun,
  listAttempts,
  type Job,
  type JobAttempt,
  listJobs,
  logSize,
  type Run,
  setRunStatus,
  transitionJob,
  updateAttempt,
} from "./index";
import { appendAudit } from "./audit";
import { appendEvent } from "./events";
import { notFrozen } from "./incident";
import {
  emitQuotaNotices,
  HOUR_MS,
  orgsWithQuotas,
  quotaStatuses,
  quotaUsage,
  type OrgQuotas,
  type QuotaStatus,
  type QuotaUsage,
} from "./quotas";
import { getProjectIngest, groupBlocked } from "./poll";
import { closeWaiting, markWaiting, setWaitingReason } from "./waiting";
import { projectsWithCaps, yieldProjects } from "./project-settings";
import {
  defaultReadiness,
  depStates,
  effectiveStates,
  latestReasons,
  needsDecision,
  type Readiness,
  resolveDependents,
} from "./readiness";
import { logKey, type Scope, scoped } from "./scope";

export type Claim = {
  attempt: JobAttempt;
  job: Job;
  run: Run;
  scope: Required<Scope>;
};

export type ClaimOptions = {
  owner: string;
  leaseMs: number;
  now: number;
  /** Most attempts running at once across the instance. */
  globalCap: number;
  /** Most attempts running at once per org, so one tenant cannot take every slot. */
  perOrgCap: number;
  /**
   * How long a per-org quota reading may be reused (the byte gauges are sums over big tables).
   * Default 0: every claim reads fresh. The scheduler passes a few seconds.
   */
  quotaCacheMs?: number;
  /** Decides whether a queued job may run. Default: plain `needs` (see defaultReadiness). */
  readiness?: Readiness;
  /** Queued rows examined per org per round. Default 25. */
  pageSize?: number;
  /** Most queued rows examined in one claim, across all orgs. Default 1000. */
  scanLimit?: number;
  /**
   * Claim only this run's attempts (a `turntable run` process running its own run), and count
   * only its attempts against the caps. Without it, runs started by `turntable run` (`local`)
   * are never claimed.
   */
  onlyRun?: string;
  /**
   * Anti-thrash (#355): a job preempted `max` times within `windowMs` is no longer preempted until
   * it finishes. `max` 0 means no limit, which is the default; the scheduler passes the
   * `preempt_max_per_job` and `preempt_window_minutes` settings.
   */
  preemptLimit?: { max: number; windowMs: number };
};

/** The defaults of `preemptLimit`, mirrored by the settings of the same names. */
export const DEFAULT_PREEMPT_LIMIT = { max: 0, windowMs: 60 * 60_000 } as const;

// Keyed by the root handle `claimNextAttempt` was given. A transaction handle is new for every
// claim, so keying on it (as this once did) never hit, and every claim re-ran the sandbox-span
// query for every waiting org (#815).
const usageCache = new WeakMap<Db, Map<string, { at: number; usage: QuotaUsage }>>();
export async function cachedUsage(
  db: Db,
  orgId: string,
  now: number,
  ttl: number,
  limits: Pick<OrgQuotas, "maxLogBytes">,
  cacheKey: Db = db,
): Promise<QuotaUsage> {
  let m = usageCache.get(cacheKey);
  if (!m) usageCache.set(cacheKey, (m = new Map()));
  const hit = m.get(orgId);
  // A limit set since the entry was cached needs the measured figure, not the skipped one.
  const measured = limits.maxLogBytes === null || hit?.usage.logBytes != null;
  if (ttl > 0 && hit && measured && Math.abs(now - hit.at) < ttl) return hit.usage;
  const usage = await quotaUsage(db, orgId, now, limits, { noWait: true });
  m.set(orgId, { at: now, usage });
  return usage;
}

const noticeAt = new WeakMap<Db, Map<string, number>>();
async function noticesOnce(
  db: Db,
  orgId: string,
  statuses: readonly QuotaStatus[],
  now: number,
  ttl: number,
  cacheKey: Db = db,
): Promise<void> {
  let m = noticeAt.get(cacheKey);
  if (!m) noticeAt.set(cacheKey, (m = new Map()));
  const last = m.get(orgId);
  if (ttl > 0 && last !== undefined && Math.abs(now - last) < ttl) return;
  m.set(orgId, now);
  await emitQuotaNotices(db, orgId, statuses, now);
}

/** Runs that have an attempt started at or after `since`. */
async function runsStartedSince(db: Db, orgId: string, since: number): Promise<Set<string>> {
  const rows = await db.orm
    .selectDistinct({ runId: s.jobs.runId })
    .from(s.jobAttempts)
    .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
    .where(
      and(
        eq(s.jobAttempts.orgId, orgId),
        isNotNull(s.jobAttempts.startedAt),
        gte(s.jobAttempts.startedAt, since),
      ),
    );
  return new Set(rows.map((r) => r.runId));
}

/**
 * Claims the next runnable queued attempt, or returns undefined. Runnable means: its job is
 * queued (not awaiting approval), the readiness function says `ready`, and neither the global
 * nor its org's cap is reached. Claiming moves the attempt, its job and its run to running and
 * takes the lease, in one transaction: two workers can never claim the same attempt.
 *
 * Fairness: orgs with queued work are visited round-robin, the org with the fewest running
 * attempts first, and oldest first within an org, one page per org per round. An org with a
 * hundred attempts that cannot run yet therefore cannot hide another org's ready attempt. The
 * scan is bounded by `scanLimit` rows in total, so a claim is never unbounded work. Jobs the
 * readiness function says can never run (`skip`, `cancel`) are resolved on the way.
 *
 * Capacity counts every attempt in state running, lease expired or not, so a crashed worker
 * keeps its slot until the reconciler resolves it.
 */
/** Run events that are claimed ahead of PR runs within a project: trust class protected. */
const PROTECTED_EVENTS: string[] = ["push", "merge_group"];

export function claimNextAttempt(db: Db, o: ClaimOptions): Promise<Claim | undefined> {
  const readiness = o.readiness ?? defaultReadiness;
  const pageSize = o.pageSize ?? 25;
  const scanLimit = o.scanLimit ?? 1000;
  return db.transaction(async (tx) => {
    const running = await tx.orm
      .select({
        orgId: s.jobAttempts.orgId,
        projectId: s.jobAttempts.projectId,
        n: sql<number>`count(*)`.mapWith(Number),
      })
      .from(s.jobAttempts)
      .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
      .innerJoin(s.runs, eq(s.runs.id, s.jobs.runId))
      .where(
        and(
          eq(s.jobAttempts.state, "running"),
          // A local run's attempts use only their own process's slots.
          o.onlyRun ? eq(s.jobs.runId, o.onlyRun) : eq(s.runs.local, false),
        ),
      )
      .groupBy(s.jobAttempts.orgId, s.jobAttempts.projectId);
    const perOrg = new Map<string, number>();
    for (const r of running) perOrg.set(r.orgId, (perOrg.get(r.orgId) ?? 0) + Number(r.n));
    let total = 0;
    for (const n of perOrg.values()) total += n;
    // Per-project caps: a project with `max_concurrent` set holds new work once that many of its
    // attempts run. Like the org quota it can only lower the instance's per-org cap. Projects at
    // their cap are left out of both queries below, so their queued attempts neither use up the
    // scan nor hide another project's ready one.
    const caps = await projectsWithCaps(tx);
    const projectFull: string[] = [];
    for (const [projectId, cap] of caps) {
      const used = running
        .filter((r) => r.projectId === projectId)
        .reduce((n, r) => n + Number(r.n), 0);
      if (used >= Math.min(cap, o.perOrgCap)) projectFull.push(projectId);
    }
    const notProjectFull =
      projectFull.length > 0 ? [notInArray(s.jobAttempts.projectId, projectFull)] : [];

    // Per-org quotas (#52). Only orgs with a limit set are looked at. A stored concurrency limit
    // lowers the instance's per-org cap for the org; the other limits hold new work when reached, and say
    // why in `get_quotas` and in an event at 80% and 100%.
    const quotas = await orgsWithQuotas(tx);
    // Quotas limit tenants: a stored limit can lower an org's cap, never lift it above the
    // instance's per-org cap (whatever a row says).
    const capOf = (orgId: string) =>
      Math.min(quotas.get(orgId)?.maxConcurrent ?? Infinity, o.perOrgCap);
    // Scheduling classes: a `yield` project's work is claimed only when no `normal` work can be.
    const yieldIds = await yieldProjects(tx);
    // Why queued attempts were left out (#775), written only when no attempt was claimed (the
    // last call of a scheduler tick), and only where the reason changed. `whyScanned` holds rows this
    // pass already read; `marks` are the groups it excluded in SQL, found by one select each.
    const marks: { reason: string; where: (SQL | undefined)[] }[] = [];
    const whyScanned = new Map<
      string,
      { row: typeof s.jobAttempts.$inferSelect; reason: string }
    >();
    if (projectFull.length > 0) {
      marks.push({ reason: "project_cap", where: [inArray(s.jobAttempts.projectId, projectFull)] });
    }
    const flushWaiting = async (): Promise<void> => {
      for (const { row, reason } of whyScanned.values()) {
        await setWaitingReason(tx, row, reason, o.now);
      }
      for (const m of marks) {
        await markWaiting(tx, { reason: m.reason, where: m.where, now: o.now, onlyRun: o.onlyRun });
      }
    };
    const pass = async (
      klass: "all" | "normal" | "yield",
      probe: boolean,
    ): Promise<Claim | { blockedOrgs: string[] } | undefined> => {
      // A probe collects the first claimable-but-for-room attempt of each org, in claim order.
      const hits: string[] = [];
      const classFilter =
        klass === "all" || yieldIds.size === 0
          ? []
          : klass === "normal"
            ? [notInArray(s.jobAttempts.projectId, [...yieldIds])]
            : [inArray(s.jobAttempts.projectId, [...yieldIds])];
      // A yield project waits for instance capacity by definition: normal work has first call on
      // it, so when the instance room is full its reason is `yield` (written once, at rest). Its
      // own org cap and quota stay named: raising them is what would start the job.
      const instanceReason = klass === "yield" ? "yield" : "instance_cap";
      if (!probe && total >= o.globalCap) {
        marks.push({
          reason: instanceReason,
          where: [...notProjectFull, ...classFilter],
        });
        return undefined;
      }
      const waiting = await tx.orm
        .select({ orgId: s.jobAttempts.orgId, oldest: sql<string>`min(${s.jobAttempts.id})` })
        .from(s.jobAttempts)
        .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
        .innerJoin(s.runs, eq(s.runs.id, s.jobs.runId))
        .where(
          and(
            eq(s.jobAttempts.state, "queued"),
            eq(s.jobs.state, "queued"),
            isNull(s.jobAttempts.leaseOwner),
            o.onlyRun ? eq(s.jobs.runId, o.onlyRun) : eq(s.runs.local, false),
            notFrozen(s.runs.orgId, s.runs.projectId),
            ...notProjectFull,
            ...classFilter,
          ),
        )
        .groupBy(s.jobAttempts.orgId);
      const heldOrgs = new Set<string>();
      const runsFull = new Map<string, Set<string>>();
      for (const w of waiting) {
        const q = quotas.get(w.orgId);
        if (!q) continue;
        const usage = await cachedUsage(tx, w.orgId, o.now, o.quotaCacheMs ?? 0, q, db);
        const statuses = quotaStatuses(q, { ...usage, concurrent: perOrg.get(w.orgId) ?? 0 });
        await noticesOnce(tx, w.orgId, statuses, o.now, o.quotaCacheMs ?? 0, db);
        const hold = statuses.find(
          (st) => st.metric !== "runs_per_hour" && st.metric !== "concurrent" && st.held,
        );
        if (hold) {
          heldOrgs.add(w.orgId);
          if (!probe) {
            marks.push({
              reason: `quota:${hold.metric}`,
              where: [eq(s.jobAttempts.orgId, w.orgId), ...notProjectFull, ...classFilter],
            });
          }
        }
        if (statuses.find((st) => st.metric === "runs_per_hour")?.held) {
          // New runs wait; runs that already started this hour finish their jobs.
          runsFull.set(w.orgId, await runsStartedSince(tx, w.orgId, o.now - HOUR_MS));
        }
      }
      if (!probe) {
        for (const w of waiting) {
          if (heldOrgs.has(w.orgId) || (perOrg.get(w.orgId) ?? 0) < capOf(w.orgId)) continue;
          const stored = quotas.get(w.orgId)?.maxConcurrent;
          marks.push({
            reason: stored != null && stored < o.perOrgCap ? "quota:concurrent" : "org_cap",
            where: [eq(s.jobAttempts.orgId, w.orgId), ...notProjectFull, ...classFilter],
          });
        }
      }
      const orgs = waiting
        .filter((w) => !heldOrgs.has(w.orgId))
        // A probe looks past the caps: it asks what would run if there were room.
        .filter((w) => probe || (perOrg.get(w.orgId) ?? 0) < capOf(w.orgId))
        .toSorted(
          (x, y) =>
            (perOrg.get(x.orgId) ?? 0) - (perOrg.get(y.orgId) ?? 0) ||
            x.oldest.localeCompare(y.oldest),
        )
        .map((w) => w.orgId);
      // Org order and round-robin are tier-agnostic. Inside one org's turn, protected runs
      // (push, merge_group) are paged before that org's other runs; FIFO within each tier.
      const TIERS = ["protected", "other"] as const;
      const cursor = new Map<string, string>(
        orgs.flatMap((id) => TIERS.map((t) => [`${id}|${t}`, ""] as const)),
      );
      const open = new Set(orgs);
      let scanned = 0;

      while (open.size > 0 && scanned < scanLimit) {
        for (const orgId of orgs) {
          if (!open.has(orgId) || scanned >= scanLimit) continue;
          let page: {
            attempt: typeof s.jobAttempts.$inferSelect;
            job: typeof s.jobs.$inferSelect;
          }[] = [];
          let tier: (typeof TIERS)[number] = "protected";
          for (tier of TIERS) {
            const cur = cursor.get(`${orgId}|${tier}`);
            if (cur === undefined) continue;
            page = await tx.orm
              .select({ attempt: s.jobAttempts, job: s.jobs })
              .from(s.jobAttempts)
              .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
              .innerJoin(s.runs, eq(s.runs.id, s.jobs.runId))
              .where(
                and(
                  eq(s.jobAttempts.orgId, orgId),
                  eq(s.jobAttempts.state, "queued"),
                  eq(s.jobs.state, "queued"),
                  isNull(s.jobAttempts.leaseOwner),
                  o.onlyRun ? eq(s.jobs.runId, o.onlyRun) : eq(s.runs.local, false),
                  notFrozen(s.runs.orgId, s.runs.projectId),
                  ...notProjectFull,
                  ...classFilter,
                  tier === "protected"
                    ? inArray(s.runs.event, PROTECTED_EVENTS)
                    : notInArray(s.runs.event, PROTECTED_EVENTS),
                  gt(s.jobAttempts.id, cur),
                ),
              )
              .orderBy(asc(s.jobAttempts.id))
              .limit(Math.min(pageSize, scanLimit - scanned));
            if (page.length > 0) break;
            cursor.delete(`${orgId}|${tier}`); // tier exhausted: next tier, same turn
          }
          if (page.length === 0) {
            open.delete(orgId);
            continue;
          }
          cursor.set(`${orgId}|${tier}`, page.at(-1)!.attempt.id);
          for (const c of page) {
            scanned++;
            const scope = { orgId: c.attempt.orgId, projectId: c.attempt.projectId };
            // A run waiting for its concurrency group (an older run of it is still going) starts
            // nothing yet.
            const candRun = await getRun(tx, scope, c.job.runId);
            const hold = (reason: string): void => {
              if (!probe) whyScanned.set(c.attempt.id, { row: c.attempt, reason });
            };
            if (candRun && (await groupBlocked(tx, candRun))) {
              hold("needs");
              continue;
            }
            const started = runsFull.get(orgId);
            if (started && !started.has(c.job.runId)) {
              hold("quota:runs_per_hour");
              continue;
            }
            if (needsDecision(c.job)) {
              const siblings = await listJobs(tx, scope, c.job.runId);
              // Resolved earlier in this scan: no longer queued.
              const self = siblings.find((j) => j.id === c.job.id);
              if (!self || self.state !== "queued") continue;
              const decision = readiness(
                c.job,
                depStates(c.job, siblings, await latestReasons(tx, scope, c.job.runId)),
                await getRun(tx, scope, c.job.runId),
              ).decision;
              if (decision === "wait") {
                hold("needs");
                continue;
              }
              if (decision === "skip" || decision === "cancel") {
                await resolveDependents(tx, scope, c.job.runId, readiness);
                continue;
              }
              // strategy.max-parallel: legs of one matrix job running at once.
              const planned = c.job.planned
                ? (JSON.parse(c.job.planned) as { id?: string; maxParallel?: number })
                : undefined;
              if (planned?.maxParallel !== undefined && planned.id !== undefined) {
                const legsRunning = siblings.filter(
                  (j) =>
                    j.state === "running" &&
                    j.planned !== null &&
                    (JSON.parse(j.planned) as { id?: string }).id === planned.id,
                ).length;
                if (legsRunning >= planned.maxParallel) {
                  hold("needs");
                  continue;
                }
              }
            }
            if (probe) {
              hits.push(orgId);
              open.delete(orgId);
              break;
            }
            const claimed = await tx.orm
              .update(s.jobAttempts)
              .set({ leaseOwner: o.owner, leaseExpiresAt: o.now + o.leaseMs, heartbeatAt: o.now })
              .where(
                and(
                  eq(s.jobAttempts.id, c.attempt.id),
                  eq(s.jobAttempts.state, "queued"),
                  isNull(s.jobAttempts.leaseOwner),
                ),
              )
              .returning({ id: s.jobAttempts.id });
            if (claimed.length === 0) {
              hold("claimable");
              continue;
            }
            await transitionJob(tx, scope, c.job.id, "running");
            const attempt = (await updateAttempt(tx, scope, c.attempt.id, {
              state: "running",
              waitingReason: null,
              waitedMs: closeWaiting(c.attempt, o.now, "claimable"),
            }))!;
            const run = (await getRun(tx, scope, c.job.runId))!;
            if (run.status !== "running") await setRunStatus(tx, scope, run.id, "running");
            return {
              attempt,
              job: (await listJobs(tx, scope, run.id)).find((j) => j.id === c.job.id)!,
              run: (await getRun(tx, scope, run.id))!,
              scope,
            };
          }
        }
      }
      return probe && hits.length > 0 ? { blockedOrgs: hits } : undefined;
    };

    if (yieldIds.size === 0) {
      const claim = (await pass("all", false)) as Claim | undefined;
      if (!claim) await flushWaiting();
      return claim;
    }
    const normal = await pass("normal", false);
    if (normal) {
      return normal as Claim;
    }
    // Nothing normal could be claimed. If a normal attempt waits only for room, free a slot by
    // preempting the newest yield attempt holding one, then claim for the waiting attempt. One
    // victim per call, so a fan-out of waiting normal attempts preempts one yield attempt each.
    const probed = await pass("normal", true);
    // Each candidate is one that nothing but a full cap holds back (the probe skips project caps,
    // freezes, quota holds, gates and groups). A preemption is made only for a candidate it lets
    // start: after the victim leaves, both the global cap and the candidate's org cap have room.
    // The first candidate with a fitting victim wins, so one that cannot be helped (its org is
    // full of normal work) never masks another that can.
    if (probed && "blockedOrgs" in probed) {
      for (const orgId of probed.blockedOrgs) {
        const orgFull = (perOrg.get(orgId) ?? 0) >= capOf(orgId);
        if (!orgFull && total < o.globalCap) continue; // lost a claim race: no cap to relieve
        const victim = await newestYieldAttempt(tx, yieldIds, {
          ...(orgFull ? { orgId } : {}),
          ...(o.onlyRun ? { onlyRun: o.onlyRun } : {}),
          limit: o.preemptLimit ?? DEFAULT_PREEMPT_LIMIT,
          now: o.now,
        });
        if (!victim) continue;
        const orgAfter = (perOrg.get(orgId) ?? 0) - (victim.orgId === orgId ? 1 : 0);
        if (total - 1 >= o.globalCap || orgAfter >= capOf(orgId)) continue; // would not make room
        await preemptAttempt(tx, victim, orgId, o.now);
        // The slot is free for the claim below: update the counts read at the start.
        total--;
        perOrg.set(victim.orgId, (perOrg.get(victim.orgId) ?? 1) - 1);
        const after = (await pass("normal", false)) as Claim | undefined;
        if (!after) await flushWaiting();
        return after;
      }
    }
    const last = (await pass("yield", false)) as Claim | undefined;
    if (!last) await flushWaiting();
    return last;
  });
}

/** Trust classes that pass `retryableAfterSteps`, as a list for the victim query. */
const RETRYABLE_CLASSES: string[] = ["trusted_pr", "untrusted_pr", "protected", "release"].filter(
  retryableAfterSteps,
);

/** The attempt error class of a preempted attempt: requeued, never a failure. */
export const PREEMPTED = "preempted";

/**
 * The newest running attempt of a `yield` project (highest id), optionally only in one org. Local
 * runs count only inside their own process's claim, as in `claimNextAttempt`. A job already
 * preempted `limit.max` times inside the window is skipped (anti-thrash): it runs to its end. A
 * `max` of 0 turns that off.
 */
async function newestYieldAttempt(
  tx: Db,
  yieldIds: ReadonlySet<string>,
  within: {
    orgId?: string;
    onlyRun?: string;
    limit: { max: number; windowMs: number };
    now: number;
  },
): Promise<JobAttempt | undefined> {
  const spent =
    within.limit.max < 1
      ? []
      : await tx.orm
          .select({ jobId: s.jobAttempts.jobId })
          .from(s.jobAttempts)
          .where(
            and(
              eq(s.jobAttempts.errorClass, PREEMPTED),
              inArray(s.jobAttempts.projectId, [...yieldIds]),
              gte(s.jobAttempts.finishedAt, within.now - within.limit.windowMs),
            ),
          )
          .groupBy(s.jobAttempts.jobId)
          .having(sql`count(*) >= ${within.limit.max}`);
  const [row] = await tx.orm
    .select({ attempt: s.jobAttempts })
    .from(s.jobAttempts)
    .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
    .innerJoin(s.runs, eq(s.runs.id, s.jobs.runId))
    .where(
      and(
        eq(s.jobAttempts.state, "running"),
        inArray(s.jobAttempts.projectId, [...yieldIds]),
        // Only a class that is safe to rerun (#565); an unrecorded class is never a victim.
        inArray(s.jobAttempts.trustClass, RETRYABLE_CLASSES),
        within.orgId ? eq(s.jobAttempts.orgId, within.orgId) : undefined,
        within.onlyRun ? eq(s.jobs.runId, within.onlyRun) : eq(s.runs.local, false),
        spent.length > 0
          ? notInArray(
              s.jobAttempts.jobId,
              spent.map((r) => r.jobId),
            )
          : undefined,
      ),
    )
    .orderBy(desc(s.jobAttempts.id))
    .limit(1);
  return row?.attempt;
}

/**
 * Stops a running yield attempt so a waiting normal one can have its slot, and requeues its job.
 * Inside the claim's transaction. The attempt ends `cancelled` with the error class `preempted`
 * and keeps its log, steps and sandbox record; the job goes back to `queued` (through
 * `infra_error`, the one existing way back) with a NEW attempt, so no attempt row is reused and the
 * partial log stays readable under the old id. No `rerun_reason` is set, so it uses none of the
 * commit's reruns. The worker is told after commit (the cancel path), and one in another process
 * finds its lease gone at its next heartbeat.
 */
async function preemptAttempt(
  tx: Db,
  victim: JobAttempt,
  forOrgId: string,
  now: number,
): Promise<void> {
  const scope = { orgId: victim.orgId, projectId: victim.projectId };
  await updateAttempt(tx, scope, victim.id, { state: "cancelled", errorClass: PREEMPTED });
  await tx.orm
    .update(s.jobAttempts)
    .set({ leaseOwner: null, leaseExpiresAt: null })
    .where(eq(s.jobAttempts.id, victim.id));
  await transitionJob(tx, scope, victim.jobId, "infra_error", { reason: PREEMPTED });
  const job = await transitionJob(tx, scope, victim.jobId, "queued", { reason: PREEMPTED });
  await createAttempt(tx, scope, { jobId: victim.jobId, provider: victim.provider });
  if (job) {
    const states = effectiveStates(await listJobs(tx, scope, job.runId));
    await setRunStatus(tx, scope, job.runId, aggregateRunStatus(states));
  }
  await appendAudit(tx, scope, {
    principalKind: "system",
    principalId: "scheduler",
    op: "scheduler.preempt",
    effect: "write",
    outcome: "ok",
    input: {
      attempt_id: victim.id,
      job_id: victim.jobId,
      scheduling_class: "yield",
      for_org_id: forOrgId,
      at: now,
    },
  });
  announceCancelled(tx, [
    { attemptId: victim.id, sandboxId: victim.sandboxId, provider: victim.provider },
  ]);
}

/**
 * Extends the lease. False means the lease is gone: the attempt was cancelled, finished or taken
 * by the reconciler, and the caller must stop work.
 */
export function heartbeatAttempt(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
  now: number,
  leaseMs: number,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.jobAttempts)
      .set({ heartbeatAt: now, leaseExpiresAt: now + leaseMs })
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, attemptId),
          eq(s.jobAttempts.state, "running"),
          eq(s.jobAttempts.leaseOwner, owner),
        ),
      )
      .returning({ id: s.jobAttempts.id });
    return rows.length > 0;
  });
}

/** Records where the attempt runs, so a restarted controller can probe it. Fenced by owner. */
export function recordExec(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
  where: {
    sandboxId?: string | undefined;
    execId?: string | undefined;
    /** Epoch ms the provider's create returned. */
    sandboxCreatedAt?: number | undefined;
    /** The provider's effective TTL for the sandbox, in seconds. */
    sandboxTtlSeconds?: number | undefined;
    /** Epoch ms the provider confirmed the destroy. */
    sandboxDestroyedAt?: number | undefined;
    /** Why another controller may not re-attach (#761); null: it may. */
    adoptBlock?: string | null | undefined;
    /** What another controller needs to rebuild the attempt's credentials (#787); never a secret. */
    adoptSpec?: string | null | undefined;
  },
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.jobAttempts)
      .set({
        ...(where.sandboxId === undefined ? {} : { sandboxId: where.sandboxId }),
        ...(where.execId === undefined ? {} : { execId: where.execId }),
        ...(where.sandboxCreatedAt === undefined
          ? {}
          : { sandboxCreatedAt: where.sandboxCreatedAt }),
        ...(where.sandboxTtlSeconds === undefined
          ? {}
          : { sandboxTtlSeconds: where.sandboxTtlSeconds }),
        ...(where.sandboxDestroyedAt === undefined
          ? {}
          : { sandboxDestroyedAt: where.sandboxDestroyedAt }),
        ...(where.adoptBlock === undefined ? {} : { adoptBlock: where.adoptBlock }),
        ...(where.adoptSpec === undefined ? {} : { adoptSpec: where.adoptSpec }),
      })
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, attemptId),
          eq(s.jobAttempts.state, "running"),
          eq(s.jobAttempts.leaseOwner, owner),
        ),
      )
      .returning({ id: s.jobAttempts.id });
    return rows.length > 0;
  });
}

/**
 * Records the class the attempt runs as (after the demotion rule). Write-once and fenced by the
 * lease owner: the class can be recorded, never changed or raised afterwards.
 */
export function recordTrustClass(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
  klass: string,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.jobAttempts)
      .set({ trustClass: klass })
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, attemptId),
          eq(s.jobAttempts.state, "running"),
          eq(s.jobAttempts.leaseOwner, owner),
          isNull(s.jobAttempts.trustClass),
        ),
      )
      .returning({ id: s.jobAttempts.id });
    return rows.length > 0;
  });
}

/**
 * Stores the attempt's resolved job plan (JSON) when it starts, so a restarted controller can
 * re-attach without fetching the repo. Fenced by the lease owner.
 */
export function recordPlan(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
  planJson: string,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.jobAttempts)
      .set({ plan: planJson })
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, attemptId),
          eq(s.jobAttempts.state, "running"),
          eq(s.jobAttempts.leaseOwner, owner),
        ),
      )
      .returning({ id: s.jobAttempts.id });
    return rows.length > 0;
  });
}

export type FinishInput = {
  attemptId: string;
  /** The lease holder finishing its own work, or the reconciler finishing an expired one. */
  owner: string;
  state: "success" | "failure" | "skipped" | "infra_error" | "cancelled";
  exitCode?: number | null;
  errorClass?: string | null;
  /** For infra_error: the named kind (`INFRA_KINDS`). */
  infraKind?: string | null;
  /** For infra_error: the underlying error's name and code, kept on the `infra.error` event. */
  errorDetail?: { name?: string; code?: string };
  /** Reconciler only: finish only if the lease has expired by this time. */
  expiredBefore?: number;
  /** How dependents of this job are resolved. Default: plain `needs`. */
  readiness?: Readiness;
  /** The job's outputs, kept for its dependents (`needs.<id>.outputs.*`). */
  outputs?: Record<string, string> | undefined;
};

/**
 * Ends a running attempt: attempt, job and run move together, the lease is cleared, events are
 * written, all in one transaction. Fenced: returns false (and changes nothing) unless the
 * attempt is still running under `owner`'s lease, so a slow worker cannot overwrite what the
 * reconciler or a cancel decided.
 */
export function finishAttempt(db: Db, scope: Scope, input: FinishInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.orm
      .select()
      .from(s.jobAttempts)
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, input.attemptId),
        ),
      )
      .limit(1);
    if (!cur || cur.state !== "running" || cur.leaseOwner !== input.owner) return false;
    if (
      input.expiredBefore !== undefined &&
      (cur.leaseExpiresAt === null || cur.leaseExpiresAt >= input.expiredBefore)
    ) {
      return false;
    }
    await updateAttempt(tx, scope, cur.id, {
      state: input.state,
      exitCode: input.exitCode ?? null,
      errorClass: input.errorClass ?? null,
      ...(input.state === "infra_error" && input.infraKind ? { infraKind: input.infraKind } : {}),
      ...(input.state === "infra_error" && input.errorDetail
        ? { errorDetail: input.errorDetail }
        : {}),
    });
    await tx.orm
      .update(s.jobAttempts)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(eq(s.jobAttempts.id, cur.id));
    const job = await transitionJob(tx, scope, cur.jobId, input.state, {
      exitCode: input.exitCode ?? null,
    });
    if (input.outputs && Object.keys(input.outputs).length > 0) {
      await tx.orm
        .update(s.jobs)
        .set({ outputs: JSON.stringify(input.outputs) })
        .where(eq(s.jobs.id, cur.jobId));
    }
    if (job) {
      // strategy.fail-fast: a failed matrix leg cancels the legs of its job that have not started.
      const planned = job.planned
        ? (JSON.parse(job.planned) as {
            id?: string;
            failFast?: boolean;
            continueOnError?: boolean;
          })
        : undefined;
      if (
        planned?.failFast &&
        planned.id !== undefined &&
        job.matrix !== null &&
        (input.state === "failure" || input.state === "infra_error") &&
        !planned.continueOnError
      ) {
        for (const sib of await listJobs(tx, scope, job.runId)) {
          if (sib.state !== "queued" || sib.id === job.id || sib.planned === null) continue;
          if ((JSON.parse(sib.planned) as { id?: string }).id !== planned.id) continue;
          await transitionJob(tx, scope, sib.id, "cancelled");
          const live = (await listAttempts(tx, scope, sib.id)).findLast(
            (a) => a.state === "queued",
          );
          if (live) {
            await updateAttempt(tx, scope, live.id, {
              state: "cancelled",
              errorClass: "matrix fail-fast",
            });
          }
        }
      }
      // Dependents that can never run leave the queue now, in this same transaction.
      await resolveDependents(tx, scope, job.runId, input.readiness);
      const states = effectiveStates(await listJobs(tx, scope, job.runId));
      await setRunStatus(tx, scope, job.runId, aggregateRunStatus(states));
    }
    return true;
  });
}

/** The attempt error class prefix of an attempt whose controller vanished (see reconcileExpired). */
export const CONTROLLER_LOST = "controller_lost";
/**
 * Set on a still-running attempt by a shutdown that gave up waiting for it (the drain timeout). It
 * tells the next boot's reconcile: if the exec cannot be re-attached, retry the job once.
 */
export const DRAIN_CUT = "drain_cut";

/** Marks a running attempt as cut by a drain timeout. Fenced by the lease holder. */
export function markDrainCut(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.jobAttempts)
      .set({ errorClass: DRAIN_CUT })
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          and(
            eq(s.jobAttempts.id, attemptId),
            eq(s.jobAttempts.state, "running"),
            eq(s.jobAttempts.leaseOwner, owner),
          ),
        ),
      )
      .returning({ id: s.jobAttempts.id });
    return rows.length > 0;
  });
}

/**
 * The reason a drain-cut attempt ends with when it is not requeued because steps may have run for
 * a protected or release job (#565). Exact text: a deploy note greps for it.
 */
export const DRAIN_CUT_NOT_RETRIED =
  "cut by a drain after steps started; not retried for a protected or release job: rerun it by hand";

/** What get_run and job_steps show for an attempt a drain cut or requeued (#784). */
export const DRAIN_CUT_LABEL = "cancelled by deploy drain";

/** The label for an attempt a deploy drain cut or requeued, else null. */
export function drainCutLabel(errorClass: string | null | undefined): string | null {
  if (!errorClass) return null;
  return errorClass === DRAIN_CUT ||
    errorClass.startsWith(`${CONTROLLER_LOST} (drain cancel)`) ||
    errorClass === DRAIN_CUT_NOT_RETRIED
    ? DRAIN_CUT_LABEL
    : null;
}

/**
 * Whether a run is a push to the project's default branch (#784), from the ingest settings'
 * `defaultBranch`. A project with no known default branch counts a push run as one: it is requeued
 * rather than cut, so a deploy gate can never be stranded by a guess.
 */
export async function isDefaultBranchPush(
  db: Db,
  scope: Scope,
  run: { event: string; ref: string },
): Promise<boolean> {
  if (run.event !== "push") return false;
  let branch: string | undefined;
  try {
    const json = await getProjectIngest(db, scope);
    const parsed: unknown = json ? JSON.parse(json) : null;
    const d = (parsed as { defaultBranch?: unknown } | null)?.defaultBranch;
    if (typeof d === "string" && d !== "") branch = d;
  } catch {
    branch = undefined;
  }
  if (branch === undefined) return true;
  const norm = (r: string): string => r.replace(/^refs\/heads\//, "");
  return norm(run.ref) === norm(branch);
}

/**
 * Whether an attempt has started a step or launched its exec (#784): the point past which a
 * default-branch push attempt is waited for by a drain rather than requeued. It follows the rule
 * `requeueLostAttemptOnce` uses: when the attempt's trust class is not `retryableAfterSteps`
 * (protected, release, none), a recorded `sandbox_id` also counts, since the runner records it
 * before exec starts and a requeue would refuse the attempt (`not_retried`, a stranded gate).
 */
export async function attemptHasStartedSteps(
  db: Db,
  scope: Scope,
  attemptId: string,
  retryable: (trustClass: string | null) => boolean = retryableAfterSteps,
): Promise<boolean> {
  const [cur] = await db.orm
    .select({
      execId: s.jobAttempts.execId,
      sandboxId: s.jobAttempts.sandboxId,
      trustClass: s.jobAttempts.trustClass,
    })
    .from(s.jobAttempts)
    .where(
      scoped(
        scope,
        { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
        eq(s.jobAttempts.id, attemptId),
      ),
    )
    .limit(1);
  if (cur?.execId) return true;
  if (cur?.sandboxId && !retryable(cur.trustClass ?? null)) return true;
  const [started] = await db.orm
    .select({ stepKey: s.attemptSteps.stepKey })
    .from(s.attemptSteps)
    .where(
      scoped(
        scope,
        { orgId: s.attemptSteps.orgId, projectId: s.attemptSteps.projectId },
        and(eq(s.attemptSteps.attemptId, attemptId), isNotNull(s.attemptSteps.startedAt)),
      ),
    )
    .limit(1);
  return started !== undefined;
}

export type RequeueLostResult = "requeued" | "not_retried" | "no";

/**
 * A job whose controller vanished after a drain timeout cut it (`markDrainCut`) is requeued ONCE
 * as an infra error: the lost attempt ends `infra_error` (never `failure`), the job goes back to
 * `queued` with a NEW attempt and no rerun reason (it uses none of the commit's reruns). A job
 * that already lost an attempt this way is left to the caller, which finishes it as `infra_error`.
 * Fenced like `finishAttempt`: only a still-running attempt whose lease expired before `now`.
 *
 * The requeue follows the infra-retry rule (#565), failing safe: only when the attempt's recorded
 * trust class passes `retryableAfterSteps`, or act provably never ran. A step row is NOT proof that
 * no step ran: it is written when the controller reads act's step-start event, so it lags the
 * sandbox, and a drain cut is exactly when the controller vanished. So the exec rule is: no step
 * row with `started_at` AND no `exec_id` AND no `sandbox_id`. The runner records `sandbox_id`
 * (awaited) before it uploads anything or starts act, and records `exec_id` only AFTER
 * `exec.start` returned, so a NULL `exec_id` alone would not prove act never started; a NULL
 * `sandbox_id` does (the cut came while the sandbox was being created), unless the caller says the sandbox was recorded after the cut (`sandboxAfterCut`). Otherwise a protected or
 * release job may have deployed or published, so nothing is changed except an
 * `attempt.drain_cut_not_retried` event and audit entry, and "not_retried" is returned: the
 * caller ends the attempt `infra_error` with `DRAIN_CUT_NOT_RETRIED`. An attempt with no recorded
 * class counts as not a pull request.
 *
 * Returns "requeued", "not_retried" (see above) or "no" (not eligible: the caller finishes it).
 */
export function requeueLostAttemptOnce(
  db: Db,
  scope: Scope,
  input: {
    attemptId: string;
    owner: string;
    errorClass: string;
    now: number;
    /**
     * Default true: only an attempt whose lease expired (a vanished controller). A live drain cut
     * of a shadow attempt (#480) passes false: this process still holds the lease and has just
     * stopped the sandbox.
     */
    requireExpired?: boolean;
    /**
     * A default-branch push attempt cut by a drain (#784) is requeued after every drain, not once:
     * skips the check for an earlier lost attempt of the job.
     */
    repeatable?: boolean;
    /**
     * The cut was chosen while no sandbox was recorded (#784), so a `sandbox_id` seen now was
     * recorded after the cut, and the runner settles before it uploads or starts act once it sees
     * the stop: it does not count as a launch. An `exec_id` or a started step still does.
     */
    sandboxAfterCut?: boolean;
    /** The trust-class half of the rule: `retryableAfterSteps` from `@turntable/act-runner`. */
    retryableAfterSteps: (trustClass: string | null) => boolean;
  },
): Promise<RequeueLostResult> {
  return db.transaction(async (tx): Promise<RequeueLostResult> => {
    const [cur] = await tx.orm
      .select()
      .from(s.jobAttempts)
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, input.attemptId),
        ),
      )
      .limit(1);
    if (!cur || cur.state !== "running" || cur.leaseOwner !== input.owner) return "no";
    if (
      input.requireExpired !== false &&
      (cur.leaseExpiresAt === null || cur.leaseExpiresAt >= input.now)
    ) {
      return "no";
    }
    if (cur.errorClass !== DRAIN_CUT) return "no";
    const earlier = (await listAttempts(tx, scope, cur.jobId)).filter(
      (a) => a.id !== cur.id && a.errorClass?.startsWith(CONTROLLER_LOST),
    );
    if (earlier.length > 0 && !input.repeatable) return "no";
    if (!input.retryableAfterSteps(cur.trustClass)) {
      const launched = (cur.sandboxId !== null && !input.sandboxAfterCut) || cur.execId !== null;
      const [started] = launched
        ? [{ stepKey: "" }]
        : await tx.orm
            .select({ stepKey: s.attemptSteps.stepKey })
            .from(s.attemptSteps)
            .where(
              scoped(
                scope,
                { orgId: s.attemptSteps.orgId, projectId: s.attemptSteps.projectId },
                and(eq(s.attemptSteps.attemptId, cur.id), isNotNull(s.attemptSteps.startedAt)),
              ),
            )
            .limit(1);
      if (started) {
        const job = await getJob(tx, scope, cur.jobId);
        await appendEvent(tx, scope, {
          type: "attempt.drain_cut_not_retried",
          runId: job?.runId,
          jobId: cur.jobId,
          attemptId: cur.id,
          payload: {
            attempt_id: cur.id,
            job_id: cur.jobId,
            org_id: scope.orgId,
            project_id: scope.projectId ?? null,
            trust_class: cur.trustClass ?? null,
          },
        });
        await appendAudit(tx, scope, {
          principalKind: "system",
          principalId: "scheduler",
          op: "attempt.drain_cut_not_retried",
          effect: "write",
          outcome: "ok",
          input: {
            attempt_id: cur.id,
            job_id: cur.jobId,
            org_id: scope.orgId,
            project_id: scope.projectId ?? null,
            at: input.now,
          },
        });
        return "not_retried";
      }
    }
    await updateAttempt(tx, scope, cur.id, {
      state: "infra_error",
      errorClass: input.errorClass,
    });
    await tx.orm
      .update(s.jobAttempts)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(eq(s.jobAttempts.id, cur.id));
    await transitionJob(tx, scope, cur.jobId, "infra_error", { reason: CONTROLLER_LOST });
    const job = await transitionJob(tx, scope, cur.jobId, "queued", { reason: CONTROLLER_LOST });
    await createAttempt(tx, scope, { jobId: cur.jobId, provider: cur.provider });
    if (job) {
      const states = effectiveStates(await listJobs(tx, scope, job.runId));
      await setRunStatus(tx, scope, job.runId, aggregateRunStatus(states));
    }
    await appendAudit(tx, scope, {
      principalKind: "system",
      principalId: "scheduler",
      op: "scheduler.requeue_lost",
      effect: "write",
      outcome: "ok",
      input: { attempt_id: cur.id, job_id: cur.jobId, at: input.now },
    });
    return "requeued";
  });
}

/**
 * The one automatic retry of a transient infrastructure failure (#517). The failed attempt ends
 * `infra_error` with its kind, the job goes back to `queued` under a NEW attempt (the same way
 * `requeueLostAttemptOnce` does it, with no rerun reason, so it uses none of the commit's
 * reruns), and the run's events and audit log record `attempt.infra_retry` with the kind.
 *
 * At most one per job: an earlier attempt of the job that ended with an infra kind (counted from
 * the latest manual rerun, which starts a fresh budget) means no retry. The drain-cut requeue has
 * its own limit and does not count here. The new attempt inherits the failed one's check, so the
 * job keeps one check, which then shows the retry.
 *
 * Fenced like `finishAttempt` (the attempt must still run under `owner`). Returns true when it
 * requeued; false (changing nothing) when the budget is spent or the lease is gone.
 */
export async function requeueInfraFailureOnce(
  db: Db,
  scope: Scope,
  input: {
    attemptId: string;
    owner: string;
    kind: string;
    reason: string;
    errorDetail?: { name?: string; code?: string };
    now: number;
  },
): Promise<boolean> {
  // With an external store the end of the log is an HTTP call, which must not run (or hang) while
  // the write lock is held, so it is read before the transaction opens; appending inside is a queue
  // push. When the store is down the marker line is skipped; the retry itself must not be lost.
  // With the database store the size is measured inside the transaction, so it is the size at the
  // moment the attempt is failed (a chunk written in between cannot be overwritten by the marker).
  const external = externalLogStore() !== undefined;
  const early = external ? await logSize(db, scope, input.attemptId).catch(() => null) : null;
  return db.transaction(async (tx) => {
    const [cur] = await tx.orm
      .select()
      .from(s.jobAttempts)
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, input.attemptId),
        ),
      )
      .limit(1);
    if (!cur || cur.state !== "running" || cur.leaseOwner !== input.owner) return false;
    if (await earlierInfraReason(tx, scope, cur)) return false;
    await updateAttempt(tx, scope, cur.id, {
      state: "infra_error",
      errorClass: input.reason.slice(0, 200),
      infraKind: input.kind,
      ...(input.errorDetail ? { errorDetail: input.errorDetail } : {}),
    });
    await tx.orm
      .update(s.jobAttempts)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(eq(s.jobAttempts.id, cur.id));
    // One line at the end of the failed attempt's job log: it was retried once, and why.
    const why = sanitizeInfraError(input.reason).slice(0, 200);
    const tail = external ? early : await logSize(tx, scope, cur.id);
    if (tail !== null) {
      await appendLog(
        tx,
        scope,
        cur.id,
        tail,
        new TextEncoder().encode(
          `infra error (${input.kind}), retrying once on a fresh sandbox: ${why}\n`,
        ),
      );
    }
    await transitionJob(tx, scope, cur.jobId, "infra_error", {
      reason: `infra_retry:${input.kind}`,
    });
    const job = await transitionJob(tx, scope, cur.jobId, "queued", {
      reason: `infra_retry:${input.kind}`,
    });
    const next = await createAttempt(tx, scope, { jobId: cur.jobId, provider: cur.provider });
    if (next && cur.checkRunId) {
      await tx.orm
        .update(s.jobAttempts)
        .set({ checkRunId: cur.checkRunId })
        .where(eq(s.jobAttempts.id, next.id));
    }
    if (job) {
      const states = effectiveStates(await listJobs(tx, scope, job.runId));
      await setRunStatus(tx, scope, job.runId, aggregateRunStatus(states));
      await appendEvent(tx, scope, {
        type: "attempt.infra_retry",
        runId: job.runId,
        jobId: cur.jobId,
        payload: { attempt_id: cur.id, next_attempt_id: next?.id ?? null, kind: input.kind },
      });
    }
    await appendAudit(tx, scope, {
      principalKind: "system",
      principalId: "scheduler",
      op: "attempt.infra_retry",
      effect: "write",
      outcome: "ok",
      input: { attempt_id: cur.id, job_id: cur.jobId, kind: input.kind, at: input.now },
    });
    return true;
  });
}

/** The error class an attempt ends with when a degraded network requeued it (#698). */
export const NETWORK_REQUEUE = "network_degraded";
/** Most requeues one job gets for a degraded network, so a flapping probe cannot loop forever. */
export const MAX_NETWORK_REQUEUES = 10;

/**
 * Requeues an attempt that failed BEFORE its sandbox existed because the network is degraded
 * (#698). The failed attempt ends `infra_error` with no infra kind, so it does NOT spend the job's
 * one automatic retry (`earlierInfraReason` counts only attempts with a kind), and the job goes
 * back to `queued` under a new attempt that inherits the check, so the check ends with the real
 * result. The invariant: an attempt that had a sandbox, an exec or a started step may have had
 * side effects and is never requeued here (it keeps today's one retry). A NULL `sandbox_id` is the
 * proof: the runner records it, awaited, before anything runs in the sandbox. Fenced like
 * `finishAttempt`: the attempt must still run under `owner`; `requireExpired` (a vanished
 * controller, found by the reconciler) also needs its lease to have expired before `now`.
 * Returns true when it requeued; false changes nothing.
 */
export async function requeuePreSandbox(
  db: Db,
  scope: Scope,
  input: {
    attemptId: string;
    owner: string;
    reason: string;
    now: number;
    requireExpired?: boolean;
  },
): Promise<boolean> {
  // With an external log store the log size is an HTTP call, read before the transaction opens;
  // when the store is down the marker line is skipped and the requeue still happens.
  const external = externalLogStore() !== undefined;
  const early = external ? await logSize(db, scope, input.attemptId).catch(() => null) : null;
  return db.transaction(async (tx) => {
    const [cur] = await tx.orm
      .select()
      .from(s.jobAttempts)
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, input.attemptId),
        ),
      )
      .limit(1);
    if (!cur || cur.state !== "running" || cur.leaseOwner !== input.owner) return false;
    if (input.requireExpired && (cur.leaseExpiresAt === null || cur.leaseExpiresAt >= input.now)) {
      return false;
    }
    if (cur.sandboxId !== null || cur.execId !== null) return false;
    const [started] = await tx.orm
      .select({ stepKey: s.attemptSteps.stepKey })
      .from(s.attemptSteps)
      .where(
        scoped(
          scope,
          { orgId: s.attemptSteps.orgId, projectId: s.attemptSteps.projectId },
          and(eq(s.attemptSteps.attemptId, cur.id), isNotNull(s.attemptSteps.startedAt)),
        ),
      )
      .limit(1);
    if (started) return false;
    const all = await listAttempts(tx, scope, cur.jobId);
    const spent = all.filter((a) => a.errorClass?.startsWith(NETWORK_REQUEUE)).length;
    if (spent >= MAX_NETWORK_REQUEUES) return false;
    await updateAttempt(tx, scope, cur.id, {
      state: "infra_error",
      errorClass: `${NETWORK_REQUEUE}: ${sanitizeInfraError(input.reason).slice(0, 160)}`,
    });
    await tx.orm
      .update(s.jobAttempts)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(eq(s.jobAttempts.id, cur.id));
    const tail = external ? early : await logSize(tx, scope, cur.id);
    if (tail !== null) {
      await appendLog(
        tx,
        scope,
        cur.id,
        tail,
        new TextEncoder().encode(
          "network degraded: this attempt failed before a sandbox existed; it is re-queued and does not use the retry\n",
        ),
      );
    }
    await transitionJob(tx, scope, cur.jobId, "infra_error", { reason: NETWORK_REQUEUE });
    const job = await transitionJob(tx, scope, cur.jobId, "queued", { reason: NETWORK_REQUEUE });
    const next = await createAttempt(tx, scope, {
      jobId: cur.jobId,
      provider: cur.provider,
      sortLike: cur.id,
    });
    if (next && cur.checkRunId) {
      await tx.orm
        .update(s.jobAttempts)
        .set({ checkRunId: cur.checkRunId })
        .where(eq(s.jobAttempts.id, next.id));
    }
    if (job) {
      const states = effectiveStates(await listJobs(tx, scope, job.runId));
      await setRunStatus(tx, scope, job.runId, aggregateRunStatus(states));
    }
    await appendAudit(tx, scope, {
      principalKind: "system",
      principalId: "scheduler",
      op: "attempt.network_requeue",
      effect: "write",
      outcome: "ok",
      input: { attempt_id: cur.id, job_id: cur.jobId, at: input.now },
    });
    return true;
  });
}

/**
 * The reason of an earlier infra failure of this attempt's job that already used its one infra
 * retry: an attempt that ended `infra_error` with a kind, since the latest manual rerun (which
 * starts a fresh budget). Undefined when the budget is unspent.
 */
export async function earlierInfraReason(
  db: Db,
  scope: Scope,
  cur: JobAttempt,
): Promise<string | undefined> {
  const all = await listAttempts(db, scope, cur.jobId);
  const lastRerun = all.findLast((a) => a.rerunReason !== null)?.attempt ?? 0;
  const spent = all.findLast(
    (a) =>
      a.id !== cur.id &&
      a.attempt >= lastRerun &&
      a.attempt < cur.attempt &&
      a.state === "infra_error" &&
      a.infraKind !== null,
  );
  return spent ? (spent.errorClass ?? "infra error") : undefined;
}

/** Running attempts whose lease has expired: their worker is gone. Oldest first. */
export function listExpiredLeases(db: Db, now: number): Promise<JobAttempt[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.jobAttempts)
      .where(and(eq(s.jobAttempts.state, "running"), lt(s.jobAttempts.leaseExpiresAt, now)))
      .orderBy(asc(s.jobAttempts.id)),
  );
}

/**
 * Attempts that recorded a sandbox and no confirmed destroy, across every org (system work, for
 * the provider's own-fleet count and the sweep). Newest first, bounded.
 */
export function listUndestroyedSandboxes(db: Db, limit = 2000): Promise<JobAttempt[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.jobAttempts)
      .where(and(isNotNull(s.jobAttempts.sandboxId), isNull(s.jobAttempts.sandboxDestroyedAt)))
      .orderBy(desc(s.jobAttempts.id))
      .limit(limit),
  );
}

/**
 * Records the log checkpoint (#761): the first `logOffset` bytes of the stored log are exactly the
 * rendering of the exec's output before `execOffset`. Fenced by the lease holder.
 */
export function recordLogCheckpoint(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
  execOffset: number,
  logOffset: number,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.jobAttempts)
      .set({ execLogOffset: execOffset, logCheckpoint: logOffset })
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, attemptId),
          eq(s.jobAttempts.state, "running"),
          eq(s.jobAttempts.leaseOwner, owner),
        ),
      )
      .returning({ id: s.jobAttempts.id });
    return rows.length > 0;
  });
}

/**
 * Re-attach from a checkpoint (#761): drops the log chunks, cuts and steps an attempt stored at or
 * past `logOffset` (the previous controller wrote them after its last checkpoint, and the new one
 * renders that output again) and returns the steps kept. Fenced by the lease: undefined when
 * `owner` does not hold it. Chunks start where a write started, and a checkpoint is only taken
 * between writes, so no chunk straddles `logOffset`.
 */
export function truncateAttemptOutput(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
  logOffset: number,
): Promise<
  | { stepKey: string; stage: string; index: number; startedAt?: number; logOffset: number }[]
  | undefined
> {
  return db.transaction(async (tx) => {
    if (!(await holdsLease(tx, scope, attemptId, owner))) return undefined;
    await tx.orm
      .delete(s.logChunks)
      .where(
        scoped(
          scope,
          { orgId: s.logChunks.orgId, projectId: s.logChunks.projectId },
          and(eq(s.logChunks.attemptId, attemptId), gte(s.logChunks.offset, logOffset)),
        ),
      );
    await tx.orm
      .delete(s.logCuts)
      .where(
        scoped(
          scope,
          { orgId: s.logCuts.orgId, projectId: s.logCuts.projectId },
          and(eq(s.logCuts.attemptId, attemptId), gte(s.logCuts.atOffset, logOffset)),
        ),
      );
    await tx.orm
      .delete(s.attemptSteps)
      .where(
        scoped(
          scope,
          { orgId: s.attemptSteps.orgId, projectId: s.attemptSteps.projectId },
          and(eq(s.attemptSteps.attemptId, attemptId), gte(s.attemptSteps.logOffset, logOffset)),
        ),
      );
    const kept = await tx.orm
      .select()
      .from(s.attemptSteps)
      .where(
        scoped(
          scope,
          { orgId: s.attemptSteps.orgId, projectId: s.attemptSteps.projectId },
          eq(s.attemptSteps.attemptId, attemptId),
        ),
      );
    return kept.map((r) => ({
      stepKey: r.stepKey,
      stage: r.stage,
      index: r.stepIndex,
      ...(r.startedAt === null ? {} : { startedAt: r.startedAt }),
      logOffset: r.logOffset,
    }));
  });
}

/**
 * Hands a running attempt to the next controller (#761): its lease is expired now, so the next
 * reconcile (this instance's successor, or another live controller) may take it at once with
 * `takeExpiredLease`, and it is marked cut by the drain, so a sandbox that is gone by then is
 * resolved exactly like a drain-timeout cut. Fenced by the lease holder, who must have stopped
 * every write first. The owner is kept: the reconciler finishes a lost attempt under it.
 */
export function handOffAttempt(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.jobAttempts)
      .set({ errorClass: DRAIN_CUT, leaseExpiresAt: 0 })
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, attemptId),
          eq(s.jobAttempts.state, "running"),
          eq(s.jobAttempts.leaseOwner, owner),
        ),
      )
      .returning({ id: s.jobAttempts.id });
    return rows.length > 0;
  });
}

/**
 * Whether a running attempt can be re-attached by another controller (#761): its exec is recorded
 * (act is running in a live sandbox) and it holds no credential only this process has. The other
 * phases (claimed, sandbox being created, setup and checkout upload before act starts) and a job
 * behind the secrets proxy, with an artifact credential or holding a job token are not. That is
 * about the drain's hand-off only: when a controller dies, reconcile re-attaches to any attempt
 * whose exec still runs, blocked or not.
 */
export function isAdoptable(a: {
  sandboxId: string | null;
  execId: string | null;
  adoptBlock: string | null;
}): boolean {
  return a.sandboxId !== null && a.execId !== null && a.adoptBlock === null;
}

/** Running attempts instance-wide, split by whether another controller can re-attach (#761). */
export function countRunningByAdoptability(
  db: Db,
): Promise<{ adoptable: number; notAdoptable: number }> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({
        sandboxId: s.jobAttempts.sandboxId,
        execId: s.jobAttempts.execId,
        adoptBlock: s.jobAttempts.adoptBlock,
      })
      .from(s.jobAttempts)
      .where(eq(s.jobAttempts.state, "running"));
    const adoptable = rows.filter(isAdoptable).length;
    return { adoptable, notAdoptable: rows.length - adoptable };
  });
}

/** Number of attempts currently running, overall or for one org. */
export function countRunning(db: Db, orgId?: string): Promise<number> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(s.jobAttempts)
      .where(
        and(
          eq(s.jobAttempts.state, "running"),
          orgId === undefined ? undefined : eq(s.jobAttempts.orgId, orgId),
        ),
      );
    return Number(row?.n ?? 0);
  });
}

/**
 * Running attempts split by their project's checks mode (#480): `live` gates a check run, anything
 * else (`shadow`, `off`) gates nothing. Instance-wide and unscoped like `countRunning`. The column
 * is the stored mode; `effective` (the registry's answer, which a `turntable.toml` or environment
 * lock can override) wins when given.
 */
export function countRunningByMode(
  db: Db,
  effective?: (orgId: string, projectId: string) => Promise<string>,
): Promise<{ live: number; shadow: number }> {
  return db
    .run((h) =>
      h.orm
        .select({
          orgId: s.projects.orgId,
          projectId: s.projects.id,
          mode: s.projects.checksMode,
          n: sql<number>`count(*)`.mapWith(Number),
        })
        .from(s.jobAttempts)
        .innerJoin(s.projects, eq(s.projects.id, s.jobAttempts.projectId))
        .where(eq(s.jobAttempts.state, "running"))
        .groupBy(s.projects.orgId, s.projects.id, s.projects.checksMode),
    )
    .then(async (rows) => {
      let live = 0;
      let shadow = 0;
      for (const r of rows) {
        const mode = effective ? await effective(r.orgId, r.projectId) : r.mode;
        if (mode === "live") live += Number(r.n);
        else shadow += Number(r.n);
      }
      return { live, shadow };
    });
}

/** True when `owner` holds the live lease on a running attempt. */
async function holdsLease(h: Db, scope: Scope, attemptId: string, owner: string): Promise<boolean> {
  const [row] = await h.orm
    .select({ id: s.jobAttempts.id })
    .from(s.jobAttempts)
    .where(
      scoped(
        scope,
        { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
        eq(s.jobAttempts.id, attemptId),
        eq(s.jobAttempts.state, "running"),
        eq(s.jobAttempts.leaseOwner, owner),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Appends a log chunk only while `owner` still holds the lease, so a worker that lost its lease
 * (reconciled, cancelled) cannot write into a log someone else now owns. False means dropped.
 */
export function appendLogFenced(
  db: Db,
  scope: Required<Scope>,
  attemptId: string,
  owner: string,
  offset: number,
  bytes: Uint8Array,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await holdsLease(tx, scope, attemptId, owner))) return false;
    return appendLog(tx, scope, attemptId, offset, bytes);
  });
}

/** Runs `fn` only while `owner` holds the lease (steps and cuts of a worker that lost it are dropped). */
export function ifLeaseHeld<T>(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  return db.transaction(async (tx) =>
    (await holdsLease(tx, scope, attemptId, owner)) ? fn() : undefined,
  );
}

/**
 * Wipes an attempt's stored log, steps and cuts so a re-attached worker can replay the whole exec
 * log and write it afresh (chunk boundaries differ between runs, so appending would garble it).
 * Fenced by the lease. Returns false when `owner` does not hold it.
 */
export async function resetAttemptOutput(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
  retry: {
    tries?: number;
    backoffMs?: number;
    maxBackoffMs?: number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<boolean> {
  const ext = externalLogStore();
  // An external store is cleared first and outside the transaction (no HTTP while the write lock is
  // held). Only the lease holder may clear it. A store that is down is retried with backoff (about
  // a minute by default, while the caller keeps heartbeating its lease), so a short outage does not
  // end an adopted job. If it stays down this throws before anything is wiped, so the reset stays
  // all or nothing and the resume path settles the attempt as an infra error.
  if (ext && (await db.run((h) => holdsLease(h, scope, attemptId, owner)))) {
    const tries = retry.tries ?? 8;
    const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let n = 1; ; n++) {
      try {
        await ext.deleteAttempt(logKey(scope, attemptId));
        break;
      } catch (err) {
        if (n >= tries || retry.signal?.aborted) throw err;
        await sleep(
          Math.min((retry.backoffMs ?? 500) * 2 ** (n - 1), retry.maxBackoffMs ?? 15_000),
        );
      }
    }
  }
  return db.transaction(async (tx) => {
    if (!(await holdsLease(tx, scope, attemptId, owner))) return false;
    if (!ext) await logStoreFor(tx).deleteAttempt(logKey(scope, attemptId));
    await tx.orm
      .delete(s.attemptSteps)
      .where(
        scoped(
          scope,
          { orgId: s.attemptSteps.orgId, projectId: s.attemptSteps.projectId },
          eq(s.attemptSteps.attemptId, attemptId),
        ),
      );
    await tx.orm
      .delete(s.logCuts)
      .where(
        scoped(
          scope,
          { orgId: s.logCuts.orgId, projectId: s.logCuts.projectId },
          eq(s.logCuts.attemptId, attemptId),
        ),
      );
    return true;
  });
}

/**
 * Takes over a running attempt whose lease has expired: the new owner gets a fresh lease and the
 * old owner is fenced out from then on (its heartbeat and finish no longer match). Returns the
 * claim, or undefined when the lease is not expired or the attempt is no longer running.
 */
export function takeExpiredLease(
  db: Db,
  attemptId: string,
  o: { owner: string; leaseMs: number; now: number },
): Promise<Claim | undefined> {
  return db.transaction(async (tx) => {
    const rows = await tx.orm
      .update(s.jobAttempts)
      .set({ leaseOwner: o.owner, leaseExpiresAt: o.now + o.leaseMs, heartbeatAt: o.now })
      .where(
        and(
          eq(s.jobAttempts.id, attemptId),
          eq(s.jobAttempts.state, "running"),
          lt(s.jobAttempts.leaseExpiresAt, o.now),
        ),
      )
      .returning({
        orgId: s.jobAttempts.orgId,
        projectId: s.jobAttempts.projectId,
        jobId: s.jobAttempts.jobId,
      });
    const row = rows[0];
    if (!row) return undefined;
    const scope = { orgId: row.orgId, projectId: row.projectId };
    const [attempt] = await tx.orm
      .select()
      .from(s.jobAttempts)
      .where(eq(s.jobAttempts.id, attemptId))
      .limit(1);
    const [job] = await tx.orm.select().from(s.jobs).where(eq(s.jobs.id, row.jobId)).limit(1);
    const run = await getRun(tx, scope, job!.runId);
    return { attempt: attempt!, job: job!, run: run!, scope };
  });
}

export type OrgRunActivity = {
  orgId: string;
  runs: Record<string, number>;
  jobs: Record<string, number>;
  runningAttempts: number;
  /** Start time (epoch ms) of the oldest running attempt, or null. */
  oldestRunningStartedAt: number | null;
  /** Queued attempts by waiting reason (#775), with attempts held for an approval as `approval`. */
  queuedByReason: Record<string, number>;
};

/**
 * Counts only, per org: runs and jobs by state, running attempts and when the oldest began. No
 * ids, refs or content leave this function. Instance-level (a deploy check across tenants), so
 * it is unscoped like `countRunning`.
 */
export function instanceRunActivity(db: Db): Promise<OrgRunActivity[]> {
  return db.run(async (h) => {
    const n = sql<number>`count(*)`.mapWith(Number);
    const runRows = await h.orm
      .select({ orgId: s.runs.orgId, state: s.runs.status, n })
      .from(s.runs)
      .groupBy(s.runs.orgId, s.runs.status);
    const jobRows = await h.orm
      .select({ orgId: s.jobs.orgId, state: s.jobs.state, n })
      .from(s.jobs)
      .groupBy(s.jobs.orgId, s.jobs.state);
    const attemptRows = await h.orm
      .select({
        orgId: s.jobAttempts.orgId,
        n,
        oldest: sql<number | null>`min(${s.jobAttempts.startedAt})`.mapWith((v) =>
          v === null || v === undefined ? null : Number(v),
        ),
      })
      .from(s.jobAttempts)
      .where(eq(s.jobAttempts.state, "running"))
      .groupBy(s.jobAttempts.orgId);
    const queuedRows = await h.orm
      .select({
        orgId: s.jobAttempts.orgId,
        reason: s.jobAttempts.waitingReason,
        state: s.jobAttempts.state,
        n,
      })
      .from(s.jobAttempts)
      .where(inArray(s.jobAttempts.state, ["queued", "awaiting_approval"]))
      .groupBy(s.jobAttempts.orgId, s.jobAttempts.waitingReason, s.jobAttempts.state);
    const out = new Map<string, OrgRunActivity>();
    const of = (orgId: string): OrgRunActivity => {
      let e = out.get(orgId);
      if (!e) {
        e = {
          orgId,
          runs: {},
          jobs: {},
          runningAttempts: 0,
          oldestRunningStartedAt: null,
          queuedByReason: {},
        };
        out.set(orgId, e);
      }
      return e;
    };
    for (const r of runRows) of(r.orgId).runs[r.state] = Number(r.n);
    for (const r of jobRows) of(r.orgId).jobs[r.state] = Number(r.n);
    for (const r of queuedRows) {
      const e = of(r.orgId);
      // An attempt held for an approval waits for that; one no claim pass has looked at yet has no
      // reason.
      const k = r.state === "awaiting_approval" ? "approval" : (r.reason ?? "unknown");
      e.queuedByReason[k] = (e.queuedByReason[k] ?? 0) + Number(r.n);
    }
    for (const r of attemptRows) {
      const e = of(r.orgId);
      e.runningAttempts = Number(r.n);
      e.oldestRunningStartedAt = r.oldest;
    }
    return [...out.values()];
  });
}
