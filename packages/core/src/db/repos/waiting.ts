// Why a queued attempt is not running (#775). The claim pass already knows which rule left each
// candidate out; this records it, but only when the reason changes, and keeps the queued time per
// reason so it can be shown when the attempt starts. No query per candidate: the pass hands over
// the attempt rows it already read, and the rest are found by one bounded select per reason.
import { and, eq, isNull, ne, or, type SQL } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { notFrozen } from "./incident";

/** The reasons without a parameter. `quota:<metric>` is the other form. */
export const WAIT_REASONS = [
  "needs",
  "project_cap",
  "org_cap",
  "instance_cap",
  "yield",
  "drain",
  "approval",
  "claimable",
] as const;
export type WaitReason = (typeof WAIT_REASONS)[number] | `quota:${string}`;

type WaitRow = Pick<
  typeof s.jobAttempts.$inferSelect,
  "id" | "waitingReason" | "waitingSince" | "waitedMs" | "createdAt"
>;

/** Most attempts one bulk mark changes in one pass; the rest follow on the next pass. */
const MARK_LIMIT = 1000;

/** The queued time per reason as stored, empty when none. */
export function parseWaited(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/**
 * The breakdown with the period up to `now` added to the reason that held it. An attempt whose
 * first pass has not run yet has no reason: its time so far goes to `fallback`.
 */
export function closeWaiting(row: WaitRow, now: number, fallback: string): string {
  const waited = parseWaited(row.waitedMs);
  const reason = row.waitingReason ?? fallback;
  const ms = Math.max(0, now - (row.waitingSince ?? row.createdAt));
  if (ms > 0) waited[reason] = (waited[reason] ?? 0) + ms;
  return JSON.stringify(waited);
}

/** Changes one attempt's reason, closing the period of the old one. A no-op when it is the same. */
export async function setWaitingReason(
  h: Db,
  row: WaitRow,
  reason: string,
  now: number,
): Promise<boolean> {
  if (row.waitingReason === reason) return false;
  const rows = await h.orm
    .update(s.jobAttempts)
    .set({ waitingReason: reason, waitingSince: now, waitedMs: closeWaiting(row, now, reason) })
    .where(
      and(
        eq(s.jobAttempts.id, row.id),
        eq(s.jobAttempts.state, "queued"),
        isNull(s.jobAttempts.leaseOwner),
      ),
    )
    .returning({ id: s.jobAttempts.id });
  return rows.length > 0;
}

/**
 * Marks the queued attempts matching `where` (and not already marked so) with `reason`. A
 * `local` run's attempts are only touched by their own process (`onlyRun`), as in the claim.
 */
export async function markWaiting(
  h: Db,
  m: { reason: string; where?: (SQL | undefined)[]; now: number; onlyRun?: string | undefined },
): Promise<number> {
  const rows = await h.orm
    .select({
      id: s.jobAttempts.id,
      waitingReason: s.jobAttempts.waitingReason,
      waitingSince: s.jobAttempts.waitingSince,
      waitedMs: s.jobAttempts.waitedMs,
      createdAt: s.jobAttempts.createdAt,
    })
    .from(s.jobAttempts)
    .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
    .innerJoin(s.runs, eq(s.runs.id, s.jobs.runId))
    .where(
      and(
        eq(s.jobAttempts.state, "queued"),
        eq(s.jobs.state, "queued"),
        isNull(s.jobAttempts.leaseOwner),
        m.onlyRun ? eq(s.jobs.runId, m.onlyRun) : eq(s.runs.local, false),
        notFrozen(s.runs.orgId, s.runs.projectId),
        or(isNull(s.jobAttempts.waitingReason), ne(s.jobAttempts.waitingReason, m.reason)),
        ...(m.where ?? []),
      ),
    )
    .limit(MARK_LIMIT);
  let n = 0;
  for (const r of rows) if (await setWaitingReason(h, r, m.reason, m.now)) n++;
  return n;
}

/** The attempt columns for a job held for an approval: the period is open from creation. */
export const HELD_FOR_APPROVAL = { waitingReason: "approval" } as const;

/**
 * The attempt columns when an approval releases it to the queue: the held time is booked to
 * `approval`, and the next period starts now.
 */
export function releasedPatch(
  row: WaitRow,
  now: number,
): {
  waitingReason: null;
  waitingSince: number;
  waitedMs: string;
} {
  return {
    waitingReason: null,
    waitingSince: now,
    waitedMs: closeWaiting({ ...row, waitingReason: "approval" }, now, "approval"),
  };
}
