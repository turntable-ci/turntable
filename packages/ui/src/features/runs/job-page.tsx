import { Link, useParams, useSearch } from "@tanstack/react-router";
import { ChevronRight, Info } from "lucide-react";
import { useMemo } from "react";
import { getBackend } from "@/api";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Duration } from "@/components/live-clock";
import { StateBadge, StateIcon } from "@/components/state-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useRunSync } from "@/db/sync";
import { LogViewer } from "@/features/log/log-viewer";
import { useScope } from "@/features/shell/scope";
import { STATE_META } from "@/lib/states";
import { cn } from "@/lib/utils";
import type { JobSearch } from "@/router";
import { ApprovalNotice } from "./approval";
import { retriedAutomatically } from "./infra-retry";
import { FailureDigestPanel } from "./failure-digest";
import { WaitingPanel } from "./waiting-panel";
import { RerunButton } from "./rerun-dialog";
import { EgressBadge, NoticeBadges, TrustBadge, useLogNotices } from "./trust";
import { AttemptChip } from "./run-page";
import { useRunAttempts, useRunJobs, useRunRow } from "./common";

export function JobPage() {
  const scope = useScope();
  const { runId = "", jobId = "" } = useParams({ strict: false }) as {
    runId?: string;
    jobId?: string;
  };
  const search = useSearch({ strict: false }) as JobSearch;
  const sync = useRunSync(runId || null);
  const run = useRunRow(runId);
  const jobs = useRunJobs(runId);
  const job = jobs.find((j) => j.id === jobId) ?? null;
  const attempts = useRunAttempts(useMemo(() => (job ? [job.id] : []), [job]));
  const orgSlug = scope.orgSlug as string;
  const projectSlug = scope.projectSlug as string;
  const notices = useLogNotices(
    (attempts.find((a) => a.attempt === search.attempt) ?? attempts.at(-1))?.id ?? null,
  );

  if (sync.error && !job)
    return (
      <ErrorState title="Could not load this job" message={sync.error} onRetry={sync.reload} />
    );
  if (!job || !run) {
    if (!sync.loading && run && !job)
      return <EmptyState title="Job not found">This run has no job with that id.</EmptyState>;
    return (
      <div
        className="mx-auto w-full max-w-7xl space-y-4 p-5"
        role="status"
        aria-label="Loading job"
      >
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-[60dvh] w-full" />
      </div>
    );
  }

  const selected = attempts.find((a) => a.attempt === search.attempt) ?? attempts.at(-1) ?? null;
  const state = selected?.state ?? job.state;
  const infra = selected?.state === "infra_error";

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col px-4 pb-8 pt-5 sm:px-5">
      <nav
        aria-label="Breadcrumb"
        className="mb-3 flex flex-wrap items-center gap-1 text-[13px] text-dim"
      >
        <Link
          to="/$org/$project"
          params={{ org: orgSlug, project: projectSlug }}
          className="rounded hover:text-foreground"
        >
          Runs
        </Link>
        <ChevronRight className="size-3.5 text-faint" aria-hidden="true" />
        <Link
          to="/$org/$project/runs/$runId"
          params={{ org: orgSlug, project: projectSlug, runId }}
          className="max-w-56 truncate rounded hover:text-foreground"
        >
          {run.runName || run.commitMessage}
        </Link>
        <ChevronRight className="size-3.5 text-faint" aria-hidden="true" />
        <span className="text-foreground">{job.name}</span>
      </nav>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight">{job.name}</h1>
        <StateBadge state={state} />
        <span className="text-[13px] text-dim">
          <Duration
            startedAt={selected?.startedAt ?? job.startedAt}
            finishedAt={selected?.finishedAt ?? job.finishedAt}
          />
        </span>
        {selected ? (
          <span className="text-[13px] text-dim">
            {selected.provider}
            {selected.sandboxId ? ` / ${selected.sandboxId}` : ""}
          </span>
        ) : null}
        {state === "failure" && selected?.exitCode != null ? (
          <span className="font-mono text-xs text-st-failure">exit {selected.exitCode}</span>
        ) : null}
        <TrustBadge run={run} />
        <EgressBadge run={run} />
        <NoticeBadges notices={notices} />
        {getBackend().api.capabilities.rerun ? (
          <span className="ml-auto">
            <RerunButton run={run} jobs={jobs} job={job} />
          </span>
        ) : null}
      </div>

      <ApprovalNotice run={run} jobs={[job]} />
      <FailureDigestPanel job={job} attempt={selected} />
      <WaitingPanel attempt={selected} />

      {attempts.length > 1 ? (
        <div
          role="tablist"
          aria-label="Attempts"
          className="mt-4 flex flex-wrap items-center gap-2"
        >
          {attempts.map((a) => (
            <Link
              key={a.id}
              to="/$org/$project/runs/$runId/jobs/$jobId"
              params={{ org: orgSlug, project: projectSlug, runId, jobId }}
              search={{ attempt: a.attempt }}
              replace
              role="tab"
              aria-selected={a.id === selected?.id}
              className={cn(
                "rounded-md transition-opacity duration-150",
                a.id === selected?.id
                  ? "ring-2 ring-foreground/70 ring-offset-2 ring-offset-background"
                  : "opacity-80 hover:opacity-100",
              )}
            >
              <AttemptChip attempt={a} job={job} />
            </Link>
          ))}
        </div>
      ) : null}

      {infra ? (
        <div
          role="note"
          className="mt-4 flex gap-3 rounded-lg border border-st-infra/40 bg-st-infra-bg p-3.5 text-sm"
        >
          <Info className="mt-0.5 size-4 shrink-0 text-st-infra" aria-hidden="true" />
          <div>
            <p className="font-medium text-foreground">
              Infra error{selected?.errorClass ? `: ${selected.errorClass}` : ""}
            </p>
            <p className="mt-0.5 text-dim">
              {STATE_META.infra_error.description} The log below ends where the sandbox stopped
              responding.{" "}
              {attempts.length > 1
                ? "A later attempt carries the real result."
                : selected && !retriedAutomatically(selected)
                  ? "This error is not retried automatically: fix the cause, then re-run."
                  : "A retry is queued automatically."}
            </p>
          </div>
        </div>
      ) : null}

      <LogViewer
        key={selected?.id ?? "none"}
        attemptId={selected?.id ?? null}
        attemptState={state}
        filename={`${job.jobKey}-attempt-${selected?.attempt ?? 1}.log`}
        className="mt-4 h-[72dvh] min-h-[420px]"
      />
      {!selected ? (
        <p className="mt-3 text-sm text-dim">
          <StateIcon state={job.state} className="mr-1 inline size-3.5 align-text-bottom" />
          {job.state === "queued"
            ? "This job is waiting for a sandbox or for the jobs it needs. The log starts when it runs."
            : "No attempt has started for this job."}
        </p>
      ) : null}
    </div>
  );
}
