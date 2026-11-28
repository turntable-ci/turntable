import type { ChangeEvent } from "./realtime";
import type {
  ActivityFilter,
  ActivityRun,
  ApprovalChallenge,
  ApprovalStatement,
  ReleaseApprovalChallenge,
  ReleaseStatement,
  ApprovalStatus,
  ApproversOverview,
  NotificationKind,
  NotificationPage,
  NotificationPrefs,
  PendingApproval,
  SandboxUsage,
  PolicyStatement,
  EnrolStatement,
  EnvironmentApprovalResult,
  WebAuthnSignature,
  CheckSummary,
  LogSlice,
  Org,
  Project,
  Run,
  RunDetail,
  RunFilter,
  StepEvent,
  CutRecord,
  LogNotice,
  ApproveResult,
  GrepResult,
  IncidentStatus,
  IngestStatus,
  Artifact,
  ConsumeResult,
  JobDigest,
  OrgQuotas,
  RerunResult,
  Setting,
  LaneAction,
  LaneConfig,
  LaneKey,
  LaneCosignKey,
  LaneSecretStatus,
  ApprovalPolicy,
  StepUpChallenge,
  StepUpProof,
  Whoami,
} from "./types";

/**
 * Typed client aligned with the planned operations registry (#22): `listRuns`, `getRun`,
 * `jobLog`, `checksForSha`, `rerun`, `cancel` and `events` map one-to-one onto the MCP/REST
 * operations `list_runs`, `get_run`, `job_log`, `checks_for_sha`, `rerun`, `cancel` and `events`.
 * `listOrgs` and `listProjects` are navigation helpers the registry will need to expose.
 */
export type ApiCapabilities = {
  /** The API has human approvals (statements signed with a passkey). */
  humanApproval: boolean;
  /** Fixture only: the page fakes the passkey ceremony, since no authenticator exists. */
  simulatedCeremony: boolean;
  /** The API can rerun jobs of a run (`rerun`). */
  rerun: boolean;
  /** The API can approve a held run (`approve_run`). */
  approve: boolean;
};

export type PrMode = "off" | "allowlist" | "approval";
export interface PrPolicy {
  prMode: PrMode;
  authors: string[];
  /** False when the project has no ingest settings, so there is nothing to change. */
  ingestEnabled: boolean;
}

export interface TurntableApi {
  readonly capabilities: ApiCapabilities;
  listOrgs(): Promise<Org[]>;
  listProjects(orgId: string): Promise<Project[]>;
  /**
   * Runs across every org the signed-in person belongs to, newest first (`my_activity_feed`).
   * Takes no org from the session: the server resolves the orgs from memberships on each call.
   */
  myActivityFeed(
    filter?: ActivityFilter,
  ): Promise<{ runs: ActivityRun[]; nextCursor: string | null }>;
  listRuns(filter: RunFilter): Promise<{ runs: Run[]; nextCursor: string | null }>;
  getRun(runId: string): Promise<RunDetail>;
  /** Read log bytes by offset. Used for the initial window, load-more and raw download. */
  jobLog(args: { attemptId: string; offset: number; limit: number }): Promise<LogSlice>;
  /** Step boundaries for an attempt that have occurred so far (out of band from the log bytes). */
  jobSteps(args: { attemptId: string }): Promise<StepEvent[]>;
  /** Output-cap cuts for an attempt, as metadata (never text in the log). */
  jobCuts(args: { attemptId: string }): Promise<CutRecord[]>;
  /** System notices for an attempt (never text in the log). */
  jobNotices(args: { attemptId: string }): Promise<LogNotice[]>;
  checksForSha(args: { projectId: string; sha: string }): Promise<CheckSummary>;
  /** Reruns jobs of a run (by job key; omit for the failed ones) with a reason that is audited. */
  rerun(args: { runId: string; jobKeys?: string[]; reason: string }): Promise<RerunResult>;
  /** The caller's role and scope. */
  whoami(): Promise<Whoami>;
  /** Releases a run held for an untrusted author, bound to the sha and workflow hash read. */
  approveRun(args: {
    runId: string;
    headSha: string;
    workflowHash: string;
  }): Promise<ApproveResult>;
  /** Why failing jobs failed: step, basis and an excerpt (plain text). */
  failureDigest(args: {
    runId?: string;
    jobId?: string;
  }): Promise<{ failingJobs: number; digests: JobDigest[] }>;
  /** Server-side search of a job's whole log, for hits beyond the part loaded in the viewer. */
  grepLog(args: {
    attemptId: string;
    pattern: string;
    regex?: boolean;
    ignoreCase?: boolean;
    context?: number;
    maxMatches?: number;
    fromOffset?: number;
  }): Promise<GrepResult>;
  /** Per-repo poll ingest status and the forge rate budget. */
  ingestStatus(): Promise<IngestStatus>;
  /** Environments of a run waiting on a human, the policy and who approved so far. */
  approvalStatus(args: { runId: string }): Promise<ApprovalStatus>;
  approversOverview(): Promise<ApproversOverview>;
  /** Approvals waiting on the signed-in person, across their orgs. A web session only. */
  myPendingApprovals(): Promise<PendingApproval[]>;
  /** The signed-in person's notifications across their orgs (#611), newest first. */
  myNotifications(args?: {
    unread?: boolean;
    kinds?: NotificationKind[];
    cursor?: string;
    limit?: number;
  }): Promise<NotificationPage>;
  /** Marks the named notifications read, or every unread one. `org` is any org of the person. */
  notificationsAck(args: { ids?: string[]; org?: string }): Promise<number>;
  getNotificationPrefs(args?: { org?: string }): Promise<NotificationPrefs>;
  /** `enabled: null` removes the preference. */
  setNotificationPref(args: {
    kind: NotificationKind;
    enabled: boolean | null;
    org?: string;
    scopeOrg?: string;
  }): Promise<void>;
  /** Sandbox minutes per UTC day for the last `days` days, with the quota limit if one is set. */
  sandboxUsage(args: { days: number; byProject?: boolean }): Promise<SandboxUsage>;
  /** The statement to sign for a run and environment, with its single-use challenge. */
  approvalChallenge(args: {
    runId: string;
    environment: string;
    approver: string;
    project: string;
  }): Promise<ApprovalChallenge>;
  /** Sends a statement a human signed. No bearer token is needed: the signature is the credential. */
  approveEnvironment(args: {
    statement: ApprovalStatement;
    signature: WebAuthnSignature | { kind: "ed25519"; signature: string };
  }): Promise<EnvironmentApprovalResult>;
  /** The v2 statement for the project's release environment, with the manifest it binds. */
  releaseApprovalChallenge(args: {
    runId: string;
    approver: string;
    project: string;
  }): Promise<ReleaseApprovalChallenge>;
  /** Sends a signed v2 release statement. No bearer token: the signature is the credential. */
  approveRelease(args: {
    statement: ReleaseStatement;
    signature: WebAuthnSignature | { kind: "ed25519"; signature: string };
  }): Promise<EnvironmentApprovalResult>;
  registerChallenge(): Promise<{
    challenge: string;
    rpId: string;
    expiresAt: number;
    attestation: "none" | "direct";
  }>;
  /** A challenge for the org's first approver passkey: an owner's web session only (#587). */
  firstApproverChallenge(): Promise<{
    challenge: string;
    rpId: string;
    expiresAt: number;
    attestation: "none" | "direct";
  }>;
  /** Enrols the org's first approver with that passkey. Owner session, fresh GitHub sign-in. */
  enrolFirstApprover(args: {
    person?: string;
    webauthn: { challenge: string; clientDataJson: string; attestationObject: string };
  }): Promise<{ approverId: string; person: string; keyFingerprint: string; warnings: string[] }>;
  /** The statement an approver signs to change the key policy (a quorum applies it). */
  keyPolicyChallenge(args: {
    mode: "any" | "hardware";
    presets: string[];
    aaguids: string[];
    approver: string;
  }): Promise<ApprovalChallenge<PolicyStatement>>;
  approveKeyPolicy(args: {
    statement: PolicyStatement;
    signature: WebAuthnSignature | { kind: "ed25519"; signature: string };
  }): Promise<{ approvals: number; required: number; applied: boolean }>;
  requestEnrolment(args: {
    person: string;
    forgeLogin: string;
    webauthn: { challenge: string; clientDataJson: string; attestationObject: string };
  }): Promise<{ enrolmentId: string; keyFingerprint: string; required: number; expiresAt: number }>;
  enrolmentChallenge(args: {
    enrolmentId: string;
    approver: string;
  }): Promise<ApprovalChallenge<EnrolStatement>>;
  approveEnrolment(args: {
    statement: EnrolStatement;
    signature: WebAuthnSignature | { kind: "ed25519"; signature: string };
  }): Promise<{ enrolmentId: string; approvals: number; required: number; activated: boolean }>;
  /** The artifacts a run recorded, with provenance (`get_artifacts`). */
  getArtifacts(args: { runId: string; project: string }): Promise<Artifact[]>;
  /** Whether a consumer run may take artifacts of other runs, and as what (`check_artifact_consumption`). */
  checkArtifactConsumption(args: {
    project: string;
    /** A run (its stored class), or a class by name: "may a build of this class take it?". */
    consumer: { runId: string } | { klass: string };
    sources: { runId: string; name: string }[];
    quarantine?: { runId: string; name: string }[];
  }): Promise<ConsumeResult[]>;
  /** The org's quotas, usage against each, and why work is held (`get_quotas`). */
  getQuotas(): Promise<OrgQuotas>;
  /**
   * The org's settings, or with a project the project's own (`list_settings`). Each carries its
   * effective value, source and lock.
   */
  listSettings(args?: { project?: string }): Promise<Setting[]>;
  /**
   * Sets a setting's stored value, or with `unset` removes it (`set_setting`). Rejects with the
   * server's refusal (locked, role, validation) as the error message.
   */
  setSetting(args: {
    key: string;
    value?: unknown;
    unset?: boolean;
    project?: string;
    /** Loosening a trust setting from a web session: a passkey confirmation for these exact args. */
    stepUp?: StepUpProof;
  }): Promise<Setting>;
  /** The org owner's view of the approval policy, defaults filled in (`get_approval_policy`). */
  getApprovalPolicy(): Promise<ApprovalPolicy>;
  /** The project's default sandbox egress (`get_project_settings`). */
  getProjectEgress(args: { project: string }): Promise<"none" | "allowlist" | "open">;
  /**
   * Tightens the project's default egress (`tighten_project_egress`, owner). It never widens: the
   * server refuses, and the instance operator widens. Resolves with the provider warnings.
   */
  tightenProjectEgress(args: {
    project: string;
    egress: "none" | "allowlist" | "open";
  }): Promise<{ egress: "none" | "allowlist" | "open"; warnings: string[] }>;
  /** The project's PR mode and trusted authors (`get_project_pr_policy`). */
  getProjectPrPolicy(args: { project: string }): Promise<PrPolicy>;
  /**
   * Sets the project's PR mode and authors (`change_project_pr_policy`, owner or admin). Only an
   * owner may widen; a refusal rejects with the server's words.
   */
  changeProjectPrPolicy(
    args: { project: string } & Omit<PrPolicy, "ingestEnabled">,
  ): Promise<PrPolicy>;
  /**
   * Sets one environment's approval policy (`set_approval_policy`). A loosening carries the
   * passkey `stepUp` for exactly these arguments; a refusal rejects with the server's words.
   */
  setApprovalPolicy(args: {
    environment: string;
    required: number;
    allowAuthorApproval: boolean;
    keyPolicy: "any" | "hardware";
    stepUp?: StepUpProof;
  }): Promise<ApprovalPolicy>;
  /** Starts a passkey confirmation for `set_setting` with exactly `input` (`session_step_up_challenge`). */
  stepUpChallenge(args: {
    action:
      | "set_setting"
      | "set_approval_policy"
      | LaneAction
      | "instance_rotate_webhook_secret"
      | "instance_replace_app_private_key";
    input: Record<string, unknown>;
  }): Promise<StepUpChallenge>;
  /**
   * The release lane's configuration (operator org owners only). A write carries the passkey
   * step-up for exactly this `input` (snake_case, as the op takes it; a secret `value` is bound by
   * `value_sha256` in the challenge, never sent to it).
   */
  laneWrite(args: {
    action: LaneAction;
    input: Record<string, unknown>;
    stepUp: StepUpProof;
  }): Promise<Record<string, unknown>>;
  laneConfig(args: { targetOrg: string; targetProject: string }): Promise<LaneConfig>;
  laneKey(args: { targetOrg: string; name: string }): Promise<LaneKey>;
  /** A project's co-signing keys (public information: fingerprints, what each signs). */
  laneCosignKeys(args: {
    targetOrg: string;
    targetProject: string;
  }): Promise<{ keys: LaneCosignKey[]; configVersion: number }>;
  laneSecretStatus(args: {
    targetOrg: string;
    targetProject: string;
    name: string;
  }): Promise<LaneSecretStatus>;
  /** The operator org's owner rotates the App webhook secret (needs `stepUp`). The secret is never returned. */
  rotateWebhookSecret(args: {
    overlapMinutes: number;
    stepUp: StepUpProof;
  }): Promise<{ fingerprint: string; overlapUntil: string }>;
  /** The operator org's owner uploads a new private key for the same App (needs `stepUp`). */
  replaceAppPrivateKey(args: {
    privateKey: string;
    stepUp: StepUpProof;
  }): Promise<{ fingerprint: string; appId: string }>;
  /** Whether scheduling is frozen for the org (or the project, when given), and why. */
  incidentStatus(args?: { project?: string }): Promise<IncidentStatus>;
  cancel(args: { runId: string }): Promise<void>;
  /** Event feed from a cursor (the same events the realtime transport pushes). */
  events(args: {
    cursor: string | null;
    limit?: number;
  }): Promise<{ events: ChangeEvent[]; cursor: string }>;
}
