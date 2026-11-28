import { z } from "zod";
import { type JobAttempt, parseWaited } from "../db/repos";

/** The fields every op shows for an attempt's queue time (#775). */
export const waitingFields = {
  waiting_reason: z
    .string()
    .nullable()
    .describe(
      "While queued: why it is not running (needs, project_cap, org_cap, instance_cap, quota:<metric>, yield, drain, approval, claimable). Null once it started, or before a claim pass has looked at it.",
    ),
  queued_ms_by_reason: z
    .record(z.string(), z.int())
    .describe(
      "Queued time in ms by reason: closed when the attempt starts, and still counting while it is queued. Empty for an attempt that never queued under a recording scheduler.",
    ),
};

/** The waiting fields of one attempt row, with the open period counted up to `now`. */
export function toWaiting(
  a: Pick<JobAttempt, "state" | "waitingReason" | "waitingSince" | "waitedMs" | "createdAt">,
  now: number,
): { waiting_reason: string | null; queued_ms_by_reason: Record<string, number> } {
  const by = parseWaited(a.waitedMs);
  // A held attempt waits for its approval, whether or not it was stamped (older rows are not).
  const reason =
    a.state === "awaiting_approval" ? "approval" : a.state === "queued" ? a.waitingReason : null;
  if (reason) {
    const open = Math.max(0, now - (a.waitingSince ?? a.createdAt));
    by[reason] = (by[reason] ?? 0) + open;
  }
  return {
    waiting_reason: reason,
    queued_ms_by_reason: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Math.round(v)])),
  };
}
