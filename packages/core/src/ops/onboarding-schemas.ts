import { z } from "zod";
import { MEMBER_ROLES } from "../db/schema";

/**
 * Shared input and output schemas for the onboarding wizard ops. Schemas only: no handlers, no
 * registry entries. Later lanes build the ops, the UI and the agent-connect flow against these.
 */

// ---- shared field schemas ----

/** Org slug: same shape the bootstrap and hosted flows accept. */
export const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const orgSlug = z
  .string()
  .regex(ORG_SLUG_RE)
  .describe("Org slug: lowercase letters, digits, dashes.");
const projectSlug = z.string().min(1).max(64).describe("Project slug.");
/** GitHub repo full name, as the webhook layer validates it. */
export const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const repoName = z.string().regex(REPO_NAME_RE).describe("Repository full name, owner/name.");
const digits = (what: string) =>
  z
    .string()
    .regex(/^\d{1,20}$/)
    .describe(`${what} (decimal digits).`);
const installationId = digits("GitHub installation id");
const repoId = digits("GitHub repository id");
const memberRole = z.enum(MEMBER_ROLES).describe("The caller's role in the org.");
const mode = z.enum(["off", "shadow", "live"]);
/**
 * What each checks mode does on GitHub, in the words every surface uses (ops, docs and the
 * wizard). The mode is the project's `checks_mode` column.
 */
export const CHECKS_MODE_LABELS = {
  off: "Off: runs on Turntable, posts nothing to GitHub (default)",
  shadow: "Shadow: posts neutral `shadow / <job>` checks that never block",
  live: "Live: posts `turntable / <job>` checks your rules can require",
} as const;
const trustClass = z.enum(["protected", "release", "trusted_pr", "untrusted_pr"]);
/** Variable name: letters, digits and underscores, not starting with a digit. */
export const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const varName = z.string().regex(VAR_NAME_RE).describe("Variable name, e.g. NODE_ENV.");

// ---- 1. onboarding_create_org ----

export const onboardingCreateOrgInput = z.object({
  slug: orgSlug,
  display_name: z.string().min(1).max(80).describe("Human-readable org name, 1 to 80 characters."),
});
export const onboardingCreateOrgOutput = z.object({
  org: z.object({
    id: z.string().describe("Org id."),
    slug: orgSlug,
    display_name: z.string().describe("Org display name."),
  }),
  role: z.literal("owner").describe("The creator is always the owner."),
});
export type OnboardingCreateOrgInput = z.infer<typeof onboardingCreateOrgInput>;
export type OnboardingCreateOrgOutput = z.infer<typeof onboardingCreateOrgOutput>;

// ---- 2. list_my_orgs ----

export const listMyOrgsInput = z.object({});
export const listMyOrgsOutput = z.object({
  orgs: z.array(
    z.object({
      slug: orgSlug,
      display_name: z.string().describe("Org display name."),
      role: memberRole,
    }),
  ),
});
export type ListMyOrgsInput = z.infer<typeof listMyOrgsInput>;
export type ListMyOrgsOutput = z.infer<typeof listMyOrgsOutput>;

// ---- 3. start_installation_claim (extension of the existing op) ----

export const startInstallationClaimExtraInput = z.object({
  popup: z
    .boolean()
    .optional()
    .describe("Open the flow in a popup: the callback page then closes itself."),
});
export const startInstallationClaimExtraOutput = z.object({
  claim_id: z.string().describe("Poll get_installation_claim with this id."),
});
export type StartInstallationClaimExtraInput = z.infer<typeof startInstallationClaimExtraInput>;
export type StartInstallationClaimExtraOutput = z.infer<typeof startInstallationClaimExtraOutput>;

// ---- 4. get_installation_claim ----

export const CLAIM_STATES = ["pending", "completed", "expired", "refused"] as const;
export const getInstallationClaimInput = z.object({
  claim_id: z.string().min(1).max(128).describe("Id from start_installation_claim."),
});
export const getInstallationClaimOutput = z.object({
  state: z.enum(CLAIM_STATES).describe("Where the claim is."),
  installation_id: installationId.optional(),
  account_login: z.string().optional().describe("GitHub account the App is installed on."),
  reason: z.string().optional().describe("Why the claim was refused, when it was."),
});
export type GetInstallationClaimInput = z.infer<typeof getInstallationClaimInput>;
export type GetInstallationClaimOutput = z.infer<typeof getInstallationClaimOutput>;

// ---- 5. list_user_installations ----

export const listUserInstallationsInput = z.object({});
/** Deliberately no field naming another org: `bound` says only whether it is taken. */
export const listUserInstallationsOutput = z.object({
  installations: z.array(
    z.object({
      installation_id: installationId,
      account_login: z.string().describe("GitHub account the App is installed on."),
      account_type: z.enum(["User", "Organization"]).describe("Kind of GitHub account."),
      repository_selection: z.enum(["all", "selected"]).describe("Repos the App can see."),
      bound: z
        .enum(["this_org", "other_org", "none"])
        .describe("Whether the installation is bound to this org, another org, or nothing."),
    }),
  ),
});
export type ListUserInstallationsInput = z.infer<typeof listUserInstallationsInput>;
export type ListUserInstallationsOutput = z.infer<typeof listUserInstallationsOutput>;

// ---- 6. bind_installation ----

export const bindInstallationInput = z.object({ installation_id: installationId });
export const bindInstallationOutput = z.object({
  installation_id: installationId,
  account_login: z.string().describe("GitHub account the App is installed on."),
  projects: z.array(
    z.object({
      slug: projectSlug,
      repo: repoName,
    }),
  ),
});
export type BindInstallationInput = z.infer<typeof bindInstallationInput>;
export type BindInstallationOutput = z.infer<typeof bindInstallationOutput>;

// ---- 7. list_installation_repos ----

export const listInstallationReposInput = z.object({ installation_id: installationId });
export const listInstallationReposOutput = z.object({
  repos: z.array(
    z.object({
      repo: repoName,
      repo_id: repoId,
      private: z.boolean().describe("Whether the repository is private."),
      project: projectSlug.nullable().describe("Project slug, or null when not a project yet."),
      status: z.enum(["new", "in_org"]).describe("new: not in this org yet."),
      mode: mode.nullable().describe("Project mode, or null when not a project."),
      paused: z.boolean().describe("Whether the project is paused."),
    }),
  ),
});
export type ListInstallationReposInput = z.infer<typeof listInstallationReposInput>;
export type ListInstallationReposOutput = z.infer<typeof listInstallationReposOutput>;

// ---- 8. onboard_repos ----

export const ONBOARD_REPOS_MAX = 100;
export const onboardReposInput = z.object({
  installation_id: installationId,
  repos: z
    .array(
      z.object({
        repo_id: repoId,
        enable: z.boolean().describe("Turn CI on for this repo."),
        mode: mode
          .optional()
          .describe(
            `Checks mode. Omitted: a new project gets \`off\`; an existing project keeps its current mode. ${CHECKS_MODE_LABELS.off}. ${CHECKS_MODE_LABELS.shadow}. ${CHECKS_MODE_LABELS.live}.`,
          ),
      }),
    )
    .max(ONBOARD_REPOS_MAX)
    .describe("Repos to configure, at most 100."),
});
export const onboardReposOutput = z.object({
  projects: z.array(
    z.object({
      slug: projectSlug,
      repo: repoName,
      enabled: z.boolean().describe("Whether CI is on."),
      mode,
      paused: z.boolean().describe("Whether the project is paused."),
    }),
  ),
});
export type OnboardReposInput = z.infer<typeof onboardReposInput>;
export type OnboardReposOutput = z.infer<typeof onboardReposOutput>;

// ---- 9. preview_workflows ----

export const PREVIEW_MAX_FILES = 50;
export const PREVIEW_MAX_BYTES = 512 * 1024;
export const previewWorkflowsInput = z.object({ project: projectSlug });
export const previewWorkflowsOutput = z.object({
  sha: z.string().describe("Commit the preview read."),
  truncated: z.boolean().describe("True when the file or byte cap cut the list short."),
  default_branch: z.string().describe("The branch the preview read (the project's default)."),
  workflows: z.array(
    z.object({
      path: z.string().describe("Workflow file path."),
      name: z.string().nullable().describe("Workflow name, when it has one."),
      triggers: z.array(z.string()).describe("Events that start the workflow."),
      ingested: z.boolean().describe("Whether Turntable would ingest this file."),
      too_large: z.boolean().describe("True when the file is over the byte cap."),
      dispatch_inputs: z
        .array(
          z.object({
            name: z.string(),
            type: z.enum(["string", "boolean", "number", "choice", "environment"]),
            required: z.boolean(),
            default: z.string().nullable(),
            options: z.array(z.string()),
            description: z.string().nullable(),
          }),
        )
        .nullable()
        .describe(
          "The inputs declared under on.workflow_dispatch, or null when the workflow has no workflow_dispatch trigger.",
        ),
      jobs: z.array(
        z.object({
          job_id: z.string().describe("Job key in the workflow."),
          name: z.string().nullable().describe("Job display name."),
          verdict: z.enum(["run", "skip", "fail"]).describe("What Turntable would do."),
          reason: z.string().optional().describe("Why, for skip and fail."),
          fix: z.string().optional().describe("How to fix a fail."),
          will_run: z
            .boolean()
            .describe(
              "True when the workflow is ingested and the job's verdict is run. A job that will not run needs none of its secrets.",
            ),
          refs: z
            .array(
              z.object({
                kind: z.enum(["secret", "var"]),
                name: z.string().describe("The name only, never a value."),
                where: z.array(z.string()).describe("Where the name is used, for example job env."),
                provided: z
                  .boolean()
                  .describe(
                    "True for secrets.GITHUB_TOKEN, which Turntable provides, and for a vars.* the project has set.",
                  ),
              }),
            )
            .describe("Every secrets.* and vars.* name the job refers to."),
        }),
      ),
    }),
  ),
  needs_summary: z.object({
    needed: z.array(z.string()).describe("Secret names used by jobs that will run, sorted."),
    text: z.string().describe('For example "2 secrets needed by jobs that will run: A, B".'),
  }),
});
/** The one-line answer to "which secrets does this project need". Names only. */
export function secretsSummary(
  workflows: {
    jobs: { will_run: boolean; refs: { kind: string; name: string; provided: boolean }[] }[];
  }[],
): { needed: string[]; text: string } {
  const set = new Set<string>();
  for (const w of workflows)
    for (const j of w.jobs)
      if (j.will_run)
        for (const r of j.refs) if (r.kind === "secret" && !r.provided) set.add(r.name);
  const needed = [...set].toSorted();
  const text =
    needed.length === 0
      ? "0 secrets needed"
      : `${needed.length} secret${needed.length === 1 ? "" : "s"} needed by jobs that will run: ${needed.join(", ")}`;
  return { needed, text };
}

export type PreviewWorkflowsInput = z.infer<typeof previewWorkflowsInput>;
export type PreviewWorkflowsOutput = z.infer<typeof previewWorkflowsOutput>;

// ---- 10. run_default_branch ----

export const runDefaultBranchInput = z.object({
  project: projectSlug,
  onboarding_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Onboarding to record this run on, as its first run."),
});
export const runDefaultBranchOutput = z.object({
  run_id: z.string().describe("Run id."),
  sha: z.string().describe("Commit the run is for."),
  trust_class: trustClass.describe("Trust decided for the run."),
  created: z.boolean().describe("False when an existing run for that sha was returned."),
});
export type RunDefaultBranchInput = z.infer<typeof runDefaultBranchInput>;
export type RunDefaultBranchOutput = z.infer<typeof runDefaultBranchOutput>;

// ---- 11. create_onboarding_agent_token ----

export const MAX_ACTIVE_ONBOARDING_TOKENS = 5;
/**
 * Leaf field names, matched anywhere in the output: define.ts matches oneTimeSecretFields (and
 * lint.ts matches output fields) by LEAF name, so `claude_command` and `mcp_json` are listed
 * without their `setup.` parent. The `prompt` field must never contain the token, because it is
 * shown and may be pasted anywhere, so it is deliberately not in this list.
 */
export const ONBOARDING_TOKEN_SECRET_FIELDS = ["token", "claude_command", "mcp_json"] as const;
export const createOnboardingAgentTokenInput = z.object({
  projects: z.array(projectSlug).max(20).optional().describe("Limit the token to these projects."),
  ttl_days: z.int().min(1).max(30).default(30).describe("Token lifetime in days, 1 to 30."),
});
export const createOnboardingAgentTokenOutput = z.object({
  token: z.string().describe("The bearer token. Shown once."),
  token_id: z.string().describe("Token id, for listing and revoking."),
  expires_at: z.int().describe("Expiry, epoch milliseconds."),
  mcp_url: z.string().describe("MCP endpoint of this instance."),
  setup: z.object({
    claude_command: z.string().describe("Shell command that registers the MCP server."),
    mcp_json: z.string().describe("MCP client config as JSON text."),
  }),
  prompt: z.string().describe("Starter prompt to paste into the agent. Never contains the token."),
});
export type CreateOnboardingAgentTokenInput = z.infer<typeof createOnboardingAgentTokenInput>;
export type CreateOnboardingAgentTokenOutput = z.infer<typeof createOnboardingAgentTokenOutput>;

// ---- 12. onboarding_ack ----

export const onboardingAckInput = z.object({ run_id: z.string().min(1).max(128) });
export const onboardingAckOutput = z.object({
  run_id: z.string().describe("Run id."),
  conclusion: z.string().nullable().describe("Run conclusion, null while running."),
  jobs: z.array(
    z.object({
      name: z.string().describe("Job name."),
      conclusion: z.string().nullable().describe("Job conclusion, null while running."),
    }),
  ),
});
export type OnboardingAckInput = z.infer<typeof onboardingAckInput>;
export type OnboardingAckOutput = z.infer<typeof onboardingAckOutput>;

// ---- 13. event payloads ----

export const tokenFirstUsedEvent = z.object({
  token_id: z.string(),
  principal_kind: z.enum(["agent", "person"]),
});
export const onboardingAgentAckEvent = z.object({ run_id: z.string(), token_id: z.string() });
export const installationClaimUpdatedEvent = z.object({
  claim_id: z.string(),
  state: z.enum(CLAIM_STATES),
});
export type TokenFirstUsedEvent = z.infer<typeof tokenFirstUsedEvent>;
export type OnboardingAgentAckEvent = z.infer<typeof onboardingAgentAckEvent>;
export type InstallationClaimUpdatedEvent = z.infer<typeof installationClaimUpdatedEvent>;

// ---- 14. lane E outline: vars and secrets ----

const varScope = z.enum(["org", "project"]);
export const setVarInput = z.object({
  scope: varScope,
  project: projectSlug.optional().describe("Required when scope is project."),
  name: varName,
  value: z
    .string()
    .max(16 * 1024)
    .describe("Variable value (not a secret)."),
});
export const setVarOutput = z.object({ name: varName, scope: varScope });
export const deleteVarInput = z.object({
  scope: varScope,
  project: projectSlug.optional().describe("Required when scope is project."),
  name: varName,
});
export const deleteVarOutput = z.object({ deleted: z.boolean() });
export const listVarsInput = z.object({
  scope: varScope,
  project: projectSlug.optional().describe("Required when scope is project."),
});
export const listVarsOutput = z.object({
  vars: z.array(
    z.object({
      name: varName,
      value: z.string().describe("Variable value."),
      scope: varScope,
      locked: z.boolean().describe("True when it cannot be changed at this scope."),
    }),
  ),
});
export type SetVarInput = z.infer<typeof setVarInput>;
export type DeleteVarInput = z.infer<typeof deleteVarInput>;
export type ListVarsInput = z.infer<typeof listVarsInput>;
export type ListVarsOutput = z.infer<typeof listVarsOutput>;

/** Deliberately without untrusted_pr: secrets never reach those runs. */
export const SECRET_TRUST_CLASSES = ["protected", "trusted_pr"] as const;
export const secretTrustInput = z.object({
  trust_classes: z
    .array(z.enum(SECRET_TRUST_CLASSES))
    .default(["protected"])
    .describe("Run trust classes allowed to use the secret."),
  environments: z.array(z.string().min(1).max(64)).optional().describe("Limit to environments."),
});
export type SecretTrustInput = z.infer<typeof secretTrustInput>;

export const listSecretProviderTypesInput = z.object({});
export const listSecretProviderTypesOutput = z.object({
  types: z.array(
    z.object({
      type: z.string().describe("Provider type id."),
      display_name: z.string().describe("Name to show."),
      config_schema: z.unknown().describe("JSON Schema of the config object."),
    }),
  ),
});
export const connectSecretProviderInput = z.object({
  type: z.string().min(1).max(64).describe("Provider type id."),
  config: z.record(z.string(), z.string()).describe("Provider config, string values."),
});
export const connectSecretProviderOutput = z.object({
  provider_id: z.string().describe("Id of the connected provider."),
  ok: z.boolean().describe("Whether the connection test passed."),
  error: z.string().optional().describe("Why it failed."),
});
export const mapSecretRefInput = z.object({
  name: z.string().min(1).max(128).describe("Secret name, e.g. DEPLOY_KEY."),
  provider_id: z.string().min(1).max(128).describe("Provider to read from."),
  ref: z.string().min(1).max(1024).describe("Reference inside the provider."),
  trust_classes: z.array(z.enum(SECRET_TRUST_CLASSES)).min(1).describe("Allowed trust classes."),
});
export const mapSecretRefOutput = z.object({ name: z.string(), provider_id: z.string() });
export const testSecretRefInput = z.object({ name: z.string().min(1).max(128) });
/** By design no value, length or hash field. */
export const testSecretRefOutput = z.object({
  ok: z.boolean().describe("Whether the reference resolved."),
  error: z.string().optional().describe("Why it did not."),
});
export type ConnectSecretProviderInput = z.infer<typeof connectSecretProviderInput>;
export type ConnectSecretProviderOutput = z.infer<typeof connectSecretProviderOutput>;
export type MapSecretRefInput = z.infer<typeof mapSecretRefInput>;
export type TestSecretRefInput = z.infer<typeof testSecretRefInput>;
export type TestSecretRefOutput = z.infer<typeof testSecretRefOutput>;

export const ONBOARDING_OPS = [
  "onboarding_create_org",
  "list_my_orgs",
  "start_installation_claim",
  "get_installation_claim",
  "list_user_installations",
  "bind_installation",
  "list_installation_repos",
  "onboard_repos",
  "preview_workflows",
  "run_default_branch",
  "create_onboarding_agent_token",
  "onboarding_ack",
  "set_var",
  "delete_var",
  "list_vars",
  "list_secret_provider_types",
  "connect_secret_provider",
  "map_secret_ref",
  "test_secret_ref",
] as const;
export type OnboardingOpName = (typeof ONBOARDING_OPS)[number];
