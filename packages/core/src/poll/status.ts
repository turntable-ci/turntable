import type { RateLimitInfo } from "./github";

/** How a repo's requests are authenticated; each mode has its own GitHub budget. */
export type PollAuthMode = "anonymous" | "token" | "installation";

export type RepoStatus = {
  repo: string;
  org: string;
  project: string;
  /** Set when the repo moved: the slug polled (same forge repo id), while `repo` is the configured one. */
  effectiveRepo?: string | undefined;
  /** The configured poll interval for this repo (poll config entry or binding settings). */
  intervalSeconds: number;
  lastPollAt: number | null;
  /** The last poll that succeeded; a failure or a stale-binding skip never moves it. */
  lastSuccessAt: number | null;
  lastOutcome: "ok" | "rate_limited" | "error" | null;
  /** Short, token-free description of the last failure. */
  lastError: string | null;
  nextPollAt: number | null;
  consecutiveFailures: number;
  runsCreated: number;
  /** The auth mode of the last poll (installation, or the fallback), null before the first. */
  authMode: PollAuthMode | null;
  /** The budget of that mode as last seen for this repo. */
  rateLimit: RateLimitInfo | undefined;
  /** Open PRs the last successful poll refused to run, with why; never silent (#807). */
  skippedPrs?: SkippedPr[] | undefined;
};

/** A pull request the PR gate did not turn into a run. */
export type SkippedPr = {
  number: number;
  /** A short class: "author not allowlisted", or the gate's own reason. */
  reason: string;
  /** When this PR was first seen skipped for this reason (ms). */
  at: number;
};

/** The most skipped PRs kept per repo. */
export const MAX_SKIPPED_PRS = 20;

const AUTHOR_REASON = "author not allowlisted";

/** Maps a gate refusal to the reason an operator sees; author refusals share one label. */
export function skipReasonOf(reason: string): string {
  return /author is not on the allowlist|no author login|no linked GitHub account/.test(reason)
    ? AUTHOR_REASON
    : reason;
}

/**
 * The PR refusals of one poll as the repo's skipped list: only `pr #N` entries, one per PR, the
 * first-seen time kept while the reason is unchanged, newest first, capped. The cap keeps author
 * refusals first, then the lowest PR numbers, so the kept set does not depend on `at` (a PR cut
 * by the cap has no prior `at` and would otherwise rotate the list on every poll).
 */
export function skippedFromRefused(
  refused: readonly { what: string; reason: string }[],
  prior: readonly SkippedPr[] | undefined,
  now: number,
): SkippedPr[] {
  const out = new Map<number, SkippedPr>();
  for (const r of refused) {
    const m = /^pr #(\d+)$/.exec(r.what);
    if (!m) continue;
    const number = Number(m[1]);
    const reason = skipReasonOf(r.reason);
    const was = prior?.find((p) => p.number === number && p.reason === reason);
    out.set(number, { number, reason, at: was?.at ?? now });
  }
  const author = (p: SkippedPr): number => (p.reason === AUTHOR_REASON ? 0 : 1);
  return [...out.values()]
    .toSorted((a, b) => author(a) - author(b) || a.number - b.number)
    .slice(0, MAX_SKIPPED_PRS)
    .toSorted((a, b) => b.at - a.at || b.number - a.number);
}

/**
 * What the poller is doing, for monitoring (the `ingest_status` operation). In-process state: a
 * snapshot of the one poller running in this process, never persisted and never holding secrets.
 */
export const ingestStatus: {
  running: boolean;
  /** When the poller last started (ms), the baseline for a repo that never succeeded. */
  startedAt: number | null;
  /** The budget of the fallback client (the poll token, or anonymous). */
  rateLimit: RateLimitInfo | undefined;
  /** Which of those the fallback is. */
  fallbackAuth: Exclude<PollAuthMode, "installation">;
  repos: Map<string, RepoStatus>;
} = {
  running: false,
  startedAt: null,
  rateLimit: undefined,
  fallbackAuth: "anonymous",
  repos: new Map(),
};

export function resetIngestStatus(): void {
  ingestStatus.running = false;
  ingestStatus.startedAt = null;
  ingestStatus.rateLimit = undefined;
  ingestStatus.fallbackAuth = "anonymous";
  ingestStatus.repos.clear();
}

/** Requests left at or below which the poller waits for the reset instead of spending the rest. */
export const POLL_RESERVE = 5;

/** What a failed poll is reported as to an operator: a class, never the upstream text. */
export type PollErrorClass =
  | "rate_limited"
  | "auth"
  | "not_found"
  | "github_4xx"
  | "github_5xx"
  | "network"
  | "stale_binding"
  | "unknown";

/**
 * Maps a repo's last failure to a class. `lastError` is short and token-free by construction, but
 * the operator view never repeats it: it can carry a repo path or an upstream message.
 */
export function classifyPollError(
  s: Pick<RepoStatus, "lastOutcome" | "lastError">,
): PollErrorClass | null {
  if (s.lastOutcome === null || s.lastOutcome === "ok") return null;
  if (s.lastOutcome === "rate_limited") return "rate_limited";
  const text = s.lastError ?? "";
  const status = /^GitHub API (\d{3}) /.exec(text)?.[1];
  if (status !== undefined) {
    const n = Number(status);
    if (n === 401 || n === 403) return "auth";
    if (n === 404) return "not_found";
    if (n === 429) return "rate_limited";
    return n >= 500 ? "github_5xx" : "github_4xx";
  }
  if (/stale/.test(text)) return "stale_binding";
  if (
    /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed? ?out|socket|network|abort/i.test(text)
  )
    return "network";
  return "unknown";
}
