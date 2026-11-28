import { z } from "zod";
import { getOrgById, getProject } from "../../db/repos";
import type { RateLimitInfo } from "../../poll/github";
import { ingestStatus } from "../../poll/status";
import { iso } from "../common";
import { defineOp } from "../define";

const rateLimitShape = z.object({
  limit: z.int().nullable(),
  remaining: z.int().nullable(),
  reset_at: z.string().nullable(),
  resource: z.string().nullable(),
  observed_at: z.string(),
});

const wireRate = (r: RateLimitInfo | undefined): z.infer<typeof rateLimitShape> | null =>
  r
    ? {
        limit: r.limit ?? null,
        remaining: r.remaining ?? null,
        reset_at: iso(r.resetAt),
        resource: r.resource ?? null,
        observed_at: iso(r.observedAt)!,
      }
    : null;

export const ingestStatusOp = defineOp({
  name: "ingest_status",
  summary: "What the GitHub poller is doing: per repo state and the API rate-limit budget.",
  description:
    "Reports the poll ingester's health for the caller's org: for each polled repo the last poll " +
    "time and outcome (ok, rate_limited or error), the next poll time, consecutive failures and " +
    "runs created, the pull requests recently skipped by the author gate with the reason, the auth mode each repo is polled with (anonymous, token, or installation: a " +
    "read-only token minted for that one repo), plus GitHub's rate-limit budget (limit, remaining, " +
    "reset) as last observed, per repo and per mode (each mode has its own budget). " +
    "Use it to check that polling is alive and is not about to run out of API budget. Read-only " +
    "and cheap. Reflects the poller in the server process answering the call; empty when polling " +
    "is off. Error text is short and never contains the token. Repo names are untrusted text.",
  input: z.object({}),
  output: z.object({
    running: z.boolean().describe("Whether the poller is running in this process."),
    rate_limit: rateLimitShape
      .nullable()
      .describe(
        "The budget of the fallback mode (the poll token, or anonymous) as last seen; null before the first request.",
      ),
    rate_limit_by_mode: z
      .object({
        anonymous: rateLimitShape.nullable(),
        poll_token: rateLimitShape.nullable(),
        installation: rateLimitShape
          .nullable()
          .describe("The installed repo with the least budget left."),
      })
      .describe("The last seen budget of each auth mode; null for a mode that made no request."),
    repos: z.array(
      z.object({
        repo: z.string(),
        project: z.string(),
        last_poll_at: z.string().nullable(),
        last_outcome: z.enum(["ok", "rate_limited", "error"]).nullable(),
        last_error: z.string().nullable(),
        next_poll_at: z.string().nullable(),
        consecutive_failures: z.int(),
        runs_created: z.int(),
        auth_mode: z
          .enum(["anonymous", "token", "installation"])
          .nullable()
          .describe("How the last poll authenticated; null before the first."),
        rate_limit: rateLimitShape
          .nullable()
          .describe("The budget of that mode as last seen for this repo."),
        skipped_prs: z
          .array(
            z.object({
              number: z.int(),
              reason: z
                .string()
                .describe('Why no run was made, e.g. "author not allowlisted". Untrusted text.'),
              since: z
                .string()
                .describe("When the last poll first saw it skipped for this reason."),
            }),
          )
          .describe(
            "Open pull requests the last successful poll did not run, so a skipped PR is never silent. Fix an author with change_project_pr_policy.",
          ),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/ingest/status" },
  async handler(ctx) {
    const org = await getOrgById(ctx.db, ctx.scope.orgId);
    // Only this org's repos, and for a project-scoped caller only that project's. The budget is
    // the instance's token budget: shown only when the narrowed list is not empty.
    const project =
      ctx.scope.projectId === undefined
        ? undefined
        : await getProject(ctx.db, { orgId: ctx.scope.orgId }, ctx.scope.projectId);
    const repos = [...ingestStatus.repos.values()].filter(
      (r) => r.org === org?.slug && (project === undefined || r.project === project.slug),
    );
    const fallback = wireRate(ingestStatus.rateLimit);
    const installed = repos
      .filter((r) => r.authMode === "installation" && r.rateLimit)
      .map((r) => r.rateLimit as RateLimitInfo)
      .toSorted((a, b) => (a.remaining ?? Infinity) - (b.remaining ?? Infinity))[0];
    return {
      running: ingestStatus.running,
      rate_limit: repos.length > 0 ? fallback : null,
      rate_limit_by_mode: {
        anonymous: repos.length > 0 && ingestStatus.fallbackAuth === "anonymous" ? fallback : null,
        poll_token: repos.length > 0 && ingestStatus.fallbackAuth === "token" ? fallback : null,
        installation: wireRate(installed),
      },
      repos: repos.map((r) => ({
        repo: r.repo,
        project: r.project,
        last_poll_at: iso(r.lastPollAt),
        last_outcome: r.lastOutcome,
        last_error: r.lastError,
        next_poll_at: iso(r.nextPollAt),
        consecutive_failures: r.consecutiveFailures,
        runs_created: r.runsCreated,
        auth_mode: r.authMode,
        rate_limit: wireRate(r.rateLimit),
        skipped_prs: (r.skippedPrs ?? []).map((p) => ({
          number: p.number,
          reason: p.reason,
          since: iso(p.at)!,
        })),
      })),
    };
  },
});
