// Instance-level operations (#205). They belong to the instance administrator, not to any org: the
// caller is a `tti_` token minted on the host, and only such a token can call them over REST. No
// org token of any role can, whatever its grant, and none of these is an MCP tool. Their audit
// entries go to the system org's chain.
import { instanceOrgCapOf } from "../org-cap";
import { z } from "zod";
import type { Db } from "../../db";
import {
  createSettingsRuntime,
  resolveSetting,
  type SettingsRuntime,
} from "../../settings/resolve";
import { effectiveChecksMode } from "../setting-guard";
import { settingsRegistry } from "../../settings/definitions";
import { approvalWarnings, bootstrapFirstApprover } from "../../approvals/apply";
import {
  ApprovalConflict,
  appendAudit,
  appendEvent,
  countActiveApiTokens,
  countRunning,
  countRunningByAdoptability,
  countRunningByMode,
  createOrg,
  findRepoBindingByName,
  getInstallation,
  getInstanceToken,
  getOrgById,
  getOrgBySlug,
  getProject,
  getProjectBySlug,
  instanceOrgSummary,
  instanceInfraErrors,
  instanceRunActivity,
  instanceRunSummary,
  listProjects,
  RUN_TRIGGERS,
  type RunSummaryCell,
  insertApiToken,
  listAllOrgs,
  moveRepoBinding,
  orgTokenHistory,
  setOrgQuotas,
  deleteProjectCascade,
  listPruneCandidates,
} from "../../db/repos";
import { loadAuditKey } from "../../audit/checkpoint";
import { SYSTEM_ORG_SLUG, systemOrgId } from "../../audit/failures";
import {
  anchorCutoverSeq,
  anchorRefusal,
  verifyAnchors,
  type AnchorCheckpoint,
  type AnchorRefusal,
} from "../../audit/verify";
import { AGENT_ROLES, FORGES, TOKEN_KINDS } from "../../db/schema";
import { ingestStatus } from "../../poll/status";
import { ORG_SLUG } from "../bootstrap";
import { defineOp } from "../define";
import { ClaimError } from "../../github/claim";
import { syncInstallation } from "../../github/installations";
import { staticPollKey } from "../project-setup";
import { resolveGithubUserId } from "../../approvals/github-id";
import { OpError } from "../errors";
import { sanitizeInfraError } from "../../infra-error-text";
import { rotateInstanceToken } from "../instance-token-cli";
import { generateToken, hashToken } from "../tokens";
import { ambientSettings } from "../../settings/ambient";
import { orgTokenRemintDelaySetting } from "../../settings/definitions";
import { processDrain } from "../../scheduler/drain";
import { doctorForApi, doctorOutput } from "./doctor";
import { quotaView, quotaViewSchema } from "./quotas";

const DAY_MS = 86_400_000;

const HOUR_MS = 3_600_000;

const iso = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

export const instanceWhoami = defineOp({
  name: "instance_whoami",
  summary: "Who the instance administrator token is.",
  description:
    "Returns the id and label of the instance token in use and when it expires. Use it to check " +
    "that a `tti_` token works. Only the instance administrator can call it. Read-only.",
  input: z.object({}),
  output: z.object({
    id: z.string(),
    name: z.string(),
    expires_at: z.string().nullable(),
  }),
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/whoami" },
  mcp: false,
  async handler(ctx) {
    const row = await getInstanceToken(ctx.db, ctx.principal.id);
    if (!row) throw new OpError("not_found", "instance token not found");
    return { id: row.id, name: row.name, expires_at: iso(row.expiresAt) };
  },
});

export const instanceListOrgs = defineOp({
  name: "instance_list_orgs",
  summary: "Every org on the instance, for the instance administrator.",
  description:
    "Lists the slug and name of every org of the instance (not the internal system org), so the " +
    "administrator can name one in set_quotas. Names come from the orgs' admins: untrusted text. " +
    "Only the instance administrator can call it. Read-only.",
  input: z.object({}),
  output: z.object({
    orgs: z.array(z.object({ slug: z.string(), name: z.string() })),
  }),
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/instance/orgs" },
  mcp: false,
  async handler(ctx) {
    const orgs = await listAllOrgs(ctx.db);
    return {
      orgs: orgs
        .filter((o) => o.slug !== SYSTEM_ORG_SLUG)
        .map((o) => ({ slug: o.slug, name: o.name })),
    };
  },
});

const limit = z.int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();

export const setQuotas = defineOp({
  name: "set_quotas",
  summary: "Set an org's quotas (instance administrator only).",
  description:
    "Changes the limits of one org, naming only the ones to change (null removes a limit). " +
    "`max_concurrent` can only lower the org's concurrency below the instance's per-org cap " +
    "(`--org-cap`): a value above it is refused, and removing it falls back to the cap. The new " +
    "limits and the usage against them are returned. The change is audited in the system org's " +
    "chain and in the target org's own. Only the instance administrator can call it: an org's own " +
    "tokens, of any role, never can. Not an MCP tool.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the org whose quotas change."),
    max_concurrent: limit.optional(),
    max_runs_per_hour: limit.optional(),
    max_sandbox_minutes_per_day: limit.optional(),
    max_log_bytes: limit.optional(),
    max_stored_bytes: limit.optional(),
  }),
  output: quotaViewSchema,
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/quotas" },
  mcp: false,
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such org");
    const patch: Record<string, number | null> = {};
    const set = (key: string, v: number | null | undefined): void => {
      if (v !== undefined) patch[key] = v;
    };
    set("maxConcurrent", i.max_concurrent);
    set("maxRunsPerHour", i.max_runs_per_hour);
    set("maxSandboxMinutesPerDay", i.max_sandbox_minutes_per_day);
    set("maxLogBytes", i.max_log_bytes);
    set("maxStoredBytes", i.max_stored_bytes);
    if (Object.keys(patch).length === 0) {
      throw new OpError("invalid_input", "name at least one limit to set");
    }
    const cap = await instanceOrgCapOf(ctx);
    if (typeof i.max_concurrent === "number" && cap !== undefined && i.max_concurrent > cap) {
      throw new OpError(
        "invalid_input",
        `max_concurrent ${i.max_concurrent} is above the instance's per-org cap of ${cap}; it can only lower it`,
      );
    }
    await setOrgQuotas(ctx.db, org.id, patch, `instance:${ctx.principal.id}`, ctx.now());
    // The org's own chain says it too: its operators should see who changed their limits.
    await appendAudit(
      ctx.db,
      { orgId: org.id },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "set_quotas",
        effect: "write",
        outcome: "ok",
        input: { target_org: org.slug, ...patch },
      },
    );
    // In the op's transaction: the cached log figure, never an HTTP call to the store under the lock.
    return quotaView(ctx, org.id, { noWait: true });
  },
});

export const rotateInstanceTokenOp = defineOp({
  name: "rotate_instance_token",
  summary:
    "Replace the instance administrator token in use with a new one (instance administrator only).",
  description:
    "Mints a new instance token with the same name (or the one given) and revokes the token that " +
    "made this call, in one step. The new secret is returned once; only its hash is stored, so it " +
    "cannot be shown again. Use it once after a first boot with " +
    "TURNTABLE_INSTANCE_BOOTSTRAP_TOKEN_SHA256, then remove that variable. The audit entry names " +
    "the two token ids and never a secret or a hash. Only the instance administrator can call it. " +
    "Not an MCP tool: instance tokens are not MCP credentials.",
  input: z.object({
    name: z.string().min(1).max(80).optional().describe("Label of the new token."),
    expires_days: z.int().min(1).max(90).optional().describe("Lifetime in days. Default 30."),
  }),
  output: z.object({
    id: z.string(),
    secret: z.string().describe("The new token. Shown once."),
    expires_at: z.string(),
    revoked_id: z.string(),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/tokens/rotate" },
  mcp: false,
  oneTimeSecretFields: ["secret"],
  auditDetail: (o) => ({ id: o.id, revoked_id: o.revoked_id }),
  async handler(ctx, i) {
    try {
      const r = await rotateInstanceToken(ctx.db, {
        oldId: ctx.principal.id,
        name: i.name,
        expiresInDays: i.expires_days,
        createdBy: `instance:${ctx.principal.id}`,
        now: ctx.now,
      });
      return {
        id: r.id,
        secret: r.secret,
        expires_at: new Date(r.expiresAt).toISOString(),
        revoked_id: r.revokedId,
      };
    } catch (err) {
      if (err instanceof Error) throw new OpError("invalid_input", err.message);
      throw err;
    }
  },
});

export const createOrgOp = defineOp({
  name: "create_org",
  summary: "Create an empty org (instance administrator only).",
  description:
    "Creates an org with a slug (lower-case letters, digits and `-`, up to 63, starting " +
    "alphanumeric) and a display name. The org starts with no projects and no tokens: give it " +
    "its first token with `create_org_token`. A slug already in use is a conflict, and the " +
    "internal system org is never a target. On a hosted instance with no shell this is how a " +
    "second tenant is added. Audited in the system org's chain and in the new org's own. Only " +
    "the instance administrator can call it. Not an MCP tool.",
  input: z.object({
    slug: z.string().min(1).max(63).describe("Slug of the new org."),
    name: z.string().min(1).max(120).describe("Display name. Untrusted text elsewhere."),
  }),
  output: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/orgs" },
  mcp: false,
  async handler(ctx, i) {
    if (!ORG_SLUG.test(i.slug)) {
      throw new OpError(
        "invalid_input",
        "an org slug is lower-case letters, digits and - (up to 63, starting alphanumeric)",
      );
    }
    if (i.slug === SYSTEM_ORG_SLUG || (await getOrgBySlug(ctx.db, i.slug))) {
      throw new OpError("conflict", "an org with that slug already exists");
    }
    const org = await createOrg(ctx.db, { slug: i.slug, name: i.name });
    await appendAudit(
      ctx.db,
      { orgId: org.id },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "create_org",
        effect: "write",
        outcome: "ok",
        input: { slug: org.slug },
      },
    );
    return { id: org.id, slug: org.slug, name: org.name };
  },
});

export const createOrgTokenOp = defineOp({
  name: "create_org_token",
  summary: "Mint an org's first token, or a new one after a delay (instance administrator only).",
  description:
    "Mints a token for an org that has none active: it is refused as a conflict once the org " +
    "has any token that is neither revoked nor expired, so it cannot be used to add access to " +
    "an org that already has some (the same one-shot rule as the env bootstrap). An org that " +
    "never had a token is served at once. An org that ever had one is refused until the " +
    "`org_remint_delay_hours` setting (default 24, minimum 1) has passed since its last " +
    "token was revoked or expired, and the refusal says when; a re-mint emits an " +
    "`org.token_reminted` event to the org. The role is " +
    "at most `release_operator`; `kind` defaults to `person` (the operator's own token, which " +
    "may approve under `no_agents`). An expiry of 1 to 365 days is required. The secret is " +
    "returned once in `token` and cannot be read again: only its hash is stored, and the audit " +
    "entries never hold it. From then on the org's own tokens (operator or above) can mint narrower ones with `create_api_token`, within their own role, scope and lifetime. The system org is never " +
    "a target. Audited in the system org's chain and in the org's own. Only the instance " +
    "administrator can call it. Not an MCP tool.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the org."),
    name: z.string().min(1).max(80).describe("A label for the token."),
    role: z.enum(AGENT_ROLES).describe("At most release_operator."),
    kind: z
      .enum(TOKEN_KINDS)
      .default("person")
      .describe("person: a human's own token (default). agent: an MCP client or script."),
    expires_days: z.int().min(1).max(365).describe("Lifetime in days."),
  }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    org: z.string().describe("Org slug."),
    role: z.enum(AGENT_ROLES),
    kind: z.enum(TOKEN_KINDS),
    expires_at: z.string(),
    token: z.string().describe("The secret. Shown once, store it now."),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/orgs/tokens" },
  mcp: false,
  oneTimeSecretFields: ["token"],
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such org");
    const scope = { orgId: org.id };
    if ((await countActiveApiTokens(ctx.db, scope, ctx.now())) > 0) {
      throw new OpError(
        "conflict",
        "the org already has an active token; only the org's own admins can add more",
      );
    }
    // An org that had a token is not served at once: a stolen instance token that gets the org's
    // tokens revoked (or waits for them to expire) must not mint itself a new one unseen (#367).
    const history = await orgTokenHistory(ctx.db, scope);
    let remint: { delayHours: number; lastEnd: number } | undefined;
    if (history.everHad) {
      const delay = await resolveSetting(
        ctx.settings ?? ambientSettings(),
        ctx.db,
        orgTokenRemintDelaySetting.key,
      );
      const delayHours = delay.value as number;
      // Every token has ended here (none is active), so lastEnd is set; the fallback fails closed.
      const lastEnd = history.lastEnd ?? ctx.now();
      const allowedAt = lastEnd + delayHours * HOUR_MS;
      if (ctx.now() < allowedAt) {
        throw new OpError(
          "conflict",
          `the org has had a token, so a new one cannot be minted until ${iso(allowedAt)} ` +
            `(${delayHours} h after its last token ended; the org_remint_delay_hours setting)`,
        );
      }
      remint = { delayHours, lastEnd };
    }
    const secret = generateToken();
    const expiresAt = ctx.now() + i.expires_days * DAY_MS;
    const row = await insertApiToken(ctx.db, scope, {
      name: i.name,
      role: i.role,
      kind: i.kind,
      tokenHash: hashToken(secret),
      createdBy: `instance:${ctx.principal.id}`,
      expiresAt,
    });
    await appendAudit(ctx.db, scope, {
      principalKind: "instance",
      principalId: ctx.principal.id,
      op: "create_org_token",
      effect: "write",
      outcome: "ok",
      input: {
        target_org: org.slug,
        token_id: row.id,
        name: i.name,
        role: i.role,
        kind: i.kind,
        expires_days: i.expires_days,
        ...(remint ? { remint: true, last_token_ended_at: iso(remint.lastEnd) } : {}),
      },
    });
    if (remint) {
      // The system chain's own record that access was minted again, naming the org.
      await appendAudit(
        ctx.db,
        { orgId: await systemOrgId(ctx.db) },
        {
          principalKind: "instance",
          principalId: ctx.principal.id,
          op: "org_token_reminted",
          effect: "write",
          outcome: "ok",
          input: {
            target_org: org.slug,
            token_id: row.id,
            last_token_ended_at: iso(remint.lastEnd),
          },
        },
      );
      // The org's notice: its feed and any webhook on it see that access was minted again.
      await appendEvent(ctx.db, scope, {
        type: "org.token_reminted",
        payload: {
          token_id: row.id,
          role: i.role,
          kind: i.kind,
          by: ctx.principal.id,
          last_token_ended_at: iso(remint.lastEnd),
          delay_hours: remint.delayHours,
        },
      });
    }
    return {
      id: row.id,
      name: row.name,
      org: org.slug,
      role: i.role,
      kind: i.kind,
      expires_at: new Date(expiresAt).toISOString(),
      token: secret,
    };
  },
});

const REFUSED = "that binding cannot be moved to that org and project";

export const moveRepoBindingOp = defineOp({
  name: "move_repo_binding",
  summary: "Move a repo's binding to a project in another org (instance administrator only).",
  description:
    "Moves the one binding of a repo (`forge`, `owner`, `repo`) to `to_project` of `to_org`, in " +
    "one transaction, and keeps its installation. A repo is bound to one project on the whole " +
    "instance, so this is how a tenant's repo leaves the bootstrap org before its installation is " +
    "claimed. Refused, with one message that names no other org, when the target project is not in " +
    "the target org, when the binding's installation is not mapped to the target org, or when " +
    "`forge_repo_id` is given and differs from the binding's. Run history stays with the old " +
    "project, and its queued and running attempts finish there; only later ingest lands in the new " +
    "project. The poller's seen markers of the repo are copied to the new project, so a poll at " +
    "the same head creates no second run. A static poll entry still naming the old project is " +
    "skipped by the poller (one warning per interval) until it is changed and the instance " +
    "restarted: the response lists the entries of the running poll config that still name the " +
    "old project. Audited in the system org's chain and in both orgs' chains, with the old and new " +
    "ids. Only the instance administrator can call it. Not an MCP tool.",
  input: z.object({
    forge: z.enum(FORGES).default("github"),
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    forge_repo_id: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe("Forge's numeric repo id; refused if the binding holds a different one."),
    to_org: z.string().min(1).max(64).describe("Slug of the target org."),
    to_project: z.string().min(1).max(63).describe("Slug of the target project in that org."),
  }),
  output: z.object({
    binding_id: z.string(),
    repo: z.string(),
    installation_id: z.string().nullable(),
    from: z.object({ org: z.string(), project: z.string() }),
    to: z.object({ org: z.string(), project: z.string() }),
    poll_entries_to_update: z
      .array(z.object({ repo: z.string(), org: z.string(), project: z.string() }))
      .describe("Entries of the running poll config that still name the old project."),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/repo-bindings/move" },
  mcp: false,
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.to_org);
    const project =
      org && org.slug !== SYSTEM_ORG_SLUG
        ? await getProjectBySlug(ctx.db, { orgId: org.id }, i.to_project)
        : undefined;
    if (!org || !project) throw new OpError("not_found", "no such org or project");
    const binding = await findRepoBindingByName(ctx.db, i);
    if (!binding) throw new OpError("not_found", "no such binding");
    if (
      binding.forgeRepoId !== null &&
      i.forge_repo_id &&
      binding.forgeRepoId !== i.forge_repo_id
    ) {
      throw new OpError("conflict", REFUSED);
    }
    if (binding.installationId !== null) {
      const inst = await getInstallation(ctx.db, binding.installationId);
      if (!inst || inst.orgId !== org.id) throw new OpError("conflict", REFUSED);
    }
    if (binding.orgId === org.id && binding.projectId === project.id) {
      throw new OpError("conflict", "the binding is already in that project");
    }
    const fromOrg = (await getOrgById(ctx.db, binding.orgId))!;
    const fromProject = (await getProject(ctx.db, { orgId: binding.orgId }, binding.projectId))!;
    if (!(await moveRepoBinding(ctx.db, binding.id, { orgId: org.id, projectId: project.id }))) {
      throw new OpError("not_found", "no such binding");
    }
    const detail = {
      binding_id: binding.id,
      repo: `${binding.owner}/${binding.repo}`,
      from_org_id: fromOrg.id,
      from_project_id: fromProject.id,
      to_org_id: org.id,
      to_project_id: project.id,
    };
    const entry = {
      principalKind: "instance" as const,
      principalId: ctx.principal.id,
      op: "move_repo_binding",
      effect: "write" as const,
      outcome: "ok" as const,
      input: detail,
    };
    // The system chain gets the dispatcher's entry; each org's own chain says it too.
    await appendAudit(ctx.db, { orgId: fromOrg.id, projectId: fromProject.id }, entry);
    if (org.id !== fromOrg.id) {
      await appendAudit(ctx.db, { orgId: org.id, projectId: project.id }, entry);
    }
    const key = `${binding.owner}/${binding.repo}`;
    return {
      binding_id: binding.id,
      repo: key,
      installation_id: binding.installationId,
      from: { org: fromOrg.slug, project: fromProject.slug },
      to: { org: org.slug, project: project.slug },
      poll_entries_to_update: [...ingestStatus.repos.values()]
        .filter(
          (r) =>
            r.repo.toLowerCase() === key &&
            r.org === fromOrg.slug &&
            r.project === fromProject.slug,
        )
        .map((r) => ({ repo: r.repo, org: r.org, project: r.project })),
    };
  },
});

export const instanceStartInstallationClaimOp = defineOp({
  name: "instance_start_installation_claim",
  summary:
    "Start a GitHub installation claim for an org that cannot (instance administrator only).",
  description:
    "Starts the same claim as `start_installation_claim`, for the org `target_org`, when none of that " +
    "org's tokens can (all below release_operator, or `create_org_token` is one-shot or in its " +
    "re-mint delay). `github_login` is required: only that GitHub user can complete it, and the " +
    "ownership check by exactly that login is unchanged (the person must still install the App " +
    "and own the installation). With `installation_id` the claim is pinned to that installation. " +
    "The link carries a signed single-use state for the target org, expires in 15 minutes and " +
    "returns `{url, expires_at}`. `reason` is required and kept in the audit. Audited in the " +
    "system org's chain and in the target org's own, and the org's feed gets an " +
    "`org.installation_claim_started_by_instance` event so a tenant sees the operator start a " +
    "claim for it. The system org is never a target. Only the instance administrator can call " +
    "it. Not an MCP tool.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the target org."),
    github_login: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,39}$/)
      .describe("Only this GitHub user can complete the claim."),
    installation_id: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional()
      .describe("Pin the claim to an existing installation."),
    reason: z.string().min(1).max(500).describe("Why the operator starts it. Kept in the audit."),
  }),
  output: z.object({
    url: z.string().describe("Give this to the GitHub user to open in a browser."),
    expires_at: z.int(),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/installation-claims" },
  mcp: false,
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such org");
    if (!ctx.claims) {
      throw new OpError(
        "unavailable",
        "installation claims are not configured: start the server with TURNTABLE_MASTER_KEY_FILE and a GitHub App",
      );
    }
    let r: { url: string; expiresAt: number };
    try {
      r = await ctx.claims.start(org.id, `instance:${ctx.principal.id}`, {
        expectedLogin: i.github_login,
        ...(i.installation_id ? { installationId: i.installation_id } : {}),
      });
    } catch (e) {
      if (e instanceof ClaimError) throw new OpError("unavailable", e.message);
      throw e;
    }
    const pinned = i.installation_id !== undefined;
    // The system chain gets the dispatcher's entry; the org's own chain and feed say it too.
    await appendAudit(
      ctx.db,
      { orgId: org.id },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "instance_start_installation_claim",
        effect: "write",
        outcome: "ok",
        input: {
          target_org: org.slug,
          github_login: i.github_login,
          installation_pinned: pinned,
          ...(i.installation_id ? { installation_id: i.installation_id } : {}),
          reason: i.reason,
        },
      },
    );
    await appendEvent(
      ctx.db,
      { orgId: org.id },
      {
        type: "org.installation_claim_started_by_instance",
        payload: {
          github_login: i.github_login,
          reason: i.reason,
          installation_pinned: pinned,
          by: ctx.principal.id,
          expires_at: iso(r.expiresAt),
        },
      },
    );
    return { url: r.url, expires_at: r.expiresAt };
  },
});

const INSTALLATION_HELD = "that installation is already connected to an org";

export const instanceBindInstallationOp = defineOp({
  name: "instance_bind_installation",
  summary:
    "Bind a GitHub App installation to an org when its owner cannot claim it (instance administrator only).",
  description:
    "Binds the installation `installation_id` to `target_org` exactly as a successful claim " +
    "does, including the repo sync, without the owner's GitHub sign-in. It is the operator " +
    "fallback when a claim cannot prove ownership (the App cannot read org membership and no " +
    "installer was recorded). The installation is looked up through the App: it must exist and " +
    "not be suspended, and its GitHub account login must equal `expected_account` " +
    "(case-insensitive), so a mistyped id binds nothing. Refused, with one message that names no " +
    "other org, when another org holds it. `reason` is required and kept in the audit. Audited " +
    "in the system org's chain and in the target org's own with the installation id, the " +
    "account login and the reason, and the org's feed gets an " +
    "`org.installation_bound_by_instance` event. The system org is never a target. Only the " +
    "instance administrator can call it. Not an MCP tool.",
  input: z.object({
    installation_id: z.string().regex(/^\d{1,20}$/),
    target_org: z.string().min(1).max(64).describe("Slug of the target org."),
    expected_account: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,39}$/)
      .describe("The GitHub account login the installation must be on."),
    reason: z.string().min(1).max(500).describe("Why the operator binds it. Kept in the audit."),
  }),
  output: z.object({
    installation_id: z.string(),
    account_login: z.string(),
    target_org: z.string(),
    bound: z.array(z.string()).describe("The repos bound by the sync, as owner/name."),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/installation-bindings" },
  mcp: false,
  // It calls GitHub: it must not hold the database's write lock meanwhile.
  outsideTransaction: true,
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such org");
    if (!ctx.githubFacts) {
      throw new OpError("unavailable", "installations are not configured on this instance");
    }
    let facts;
    try {
      facts = await ctx.githubFacts.getInstallation(i.installation_id);
    } catch (e) {
      throw new OpError(
        "unavailable",
        e instanceof Error ? e.message : "could not read the installation",
      );
    }
    if (!facts) throw new OpError("not_found", "GitHub does not know that installation");
    if (facts.suspended) throw new OpError("conflict", "that installation is suspended");
    if (facts.account.login.toLowerCase() !== i.expected_account.toLowerCase()) {
      throw new OpError("conflict", "that installation is not on the expected GitHub account");
    }
    const held = await getInstallation(ctx.db, i.installation_id);
    if (held && held.orgId !== org.id) throw new OpError("conflict", INSTALLATION_HELD);
    let r;
    try {
      r = await syncInstallation(ctx.db, ctx.githubFacts, i.installation_id, {
        claimedBy: org.id,
      });
    } catch (e) {
      if (e instanceof Error && e.message.includes("already claimed by another org")) {
        throw new OpError("conflict", INSTALLATION_HELD);
      }
      throw new OpError(
        "unavailable",
        e instanceof Error ? e.message : "could not bind the installation",
      );
    }
    if (r.outcome === "unknown" || r.outcome === "deleted") {
      throw new OpError("not_found", "GitHub does not know that installation");
    }
    // The system chain gets the dispatcher's entry; the org's own chain and feed say it too.
    await ctx.db.transaction(async (tx) => {
      await appendAudit(
        tx,
        { orgId: org.id },
        {
          principalKind: "instance",
          principalId: ctx.principal.id,
          op: "instance_bind_installation",
          effect: "write",
          outcome: "ok",
          input: {
            target_org: org.slug,
            installation_id: i.installation_id,
            account_login: facts.account.login,
            reason: i.reason,
          },
        },
      );
      await appendEvent(
        tx,
        { orgId: org.id },
        {
          type: "org.installation_bound_by_instance",
          payload: { installation_id: i.installation_id, account_login: facts.account.login },
        },
      );
    });
    return {
      installation_id: i.installation_id,
      account_login: facts.account.login,
      target_org: org.slug,
      bound: r.bound,
    };
  },
});

export const instancePruneUnconfiguredProjectsOp = defineOp({
  name: "instance_prune_unconfigured_projects",
  summary:
    "List or delete the projects an installation sync made that nobody set up (instance administrator only).",
  description:
    "Before #577 an installation sync made a project for every repository the installation could " +
    "reach. This lists, and with `dry_run: false` deletes, the projects of `target_org` that " +
    "were made that way and never set up: never added on purpose, bound (or once bound) through " +
    "an installation, zero runs, every setting at its default (paused is the sync's default), no " +
    "static poll entry naming it, no onboarding row, and no token, secret or other row scoped to " +
    "it. A project with any of those is never listed. A dry run returns the list and its count. A " +
    "non-dry run needs `expected_count`, the count of that dry run, and refuses (conflict, " +
    "nothing deleted) when the list now has a different count. Each deletion is audited with " +
    "the project's slug and repos in the system chain and in the org's chain. The system org is " +
    "never a target. Only the instance administrator can call it. Not an MCP tool.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the org to prune."),
    dry_run: z.boolean().describe("True lists only. False deletes the listed projects."),
    expected_count: z
      .int()
      .min(0)
      .max(100_000)
      .optional()
      .describe("Required when dry_run is false: the count the dry run returned."),
  }),
  output: z.object({
    target_org: z.string(),
    dry_run: z.boolean(),
    count: z.int().describe("Projects listed (a dry run) or deleted."),
    projects: z.array(z.object({ slug: z.string(), repos: z.array(z.string()) })),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/prune-unconfigured-projects" },
  mcp: false,
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such org");
    if (!i.dry_run && i.expected_count === undefined) {
      throw new OpError("invalid_input", "expected_count is required when dry_run is false");
    }
    const prefix = staticPollKey(org.slug, "");
    const staticPollSlugs = new Set(
      (ctx.staticPollProjects ?? [])
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length)),
    );
    const list = await listPruneCandidates(ctx.db, { orgId: org.id }, { staticPollSlugs });
    const view = list.map((p) => ({ slug: p.slug, repos: p.repos }));
    if (i.dry_run) {
      return { target_org: org.slug, dry_run: true, count: list.length, projects: view };
    }
    if (list.length !== i.expected_count) {
      throw new OpError(
        "conflict",
        `the list changed: ${list.length} projects qualify now, not ${i.expected_count}; run a dry run again`,
        { count: list.length },
      );
    }
    const system = { orgId: await systemOrgId(ctx.db) };
    for (const p of list) {
      if (!(await deleteProjectCascade(ctx.db, { orgId: org.id }, p.id))) continue;
      const entry = {
        principalKind: "instance" as const,
        principalId: ctx.principal.id,
        op: "instance_prune_unconfigured_projects",
        effect: "write" as const,
        outcome: "ok",
        input: { target_org: org.slug, project: p.slug, repos: p.repos, project_id: p.id },
      };
      await appendAudit(ctx.db, { orgId: org.id }, entry);
      await appendAudit(ctx.db, system, entry);
    }
    return { target_org: org.slug, dry_run: false, count: list.length, projects: view };
  },
});

export const instanceDoctorOp = defineOp({
  name: "instance_doctor",
  summary: "The instance's readiness report, for the instance administrator.",
  description:
    "Runs the same read-only readiness checks as `turntable doctor` (master key and audit " +
    "anchor, database and migrations, GitHub App credentials, sandbox provider, proxy TLS, " +
    "forwarded headers, release channel, quotas) and returns each check's id, area, status " +
    "(pass, warn or fail), a fixed one-line summary and a fixed fix. It never returns raw error " +
    "text or a secret value. Use it on a hosted instance with no shell, for example to confirm " +
    "a master-key rotation before removing the previous key. Only the instance administrator " +
    "can call it. Read-only. Not an MCP tool.",
  input: z.object({}),
  output: doctorOutput,
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/doctor" },
  mcp: false,
  async handler(ctx) {
    return doctorForApi(ctx.doctor);
  },
});

/** The most anchor bodies one call takes. */
export const AUDIT_VERIFY_MAX_ANCHORS = 1000;

const VERDICT_SENTENCE = {
  ok: "Every anchor matches the chain and carries a valid signature.",
  rolled_back:
    "The chain ends behind a signed anchor: entries were removed or the database was restored from an older copy.",
  mismatch:
    "The chain or an anchor does not check out: a hash or a signature disagrees, or the org has no audit chain.",
} as const;

const anchorBody = {
  org_id: z.string().min(1).max(64),
  sequence: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  head_hash: z.string().min(1).max(128),
  time: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  signature: z.string().min(1).max(512),
};

export const instanceAuditVerifyOp = defineOp({
  name: "instance_audit_verify",
  summary: "Check orgs' audit chains against exported anchors, for the instance administrator.",
  description:
    "Takes anchor bodies exported from the audit export sink (v2: `{version: 2, org_id, sequence, " +
    "head_hash, time, key_id, signature}`, up to 1000; a keyless `version: 1` body is accepted only " +
    "at or before the org's v2 cutover) and, per org, walks its audit chain and checks each " +
    "anchor's signature, under the key its `key_id` names and no other, and its hash. The result per org is `ok`, `rolled_back` (the chain ends behind " +
    "a validly signed anchor) or `mismatch` (a hash or signature disagrees, the chain is broken, " +
    "or the org is unknown), with a fixed sentence and never a raw error; `reasons` classifies a refused anchor " +
    "(`unknown_key`: the key id is not a trusted key of the org; `keyless_after_cutover`). Signatures are checked " +
    "under the org's audit key from the secret store: for a key pinned outside the server use " +
    "`turntable audit verify --pubkey`. Only the instance administrator can call it. Read-only. " +
    "Not an MCP tool.",
  input: z.object({
    anchors: z
      .array(
        z.discriminatedUnion("version", [
          z.object({ ...anchorBody, version: z.literal(1) }),
          z.object({ ...anchorBody, version: z.literal(2), key_id: z.string().min(1).max(128) }),
        ]),
      )
      .min(1)
      .max(AUDIT_VERIFY_MAX_ANCHORS)
      .describe("Exported anchor bodies; time is the signing time in epoch milliseconds."),
  }),
  output: z.object({
    orgs: z.array(
      z.object({
        org_id: z.string(),
        result: z.enum(["ok", "rolled_back", "mismatch"]),
        anchors: z.int(),
        message: z.string(),
        reasons: z.array(z.enum(["unknown_key", "keyless_after_cutover"])),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/audit-verify" },
  mcp: false,
  async handler(ctx, i) {
    const store = ctx.auditStore;
    if (!store) {
      throw new OpError(
        "unavailable",
        "audit keys are not available: start the server with TURNTABLE_MASTER_KEY_FILE",
      );
    }
    const byOrg = new Map<string, AnchorCheckpoint[]>();
    for (const a of i.anchors) {
      const list = byOrg.get(a.org_id) ?? [];
      // A v2 body names its key and is checked under it alone; a keyless v1 body is tried under
      // every trusted key, and only before the org's v2 cutover.
      list.push({
        orgId: a.org_id,
        seq: a.sequence,
        hash: a.head_hash,
        signedAt: a.time,
        keyId: a.version === 2 ? a.key_id : "",
        signature: a.signature,
      });
      byOrg.set(a.org_id, list);
    }
    const orgs: {
      org_id: string;
      result: keyof typeof VERDICT_SENTENCE;
      anchors: number;
      message: string;
      reasons: AnchorRefusal[];
    }[] = [];
    for (const [orgId, anchors] of byOrg) {
      let result: keyof typeof VERDICT_SENTENCE = "mismatch";
      const reasons = new Set<AnchorRefusal>();
      if (await getOrgById(ctx.db, orgId)) {
        const key = await loadAuditKey(store, orgId).catch(() => undefined);
        const keys = new Map(key ? [[key.keyId, key.publicKeyPem]] : []);
        const cutover = await anchorCutoverSeq(ctx.db, orgId, anchors);
        for (const an of anchors) {
          const r = anchorRefusal(an, keys, cutover);
          if (r) reasons.add(r);
        }
        result = await verifyAnchors(ctx.db, orgId, keys, anchors);
      }
      orgs.push({
        org_id: orgId,
        result,
        anchors: anchors.length,
        message: VERDICT_SENTENCE[result],
        reasons: [...reasons],
      });
    }
    // The dispatcher writes nothing for a read, so the call is recorded here, in the system chain.
    await appendAudit(
      ctx.db,
      { orgId: await systemOrgId(ctx.db) },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "instance_audit_verify",
        effect: "read",
        outcome: "ok",
        input: {
          anchors: i.anchors.length,
          results: Object.fromEntries(orgs.map((o) => [o.org_id, o.result])),
        },
      },
    );
    return { orgs };
  },
});

export const bootstrapApprover = defineOp({
  name: "bootstrap_approver",
  summary:
    "Enrol an org's first approver from an offline ed25519 public key (instance administrator only).",
  description:
    "The hosted counterpart of `turntable approvals bootstrap`, for an instance with no shell. " +
    "Takes the target org, the person's name and forge login, and an ed25519 public key generated " +
    "offline (`turntable approvals keygen`); the private key never reaches the server. Works only " +
    "while the org has no active approver and never adds to an existing set: after that, new keys " +
    "need a quorum of existing approvers (request_enrolment and approve_enrolment), and the " +
    "bootstrap key signs the passkey's enrolment as usual. An org whose approvers were all revoked " +
    "can be bootstrapped again only after the `approver_rebootstrap_delay_hours` setting (24 by " +
    "default, at least 1) has passed since the last revocation, so a stolen token cannot revoke " +
    "every approver and enrol its own key at once; the refusal says when. The forge login is resolved to its numeric GitHub id through the App (refused if it cannot be), which web step-up matches on. Revoking the last " +
    "approver and every bootstrap emit an event (`approvers.depleted`, `approver.bootstrapped`) " +
    "that outbound webhooks can carry. Returns the approver id and the key's " +
    "fingerprint. The change is audited in the system org's chain and in the target org's own, " +
    "with the fingerprint and never the key. Only the instance administrator can call it: an " +
    "org's own tokens, of any role, never can. Not an MCP tool.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the org that gets its first approver."),
    person: z.string().trim().min(1).max(200).describe("A name for the human who holds the key."),
    forge_login: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe("Their forge login, which an approval is checked against the run's author with."),
    public_key: z
      .string()
      .min(1)
      .max(4096)
      .describe("The ed25519 public key (SPKI PEM or base64)."),
  }),
  output: z.object({
    approver_id: z.string(),
    person: z.string(),
    key_fingerprint: z.string(),
    warnings: z.array(z.string()),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/approvers/bootstrap" },
  mcp: false,
  // Only the public key's fingerprint is audited, never the key text itself.
  logOmitFields: ["public_key"],
  auditDetail: (o) => ({ approver_id: o.approver_id, key_fingerprint: o.key_fingerprint }),
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such org");
    const rt = ctx.settings ?? createSettingsRuntime(settingsRegistry);
    const hours = (
      await resolveSetting(rt, ctx.db, "approver_rebootstrap_delay_hours", {
        orgId: org.id,
        orgSlug: org.slug,
      })
    ).value as number;
    // Resolve the login to its numeric id through the App first; a failed lookup refuses.
    const githubUserId = await resolveGithubUserId(ctx.githubUsers, i.forge_login);
    let made: { id: string; person: string; fingerprint: string };
    try {
      made = await bootstrapFirstApprover(
        ctx.db,
        org.id,
        {
          person: i.person,
          forgeLogin: i.forge_login,
          githubUserId,
          publicKey: i.public_key,
          createdBy: `instance:${ctx.principal.id}`,
        },
        ctx.now(),
        { delayMs: hours * 3_600_000 },
      );
    } catch (e) {
      if (e instanceof ApprovalConflict) throw new OpError("conflict", e.message);
      if (e instanceof OpError) throw e;
      throw new OpError("invalid_input", "public_key is not a valid ed25519 public key");
    }
    // The org's own chain says it too: its operators should see how their first approver came.
    await appendAudit(
      ctx.db,
      { orgId: org.id },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "bootstrap_approver",
        effect: "write",
        outcome: "ok",
        input: {
          target_org: org.slug,
          person: made.person,
          forge_login: i.forge_login,
          approver_id: made.id,
          key_fingerprint: made.fingerprint,
        },
      },
    );
    return {
      approver_id: made.id,
      person: made.person,
      key_fingerprint: made.fingerprint,
      warnings: await approvalWarnings(ctx.db, org.id, ["production", "release"]),
    };
  },
});

const drainOutput = z.object({
  draining: z.boolean(),
  running_attempts: z.int().describe("Attempts running right now, across the instance."),
  since: z.string().nullable().describe("When the drain started (ISO 8601), or null."),
  running_by_mode: z
    .object({
      live: z.int().describe("Running attempts of projects whose checks mode is live."),
      shadow: z.int().describe("Running attempts of projects whose checks mode is shadow or off."),
    })
    .describe("`running_attempts` split by the project's checks mode."),
  shadow_mode: z
    .enum(["wait", "cancel", "cut_branches"])
    .describe("What this drain does with shadow attempts: wait for them or cut them."),
  shadow_cut: z.int().describe("Shadow attempts cut since this drain began."),
  running_by_adoption: z
    .object({
      adoptable: z
        .int()
        .describe(
          "Running attempts the next controller can re-attach to: act runs in a live sandbox and " +
            "the attempt holds no credential only this process has (secrets proxy, artifact credential, job token). A restart hands them off.",
        ),
      not_adoptable: z
        .int()
        .describe(
          "Running attempts a restart would cut: still claiming, creating the sandbox or uploading " +
            "the checkout, or behind the secrets proxy, or holding an artifact credential or a job token. A crash still re-attaches to those whose exec runs.",
        ),
    })
    .describe(
      "`running_attempts` split by whether a restart can hand them off (#761). A deploy waits " +
        "only for `not_adoptable` to be 0.",
    ),
});

async function drainView(ctx: {
  db: Db;
  settings?: SettingsRuntime | undefined;
}): Promise<z.infer<typeof drainOutput>> {
  const snap = processDrain.snapshot();
  return {
    draining: snap.draining,
    running_attempts: await countRunning(ctx.db),
    since: iso(snap.since),
    // The effective mode, so a turntable.toml or environment lock on checks_mode is counted.
    running_by_mode: await countRunningByMode(ctx.db, (orgId, projectId) =>
      effectiveChecksMode(ctx.settings, ctx.db, orgId, projectId),
    ),
    shadow_mode: processDrain.shadowMode,
    shadow_cut: processDrain.shadowCut,
    running_by_adoption: await countRunningByAdoptability(ctx.db).then((c) => ({
      adoptable: c.adoptable,
      not_adoptable: c.notAdoptable,
    })),
  };
}

export const instanceDrainOp = defineOp({
  name: "instance_drain",
  summary:
    "Stop starting new attempts so a deploy does not cut running jobs (instance administrator).",
  description:
    "With on=true the scheduler of this server process starts no new attempt: queued work stays " +
    "queued in the database and running attempts finish. Poll `instance_drain_status` (or " +
    "`/healthz`) until `running_attempts` is 0, deploy, and the new instance boots undrained and " +
    "resumes the queue. on=false resumes claiming without a restart. The drain is held in memory " +
    "and is never persisted, so a restart always ends it. It covers this process: run the worker " +
    "role in the same process as the web role (the default), or drain each worker process. " +
    "Turning it on twice keeps the first time. With shadow=cancel, running attempts of projects " +
    "whose checks mode is shadow or off are stopped now as infrastructure cuts and their jobs " +
    "requeued once (never a job failure, no failed check); live projects are still waited for. " +
    "With shadow=cut_branches, attempts on a ref other than the project's default branch are cut " +
    "(they end cancelled, labelled as cancelled by deploy drain) and default-branch push attempts " +
    "with no step started are requeued with no rerun used, on every drain; one whose steps have " +
    "started is waited for, never cut. " +
    "The reason is kept in the system audit chain. " +
    "Only the instance administrator can call it. Not an MCP tool.",
  input: z.object({
    on: z.boolean().describe("true starts the drain, false ends it."),
    reason: z.string().trim().min(3).max(500).describe("Why. Kept in the audit."),
    shadow: z
      .enum(["wait", "cancel", "cut_branches"])
      .optional()
      .describe(
        "What to do with running attempts of projects whose checks mode is not live (shadow or " +
          "off), which gate nothing. wait (default) lets them finish; cancel stops each one now " +
          "as an infrastructure cut and requeues its job once; cut_branches cuts attempts on any ref " +
          "but the project's default branch (cancelled, labelled cancelled by deploy drain) and " +
          "requeues default-branch push attempts that have started no step, with no rerun used and no once limit " +
          "(one with steps started is waited for). Live projects' attempts are " +
          "always waited for. Only meaningful with on=true. Each call sets it explicitly: omitted means wait, even if an earlier call set cancel.",
      ),
  }),
  output: drainOutput,
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/drain" },
  mcp: false,
  auditDetail: (o) => ({
    draining: o.draining,
    running_attempts: o.running_attempts,
    shadow_mode: o.shadow_mode,
    shadow_cut: o.shadow_cut,
  }),
  async handler(ctx, i) {
    processDrain.set(i.on, i.reason, ctx.now());
    if (i.on) await processDrain.applyShadow(i.shadow ?? "wait");
    return drainView(ctx);
  },
});

export const instanceDrainStatusOp = defineOp({
  name: "instance_drain_status",
  summary: "Whether this instance is draining and how many attempts still run.",
  description:
    "Returns `draining`, `running_attempts` (across the instance, split in `running_by_mode` into " +
    "live and shadow), `since`, `shadow_mode` and `shadow_cut` (attempts cut since the drain began). " +
    "`running_by_adoption` splits them into `adoptable` (a restart hands them to the next boot, " +
    "which re-attaches) and `not_adoptable`. A deploy script " +
    "waits for `running_by_adoption.not_adoptable` to be 0 after `instance_drain` (or for " +
    "`running_attempts` to be 0 to wait for every job). Only the instance " +
    "administrator can call it. Read-only. Not an MCP tool.",
  input: z.object({}),
  output: drainOutput,
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/drain" },
  mcp: false,
  async handler(ctx) {
    return drainView(ctx);
  },
});

const activityCounts = z.object({
  queued: z.int(),
  running: z.int(),
  awaiting_approval: z.int().describe("Held for an approval."),
});

export const instanceRunActivityOp = defineOp({
  name: "instance_run_activity",
  summary: "Counts of runs, jobs and running attempts per org, for a deploy check.",
  description:
    "Per org: the slug, runs and jobs by state (queued, running, awaiting_approval), running " +
    "attempts and the start time of the oldest running attempt, with instance totals. Counts " +
    "only: no run ids, refs, shas, workflow names, logs or repo names. Use it to find a quiet " +
    "window before a deploy, with no tenant token. The read is audited in the system chain. Only " +
    "the instance administrator can call it. Read-only. Not an MCP tool.",
  input: z.object({}),
  output: z.object({
    orgs: z.array(
      z.object({
        org: z.string(),
        runs: activityCounts,
        jobs: activityCounts,
        running_attempts: z.int(),
        oldest_running_started_at: z.string().nullable(),
        queued_by_reason: z
          .record(z.string(), z.int())
          .describe(
            "Queued attempts by why they wait (needs, project_cap, org_cap, instance_cap, quota:<metric>, yield, drain, claimable; unknown before a claim pass has looked), with jobs held for an approval counted as approval. Omits reasons with no attempt.",
          ),
      }),
    ),
    total_running_attempts: z.int(),
    orgs_with_running_attempts: z.int(),
  }),
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/run-activity" },
  mcp: false,
  async handler(ctx) {
    const [orgs, activity] = await Promise.all([listAllOrgs(ctx.db), instanceRunActivity(ctx.db)]);
    const byOrg = new Map(activity.map((a) => [a.orgId, a]));
    const count = (m: Record<string, number> | undefined) => ({
      queued: m?.queued ?? 0,
      running: m?.running ?? 0,
      awaiting_approval: m?.awaiting_approval ?? 0,
    });
    const rows = orgs
      .filter((o) => o.slug !== SYSTEM_ORG_SLUG)
      .map((o) => {
        const a = byOrg.get(o.id);
        return {
          org: o.slug,
          runs: count(a?.runs),
          jobs: count(a?.jobs),
          running_attempts: a?.runningAttempts ?? 0,
          oldest_running_started_at: iso(a?.oldestRunningStartedAt),
          queued_by_reason: a?.queuedByReason ?? {},
        };
      });
    const total = rows.reduce((n, r) => n + r.running_attempts, 0);
    await appendAudit(
      ctx.db,
      { orgId: await systemOrgId(ctx.db) },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "instance_run_activity",
        effect: "read",
        outcome: "ok",
        input: { orgs: rows.length, running_attempts: total },
      },
    );
    return {
      orgs: rows,
      total_running_attempts: total,
      orgs_with_running_attempts: rows.filter((r) => r.running_attempts > 0).length,
    };
  },
});

const SUMMARY_MAX_MS = 7 * 86_400_000;
const SUMMARY_DEFAULT_MS = 86_400_000;
const DURATION_UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `since` as an epoch ms: a duration back from now (`90m`, `24h`, `7d`) or an ISO 8601 time. */
function parseSummarySince(raw: string | undefined, now: number): number {
  if (raw === undefined) return now - SUMMARY_DEFAULT_MS;
  const d = /^(\d{1,6})([smhd])$/.exec(raw.trim());
  const at = d ? now - Number(d[1]) * DURATION_UNIT_MS[d[2]!]! : Date.parse(raw);
  if (Number.isNaN(at)) {
    throw new OpError("invalid_input", "since is an ISO 8601 time or a duration like 24h or 2d");
  }
  if (at < now - SUMMARY_MAX_MS) {
    throw new OpError(
      "invalid_input",
      "since reaches back more than 7 days; the window is at most 7 days",
    );
  }
  return Math.min(at, now);
}

const countMap = z.record(z.string(), z.int());
const runSummaryCell = z.object({
  runs: z.object({
    total: z.int(),
    by_trigger: z.object({
      push: z.int(),
      pull_request: z.int(),
      merge_group: z.int(),
      workflow_dispatch: z.int(),
      tag: z.int(),
      other: z.int(),
    }),
    by_conclusion: z.object({
      success: z.int(),
      failure: z.int(),
      infra_error: z.int(),
      cancelled: z.int(),
      skipped: z.int(),
      awaiting_approval: z.int(),
      running: z.int(),
      queued: z.int(),
    }),
  }),
  jobs: z.object({
    queued: z.int(),
    running: z.int(),
    success: z.int(),
    failure: z.int(),
    infra_error: z.int(),
    awaiting_approval: z.int(),
    cancelled: z.int(),
    skipped: z.int(),
  }),
  infra_kinds: countMap.describe(
    "Failed attempts by recorded infra kind (`unknown` when none was recorded).",
  ),
  sandbox_minutes: z.number(),
  newest_run_at: z.string().nullable(),
  newest_run_conclusion: z.string().nullable(),
});
type RunSummaryOut = z.infer<typeof runSummaryCell>;

const pickCounts = <K extends string>(keys: readonly K[], m: Record<string, number>) =>
  Object.fromEntries(keys.map((k) => [k, m[k] ?? 0])) as Record<K, number>;

function summaryCell(cells: RunSummaryCell[]): RunSummaryOut {
  const sum = (pick: (c: RunSummaryCell) => Record<string, number>) => {
    const m: Record<string, number> = {};
    for (const c of cells) for (const [k, v] of Object.entries(pick(c))) m[k] = (m[k] ?? 0) + v;
    return m;
  };
  const trig = sum((c) => c.runsByTrigger);
  const concl = sum((c) => c.runsByConclusion);
  const newest = cells.reduce<RunSummaryCell | undefined>(
    (b, c) =>
      c.newestRunAt !== null && (b === undefined || c.newestRunAt > b.newestRunAt!) ? c : b,
    undefined,
  );
  const ms = cells.reduce((n, c) => n + c.sandboxMs, 0);
  return {
    runs: {
      total: Object.values(concl).reduce((n, v) => n + v, 0),
      by_trigger: pickCounts(RUN_TRIGGERS, trig),
      by_conclusion: pickCounts(
        [
          "success",
          "failure",
          "infra_error",
          "cancelled",
          "skipped",
          "awaiting_approval",
          "running",
          "queued",
        ],
        concl,
      ),
    },
    jobs: pickCounts(
      [
        "queued",
        "running",
        "success",
        "failure",
        "infra_error",
        "awaiting_approval",
        "cancelled",
        "skipped",
      ],
      sum((c) => c.jobsByState),
    ),
    infra_kinds: sum((c) => c.infraKinds),
    sandbox_minutes: Math.round(ms / 60) / 1000,
    newest_run_at: iso(newest?.newestRunAt),
    newest_run_conclusion: newest?.newestRunConclusion ?? null,
  };
}

export const instanceRunSummaryOp = defineOp({
  name: "instance_run_summary",
  summary: "Counts of finished runs by trigger and conclusion, per org and project, for operators.",
  description:
    "Per org and project over a window (`since`: an ISO 8601 time or a duration like `24h`; " +
    "default 24 hours, at most 7 days): runs by trigger (push, pull_request, merge_group, " +
    "workflow_dispatch, tag, other) and by conclusion (success, failure, infra_error, cancelled, " +
    "skipped, awaiting_approval, running, queued), jobs by state, the recorded infra kinds of " +
    "failed attempts, sandbox minutes, and the time and conclusion of the newest run. Narrow it " +
    "with `target_org` and `target_project` (slugs). Counts only: no shas, branches, job names, " +
    "logs or ids. Use it to see whether an org's CI is working, with no tenant token. The read " +
    "is audited in the system chain. Only the instance administrator can call it. Read-only. " +
    "Not an MCP tool.",
  input: z.object({
    since: z
      .string()
      .max(40)
      .optional()
      .describe(
        "ISO 8601 time or a duration such as 24h, 90m or 2d. Default 24h; at most 7 days back.",
      ),
    target_org: z.string().max(100).optional().describe("Only this org (slug)."),
    target_project: z
      .string()
      .max(100)
      .optional()
      .describe("Only this project (slug); needs target_org."),
  }),
  output: z.object({
    since: z.string(),
    until: z.string(),
    orgs: z.array(
      runSummaryCell.extend({
        org: z.string(),
        projects: z.array(runSummaryCell.extend({ project: z.string() })),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/run-summary" },
  mcp: false,
  async handler(ctx, i) {
    const now = ctx.now();
    const since = parseSummarySince(i.since, now);
    if (i.target_project !== undefined && i.target_org === undefined) {
      throw new OpError("invalid_input", "target_project needs target_org");
    }
    let orgs = (await listAllOrgs(ctx.db)).filter((o) => o.slug !== SYSTEM_ORG_SLUG);
    let projectId: string | undefined;
    if (i.target_org !== undefined) {
      orgs = orgs.filter((o) => o.slug === i.target_org);
      if (orgs.length === 0) throw new OpError("not_found", "no such org");
      if (i.target_project !== undefined) {
        const p = await getProjectBySlug(ctx.db, { orgId: orgs[0]!.id }, i.target_project);
        if (!p) throw new OpError("not_found", "no such project");
        projectId = p.id;
      }
    }
    const [cells, projects] = await Promise.all([
      instanceRunSummary(ctx.db, since, now, {
        orgId: orgs.length === 1 && i.target_org !== undefined ? orgs[0]!.id : undefined,
        projectId,
      }),
      Promise.all(orgs.map((o) => listProjects(ctx.db, { orgId: o.id }))),
    ]);
    const rows = orgs.map((o, ix) => {
      const mine = cells.filter((c) => c.orgId === o.id);
      return {
        org: o.slug,
        ...summaryCell(mine),
        projects: projects[ix]!.filter((p) => projectId === undefined || p.id === projectId).map(
          (p) => ({
            project: p.slug,
            ...summaryCell(mine.filter((c) => c.projectId === p.id)),
          }),
        ),
      };
    });
    await appendAudit(
      ctx.db,
      { orgId: await systemOrgId(ctx.db) },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "instance_run_summary",
        effect: "read",
        outcome: "ok",
        input: {
          orgs: rows.length,
          window_ms: now - since,
          filtered: i.target_org !== undefined,
        },
      },
    );
    return { since: new Date(since).toISOString(), until: new Date(now).toISOString(), orgs: rows };
  },
});

export { sanitizeInfraError };

export const instanceInfraErrorsOp = defineOp({
  name: "instance_infra_errors",
  summary:
    "Recent infra_error attempts across orgs, with a sanitized error message, for operators.",
  description:
    "Recent attempts that ended `infra_error`, newest first, over a window (`since`: an ISO 8601 " +
    "time or a duration like 24h; default 24 hours, at most 7 days). Each row has the org and " +
    "project slug, run id, job key, attempt number, infra kind (`unknown` when none was " +
    "recorded), the error text sanitized (secrets and tokens redacted, URL credentials, query " +
    "strings and fragments removed, at most 500 characters), the underlying error's name and code " +
    "when recorded (`error_name`, `error_code`) and timestamps. Never log or job " +
    "output. Narrow it with `target_org`, `target_project` (needs target_org) and `run_id`. Use " +
    "it to diagnose an infra error with no tenant token. The read is audited in the system " +
    "chain. Only the instance administrator can call it. Read-only. Not an MCP tool.",
  input: z.object({
    since: z
      .string()
      .max(40)
      .optional()
      .describe("ISO 8601 time or a duration such as 24h or 2d. Default 24h; at most 7 days back."),
    target_org: z.string().max(100).optional().describe("Only this org (slug)."),
    target_project: z
      .string()
      .max(100)
      .optional()
      .describe("Only this project (slug); needs target_org."),
    run_id: z.string().max(100).optional().describe("Only this run."),
    limit: z.int().min(1).max(200).optional().describe("At most this many rows. Default 50."),
  }),
  output: z.object({
    since: z.string(),
    until: z.string(),
    errors: z.array(
      z.object({
        org: z.string(),
        project: z.string(),
        run_id: z.string(),
        job_key: z.string(),
        attempt: z.int(),
        infra_kind: z.string(),
        error_class: z.string(),
        error_name: z.string().nullable(),
        error_code: z.string().nullable(),
        created_at: z.string(),
        started_at: z.string().nullable(),
        finished_at: z.string().nullable(),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/instance/infra-errors" },
  mcp: false,
  async handler(ctx, i) {
    const now = ctx.now();
    const since = parseSummarySince(i.since, now);
    if (i.target_project !== undefined && i.target_org === undefined) {
      throw new OpError("invalid_input", "target_project needs target_org");
    }
    const orgs = (await listAllOrgs(ctx.db)).filter((o) => o.slug !== SYSTEM_ORG_SLUG);
    let orgId: string | undefined;
    let projectId: string | undefined;
    if (i.target_org !== undefined) {
      const o = orgs.find((x) => x.slug === i.target_org);
      if (!o) throw new OpError("not_found", "no such org");
      orgId = o.id;
      if (i.target_project !== undefined) {
        const p = await getProjectBySlug(ctx.db, { orgId: o.id }, i.target_project);
        if (!p) throw new OpError("not_found", "no such project");
        projectId = p.id;
      }
    }
    const rows = await instanceInfraErrors(
      ctx.db,
      since,
      { orgId, projectId, runId: i.run_id },
      i.limit ?? 50,
    );
    const orgSlug = new Map(orgs.map((o) => [o.id, o.slug]));
    const projectSlugs = new Map<string, string>();
    for (const id of new Set(rows.map((r) => r.orgId))) {
      for (const p of await listProjects(ctx.db, { orgId: id })) projectSlugs.set(p.id, p.slug);
    }
    const iso = (t: number | null): string | null =>
      t === null ? null : new Date(t).toISOString();
    const errors = rows
      .filter((r) => orgSlug.has(r.orgId))
      .map((r) => ({
        org: orgSlug.get(r.orgId)!,
        project: projectSlugs.get(r.projectId) ?? "",
        run_id: r.runId,
        job_key: r.jobKey,
        attempt: r.attempt,
        infra_kind: r.infraKind ?? "unknown",
        error_class: sanitizeInfraError(r.errorClass),
        error_name: r.errorName === null ? null : sanitizeInfraError(r.errorName).slice(0, 60),
        error_code: r.errorCode === null ? null : sanitizeInfraError(r.errorCode).slice(0, 60),
        created_at: new Date(r.createdAt).toISOString(),
        started_at: iso(r.startedAt),
        finished_at: iso(r.finishedAt),
      }));
    await appendAudit(
      ctx.db,
      { orgId: await systemOrgId(ctx.db) },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "instance_infra_errors",
        effect: "read",
        outcome: "ok",
        input: {
          rows: errors.length,
          window_ms: now - since,
          filtered: i.target_org !== undefined || i.run_id !== undefined,
        },
      },
    );
    return { since: new Date(since).toISOString(), until: new Date(now).toISOString(), errors };
  },
});

export const instanceOrgSummaryOp = defineOp({
  name: "instance_org_summary",
  summary: "Counts of tokens, approvers, members and pending invites per org.",
  description:
    "Per org: the slug, active tokens and how many expire within 7 days, approvers (active, " +
    "revoked, and how many active ones lack a GitHub account id and so must re-enrol for " +
    "passkey step-up), members by role and pending invites, with instance totals. Counts only: " +
    "no token, approver or member ids, names, logins, GitHub ids or key material. Use it to see " +
    "an org's identity state with no tenant token. The read is audited in the system chain. " +
    "Only the instance administrator can call it. Read-only. Not an MCP tool.",
  input: z.object({}),
  output: z.object({
    orgs: z.array(
      z.object({
        org: z.string(),
        tokens: z.object({
          active: z.int(),
          expiring_within_7_days: z.int(),
        }),
        approvers: z.object({
          active: z.int(),
          revoked: z.int(),
          active_missing_github_user_id: z.int(),
        }),
        members: z.object({
          owner: z.int(),
          admin: z.int(),
          member: z.int(),
          viewer: z.int(),
        }),
        pending_invites: z.int(),
      }),
    ),
    totals: z.object({
      orgs: z.int(),
      active_tokens: z.int(),
      active_approvers: z.int(),
      active_approvers_missing_github_user_id: z.int(),
      members: z.int(),
      pending_invites: z.int(),
    }),
  }),
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/org-summary" },
  mcp: false,
  async handler(ctx) {
    const [orgs, summary] = await Promise.all([
      listAllOrgs(ctx.db),
      instanceOrgSummary(ctx.db, ctx.now()),
    ]);
    const byOrg = new Map(summary.map((x) => [x.orgId, x]));
    const rows = orgs
      .filter((o) => o.slug !== SYSTEM_ORG_SLUG)
      .map((o) => {
        const x = byOrg.get(o.id);
        return {
          org: o.slug,
          tokens: {
            active: x?.tokensActive ?? 0,
            expiring_within_7_days: x?.tokensExpiringSoon ?? 0,
          },
          approvers: {
            active: x?.approversActive ?? 0,
            revoked: x?.approversRevoked ?? 0,
            active_missing_github_user_id: x?.approversMissingGithubId ?? 0,
          },
          members: {
            owner: x?.members.owner ?? 0,
            admin: x?.members.admin ?? 0,
            member: x?.members.member ?? 0,
            viewer: x?.members.viewer ?? 0,
          },
          pending_invites: x?.pendingInvites ?? 0,
        };
      });
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + f(r), 0);
    const totals = {
      orgs: rows.length,
      active_tokens: sum((r) => r.tokens.active),
      active_approvers: sum((r) => r.approvers.active),
      active_approvers_missing_github_user_id: sum(
        (r) => r.approvers.active_missing_github_user_id,
      ),
      members: sum((r) => r.members.owner + r.members.admin + r.members.member + r.members.viewer),
      pending_invites: sum((r) => r.pending_invites),
    };
    await appendAudit(
      ctx.db,
      { orgId: await systemOrgId(ctx.db) },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "instance_org_summary",
        effect: "read",
        outcome: "ok",
        input: { orgs: rows.length },
      },
    );
    return { orgs: rows, totals };
  },
});
