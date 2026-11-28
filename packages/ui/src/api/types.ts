// Domain types for the UI. They mirror packages/core/src/db/schema.ts (ids are ULID strings,
// timestamps are epoch milliseconds) and are meant to be replaced by types generated from the
// operations registry (#22) once it exists. Keep field names identical to the schema.

export const JOB_STATES = [
  "queued",
  "running",
  "success",
  "failure",
  "infra_error",
  "awaiting_approval",
  "cancelled",
  "skipped",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export type Org = { id: string; slug: string; name: string };

export type Project = {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  /** "owner/repo" of the bound forge repo. */
  repo: string;
  /** "available": created by installation sync and never set up for CI. Absent means active. */
  setup?: "active" | "available";
  /** The repo was unbound (access lost or removed); the project and its history are kept. */
  noAccess?: boolean;
};

/** How far a run is trusted, decided by the server from re-fetched forge facts. */
export const TRUST_CLASSES = ["protected", "release", "trusted_pr", "untrusted_pr"] as const;
export type TrustClass = (typeof TRUST_CLASSES)[number];

/** The trust decision recorded on a run. `workflowHash` is what an approval is bound to. */
export type RunTrust = {
  reasons: string[];
  workflowHash: string;
  decidedAt: number | null;
};

/** An approval recorded on a run. `via` is set when a pull request label approved it. */
export type RunApproval = {
  by: string;
  at: number | null;
  via?: { kind: "label"; label: string; eventId: string };
};

export type Run = {
  id: string;
  orgId: string;
  projectId: string;
  workflowPath: string;
  workflowName: string;
  /** The workflow's `run-name`, evaluated when the run was planned; shown as the title when set. */
  runName?: string | null;
  event: string;
  ref: string;
  sha: string | null;
  /** Title shown for the run. The REST API has no commit message yet, so the HTTP adapter derives one. */
  commitMessage: string;
  /** Empty when the API does not report who triggered the run. */
  actor: string;
  status: JobState;
  /** Pull request number, when the run is for one. */
  prNumber?: number | null;
  headBranch?: string | null;
  /** null when the server has not classified the run (older data). */
  trustClass?: TrustClass | null;
  trust?: RunTrust | null;
  /** Who approved a held run, when the API reports it (the run detail). */
  approval?: RunApproval | null;
  /** Network policy of the run's sandboxes when the API reports it; absent means not reported. */
  egress?: "none" | "open" | "allowlist" | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type JobShard = { job: string; index: number; total: number; steps: string[] };

export type Job = {
  id: string;
  orgId: string;
  projectId: string;
  runId: string;
  jobKey: string;
  name: string;
  state: JobState;
  /** jobKeys this job depends on (the `needs:` edges of the job graph). */
  needs: string[];
  /** Matrix leg values, or null for a plain job. Legs of one matrix share `matrixGroup`. */
  matrix: Record<string, string> | null;
  matrixGroup: string | null;
  /**
   * Set when this row is one shard of a job the operator splits across sandboxes. `job` is the
   * workflow job id the shards share (they also share a name and one forge check), `index` counts
   * from 0, `steps` are the steps only this shard runs. Null for a job that is not split.
   */
  shard: JobShard | null;
  /**
   * Why the job is waiting when `state` is awaiting_approval: an untrusted-author gate
   * (an operator approves) or a release/environment gate (a human approves with a security key).
   */
  approval: "untrusted_author" | "environment" | null;
  exitCode: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type JobAttempt = {
  id: string;
  orgId: string;
  projectId: string;
  jobId: string;
  attempt: number;
  state: JobState;
  provider: string;
  sandboxId: string | null;
  exitCode: number | null;
  /** Set for infra_error: a short machine class such as "sandbox_create_failed". */
  errorClass: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** When the provider's create returned (billing starts). Null if no sandbox was made. */
  sandboxCreatedAt: number | null;
  /** When the provider confirmed the destroy. Null if never confirmed: the time is an estimate. */
  sandboxDestroyedAt: number | null;
  /** Exact sandbox time, create to confirmed destroy. Null until both are known. */
  sandboxSeconds: number | null;
  /** While queued: why it is not running (`needs`, `project_cap`, `quota:<metric>`, ...). Null otherwise. */
  waitingReason?: string | null;
  /** Queued time in ms by reason, closed when the attempt started. */
  queuedMsByReason?: Record<string, number>;
};

/** Sandbox time for one UTC day, from the `sandbox_usage` op. */
export type SandboxUsageDay = {
  day: string;
  seconds: number;
  minutes: number;
  attempts: number;
  /** Attempts of the day with no confirmed destroy, whose time is an estimate. */
  estimatedAttempts: number;
};

/** One project's sandbox time, from `sandbox_usage` with `group_by=project`. */
export type SandboxUsageProject = {
  id: string;
  slug: string;
  name: string;
  days: SandboxUsageDay[];
  totalMinutes: number;
  /** Attempts preempted for normal work in the window, and the sandbox time they wasted. */
  preemptions: number;
  preemptedMinutes: number;
  usefulMinutes: number;
};

export type SandboxUsage = {
  days: SandboxUsageDay[];
  totalMinutes: number;
  /** Per project, for the projects with usage in the window. Empty when the server gives none. */
  projects: SandboxUsageProject[];
  /** The org's sandbox-minutes-per-day quota, or null when none is set (or unreadable). */
  limitMinutesPerDay: number | null;
};

/**
 * One step boundary from act's step events. The server stores these apart from the log text and
 * delivers them out of band; `logOffset` is the byte offset in the log where the step starts
 * (for an "end" event, where it ended). Never parsed from log text, so a log cannot forge one.
 */
export type StepEvent = {
  attemptId: string;
  index: number;
  name: string;
  phase: "start" | "end";
  result?: "success" | "failure" | "skipped" | "cancelled";
  at: number;
  logOffset: number;
};

/**
 * Where the output cap removed bytes from an attempt's log. Stored as metadata next to the log,
 * never as text inside it: `atOffset` is the byte offset in the stored log where the omission falls.
 */
export type CutRecord = {
  attemptId: string;
  kind: "cut";
  atOffset: number;
  omittedBytes: number;
  reason: string;
};

/**
 * A system notice the control plane put on an attempt's log (the cache dropped entries, a hold
 * reason). Recorded apart from the log text, so a job's output cannot forge one. `atOffset` is
 * where the stored log ended when it was added.
 */
export type LogNotice = {
  attemptId: string;
  kind: "notice";
  atOffset: number;
  source: string;
  text: string;
};

/** The caller, from `whoami`. */
export type Whoami = {
  kind: "token" | "member";
  id: string;
  name: string | null;
  role: "reader" | "operator" | "release_operator" | "owner" | "admin" | "member" | "viewer";
  org: string;
  project: string | null;
  /** True for the operator org, whose owners configure the release lane. */
  operatorOrg: boolean;
};

/** What `approve_run` reports back. */
export type ApproveResult = {
  runId: string;
  state: JobState;
  releasedJobs: number;
  approvedBy: string;
  headSha: string;
  workflowHash: string;
};

export type JobDigest = {
  jobId: string;
  jobKey: string;
  state: JobState;
  attempt: number | null;
  step: {
    name: string;
    stage: "pre" | "main" | "post";
    index: number;
    result: string | null;
  } | null;
  basis: "failure_marker" | "annotation" | "error_pattern" | "tail" | null;
  /** Plain text from the job's log. Never rendered as markup. */
  excerpt: string;
  truncated: boolean;
  infraErrorReason: string | null;
};

export type RerunResult = {
  runId: string;
  state: JobState;
  reruns: {
    jobId: string;
    jobKey: string;
    attempt: number;
    previousState: JobState;
    state: JobState;
  }[];
};

/** One hit of a server-side log search. `offset` is the byte offset of the line in the log. */
export type GrepHit = { offset: number; text: string; context: boolean };
export type GrepResult = {
  hits: GrepHit[];
  matches: number;
  /** Where the scan stopped, when the log was not fully scanned; search again from here. */
  nextOffset: number | null;
  totalBytes: number;
};

export type IngestRepoStatus = {
  repo: string;
  project: string;
  lastPollAt: number | null;
  lastOutcome: "ok" | "rate_limited" | "error" | null;
  lastError: string | null;
  nextPollAt: number | null;
  consecutiveFailures: number;
  runsCreated: number;
};

export type IngestStatus = {
  running: boolean;
  rateLimit: {
    limit: number | null;
    remaining: number | null;
    resetAt: number | null;
    resource: string | null;
    observedAt: number;
  } | null;
  repos: IngestRepoStatus[];
};

/** What a human signs to approve a run in an environment. Mirrors the server's statement. */
export type ApprovalStatement = {
  type: string;
  org: string;
  project: string;
  run_id: string;
  head_sha: string;
  workflow_hash: string;
  environment: string;
  approver: string;
  /** Epoch milliseconds. */
  expires_at: number;
  nonce: string;
};

export type EnrolStatement = {
  type: string;
  org: string;
  enrolment_id: string;
  person: string;
  /** The forge login the key is enrolled under, lower-cased. */
  forge_login: string;
  key_fingerprint: string;
  approver: string;
  expires_at: number;
  nonce: string;
};

/** One artifact of a release manifest, as the server recorded it. */
export type ReleaseArtifact = { name: string; sha256: string; size: number };

/** What a human signs to approve a release: the run, the commit and the manifest digest. */
export type ReleaseStatement = Omit<ApprovalStatement, "type"> & {
  type: "turntable.approve_release.v2";
  /** sha256 hex of the canonical manifest of the artifacts the release lane will sign. */
  manifest_sha256: string;
  /** The release lane's configuration version the approver signs over (the pin, targets, secrets). */
  lane_config_version: number;
};

export type ReleaseApprovalChallenge = ApprovalChallenge<ReleaseStatement> & {
  manifestSha256: string;
  artifacts: ReleaseArtifact[];
};

export type ApprovalChallenge<S = ApprovalStatement> = {
  statement: S;
  canonical: string;
  statementHash: string;
  /** base64url of the statement hash: the WebAuthn challenge. */
  challenge: string;
  rpId: string | null;
  passkeyId: string | null;
  challengeExpiresAt: number;
};

export type WebAuthnSignature = {
  kind: "webauthn";
  credential_id: string;
  client_data_json: string;
  authenticator_data: string;
  signature: string;
};

export type ApprovalStatus = {
  runId: string;
  headSha: string | null;
  workflowHash: string | null;
  /** Forge login of the run's author: untrusted text. */
  author: string | null;
  environments: {
    environment: string;
    required: number;
    allowAuthorApproval: boolean;
    waiting: boolean;
    /** The project's release environment: approved over the release manifest (v2). */
    release: boolean;
    approvals: {
      person: string;
      method: "webauthn" | "ed25519";
      approvedAt: number;
      expiresAt: number;
    }[];
  }[];
};

export type Approver = {
  id: string;
  person: string;
  forgeLogin: string | null;
  kind: "webauthn" | "ed25519";
  passkeyId: string | null;
  createdAt: number;
  /** Why the key counts toward no approval or quorum; null when it does. */
  notCounting: string | null;
  /** A pinned vendor attestation chain verified when the key was enrolled. */
  attested: boolean;
  aaguid: string | null;
};

/** A key policy change, signed by a quorum of the counted approvers. */
export type PolicyStatement = {
  type: string;
  org: string;
  old: KeyPolicy;
  new: KeyPolicy;
  allowlist_hash: string;
  approver: string;
  expires_at: number;
  nonce: string;
};

export type KeyPolicy = { mode: "any" | "hardware"; presets: string[]; aaguids: string[] };

/** One approval waiting on the signed-in person (`my_pending_approvals`): no repository text. */
export type PendingApprovalKind =
  | "release_approval"
  | "environment_approval"
  | "untrusted_run_approval"
  | "enrolment_approval"
  | "key_policy_approval";
export type PendingApproval = {
  id: string;
  kind: PendingApprovalKind;
  org: string;
  project: string;
  environment?: string;
  createdAt: number;
  /** Epoch milliseconds, when the item expires. */
  expiresAt?: number;
  /** The UI route of the item's approval screen. */
  link: string;
};

export type ApproversOverview = {
  approvers: Approver[];
  keyPolicy: KeyPolicy;
  pendingEnrolments: {
    id: string;
    person: string;
    forgeLogin: string | null;
    kind: "webauthn" | "ed25519";
    keyFingerprint: string;
    approvals: number;
    required: number;
    expiresAt: number;
  }[];
  policies: {
    environment: string;
    required: number;
    allowAuthorApproval: boolean;
    source: "configured" | "default";
  }[];
  /** Ways the approval setup is weaker than it looks, such as too few approvers. */
  warnings: string[];
  /** The built-in default for `production` and `release` where no entry is set (#663). */
  defaultMode: "solo" | "strict";
  /** The instance administrator's recent loosenings of this org's approval policy, newest first. */
  instanceLoosenings: { at: number; by: string; reason: string; loosened: string[] }[];
};

export type EnvironmentApprovalResult = {
  runId: string;
  environment: string;
  approvals: number;
  required: number;
  releasedJobs: number;
  state: string;
};

/** The freeze that applies to a scope, and the secrets still waiting for rotation. */
export type IncidentStatus = {
  frozen: boolean;
  level: "org" | "project" | null;
  /** Text a person typed: untrusted. Render as text. */
  reason: string | null;
  frozenAt: number | null;
  frozenBy: string | null;
  /** Secrets still waiting for rotation; the names come only to release_operator and above. */
  rotationRequiredCount: number;
  rotationRequired: { name: string; reason: string; flaggedBy: string; flaggedAt: number }[];
};

export type RunDetail = { run: Run; jobs: Job[]; attempts: JobAttempt[] };

export type CheckSummary = {
  sha: string;
  state: JobState | "none";
  runs: { runId: string; workflowName: string; status: JobState }[];
};

export type RunFilter = {
  projectId: string;
  status?: JobState;
  branch?: string;
  event?: string;
  limit?: number;
  cursor?: string;
};

/** Raw log bytes for one attempt. `offset` is a byte position; `size` is the bytes available now. */
export type LogSlice = {
  attemptId: string;
  offset: number;
  bytes: Uint8Array;
  size: number;
  /** True when the attempt is finished and `offset + bytes.length === size`. */
  done: boolean;
};

/** One recorded artifact with its provenance, set by the control plane when it was recorded. */
export type Artifact = {
  name: string;
  size: number;
  /** Lower-case hex sha256. */
  sha256: string;
  /** `computed` when the control plane hashed the bytes itself, `reported` when the recorder gave it. */
  digestSource: "reported" | "computed";
  /** Trust class of the attempt that produced it (capped by its run's class). */
  trustClass: TrustClass | string;
  runSha: string | null;
  attemptId: string;
  createdAt: number;
};

export type ConsumeDecision = "allow" | "quarantine" | "deny";

export type ConsumeResult = {
  runId: string;
  name: string;
  decision: ConsumeDecision;
  reason: string | null;
  trustClass: string | null;
  sha256: string | null;
};
/** The limits of an org (null is no limit). */
export type QuotaLimits = {
  maxConcurrent: number | null;
  maxRunsPerHour: number | null;
  maxSandboxMinutesPerDay: number | null;
  maxLogBytes: number | null;
  maxStoredBytes: number | null;
};

export type QuotaMetric =
  "concurrent" | "runs_per_hour" | "sandbox_minutes" | "log_bytes" | "stored_bytes";

export type QuotaUsage = {
  metric: QuotaMetric;
  /** Null when not measured (log bytes without a limit). */
  used: number | null;
  limit: number | null;
  /** Percent of the limit, rounded down; null with no limit. */
  percent: number | null;
  /** Why new work is held because of this limit, when it is. */
  held: string | null;
};

export type OrgQuotas = { limits: QuotaLimits; usage: QuotaUsage[] };

export type SettingScope = "instance" | "org" | "project";
export type SettingSource = "env" | "toml" | "db" | "default";

/** One org or project setting from `list_settings`: its effective value, source and lock. */
export type Setting = {
  key: string;
  scope: SettingScope;
  description: string;
  value: unknown;
  default: unknown;
  source: SettingSource;
  /** Set by the environment or `turntable.toml`: it cannot be changed here. */
  locked: boolean;
  /** For a locked value, the variable name, or `toml` (the file path is not shared). */
  lockedBy: string | null;
  /** The least role that may change it. */
  role: Whoami["role"];
  mcpEditable: boolean;
  /** Values from least to most strict, when the role may tighten but only the instance loosen. */
  strictness?: string[];
  /** What is at risk in changing it, for a setting whose change can weaken a protection. */
  warning: string | null;
  /** A trust setting: only tightened without a passkey confirmation. */
  trust?: "tighten_only";
};

/** One environment's effective approval policy, defaults filled in (`get_approval_policy`). */
export type ApprovalPolicyEnv = {
  environment: string;
  required: number;
  allowAuthorApproval: boolean;
  keyPolicy: "any" | "hardware";
  /** Whether a job in this environment waits for approval at all. */
  gated: boolean;
  source: "configured" | "default";
};

/** The org's approval policy: the effective map, where it comes from, and whether it is locked. */
export type ApprovalPolicy = {
  environments: ApprovalPolicyEnv[];
  source: SettingSource;
  locked: boolean;
  lockedBy: string | null;
  /** Counted approvers: with two or more, a loosening also needs their signed quorum. */
  approvers: number;
};

/** The passkey confirmation a session attaches to a sensitive write (`step_up`). */
export type StepUpProof = {
  id: string;
  approver: string;
  signature: {
    credential_id: string;
    client_data_json: string;
    authenticator_data: string;
    signature: string;
  };
};

/** A passkey challenge for one exact action (`session_step_up_challenge`). */
export type StepUpChallenge = {
  id: string;
  challenge: string;
  rpId: string;
  passkeys: { approver: string; passkeyId: string }[];
};

/** One row of the cross-org activity feed (`my_activity_feed`). Every text field but the ids is forge text. */
export type ActivityRun = {
  runId: string;
  org: string;
  orgName: string;
  orgAvatarUrl: string | null;
  project: string;
  projectName: string;
  projectAvatarUrl: string | null;
  workflow: string;
  ref: string;
  refType: "branch" | "tag" | null;
  sha: string | null;
  event: string;
  commitMessage: string | null;
  actor: string | null;
  actorAvatarUrl: string | null;
  /** In progress states, or `completed` (then `conclusion` says how it ended). */
  state: "queued" | "running" | "awaiting_approval" | "completed";
  conclusion: "success" | "failure" | "infra_error" | "cancelled" | "skipped" | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type ActivityStatus = "running" | "failed" | "all";
export type ActivityFilter = {
  org?: string | undefined;
  project?: string | undefined;
  status?: ActivityStatus | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

/** Kinds of per-person notification (#611). */
export type NotificationKind =
  | "run_failed"
  | "infra_errors"
  | "work_held"
  | "approval_waiting"
  | "checkout_auth_failed"
  | "dogfood_red"
  | "deploy_failed";

/** One notification of the signed-in person: ids, slugs and an escaped, truncated title. */
export type AppNotification = {
  id: string;
  kind: NotificationKind;
  org: string;
  project: string | null;
  runId: string | null;
  /** Coalesced events behind it (infra_errors). */
  count: number;
  /** Escaped, truncated forge text. Shown as text, never as markup. */
  title: string;
  createdAt: number;
  readAt: number | null;
  link: string;
};
export type NotificationPage = {
  notifications: AppNotification[];
  unreadCount: number;
  nextCursor: string | null;
};
export type NotificationPref = {
  kind: NotificationKind;
  org: string | null;
  project: string | null;
  enabled: boolean;
};
export type NotificationPrefs = {
  prefs: NotificationPref[];
  defaults: { kind: NotificationKind; enabled: boolean; operatorOnly: boolean }[];
};

/** The release lane config writes: each needs a passkey step-up for exactly its input. */
export type LaneAction =
  | "release_pin_repo"
  | "release_init_key"
  | "release_publish_target_set"
  | "release_publish_target_delete"
  | "release_set_project_signing"
  | "release_secret_set"
  | "release_cosign_key_set"
  | "release_cosign_key_remove";

/** A publish target as the lane's file holds it: never a secret value. */
export type LaneTarget = {
  key: string;
  kind: string;
  mode: string;
  hasCredential: boolean;
  settings: Record<string, unknown>;
};

export type LaneConfig = {
  pinnedRepo: string | null;
  configVersion: number;
  targets: LaneTarget[];
};

/** A project's co-signing key as the lane reports it: fingerprints only, never key material. */
export type LaneCosignKey = {
  name: string;
  keyId: string;
  spkiSha256: string;
  signs: string;
  outputName: string;
  format: string;
  manifest: boolean;
};

/** The public half of a release signing key. */
export type LaneKey = { keyid: string; publicKeyPem: string; createdAt: string };

/** Whether a lane secret was set, when and by whom. Never the value. */
export type LaneSecretStatus = { set: boolean; setAt: string | null; setBy: string | null };
