import { formatDuration } from "@/lib/format";
import type { JobAttempt } from "@/api/types";

const WHY: Record<string, string> = {
  needs: "waiting for the jobs it needs (or its concurrency group)",
  project_cap: "the project's concurrency cap is reached",
  org_cap: "the org's concurrency cap is reached",
  instance_cap: "the instance's concurrency cap is reached",
  yield: "other projects' work goes first (yield class)",
  drain: "the instance is draining",
  approval: "waiting for an approval",
  claimable: "next in line to start",
};

/** Says why a queued attempt waits, and where its queued time went once it has started. */
export function reasonText(reason: string): string {
  if (reason.startsWith("quota:")) return `the org's ${reason.slice(6)} quota is reached`;
  return WHY[reason] ?? reason;
}

export function WaitingPanel({ attempt }: { attempt: JobAttempt | null }) {
  if (!attempt) return null;
  const by = Object.entries(attempt.queuedMsByReason ?? {}).filter(([, ms]) => ms > 0);
  if (!attempt.waitingReason && by.length === 0) return null;
  return (
    <div className="mt-4 rounded-md border border-border px-3.5 py-2 text-[13px]" role="status">
      {attempt.waitingReason ? (
        <p className="text-foreground">
          Queued: {reasonText(attempt.waitingReason)}
          <span className="ml-1 font-mono text-xs text-dim">({attempt.waitingReason})</span>
        </p>
      ) : null}
      {by.length > 0 ? (
        <p className="text-dim">
          {attempt.waitingReason ? "Queued so far: " : "Queued before it started: "}
          {by
            .toSorted((a, b) => b[1] - a[1])
            .map(([r, ms]) => `${r} ${formatDuration(ms)}`)
            .join(", ")}
        </p>
      ) : null}
    </div>
  );
}
