import type { Provider } from "@turntable/provider-sdk";
import type { InfraKind } from "@turntable/act-runner";
import type { SecretRegistry } from "@turntable/redact";
import type { ProxyAccess } from "../proxy";
import type { Claim, Job, JobAttempt, Run, Scope } from "../db/repos";
import type { StepInput } from "../db/repos";

/** What a runner reports when it is done. `exitCode` is 0 for success, non-zero for failure. */
export type AttemptOutcome = {
  state: "success" | "failure" | "skipped" | "infra_error" | "cancelled";
  exitCode?: number | undefined;
  /** Short cause. Stored as the attempt's error class for infra_error. */
  reason: string;
  /**
   * For infra_error: the named kind (see `INFRA_KINDS`), which says whether one retry is worth it.
   * Absent means `other`: never retried.
   */
  infraKind?: InfraKind | undefined;
  /** For infra_error: the underlying error's name and code (identifiers only), when known. */
  errorName?: string | undefined;
  errorCode?: string | undefined;
  /** For a transient kind that must wait first (a rate limit): ms until the retry may start. */
  retryAfterMs?: number | undefined;
  /** The job's declared outputs, kept for its dependents. */
  outputs?: Record<string, string> | undefined;
};

/** Persistence a runner may use while running. Every call is fenced by the attempt's lease. */
export interface AttemptStore {
  /** Records the sandbox (and exec) so a restarted controller can find and probe them. */
  setExec(where: {
    sandboxId?: string;
    execId?: string;
    sandboxCreatedAt?: number;
    sandboxTtlSeconds?: number;
    sandboxDestroyedAt?: number;
    /** Why another controller may not re-attach (#761); null: it may. */
    adoptBlock?: string | null;
    /** What another controller needs to rebuild the attempt's credentials (#787); never a secret. */
    adoptSpec?: string | null;
  }): Promise<void>;
  /** Stores the resolved job plan (JSON), so a restarted controller can re-attach without the repo. */
  setPlan(planJson: string): Promise<void>;
  /** Records the class the attempt runs as, once, before the sandbox starts (the vault reads it). */
  setTrustClass(klass: string): Promise<void>;
  /** Clears stored log, steps and cuts. Only a run that re-attaches calls it, to replay the whole exec log; an early exit keeps the partial log. */
  reset(): Promise<void>;
  /**
   * Re-attach from a checkpoint (#761): drops stored log, cuts and steps at or past `logOffset`
   * and returns the steps kept.
   */
  truncate?(
    logOffset: number,
  ): Promise<
    { stepKey: string; stage: string; index: number; startedAt?: number; logOffset: number }[]
  >;
  /** Records the log checkpoint (#761): see `job_attempts.exec_log_offset`. */
  setLogCheckpoint?(execOffset: number, logOffset: number): Promise<void>;
  appendLog(offset: number, bytes: Uint8Array): Promise<void>;
  recordStep(step: Omit<StepInput, "attemptId">): Promise<void>;
  addCut(cut: { atOffset: number; omittedBytes: number; reason: string }): Promise<void>;
}

export interface AttemptContext {
  attempt: JobAttempt;
  job: Job;
  run: Run;
  scope: Required<Scope>;
  provider: Provider;
  /**
   * Set when this attempt was started by a worker that died and is being re-attached to: the
   * sandbox and exec it left. A runner that can re-attach replays the exec and returns the real
   * outcome; one that cannot should end the attempt as infra_error.
   */
  resume?: { sandboxId: string; execId: string };
  /**
   * Set by a wrapper that refused to resume this attempt (for example the secrets proxy, which
   * cannot re-establish its credential). The runner does not run the job: it releases the
   * inherited sandbox and ends the attempt as infra_error with this reason.
   */
  refuseResume?: string;
  /**
   * Lines the runner shows at the top of the job's log, ahead of its own output: policy facts
   * the people reading the run should see (for example an isolation override).
   */
  notices?: readonly string[];
  /**
   * Set when the secrets proxy fronts this attempt: the job's sandbox reaches only the proxy, and
   * its env points there. Never set for `untrusted_pr`.
   */
  proxy?: ProxyAccess;
  /** The attempt's redaction set: the proxy adds every value it injects. */
  redact?: SecretRegistry;
  /** Aborted when the lease is lost (cancelled, reconciled) or the scheduler stops hard. */
  signal: AbortSignal;
  /**
   * False once this controller's lease may have lapsed by its own clock: no heartbeat renewed it
   * before the time recorded with it (#789). Then another controller may already have taken the
   * attempt over and minted its own credentials, so this one's must not be used: the secrets
   * proxy injects nothing for the attempt (no GitHub token, no OIDC credential, no vault secret)
   * until a heartbeat renews the lease, and `signal` aborts once the database says it is lost.
   * Absent (a runner called outside the scheduler): always valid.
   */
  leaseValid?: () => boolean;
  /**
   * Aborted when the scheduler hands the attempt off to the next controller (#761): stop watching
   * and return at once, leaving the exec running, the sandbox alive and any job token valid.
   */
  detach?: AbortSignal;
  store: AttemptStore;
}

/**
 * Runs one claimed attempt to completion and says how it ended. A runner never touches attempt,
 * job or run state itself: the scheduler records the outcome, fenced by the lease. Throwing is an
 * infra_error. Must stop promptly when `signal` aborts (destroy the sandbox).
 */
export type AttemptRunner = (ctx: AttemptContext) => Promise<AttemptOutcome>;

/** Picks the provider for an attempt by the name stored on it. */
export type ProviderResolver = (name: string) => Provider | undefined;

/**
 * Told when an attempt starts (or is re-attached after a restart) and when it has a result. Called
 * after the fact and never awaited: an observer's slowness or failure cannot hold up a run.
 */
export interface AttemptObserver {
  started(claim: Claim): void;
  finished(claim: Claim, outcome: AttemptOutcome): void;
  /** Called at the end of every claim pass, for work that has no attempt to hang off (not awaited). */
  tick?(): void;
}
