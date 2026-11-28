import { instanceOrgCapOf } from "../org-cap";
import { z } from "zod";
import {
  appendAudit,
  createProject,
  getOrgById,
  getOrgBySlug,
  getProject,
  getProjectBySlug,
  getProjectEgress,
  getProjectSandboxSettings,
  setProjectEgress,
  type EgressMode,
  setProjectSandboxSettings,
  SNAPSHOT_NAME,
} from "../../db/repos";
import { UNTRUSTED_RUN_APPROVALS } from "../../db/schema";
import { SYSTEM_ORG_SLUG } from "../../audit/failures";
import { settingsRegistry, untrustedRunApprovalSetting } from "../../settings/definitions";
import { createSettingsRuntime } from "../../settings/resolve";
import { lockSettingKey } from "../../db/repos/settings";
import { effectiveApproval, guardSettingChange } from "../setting-guard";
import { defineOp, type OpContext } from "../define";
import { OpError } from "../errors";
import { getSandboxImage } from "../../db/repos/sandbox-images";
import { imageView, sandboxImageShape } from "./sandbox-images";

const EGRESS = ["none", "allowlist", "open"] as const;
/** Tightness: a higher rank is tighter. */
const EGRESS_RANK: Record<EgressMode, number> = { open: 0, allowlist: 1, none: 2 };

const settingsShape = z.object({
  egress: z
    .enum(EGRESS)
    .describe("The project's default sandbox egress: none (default), allowlist or open."),
  sandbox_snapshot: z
    .string()
    .nullable()
    .describe("The provider snapshot this project's sandboxes start from; null is the default."),
  sandbox_image: sandboxImageShape
    .nullable()
    .describe(
      "The registered image behind `sandbox_snapshot` (`register_sandbox_image`): its digest-pinned ref. Null when no snapshot is set or it was not registered through Turntable.",
    ),
  max_concurrent: z
    .int()
    .nullable()
    .describe("Most attempts of this project running at once; null is no project limit."),
  untrusted_run_approval: z
    .enum(UNTRUSTED_RUN_APPROVALS)
    .describe(
      "Who may approve a run held for an untrusted author: human (an enrolled approver's signature only), no_agents (default: not over MCP, not with an agent token) or any.",
    ),
});

async function imageOf(db: OpContext["db"], snapshot: string | null) {
  if (snapshot === null) return null;
  const img = await getSandboxImage(db, snapshot);
  return img ? imageView(img) : null;
}

export const getProjectSettings = defineOp({
  name: "get_project_settings",
  summary: "A project's sandbox snapshot, concurrency cap and untrusted-run approval policy.",
  description:
    "The settings the instance operator gave one project: `sandbox_snapshot` (the provider " +
    "snapshot its sandboxes start from; it beats a size class's snapshot and the provider's " +
    "default) and `max_concurrent` (most of its attempts running at once; it can only lower the " +
    "org's and the instance's caps). Null means not set. `untrusted_run_approval` says who may " +
    "approve a run held for an untrusted author (human, no_agents or any; default no_agents): " +
    "read it to know whether `approve_run` will be refused for you. Pass the project. Read-only. They are " +
    "set by the instance operator (`set_project_settings`, or `turntable policy set` on the " +
    "host), never by the project's own tokens.",
  input: z.object({}),
  output: z.object({ project: z.string(), ...settingsShape.shape }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "GET", path: "/project-settings" },
  async handler(ctx) {
    if (!ctx.scope.projectId) throw new OpError("invalid_input", "a project is required");
    const s = await getProjectSandboxSettings(ctx.db, ctx.scope);
    // The effective policy: a value in the environment or turntable.toml wins over the stored one.
    s.untrustedRunApproval = await effectiveApproval(
      ctx.settings,
      ctx.db,
      ctx.scope.orgId,
      ctx.scope.projectId,
    );
    return {
      project: ctx.scope.projectId,
      egress: await getProjectEgress(ctx.db, ctx.scope),
      sandbox_snapshot: s.sandboxSnapshot,
      sandbox_image: await imageOf(ctx.db, s.sandboxSnapshot),
      max_concurrent: s.maxConcurrent,
      untrusted_run_approval: s.untrustedRunApproval,
    };
  },
});

export const setProjectSettings = defineOp({
  name: "set_project_settings",
  summary: "Set a project's sandbox snapshot and concurrency cap (instance administrator only).",
  description:
    "Changes the sandbox settings of one project, naming only the ones to change (null removes " +
    "one). `sandbox_snapshot` is the name of an existing provider snapshot: the project's " +
    "sandboxes start from it instead of the size class's or the provider's default. " +
    "`max_concurrent` caps the project's running attempts and can only lower the instance's " +
    "per-org cap (`--org-cap`): a value above it is refused. Both are operator controls and a " +
    "tenant must not choose its own image or lift its own cap, so only the instance " +
    "administrator can call it: an org's own tokens, of any role, never can. " +
    "`untrusted_run_approval` (human, no_agents or any) says who may approve a run held for an " +
    "untrusted author; raising it to `any` lets agents approve, so it is audited with the old " +
    "and new value like every change here and is never an MCP call. The change is " +
    "audited in the system org's chain and in the target org's own. Not an MCP tool.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the org."),
    target_project: z.string().min(1).max(64).describe("Slug of the project."),
    sandbox_snapshot: z.string().min(1).max(128).nullable().optional(),
    max_concurrent: z.int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    untrusted_run_approval: z.enum(UNTRUSTED_RUN_APPROVALS).optional(),
  }),
  output: z.object({ project: z.string(), ...settingsShape.shape }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/project-settings" },
  mcp: false,
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such project");
    const project = await getProjectBySlug(ctx.db, { orgId: org.id }, i.target_project);
    if (!project) throw new OpError("not_found", "no such project");
    if (
      i.sandbox_snapshot === undefined &&
      i.max_concurrent === undefined &&
      i.untrusted_run_approval === undefined
    )
      throw new OpError("invalid_input", "name at least one setting to set");
    if (typeof i.sandbox_snapshot === "string" && !SNAPSHOT_NAME.test(i.sandbox_snapshot))
      throw new OpError(
        "invalid_input",
        "a snapshot name is letters, digits, . _ - (up to 128, starting alphanumeric)",
      );
    const cap = await instanceOrgCapOf(ctx);
    if (typeof i.max_concurrent === "number" && cap !== undefined && i.max_concurrent > cap) {
      throw new OpError(
        "invalid_input",
        `max_concurrent ${i.max_concurrent} is above the instance's per-org cap of ${cap}; it can only lower it`,
      );
    }
    const scope = { orgId: org.id, projectId: project.id };
    const rt = ctx.settings ?? createSettingsRuntime(settingsRegistry);
    // A thin alias of set_setting: the same lock, role, MCP and value refusals, so a turntable.toml
    // value locks the field.
    if (i.untrusted_run_approval !== undefined) {
      // The same per-(org, key) lock as set_setting (#369), held to the end of the transaction.
      await lockSettingKey(ctx.db, org.id, untrustedRunApprovalSetting.key);
      await guardSettingChange(
        rt,
        ctx.db,
        untrustedRunApprovalSetting,
        { orgId: org.id, orgSlug: org.slug, projectId: project.id, projectSlug: project.slug },
        { principal: ctx.principal, viaMcp: ctx.viaMcp },
        { value: i.untrusted_run_approval },
      );
    }
    const from = await getProjectSandboxSettings(ctx.db, scope);
    from.untrustedRunApproval = await effectiveApproval(rt, ctx.db, org.id, project.id);
    const to = await setProjectSandboxSettings(
      ctx.db,
      scope,
      {
        ...(i.sandbox_snapshot !== undefined ? { sandboxSnapshot: i.sandbox_snapshot } : {}),
        ...(i.max_concurrent !== undefined ? { maxConcurrent: i.max_concurrent } : {}),
        ...(i.untrusted_run_approval !== undefined
          ? { untrustedRunApproval: i.untrusted_run_approval }
          : {}),
      },
      { id: ctx.principal.id, now: ctx.now() },
    );
    if (!to) throw new OpError("not_found", "no such project");
    to.untrustedRunApproval = await effectiveApproval(rt, ctx.db, org.id, project.id);
    // The org's own chain says it too: its operators should see who changed their project.
    await appendAudit(ctx.db, scope, {
      principalKind: "instance",
      principalId: ctx.principal.id,
      op: "set_project_settings",
      effect: "write",
      outcome: "ok",
      input: { target_org: org.slug, target_project: project.slug, from, to },
    });
    return {
      project: project.id,
      egress: await getProjectEgress(ctx.db, scope),
      sandbox_snapshot: to.sandboxSnapshot,
      sandbox_image: await imageOf(ctx.db, to.sandboxSnapshot),
      max_concurrent: to.maxConcurrent,
      untrusted_run_approval: to.untrustedRunApproval,
    };
  },
});

const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const createProjectOp = defineOp({
  name: "create_project",
  summary: "Create a project in an org (instance administrator only).",
  description:
    "Creates an empty project in an existing org: a slug (lower-case letters, digits and `-`, " +
    "up to 63) and a display name. A project is what a repo is ingested into, what carries a " +
    "sandbox snapshot and a concurrency cap (`set_project_settings`) and the policy of its " +
    "runs, so it is made by the instance operator: on a hosted instance with no shell this is " +
    "how a second repo gets its own project. A slug already used in the org is a conflict. " +
    "Audited in the system org's chain and the org's own. Not an MCP tool.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the org."),
    slug: z.string().min(1).max(63).describe("Slug of the new project."),
    name: z.string().min(1).max(120).describe("Display name. Untrusted text elsewhere."),
  }),
  output: z.object({ org: z.string(), project: z.string(), id: z.string(), name: z.string() }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/projects" },
  mcp: false,
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such org");
    if (!PROJECT_SLUG.test(i.slug))
      throw new OpError(
        "invalid_input",
        "a project slug is lower-case letters, digits and - (up to 63, starting alphanumeric)",
      );
    if (await getProjectBySlug(ctx.db, { orgId: org.id }, i.slug))
      throw new OpError("conflict", "a project with that slug already exists in the org");
    const project = await createProject(ctx.db, { orgId: org.id }, { slug: i.slug, name: i.name });
    await appendAudit(
      ctx.db,
      { orgId: org.id, projectId: project.id },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "create_project",
        effect: "write",
        outcome: "ok",
        input: { target_org: org.slug, slug: i.slug },
      },
    );
    return { org: org.slug, project: project.slug, id: project.id, name: project.name };
  },
});

/**
 * Checks a mode against what the provider can enforce. `allowlist` and `open` the provider cannot
 * enforce are refused; `none` it cannot enforce is allowed (it is the safe default) with a warning,
 * because every job would then fail its egress canary. Unknown capabilities (no provider in this
 * process) refuse `allowlist` and `open` and warn for `none`.
 */
function egressCapability(ctx: OpContext, mode: EgressMode): string[] {
  const caps = ctx.providerEgress?.();
  if (!caps) {
    if (mode !== "none")
      throw new OpError(
        "invalid_input",
        `the provider's egress support is unknown here (no provider in this process), so egress ${mode} cannot be checked`,
      );
    return ["the provider's egress support is unknown here (no provider in this process)"];
  }
  if (caps.includes(mode)) return [];
  if (mode === "none")
    return [
      "the provider cannot enforce egress none: jobs will fail the egress canary until the project is set to a mode it can enforce",
    ];
  throw new OpError("invalid_input", `the provider cannot enforce egress ${mode}`);
}

async function changeEgress(
  ctx: OpContext,
  op: string,
  orgId: string,
  projectId: string,
  chains: readonly { orgId: string; projectId?: string }[],
  target: { org: string; project: string },
  to: EgressMode,
  tightenOnly: boolean,
) {
  const scope = { orgId, projectId };
  const from = await getProjectEgress(ctx.db, scope);
  if (tightenOnly && EGRESS_RANK[to] < EGRESS_RANK[from])
    throw new OpError(
      "forbidden",
      `egress can only be tightened here (open, then allowlist, then none); ${from} to ${to} is widening, which the instance operator does`,
    );
  // Checked even when the mode is unchanged: re-setting `none` must still warn.
  const warnings = egressCapability(ctx, to);
  if (from === to) return { project: projectId, from, to, warnings };
  await setProjectEgress(ctx.db, scope, to);
  for (const c of chains)
    await appendAudit(ctx.db, c, {
      principalKind: ctx.principal.kind,
      principalId: ctx.principal.id,
      op,
      effect: "write",
      outcome: "ok",
      input: { target_org: target.org, target_project: target.project, from, to },
    });
  return { project: projectId, from, to, warnings };
}

const egressOutput = z.object({
  project: z.string(),
  from: z.enum(EGRESS),
  to: z.enum(EGRESS),
  warnings: z.array(z.string()).describe("Why the new mode may not work on the provider."),
});

export const setProjectEgressOp = defineOp({
  name: "set_project_egress",
  summary: "Set a project's default sandbox egress (instance administrator only).",
  description:
    "Sets the default egress of one project's sandboxes: `none` (default), `allowlist` or " +
    "`open`. A repo's own `egress` in its poll config still overrides it, and an untrusted run " +
    "never gets `open`. The mode is checked against what the provider can enforce: `allowlist` " +
    "or `open` it cannot enforce is refused, `none` it cannot enforce is allowed with a warning " +
    "(every job would fail the egress canary). Widening is an operator control, so this is the " +
    "instance administrator's and never an MCP tool; an org owner can only tighten, with " +
    "`tighten_project_egress`. Audited with the old and new value in the system org's chain and " +
    "the org's own.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the org."),
    target_project: z.string().min(1).max(64).describe("Slug of the project."),
    egress: z.enum(EGRESS),
  }),
  output: egressOutput,
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/project-egress" },
  mcp: false,
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such project");
    const project = await getProjectBySlug(ctx.db, { orgId: org.id }, i.target_project);
    if (!project) throw new OpError("not_found", "no such project");
    return changeEgress(
      ctx,
      "set_project_egress",
      org.id,
      project.id,
      [{ orgId: org.id, projectId: project.id }],
      { org: org.slug, project: project.slug },
      i.egress,
      false,
    );
  },
});

export const tightenProjectEgress = defineOp({
  name: "tighten_project_egress",
  summary: "Tighten a project's default sandbox egress (org owner; never widens).",
  description:
    "Lowers the default egress of the project: open to allowlist or none, allowlist to none. " +
    "Widening is refused here: only the instance administrator does that " +
    "(`set_project_egress`). Same provider capability check as `set_project_egress`. Audited " +
    "with the old and new value. Pass the project.",
  input: z.object({ egress: z.enum(EGRESS) }),
  output: egressOutput,
  effect: "write",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "POST", path: "/project-egress" },
  // Owners are people (a web session); no token holds the role, and an agent never changes egress.
  mcp: false,
  async handler(ctx, i) {
    if (!ctx.scope.projectId) throw new OpError("invalid_input", "a project is required");
    const org = await getOrgById(ctx.db, ctx.scope.orgId);
    const project = await getProject(ctx.db, { orgId: ctx.scope.orgId }, ctx.scope.projectId);
    if (!org || !project) throw new OpError("not_found", "no such project");
    return changeEgress(
      ctx,
      "tighten_project_egress",
      ctx.scope.orgId,
      ctx.scope.projectId,
      [{ orgId: ctx.scope.orgId, projectId: ctx.scope.projectId }],
      { org: org.slug, project: project.slug },
      i.egress,
      true,
    );
  },
});
