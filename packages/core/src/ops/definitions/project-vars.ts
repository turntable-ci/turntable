// A project's `vars.*` (non-secret workflow variables), kept in its stored ingest settings, the
// same place `turntable policy set --ingest on --var` writes and the poller and
// `preview_workflows` read. One entry per op, so REST, MCP and the web UI share it.
import { z } from "zod";
import {
  appendAudit,
  getOrgBySlug,
  getProjectBySlug,
  getProjectIngest,
  setProjectIngest,
  type Scope,
} from "../../db/repos";
import { SYSTEM_ORG_SLUG } from "../../audit/failures";
import { ingestSettingsSchema, varsSchema, type IngestSettings } from "../../poll/config";
import { decodeCursor, encodeCursor, nextCursor, pageInput } from "../common";
import { defineOp, type OpContext } from "../define";
import { OpError } from "../errors";

/** Set by onboarding to gate jobs Turntable cannot run; changing or removing it breaks that. */
export const RESERVED_VARS: readonly string[] = ["TURNTABLE_CI"];

const nameField = z
  .string()
  .min(1)
  .max(64)
  .describe("A variable name: letters, digits and underscores, not starting with GITHUB_.");

const varView = z.object({
  name: z.string(),
  value: z.string().describe("Plain text. Variables are not secrets: use a secret for those."),
  reserved: z.boolean().describe("Set by Turntable; it cannot be changed or removed."),
});

const isReserved = (name: string): boolean =>
  RESERVED_VARS.some((r) => r.toUpperCase() === name.toUpperCase());

function requireScope(ctx: OpContext): Scope {
  if (!ctx.scope.projectId) throw new OpError("invalid_input", "a project is required");
  return ctx.scope;
}

async function stored(ctx: OpContext, scope: Scope): Promise<IngestSettings> {
  const raw = await getProjectIngest(ctx.db, scope);
  if (raw === null) {
    throw new OpError(
      "conflict",
      "this project is not ingested yet: finish onboarding (or turn ingest on) before setting variables",
    );
  }
  const parsed = ingestSettingsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new OpError("unavailable", "the project's stored ingest settings are not readable");
  }
  return parsed.data;
}

async function save(
  ctx: OpContext,
  scope: Scope,
  cur: IngestSettings,
  vars: Record<string, string>,
) {
  const { vars: _old, ...rest } = cur;
  const next: IngestSettings = Object.keys(vars).length === 0 ? rest : { ...rest, vars };
  await setProjectIngest(ctx.db, scope, JSON.stringify(next));
}

const keyOf = (vars: Record<string, string>, name: string): string | undefined =>
  Object.keys(vars).find((k) => k.toUpperCase() === name.toUpperCase());

async function setVar(
  ctx: OpContext,
  scope: Scope,
  i: { name: string; value: string },
): Promise<{ name: string; created: boolean }> {
  if (isReserved(i.name)) {
    throw new OpError("invalid_input", `${i.name.toUpperCase()} is reserved and cannot be set`);
  }
  // Assigning `__proto__` would change the object's prototype and store nothing.
  if (i.name === "__proto__") throw new OpError("invalid_input", "that variable name is reserved");
  const cur = await stored(ctx, scope);
  const vars = { ...cur.vars };
  const existing = keyOf(vars, i.name);
  if (existing !== undefined) delete vars[existing];
  vars[i.name] = i.value;
  const ok = varsSchema.safeParse(vars);
  if (!ok.success) {
    throw new OpError("invalid_input", ok.error.issues[0]?.message ?? "invalid variable");
  }
  await save(ctx, scope, cur, vars);
  return { name: i.name, created: existing === undefined };
}

async function deleteVar(
  ctx: OpContext,
  scope: Scope,
  i: { name: string },
): Promise<{ deleted: boolean }> {
  if (isReserved(i.name)) {
    throw new OpError("invalid_input", `${i.name.toUpperCase()} is reserved and cannot be removed`);
  }
  const cur = await stored(ctx, scope);
  const vars = { ...cur.vars };
  const existing = keyOf(vars, i.name);
  if (existing === undefined) throw new OpError("not_found", "no variable with that name");
  delete vars[existing];
  await save(ctx, scope, cur, vars);
  return { deleted: true };
}

/** The target of an instance-administrator call: an org and project by slug, never the system org. */
async function target(
  ctx: OpContext,
  i: { target_org: string; target_project: string },
): Promise<{ scope: Scope; org: string; project: string }> {
  const org = await getOrgBySlug(ctx.db, i.target_org);
  if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such project");
  const project = await getProjectBySlug(ctx.db, { orgId: org.id }, i.target_project);
  if (!project) throw new OpError("not_found", "no such project");
  return { scope: { orgId: org.id, projectId: project.id }, org: org.slug, project: project.slug };
}

const targetFields = {
  target_org: z.string().min(1).max(64).describe("Slug of the org."),
  target_project: z.string().min(1).max(64).describe("Slug of the project."),
};

export const listProjectVarsOp = defineOp({
  name: "list_project_vars",
  summary: "List a project's workflow variables (`vars.*`).",
  description:
    "The non-secret variables workflows read as `${{ vars.NAME }}`, with their values (variables " +
    "are plain text; use secrets for anything sensitive). `TURNTABLE_CI` is set by Turntable and " +
    "marked `reserved`. Pass the project. Read-only. Pages by cursor.",
  input: z.object({ ...pageInput }),
  output: z.object({ vars: z.array(varView), next_cursor: nextCursor }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "GET", path: "/project-vars" },
  async handler(ctx, i) {
    requireScope(ctx);
    const raw = await getProjectIngest(ctx.db, ctx.scope);
    const cur = raw === null ? undefined : ingestSettingsSchema.safeParse(JSON.parse(raw)).data;
    const after = i.cursor === undefined ? undefined : decodeCursor(i.cursor);
    const all = Object.entries(cur?.vars ?? {})
      .map(([name, value]) => ({ name, value, reserved: isReserved(name) }))
      .toSorted((x, y) => (x.name < y.name ? -1 : 1))
      .filter((v) => after === undefined || v.name > after);
    const page = all.slice(0, i.limit);
    const last = page.at(-1);
    return {
      vars: page,
      next_cursor: all.length > i.limit && last ? encodeCursor(last.name) : null,
    };
  },
});

export const setProjectVarOp = defineOp({
  name: "set_project_var",
  summary: "Create or replace one workflow variable (`vars.NAME`) of a project.",
  description:
    "Sets a non-secret variable for the project's workflows: `${{ vars.NAME }}`. Names follow " +
    "GitHub's rules (letters, digits, underscores; no `GITHUB_` prefix; at most 1000 per " +
    "project). The value is stored and shown as plain text, so never put a secret in it (use " +
    "`set_secret`). `TURNTABLE_CI` is reserved. Takes effect on the next ingest and in " +
    "`preview_workflows`. The audit log records the name only. Needs release_operator or above, because the values reach protected and release runs; " +
    "pass the project.",
  input: z.object({
    name: nameField,
    value: z.string().max(1024),
  }),
  output: z.object({ name: z.string(), created: z.boolean() }),
  effect: "write",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "project",
  logOmitFields: ["value"],
  http: { method: "POST", path: "/project-vars" },
  async handler(ctx, i) {
    return setVar(ctx, requireScope(ctx), i);
  },
});

export const deleteProjectVarOp = defineOp({
  name: "delete_project_var",
  summary: "Delete one workflow variable of a project.",
  description:
    "Removes a variable: workflows that read it see it unset from the next ingest. " +
    "`TURNTABLE_CI` is reserved and cannot be removed. The audit log records the name only. " +
    "Needs release_operator or above, because the values reach protected and release runs; pass " +
    "the project.",
  input: z.object({ name: nameField }),
  output: z.object({ deleted: z.boolean() }),
  effect: "destructive",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "DELETE", path: "/project-vars" },
  async handler(ctx, i) {
    return deleteVar(ctx, requireScope(ctx), i);
  },
});

export const setProjectVarInstanceOp = defineOp({
  name: "set_project_var_instance",
  summary: "Create or replace one workflow variable of any project (instance administrator only).",
  description:
    "The instance administrator's form of `set_project_var`: names the org and project by slug. " +
    "Same name, reserved-name and size rules. Audited in the system org's chain and in the " +
    "target org's own, with the name only, never the value. Not an MCP tool.",
  input: z.object({ ...targetFields, name: nameField, value: z.string().max(1024) }),
  output: z.object({ name: z.string(), created: z.boolean() }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  logOmitFields: ["value"],
  http: { method: "POST", path: "/instance/project-vars" },
  mcp: false,
  async handler(ctx, i) {
    const t = await target(ctx, i);
    const out = await setVar(ctx, t.scope, i);
    await auditInstance(ctx, t, "set_project_var_instance", "write", i.name);
    return out;
  },
});

export const deleteProjectVarInstanceOp = defineOp({
  name: "delete_project_var_instance",
  summary: "Delete one workflow variable of any project (instance administrator only).",
  description:
    "The instance administrator's form of `delete_project_var`: names the org and project by " +
    "slug. `TURNTABLE_CI` is reserved. Audited in the system org's chain and in the target " +
    "org's own, with the name only. Not an MCP tool.",
  input: z.object({ ...targetFields, name: nameField }),
  output: z.object({ deleted: z.boolean() }),
  effect: "destructive",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "DELETE", path: "/instance/project-vars" },
  mcp: false,
  async handler(ctx, i) {
    const t = await target(ctx, i);
    const out = await deleteVar(ctx, t.scope, i);
    await auditInstance(ctx, t, "delete_project_var_instance", "destructive", i.name);
    return out;
  },
});

async function auditInstance(
  ctx: OpContext,
  t: { scope: Scope; org: string; project: string },
  op: string,
  effect: "write" | "destructive",
  name: string,
): Promise<void> {
  // The org's own chain says it too: its operators should see who changed their project.
  await appendAudit(ctx.db, t.scope, {
    principalKind: "instance",
    principalId: ctx.principal.id,
    op,
    effect,
    outcome: "ok",
    input: { target_org: t.org, target_project: t.project, name },
  });
}
