// The single enforcement point for operations. Authentication, scope, role, validation and audit
// all happen here; adapters (REST, MCP, CLI) only translate transport and never decide access.
import { auditFailure, systemOrgId } from "../audit/failures";
import type { BackupConfig } from "../db/backup";
import type { SettingsRuntime } from "../settings/resolve";
import type { Db } from "../db";
import {
  appendAudit,
  findApiTokenByHash,
  getIdentityByUserId,
  findInstanceTokenByHash,
  getOrgById,
  getOrgBySlug,
  getProjectBySlug,
  listMembershipsOfUser,
  type Scope,
  touchApiToken,
  touchInstanceToken,
} from "../db/repos";
import type { DoctorReport } from "../doctor/types";
import type { ArtifactBlobs, ImageRegistrar, Op, OpContext } from "./define";
import type { TrustAnchors } from "../approvals/attestation";
import type { RelyingParty } from "../approvals/webauthn";
import type { LaneConfigClient } from "../release/channel-client";
import type { LaneAvailability } from "../release/supervisor";
import type { WebSessions } from "../auth/web-sessions";
import type { UserGithub } from "../auth/user-tokens";
import type { WebhookService } from "../webhooks/service";
import type { GithubFacts, GithubUserLookup } from "../github/api";
import type { InstallationClaims } from "../github/claim";
import type { AppAuth } from "../github/app-auth";
import type { SecretStore } from "../secrets/store";
import type { SecretVault } from "../secrets/vault";
import type { RunDispatcher } from "../poll/dispatch";
import type {
  ContainerJobs,
  DefaultBranchRunner,
  RepoReaderFactory,
} from "../poll/onboarding-forge";
import { OpError } from "./errors";
import { authenticateSigned } from "./signed";
import { type Credential, orgRole, type Principal, principalId } from "./principal";
import type { OpRegistry } from "./registry";
import { roleSatisfies } from "./roles";
import { hashToken, looksLikeInstanceToken, looksLikeToken } from "./tokens";
import { boundInput } from "./lane-target";
import {
  inputTarget,
  LANE_CONFIG_READ_OPS,
  LANE_CONFIG_WRITE_OPS,
  SESSION_STEP_UP_OPS,
  verifyStepUp,
  type VerifiedStepUp,
} from "./step-up";

export type Transport = "mcp" | "rest";

export type DispatchEnv = {
  registry: OpRegistry;
  db: Db;
  now?: () => number;
  /** Set when the server has a master key; the vault ops need it. */
  vault?: SecretVault | undefined;
  claims?: InstallationClaims | undefined;
  /** GitHub API facts (the App's credentials); `resync_installation` needs them. */
  githubFacts?: GithubFacts | undefined;
  /** Starts `workflow_dispatch` runs (the poller); absent where this process has none. */
  runDispatcher?: RunDispatcher | undefined;
  /** Read-only repo reader for the onboarding preview; absent without a GitHub App. */
  repoReader?: RepoReaderFactory | undefined;
  containerJobs?: ContainerJobs | undefined;
  /** Starts a default-branch push run (the poller); absent where this process has none. */
  defaultBranchRunner?: DefaultBranchRunner | undefined;
  /** Login to numeric id lookup, for invites. */
  githubUsers?: GithubUserLookup | undefined;
  /**
   * Let a `tti_` instance token authenticate. Set only by the REST adapter: MCP and the realtime
   * socket leave it off, so an instance token is simply not a credential there.
   */
  allowInstance?: boolean | undefined;
  /**
   * Which adapter carries the call. Set by the MCP adapters (`mcp`) and the REST adapter
   * (`rest`); absent for in-process callers (the CLI, tests). `approve_run` reads it to refuse an
   * MCP call under a project's `no_agents` policy.
   */
  transport?: Transport | undefined;
  /** Egress modes the sandbox provider can enforce; absent without a provider in this process. */
  providerEgress?: (() => readonly string[] | undefined) | undefined;
  /** The provider's image registration, for `register_sandbox_image`; absent without one. */
  imageRegistrar?: (() => ImageRegistrar | undefined) | undefined;
  /** The instance's per-org concurrency cap (`--org-cap`), the ceiling `set_quotas` clamps to. */
  instanceOrgCap?: number | undefined;
  staticPollProjects?: readonly string[] | undefined;
  /** The data dir and database file `db_backup` works on; `{ dialect: "pg" }` on Postgres. */
  backup?: BackupConfig | undefined;
  webhooks?: WebhookService | undefined;
  /** WebAuthn relying party for human approvals (TURNTABLE_PUBLIC_URL or the WEBAUTHN vars). */
  webauthn?: RelyingParty | undefined;
  /** The release lane's config channel; absent when no lane is configured on this instance. */
  releaseConfig?: LaneConfigClient | undefined;
  /** The supervised release lane's availability, for `request_release`. */
  releaseLane?: { availability(): LaneAvailability } | undefined;
  /** The artifact store's reads, for the download ops; absent when artifacts are off. */
  artifactBlobs?: ArtifactBlobs | undefined;
  /** Slug of the operator org (TURNTABLE_BOOTSTRAP_ORG, default `local`): its owners configure the release lane. */
  operatorOrgSlug?: string | undefined;
  /** Attestation trust anchors; the pinned vendor roots when absent. */
  attestationAnchors?: TrustAnchors | undefined;
  /** The secret store, for ops that read an org's audit public key; absent without a master key. */
  auditStore?: SecretStore | undefined;
  /** The readiness checks, for the `doctor` operation. */
  doctor?: (() => Promise<DoctorReport>) | undefined;
  /** The settings registry and its environment and file layers (boot builds it). */
  settings?: SettingsRuntime | undefined;
  /**
   * Web sessions (#430). Set by the REST adapter's owner when sign-in is configured; absent, a
   * session cookie is not a credential anywhere.
   */
  sessions?: WebSessions | undefined;
  /** Set by the MCP adapter alone: the call is an agent's, so MCP-off settings are refused. */
  viaMcp?: boolean | undefined;
  /** GitHub calls made with a signed-in user's own token; absent when sign-in is not set up. */
  userGithub?: UserGithub | undefined;
  /** The GitHub App's credential minter; the App-secret ops need it. */
  appAuth?: AppAuth | undefined;
};

export type DispatchResult =
  | { ok: true; op: Op; output: unknown; untrusted: boolean }
  | { ok: false; error: OpError; op?: Op };

/** How often a token's last_used_at is refreshed, so reads do not become writes. */
const TOUCH_INTERVAL_MS = 60_000;

const BAD_TOKEN = "invalid, expired or revoked token";

/**
 * An `unauthenticated` OpError that remembers which org's token it was, when it was one, so the
 * failure can be audited in that org's chain.
 */
export class AuthFailure extends OpError {
  readonly orgId: string | undefined;
  readonly tokenId: string | undefined;
  constructor(orgId?: string, tokenId?: string) {
    super("unauthenticated", BAD_TOKEN);
    this.orgId = orgId;
    this.tokenId = tokenId;
  }
}

/** The input as audited: fields that carry a secret value never go into the log. */
export function redactInput(op: Op, input: unknown): unknown {
  const any = op.secretInputFields.length > 0 || op.logOmitFields.length > 0;
  if (!any || input === null || typeof input !== "object") return input;
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const f of op.secretInputFields) if (f in out) out[f] = "[redacted]";
  for (const f of op.logOmitFields) if (f in out) out[f] = "[omitted]";
  return out;
}

/**
 * The audited input of a successful call: the redacted input, plus the op's own detail. The
 * redacted input wins: a detail key that collides with an input key is dropped (and named, never
 * its value), so a detail can never un-redact a secret or omitted field.
 */
function auditedInput(op: Op, input: unknown, detail: Record<string, unknown>): object {
  const base = redactInput(op, input);
  const redacted =
    base !== null && typeof base === "object" ? (base as Record<string, unknown>) : {};
  // A detail key that names a secret, omitted or one-time-secret field is dropped even when the
  // input left that (optional) field out: otherwise an omitted optional secret would slip through.
  const guarded = new Set([
    ...op.secretInputFields,
    ...op.logOmitFields,
    ...op.oneTimeSecretFields,
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (k in redacted || guarded.has(k)) {
      console.warn(
        `turntable: op ${op.name} auditDetail key "${k}" collides with an input or secret field; dropped`,
      );
      continue;
    }
    out[k] = v;
  }
  return { ...out, ...redacted };
}

/** A short stable digest of an unrecognised token, so repeats of it share a throttle bucket. */
const unknownTokenSource = (c: Credential): string =>
  c.kind === "bearer"
    ? hashToken(c.token).slice(0, 12)
    : c.kind === "session"
      ? hashToken(c.cookie).slice(0, 12)
      : "none";

/**
 * The writes a web session may make with no step-up. Everything else that is not a read is
 * refused for a session by default, so a new op is closed to sessions until someone opens it
 * here, or in SESSION_STEP_UP_OPS (step-up.ts), where it also needs a fresh passkey assertion
 * bound to the exact request. `invite_member` is in both: a viewer or member invite needs none,
 * an admin or owner invite needs the step-up (the handler enforces it).
 */
export const SESSION_WRITE_OPS: ReadonlySet<string> = new Set([
  "invite_member",
  "session_step_up_challenge",
  // The org owner's own first approver passkey (#587): the ops require an owner session whose
  // GitHub sign-in is under 10 minutes old, and refuse every token, instance call and MCP.
  "first_approver_challenge",
  "enrol_first_approver",
  // Onboarding. Creating an org is gated by `self_serve_orgs` and a rate limit in its handler.
  // The claim link only starts a flow (ownership of the GitHub installation is checked when it
  // binds), and `bind_installation` re-checks that with the user's own GitHub token every time.
  "onboarding_create_org",
  "start_installation_claim",
  "bind_installation",
  // Adding a repo as a project and removing one (history is kept; deleting it needs the step-up,
  // which `remove_project` takes only with `delete_history`).
  "add_project",
  "remove_project",
  // Onboarding (A3): owner or admin sessions only, by the ops' own `admin` role.
  "onboard_repos",
  "run_default_branch",
  // A human starts a workflow_dispatch run from the web (#617): the op's own `release_operator`
  // role gates it, and a release-class run is still held for approval before any signing or
  // publishing, so no step-up (a dispatch is not an approval).
  "run_dispatch",
  // An owner or admin session sets its org's settings, by each setting's own role. Loosening a
  // trust setting also needs the step-up (the guard enforces it: set_setting is in
  // SESSION_STEP_UP_OPS for that case only).
  "set_setting",
  // An owner's session edits `approval_policy` (#664): tightening needs no step-up, loosening does
  // (the handler enforces it, and a quorum of approvers when the org has two or more).
  "set_approval_policy",
  // An owner session tightens its project's egress (open, then allowlist, then none); widening
  // is the instance administrator's op and the handler refuses it here.
  "tighten_project_egress",
  // An owner or admin session edits its project's PR mode and authors; the handler lets only an
  // owner widen (#807).
  "change_project_pr_policy",
  // A person's own notifications and preferences (#611): rows keyed by the session's user.
  "notifications_ack",
  "set_notification_prefs",

  // A project's non-secret `vars.*` from its settings page (#798): the ops' own role
  // gates them (release_operator, since the values reach protected runs), the values are plain text and the audit log keeps the name only. No step-up.
  "set_project_var",
  "delete_project_var",
  // Cancel and rerun from the run and job pages: audited, low-risk writes, gated by each op's own
  // `operator` role exactly as for a token. No step-up.
  "cancel",
  "rerun",
]);

/**
 * Refuses every caller of a lane configuration op but an OWNER of the operator org on a web
 * session. A refusal is audited in the caller's own org's chain (a write) and reads the same
 * whatever the reason.
 */
async function laneGate(
  env: DispatchEnv,
  credential: Credential,
  principal: Principal,
  name: string,
): Promise<void> {
  const refuse = async (): Promise<never> => {
    // Every org-bound principal's refusal is audited in its org's chain (a member principal too).
    if (principal.kind === "session" || principal.kind === "token" || principal.kind === "member") {
      await appendAudit(
        env.db,
        { orgId: principal.orgId },
        {
          principalKind: principal.kind,
          principalId: principalId(principal),
          op: name,
          effect: LANE_CONFIG_WRITE_OPS.has(name) ? "write" : "read",
          outcome: "error:forbidden",
          input: { reason: "not_operator_org_owner" },
        },
      ).catch(() => {});
    }
    throw new OpError(
      "forbidden",
      `${name} is for a signed-in owner of the operator org, in the web app`,
      { reason: "lane_operator_owner_only" },
    );
  };
  if (
    credential.kind !== "session" ||
    env.viaMcp === true ||
    env.transport === "mcp" ||
    principal.kind !== "session" ||
    principal.role !== "owner"
  ) {
    return refuse();
  }
  const operator = await getOrgBySlug(env.db, env.operatorOrgSlug ?? "local");
  if (!operator || operator.id !== principal.orgId) return refuse();
}

/** Step 1: turns a credential into a principal, or throws `unauthenticated`. */
export async function authenticate(
  env: DispatchEnv,
  credential: Credential,
  /** The `org` the call names, which picks the org a session acts in. */
  orgHint?: unknown,
): Promise<Principal> {
  if (credential.kind === "principal") return credential.principal;
  if (credential.kind === "session") return authenticateSession(env, credential.cookie, orgHint);
  // A signed request is authenticated against its input, by authenticateSigned.
  if (credential.kind === "signed") throw new AuthFailure();
  const token = credential.token;
  if (looksLikeInstanceToken(token)) return authenticateInstance(env, token);
  // One message for every failure, so a caller cannot tell a wrong token from a revoked one.
  if (!looksLikeToken(token)) throw new AuthFailure();
  const row = await findApiTokenByHash(env.db, hashToken(token));
  const now = (env.now ?? Date.now)();
  if (!row || row.revokedAt !== null || (row.expiresAt !== null && row.expiresAt <= now)) {
    throw new AuthFailure(row?.orgId, row?.id);
  }
  if (row.lastUsedAt === null || now - row.lastUsedAt > TOUCH_INTERVAL_MS) {
    // Best effort: a failed touch must not fail the call.
    await touchApiToken(
      env.db,
      { orgId: row.orgId, ...(row.projectId ? { projectId: row.projectId } : {}) },
      row.id,
      now,
    ).catch(() => {});
  }
  return {
    kind: "token",
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    role: row.role as Extract<Principal, { kind: "token" }>["role"],
    // Only an explicit `person` is one; anything else, a missing value included, is an agent.
    tokenKind: row.kind === "person" ? "person" : "agent",
  };
}

/**
 * A `tti_` token. Accepted only when the adapter allows it, from the instance_tokens table (never
 * api_tokens), and the principal it gives holds no org grant. Failures look like any bad token.
 */
async function authenticateInstance(env: DispatchEnv, token: string): Promise<Principal> {
  if (env.allowInstance !== true) throw new AuthFailure();
  const row = await findInstanceTokenByHash(env.db, hashToken(token));
  const now = (env.now ?? Date.now)();
  if (!row || row.revokedAt !== null || (row.expiresAt !== null && row.expiresAt <= now)) {
    throw new AuthFailure(await systemOrgId(env.db), row?.id);
  }
  if (row.lastUsedAt === null || now - row.lastUsedAt > TOUCH_INTERVAL_MS) {
    await touchInstanceToken(env.db, row.id, now).catch(() => {});
  }
  return { kind: "instance", id: row.id, orgId: await systemOrgId(env.db), role: "instance_admin" };
}

const NO_SUCH_SCOPE = "org or project not found";

/**
 * A session cookie for an op that takes the `account` principal: the signed-in GitHub user with
 * no org picked. The call must name no org (an org picks the `session` principal instead).
 */
async function authenticateAccount(
  env: DispatchEnv,
  cookie: string,
  org: unknown,
): Promise<Principal> {
  const live = await env.sessions?.resolve(cookie);
  if (!live) throw new AuthFailure();
  if (org !== undefined) throw new OpError("invalid_input", "this operation takes no org");
  const identity = await getIdentityByUserId(env.db, live.userId);
  if (!identity) throw new AuthFailure();
  return {
    kind: "account",
    githubUserId: identity.githubUserId,
    login: identity.login,
    sessionHash: live.hash,
    id: identity.githubUserId,
    orgId: await systemOrgId(env.db),
  };
}

/**
 * A session cookie. The principal is a `member` whose role is the one Turntable's own membership
 * row gives in the org the call names, never anything GitHub says. A person in several orgs must
 * name one; a non-member gets the same error as an org that does not exist.
 */
async function authenticateSession(
  env: DispatchEnv,
  cookie: string,
  org: unknown,
): Promise<Principal> {
  const live = await env.sessions?.resolve(cookie);
  if (!live) throw new AuthFailure();
  if (org !== undefined && typeof org !== "string") {
    throw new OpError("invalid_input", "org must be a string");
  }
  const memberships = await listMembershipsOfUser(env.db, live.userId);
  const pick =
    org === undefined
      ? memberships.length === 1
        ? memberships[0]
        : undefined
      : memberships.find((m) => m.slug === org);
  if (!pick) {
    if (org === undefined && memberships.length > 1) {
      throw new OpError("invalid_input", "org is required: this account belongs to several orgs");
    }
    throw new OpError("not_found", NO_SUCH_SCOPE);
  }
  return {
    kind: "session",
    id: live.userId,
    orgId: pick.orgId,
    role: pick.role,
    sessionHash: live.hash,
  };
}

/**
 * Step 2: resolves the Scope from the principal's grant. The input's `org` and `project` can
 * only narrow it. A target outside the grant and one that does not exist give the same error.
 */
async function resolveScope(
  db: Db,
  principal: Principal,
  op: Op,
  raw: Record<string, unknown>,
): Promise<Scope> {
  const orgSlug = raw.org;
  const projectSlug = raw.project;
  if (orgSlug !== undefined && typeof orgSlug !== "string") {
    throw new OpError("invalid_input", "org must be a string");
  }
  if (projectSlug !== undefined && typeof projectSlug !== "string") {
    throw new OpError("invalid_input", "project must be a string");
  }
  const org =
    orgSlug === undefined ? await getOrgById(db, principal.orgId) : await getOrgBySlug(db, orgSlug);
  if (!org || org.id !== principal.orgId) throw new OpError("not_found", NO_SUCH_SCOPE);
  const grantProject = principal.kind === "token" ? principal.projectId : null;
  let projectId: string | undefined = grantProject ?? undefined;
  if (projectSlug !== undefined && !op.projectIsNew) {
    const project = await getProjectBySlug(db, { orgId: org.id }, projectSlug);
    if (!project || (grantProject !== null && project.id !== grantProject)) {
      throw new OpError("not_found", NO_SUCH_SCOPE);
    }
    projectId = project.id;
  }
  if (op.scope === "project" && projectId === undefined) {
    throw new OpError("invalid_input", "project is required for this operation");
  }
  return { orgId: org.id, ...(projectId ? { projectId } : {}) };
}

/**
 * For trusted in-process readers (the realtime server): authenticates a credential and resolves
 * the Scope of its grant with exactly the checks an operation gets. The data itself must still
 * be read by dispatching an operation, so roles, caps and redaction are never duplicated.
 */
export async function resolveCallerScope(
  env: DispatchEnv,
  credential: Credential,
  raw: Record<string, unknown> = {},
): Promise<{ principal: Principal; scope: Scope }> {
  const principal = await authenticate(env, credential);
  const scope = await resolveScope(env.db, principal, { scope: "org" } as Op, raw);
  return { principal, scope };
}

function validateInput(op: Op, raw: Record<string, unknown>): Record<string, unknown> {
  const parsed = op.input.safeParse(raw);
  if (!parsed.success) {
    throw new OpError(
      "invalid_input",
      "input does not match the operation's schema",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  // A cross-org read takes `org` and `project` as filters its handler narrows by.
  if (op.crossOrg) return parsed.data as Record<string, unknown>;
  const { org: _org, project, ...rest } = parsed.data as Record<string, unknown>;
  // The new project's slug is the op's own input (`add_project`), not a scope.
  return op.projectIsNew && project !== undefined ? { ...rest, project } : rest;
}

function validateOutput(op: Op, output: unknown): unknown {
  const parsed = op.output.safeParse(output);
  if (!parsed.success) {
    // Never echo the offending value: it may be exactly what the schema exists to keep out.
    console.error(
      `turntable: op ${op.name} returned output that violates its schema`,
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
    throw new OpError("internal", "operation produced an invalid response");
  }
  // Parsed output drops fields the schema does not declare, a second guard against leaks.
  return parsed.data;
}

/**
 * Runs one operation for a credential.
 *
 * 1 authenticate, 2 resolve scope and check the grant, 3 check the role, 4 validate input,
 * 5 run the handler, 6 validate output, 7 audit writes. Reads run directly; writes run, and
 * write their audit row, in one transaction, so a failed write leaves no partial effect. A
 * failed or denied write is still audited, outside that transaction.
 */
export async function dispatch(
  env: DispatchEnv,
  credential: Credential,
  name: string,
  rawInput: unknown,
): Promise<DispatchResult> {
  let op: Op | undefined;
  try {
    let principal: Principal;
    try {
      if (credential.kind === "signed") {
        const signedOp = env.registry.get(name);
        if (!signedOp) throw new OpError("not_found", `unknown operation: ${name}`);
        if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput))
          throw new OpError("invalid_input", "input must be a JSON object");
        const r = await authenticateSigned(env, signedOp, rawInput as Record<string, unknown>);
        principal = r.principal;
        rawInput = r.raw;
      } else if (
        credential.kind === "session" &&
        (env.registry.get(name)?.auth.type === "account" || env.registry.get(name)?.crossOrg)
      ) {
        // The account principal comes from a session cookie alone, and only for an op that
        // declares `account`: every other op with a cookie gets the org `session` principal.
        principal = await authenticateAccount(
          env,
          credential.cookie,
          // A cross-org read takes `org` as a filter, never as the session's pick.
          rawInput !== null && typeof rawInput === "object" && !env.registry.get(name)?.crossOrg
            ? (rawInput as Record<string, unknown>).org
            : undefined,
        );
      } else {
        principal = await authenticate(
          env,
          credential,
          rawInput !== null && typeof rawInput === "object"
            ? (rawInput as Record<string, unknown>).org
            : undefined,
        );
      }
    } catch (err) {
      // An authentication failure has no scope yet; it is audited in the token's org, or in the
      // system chain when the token names none (throttled either way).
      if (err instanceof AuthFailure) {
        await auditFailure(env.db, {
          orgId: err.orgId,
          principalKind: credential.kind === "session" ? "session" : "token",
          principalId: err.tokenId ?? "unknown",
          source: err.tokenId ?? `unknown:${unknownTokenSource(credential)}`,
          trackFirst: err.tokenId !== undefined,
          op: name,
          outcome: "error:unauthenticated",
          detail: { reason: err.orgId ? "revoked_or_expired" : "unknown_or_malformed" },
        });
      }
      throw err;
    }
    op = env.registry.get(name);
    if (!op) throw new OpError("not_found", `unknown operation: ${name}`);
    // The account principal and the `account` ops belong together and to nothing else: an op that
    // does not declare it refuses an account, and an account op refuses every other principal
    // and every MCP call. This is the first check, so every refusal reads the same.
    if (principal.kind === "account" && op.auth.type !== "account" && !op.crossOrg) {
      throw new OpError("forbidden", `${op.name} does not take an account session`);
    }
    if (op.auth.type === "account" && principal.kind !== "account") {
      throw new OpError("forbidden", `${op.name} needs a signed-in GitHub web session`);
    }
    if (op.auth.type === "account" && (env.viaMcp === true || env.transport === "mcp")) {
      throw new OpError("forbidden", `${op.name} is not available over MCP`);
    }
    // Signature ops need a human-signed assertion. No bearer token or in-process principal
    // carries one, so they are refused here, not just left out of adapters.
    if (op.auth.type === "signature" && credential.kind !== "signed") {
      throw new OpError("signature_required", `${op.name} requires a human signature`);
    }
    // An approver principal is proof of one signed statement, good for signature ops only.
    if (principal.kind === "approver" && op.auth.type !== "signature") {
      throw new OpError("forbidden", `${op.name} does not take a signed request`);
    }
    if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput)) {
      throw new OpError("invalid_input", "input must be a JSON object");
    }
    // A step-up rides beside the input and is judged by the dispatcher, never by the schema.
    const { step_up: stepUpRaw, ...raw } = rawInput as Record<string, unknown>;
    if (stepUpRaw !== undefined && credential.kind !== "session") {
      throw new OpError("invalid_input", "step_up is only for web sessions");
    }
    if (stepUpRaw !== undefined && !SESSION_STEP_UP_OPS.has(op.name)) {
      throw new OpError("invalid_input", `${op.name} does not take a step-up`);
    }
    // Instance ops and org ops never meet: an instance op takes the instance administrator and
    // no one else (an org token of any role is refused), and the administrator, who holds no org
    // grant, is refused every org op. The instance op's scope is the system org, where its audit
    // entries go.
    if (op.auth.type === "instance" && principal.kind !== "instance") {
      throw new OpError("forbidden", `${op.name} is for the instance administrator`);
    }
    if (op.auth.type !== "instance" && principal.kind === "instance") {
      throw new OpError("forbidden", "an instance token holds no org grant");
    }
    // The release lane's configuration (#541) takes ONE credential: a signed-in web session of an
    // owner of the operator org. An org token, an in-process principal, MCP and a `tti_` token
    // (refused above) are not it. This runs before the step-up is looked at and before the scope.
    if (LANE_CONFIG_WRITE_OPS.has(op.name) || LANE_CONFIG_READ_OPS.has(op.name)) {
      await laneGate(env, credential, principal, op.name);
    }
    // A web session is default-deny for writes: only the named ones, whatever the member's role.
    // It is judged before the scope (a project-scoped op with no project would fail there first);
    // a member principal is bound to one org, so the refusal is audited in that org's chain.
    if (
      credential.kind === "session" &&
      op.effect !== "read" &&
      !SESSION_WRITE_OPS.has(op.name) &&
      stepUpRaw === undefined
    ) {
      await appendAudit(
        env.db,
        { orgId: principal.kind === "account" ? await systemOrgId(env.db) : principal.orgId },
        {
          principalKind: principal.kind,
          principalId: principalId(principal),
          op: op.name,
          effect: op.effect,
          outcome: "error:forbidden",
          input: redactInput(op, raw),
        },
      ).catch(() => {});
      throw new OpError(
        "forbidden",
        SESSION_STEP_UP_OPS.has(op.name)
          ? `${op.name} needs a fresh passkey step-up (step_up_required): call session_step_up_challenge`
          : `${op.name} needs a passkey step-up, which this operation does not take for a web session: use a token`,
        { reason: "step_up_required" },
      );
    }
    // An account has no org: its calls are scoped to the system org (where an instance call goes
    // too), and an op that creates something writes its own entry in the new org's chain.
    const scope: Scope =
      principal.kind === "instance"
        ? { orgId: principal.orgId }
        : principal.kind === "account"
          ? { orgId: await systemOrgId(env.db) }
          : await resolveScope(env.db, principal, op, raw);
    const audited = op.effect !== "read";
    const audit = (outcome: string, input: unknown) =>
      appendAudit(env.db, scope, {
        principalKind: principal.kind,
        principalId: principalId(principal),
        op: op!.name,
        effect: op!.effect,
        outcome,
        input: redactInput(op!, input),
      }).catch(() => {});

    if (
      op.auth.type !== "signature" &&
      op.auth.type !== "instance" &&
      op.auth.type !== "account" &&
      !(op.crossOrg && principal.kind === "account") &&
      !roleSatisfies(orgRole(principal), op.auth.minRole)
    ) {
      if (audited) await audit("error:forbidden", raw);
      throw new OpError("forbidden", `${op.name} requires role ${op.auth.minRole}`);
    }
    let input: Record<string, unknown>;
    try {
      input = validateInput(op, raw);
    } catch (err) {
      if (audited) await audit("error:invalid_input", raw);
      throw err;
    }
    let stepUp: VerifiedStepUp | undefined;
    if (stepUpRaw !== undefined && principal.kind === "session") {
      try {
        stepUp = await verifyStepUp(
          {
            db: env.db,
            rp: env.webauthn,
            now: (env.now ?? Date.now)(),
            orgId: scope.orgId,
            sessionHash: principal.sessionHash,
            userId: principal.id,
            action: op.name,
            target: inputTarget(boundInput(input, op.secretInputFields), scope.projectId),
          },
          stepUpRaw,
        );
      } catch (err) {
        await audit(err instanceof OpError ? `error:${err.code}` : "error:internal", input);
        throw err;
      }
    }
    const ctx = (db: Db): OpContext => ({
      stepUp,
      db,
      scope,
      principal,
      now: env.now ?? Date.now,
      vault: env.vault,
      claims: env.claims,
      githubFacts: env.githubFacts,
      githubUsers: env.githubUsers,
      runDispatcher: env.runDispatcher,
      repoReader: env.repoReader,
      containerJobs: env.containerJobs,
      defaultBranchRunner: env.defaultBranchRunner,
      webhooks: env.webhooks,
      webauthn: env.webauthn,
      releaseConfig: env.releaseConfig,
      releaseLane: env.releaseLane,
      artifactBlobs: env.artifactBlobs,
      operatorOrgSlug: env.operatorOrgSlug,
      transport: env.transport,
      providerEgress: env.providerEgress,
      imageRegistrar: env.imageRegistrar,
      instanceOrgCap: env.instanceOrgCap,
      staticPollProjects: env.staticPollProjects,
      backup: env.backup,
      attestationAnchors: env.attestationAnchors,
      doctor: env.doctor,
      auditStore: env.auditStore,
      settings: env.settings,
      viaMcp: env.viaMcp,
      userGithub: env.userGithub,
      appAuth: env.appAuth,
    });
    const target = op;
    if (!audited) {
      const output = validateOutput(target, await target.handler(ctx(env.db), input));
      return { ok: true, op: target, output, untrusted: target.untrustedOutput };
    }
    if (target.outsideTransaction) {
      // The handler runs without the write lock; the audit row gets its own short transaction.
      let output: unknown;
      try {
        output = validateOutput(target, await target.handler(ctx(env.db), input));
      } catch (err) {
        const code = err instanceof OpError ? err.code : "internal";
        await audit(
          `error:${code}`,
          err instanceof OpError && err.auditDetail ? { ...input, ...err.auditDetail } : input,
        );
        throw err;
      }
      const detail = target.auditDetail?.(output) ?? {};
      await env.db.transaction(
        async (tx) => {
          await appendAudit(tx, scope, {
            principalKind: principal.kind,
            principalId: principalId(principal),
            op: target.name,
            effect: target.effect,
            outcome: "ok",
            input: auditedInput(target, input, detail),
          });
        },
        { lock: `audit:${scope.orgId}` },
      );
      return { ok: true, op: target, output, untrusted: target.untrustedOutput };
    }
    try {
      const output = await env.db.transaction(
        async (tx) => {
          const out = validateOutput(target, await target.handler(ctx(tx), input));
          await appendAudit(tx, scope, {
            principalKind: principal.kind,
            principalId: principalId(principal),
            op: target.name,
            effect: target.effect,
            outcome: "ok",
            input: auditedInput(target, input, target.auditDetail?.(out) ?? {}),
          });
          return out;
        },
        { lock: `audit:${scope.orgId}` },
      );
      return { ok: true, op: target, output, untrusted: target.untrustedOutput };
    } catch (err) {
      const code = err instanceof OpError ? err.code : "internal";
      await audit(
        `error:${code}`,
        err instanceof OpError && err.auditDetail ? { ...input, ...err.auditDetail } : input,
      );
      throw err;
    }
  } catch (err) {
    if (err instanceof OpError) return { ok: false, error: err, ...(op ? { op } : {}) };
    console.error("turntable: unexpected error in operation dispatch", err);
    return { ok: false, error: new OpError("internal", "internal error"), ...(op ? { op } : {}) };
  }
}
