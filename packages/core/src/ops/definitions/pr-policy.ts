// A project's pull request policy (`pr_mode` and `authors` of its ingest settings), editable
// without a host CLI (#807). Like egress (#799): an instance administrator op, an org owner or
// admin op, and a read-only MCP tool. Only these two fields change; every other ingest setting is
// kept as stored.
import { z } from "zod";
import type { Db } from "../../db";
import {
  appendAudit,
  getOrgById,
  getOrgBySlug,
  getProject,
  getProjectBySlug,
  getProjectIngest,
  setProjectIngest,
} from "../../db/repos";
import { SYSTEM_ORG_SLUG } from "../../audit/failures";
import { ingestSettingsSchema, type IngestSettings } from "../../poll/config";
import { defineOp, type OpContext } from "../define";
import { OpError } from "../errors";
import { orgRole } from "../principal";
import { roleSatisfies } from "../roles";

const PR_MODES = ["off", "allowlist", "approval"] as const;
type PrMode = (typeof PR_MODES)[number];
/** Tightness: a higher rank trusts fewer strangers' PRs. */
const MODE_RANK: Record<PrMode, number> = { approval: 0, allowlist: 1, off: 2 };

/** A GitHub login, or a GitHub App's bot login (`name[bot]`). */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

const authorsInput = z
  .array(z.string().min(1).max(60))
  .max(200)
  .describe("The full list of trusted logins; bot logins keep their `[bot]` suffix.");

const policyShape = z.object({
  project: z.string(),
  pr_mode: z.enum(PR_MODES),
  authors: z.array(z.string()),
});

const changeShape = z.object({
  project: z.string(),
  from: z.object({ pr_mode: z.enum(PR_MODES), authors: z.array(z.string()) }),
  to: z.object({ pr_mode: z.enum(PR_MODES), authors: z.array(z.string()) }),
  loosened: z.boolean().describe("Whether the change trusts more PRs than before."),
});

type Policy = { pr_mode: PrMode; authors: string[] };

const lower = (s: string): string => s.toLowerCase();

async function loadIngest(
  db: Db,
  scope: { orgId: string; projectId: string },
): Promise<IngestSettings> {
  const raw = await getProjectIngest(db, scope);
  const parsed = raw === null ? undefined : ingestSettingsSchema.safeParse(JSON.parse(raw)).data;
  if (!parsed)
    throw new OpError(
      "conflict",
      "ingest is not turned on for this project, so it has no pull request policy to change",
    );
  return parsed;
}

const policyOf = (s: IngestSettings): Policy => ({ pr_mode: s.prMode, authors: [...s.authors] });

/** True when `to` runs PRs `from` would not: a looser mode, or an author added. */
export function loosensPrPolicy(from: Policy, to: Policy): boolean {
  if (MODE_RANK[to.pr_mode] < MODE_RANK[from.pr_mode]) return true;
  // No short-circuit for "off": the merge-queue gate checks `authors` whatever the mode is.
  const had = new Set(from.authors.map(lower));
  return to.authors.some((a) => !had.has(lower(a)));
}

function normalizeAuthors(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const a = raw.trim();
    if (!LOGIN.test(a))
      throw new OpError(
        "invalid_input",
        `"${raw}" is not a GitHub login (a bot is name[bot], with the suffix)`,
      );
    if (seen.has(lower(a))) continue;
    seen.add(lower(a));
    out.push(a);
  }
  return out;
}

async function changePolicy(
  ctx: OpContext,
  op: string,
  orgId: string,
  projectId: string,
  target: { org: string; project: string },
  i: { pr_mode?: PrMode | undefined; authors?: string[] | undefined },
  requireOwnerToLoosen: boolean,
): Promise<z.infer<typeof changeShape>> {
  if (i.pr_mode === undefined && i.authors === undefined)
    throw new OpError("invalid_input", "name pr_mode or authors to set");
  const scope = { orgId, projectId };
  // Read, write and audit commit together: a concurrent edit cannot lose an update between the
  // read and the write, and a change is never stored without its audit row.
  return ctx.db.transaction(async (tx) => {
    const cur = await loadIngest(tx, scope);
    const from = policyOf(cur);
    const to: Policy = {
      pr_mode: i.pr_mode ?? from.pr_mode,
      authors: i.authors === undefined ? from.authors : normalizeAuthors(i.authors),
    };
    const loosened = loosensPrPolicy(from, to);
    if (requireOwnerToLoosen && loosened && !roleSatisfies(orgRole(ctx.principal), "owner"))
      throw new OpError(
        "forbidden",
        "widening the allowlist or switching to approval needs the owner role; an admin can only tighten",
      );
    const changed =
      from.pr_mode !== to.pr_mode ||
      from.authors.length !== to.authors.length ||
      from.authors.some((a, n) => a !== to.authors[n]);
    if (changed) {
      const next = ingestSettingsSchema.parse({
        ...cur,
        prMode: to.pr_mode,
        authors: to.authors,
      });
      await setProjectIngest(tx, scope, JSON.stringify(next));
      await appendAudit(tx, scope, {
        principalKind: ctx.principal.kind,
        principalId: ctx.principal.id,
        op,
        effect: "write",
        outcome: "ok",
        input: {
          target_org: target.org,
          target_project: target.project,
          from,
          to,
          loosened,
        },
      });
    }
    return { project: projectId, from, to, loosened };
  });
}

export const getProjectPrPolicy = defineOp({
  name: "get_project_pr_policy",
  summary: "A project's pull request mode and trusted authors.",
  description:
    "Reads the project's `pr_mode` (`off`: PRs never run, `allowlist`: only same-repo PRs by a " +
    "listed author run, `approval`: other PRs are held until a maintainer approves) and its " +
    "`authors`, the logins treated as trusted, bot logins (`name[bot]`) included. Use it to see " +
    "why a PR got no run: `ingest_status` lists the PRs skipped with the reason. " +
    "`ingest_enabled` is false when the project has no ingest settings. Read-only; changing it is " +
    "a person's or the instance operator's call, never an MCP tool. Pass the project.",
  input: z.object({}),
  output: policyShape.extend({ ingest_enabled: z.boolean() }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "GET", path: "/project-pr-policy" },
  async handler(ctx) {
    if (!ctx.scope.projectId) throw new OpError("invalid_input", "a project is required");
    const raw = await getProjectIngest(ctx.db, {
      orgId: ctx.scope.orgId,
      projectId: ctx.scope.projectId,
    });
    const s = raw === null ? undefined : ingestSettingsSchema.safeParse(JSON.parse(raw)).data;
    return {
      project: ctx.scope.projectId,
      ingest_enabled: s !== undefined,
      pr_mode: s?.prMode ?? "off",
      authors: s ? [...s.authors] : [],
    };
  },
});

export const changeProjectPrPolicy = defineOp({
  name: "change_project_pr_policy",
  summary: "Set a project's pull request mode and trusted authors (org owner or admin).",
  description:
    "Sets `pr_mode` (off, allowlist or approval) and/or `authors` (the full list of trusted " +
    "logins; a GitHub App's bot login is `name[bot]`). Naming only one keeps the other. An admin " +
    "can only tighten (a mode closer to off, authors removed); widening the allowlist or " +
    "switching to `approval` needs the owner role. Every change is audited with the old and new " +
    "value. Needs ingest turned on for the project, and changes nothing else about it. " +
    "Not an MCP tool: who is trusted is a person's decision. Pass the project.",
  input: z.object({ pr_mode: z.enum(PR_MODES).optional(), authors: authorsInput.optional() }),
  output: changeShape,
  effect: "write",
  auth: { type: "token", minRole: "admin" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "POST", path: "/project-pr-policy" },
  mcp: false,
  async handler(ctx, i) {
    if (!ctx.scope.projectId) throw new OpError("invalid_input", "a project is required");
    const org = await getOrgById(ctx.db, ctx.scope.orgId);
    const project = await getProject(ctx.db, { orgId: ctx.scope.orgId }, ctx.scope.projectId);
    if (!org || !project) throw new OpError("not_found", "no such project");
    return changePolicy(
      ctx,
      "change_project_pr_policy",
      org.id,
      project.id,
      { org: org.slug, project: project.slug },
      i,
      true,
    );
  },
});

export const setProjectPrPolicy = defineOp({
  name: "set_project_pr_policy",
  summary: "Set any project's pull request mode and trusted authors (instance administrator only).",
  description:
    "The instance administrator's form of `change_project_pr_policy`: names the org and project " +
    "and may widen as well as tighten, for a hosted instance with no shell where the project's " +
    "own owner cannot be asked. `pr_mode` is off, allowlist or approval; `authors` is the full " +
    "list of trusted logins (a bot is `name[bot]`). Needs ingest turned on and changes nothing " +
    "else. Audited with the old and new value in the org's chain. Not an MCP tool.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the org."),
    target_project: z.string().min(1).max(64).describe("Slug of the project."),
    pr_mode: z.enum(PR_MODES).optional(),
    authors: authorsInput.optional(),
  }),
  output: changeShape,
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/project-pr-policy" },
  mcp: false,
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such project");
    const project = await getProjectBySlug(ctx.db, { orgId: org.id }, i.target_project);
    if (!project) throw new OpError("not_found", "no such project");
    return changePolicy(
      ctx,
      "set_project_pr_policy",
      org.id,
      project.id,
      { org: org.slug, project: project.slug },
      i,
      false,
    );
  },
});
