// The onboarding client: one method per onboarding operation, over REST with the web session's
// cookie (the account operations accept nothing else). Unlike the org client it takes the org as
// an argument on every call, because the wizard lives at /onboarding, where the URL names no org.
// Every refusal is thrown with the server's own text so the wizard can show it plainly.
import { versionAwareFetch } from "@/lib/build-version";
import { ApiError } from "./http-adapter";
import { refusalMessage } from "./refusal";
import type { WireError, WireRunDetail } from "./wire";

/** One of a project's `vars.*`. Plain text, not a secret. `reserved` is set by Turntable. */
export type ProjectVar = { name: string; value: string; reserved: boolean };
export type MemberRole = "owner" | "admin" | "release_operator" | "member" | "viewer" | string;
export type ChecksMode = "off" | "shadow" | "live";
export type ClaimState = "pending" | "completed" | "expired" | "refused";

export type MyOrg = { slug: string; display_name: string; role: MemberRole };
export type CreatedOrg = { org: { id: string; slug: string; display_name: string }; role: "owner" };
export type StartedClaim = { url: string; expires_at: number; claim_id: string };
export type ClaimStatus = {
  state: ClaimState;
  installation_id?: string;
  account_login?: string;
  reason?: string;
};
export type UserInstallation = {
  installation_id: string;
  account_login: string;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
  bound: "this_org" | "other_org" | "none";
};
/** One installation this org holds, from `github_app_status` (no tokens, no other org's). */
export type OrgInstallation = {
  installation_id: string;
  account_login: string;
  account_type: string;
  status: string;
};
export type BoundInstallation = {
  installation_id: string;
  account_login: string;
  /** The org's projects already bound to it. Binding creates none (#577). */
  projects: { slug: string; repo: string }[];
};
export type InstallationRepo = {
  repo: string;
  repo_id: string;
  private: boolean;
  project: string | null;
  status: "new" | "in_org";
  mode: ChecksMode | null;
  paused: boolean;
};
export type AddedProject = {
  project: string;
  repo: string;
  created: boolean;
  reattached: boolean;
};
export type RemovedProject = { project: string; unbound: string[]; deleted: boolean };
/** A passkey confirmation for one exact action (`session_step_up_challenge`). */
export type OnboardingStepUp = {
  id: string;
  challenge: string;
  rpId: string;
  passkeys: { approver: string; passkeyId: string }[];
};
export type OnboardingStepUpProof = {
  id: string;
  approver: string;
  signature: {
    credential_id: string;
    client_data_json: string;
    authenticator_data: string;
    signature: string;
  };
};
export type OnboardRepoRow = { repo_id: string; enable: boolean; mode?: ChecksMode };
export type OnboardedProject = {
  slug: string;
  repo: string;
  enabled: boolean;
  mode: ChecksMode;
  paused: boolean;
};
export type PreviewJob = {
  job_id: string;
  name: string | null;
  verdict: "run" | "skip" | "fail";
  reason?: string;
  fix?: string;
  /** True when the workflow is ingested and the verdict is run. */
  will_run?: boolean;
  /** Names only: never a value. */
  refs?: PreviewRef[];
};
export type PreviewRef = {
  kind: "secret" | "var";
  name: string;
  where: string[];
  provided: boolean;
};
export type DispatchInput = {
  name: string;
  type: "string" | "boolean" | "number" | "choice" | "environment";
  required: boolean;
  default: string | null;
  options: string[];
  description: string | null;
};
export type PreviewWorkflow = {
  path: string;
  name: string | null;
  triggers: string[];
  ingested: boolean;
  too_large: boolean;
  /** The `on.workflow_dispatch` inputs; null when the workflow has no workflow_dispatch trigger. */
  dispatch_inputs?: DispatchInput[] | null;
  jobs: PreviewJob[];
};
export type WorkflowPreview = {
  sha: string;
  truncated: boolean;
  default_branch?: string;
  workflows: PreviewWorkflow[];
  needs_summary?: { needed: string[]; text: string };
};
export type DispatchedRun = {
  run_id: string;
  ref: string;
  sha: string;
  trust_class: string;
  state: "queued" | "awaiting_approval";
};
export type DefaultBranchRun = {
  run_id: string;
  sha: string;
  trust_class: string;
  created: boolean;
};

export interface OnboardingApi {
  listMyOrgs(): Promise<MyOrg[]>;
  createOrg(args: { slug: string; displayName: string }): Promise<CreatedOrg>;
  /** `installationId` opens that installation's configure page instead of a fresh install. */
  startClaim(args: { org: string; popup: boolean; installationId?: string }): Promise<StartedClaim>;
  getClaim(args: { org: string; claimId: string }): Promise<ClaimStatus>;
  /** The active installations this org has bound. */
  listOrgInstallations(args: { org: string }): Promise<OrgInstallation[]>;
  listUserInstallations(): Promise<UserInstallation[]>;
  bindInstallation(args: { org: string; installationId: string }): Promise<BoundInstallation>;
  listInstallationRepos(args: { org: string; installationId: string }): Promise<InstallationRepo[]>;
  onboardRepos(args: {
    org: string;
    installationId: string;
    repos: OnboardRepoRow[];
  }): Promise<OnboardedProject[]>;
  /** Makes one repo the installation reaches a project (`add_project`); `project` names its slug. */
  addProject(args: {
    org: string;
    installationId: string;
    repo: string;
    project?: string;
    /** The new project's cap on attempts at once; omitted, the org's default (2). */
    maxConcurrent?: number;
  }): Promise<AddedProject>;
  /**
   * Unbinds a project's repo and keeps its history (`remove_project`). `deleteHistory` deletes
   * the project and everything it ran, and needs `stepUp` (a passkey confirmation for exactly
   * this call) from a web session.
   */
  removeProject(args: {
    org: string;
    project: string;
    deleteHistory?: boolean;
    stepUp?: OnboardingStepUpProof;
  }): Promise<RemovedProject>;
  /** Starts a passkey confirmation for `remove_project` with `delete_history`. */
  removeProjectChallenge(args: { org: string; project: string }): Promise<OnboardingStepUp>;
  previewWorkflows(args: { org: string; project: string }): Promise<WorkflowPreview>;
  /** `list_project_vars`: the project's non-secret `vars.*` (plain text). */
  listProjectVars(args: { org: string; project: string }): Promise<ProjectVar[]>;
  /** `set_project_var`: create or replace one variable (an operator or above). */
  setProjectVar(args: {
    org: string;
    project: string;
    name: string;
    value: string;
  }): Promise<{ name: string; created: boolean }>;
  /** `delete_project_var`: remove one variable. `TURNTABLE_CI` is reserved. */
  deleteProjectVar(args: { org: string; project: string; name: string }): Promise<void>;
  runDefaultBranch(args: {
    org: string;
    project: string;
    onboardingId?: string;
  }): Promise<DefaultBranchRun>;
  /** `run_dispatch`: start a workflow_dispatch run (owner and admin sessions, #617). */
  runDispatch(args: {
    org: string;
    project: string;
    workflow: string;
    ref: string;
    inputs: Record<string, string>;
  }): Promise<DispatchedRun>;
  getRun(args: { org: string; runId: string }): Promise<WireRunDetail>;
  /**
   * Whether this server publishes the operation (by operationId in its OpenAPI document). A
   * failed lookup answers false, so a step that needs a missing operation stays hidden.
   */
  hasOperation(operationId: string): Promise<boolean>;
}

export type OnboardingApiOptions = {
  baseUrl?: string;
  /** Called on a 401: the session is gone. */
  onUnauthenticated?: () => void;
  fetch?: typeof fetch;
};

export function createOnboardingApi(options: OnboardingApiOptions = {}): OnboardingApi {
  const doFetch = options.fetch ?? versionAwareFetch;
  const base = `${options.baseUrl ?? ""}/api/v1`;

  async function call<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    query: Record<string, string | number | undefined> = {},
    body?: unknown,
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== "") qs.set(k, String(v));
    const res = await doFetch(`${base}${path}${qs.size > 0 ? `?${qs}` : ""}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
    });
    if (!res.ok) {
      let code = "internal";
      let message = `Request failed (${res.status})`;
      let reason: string | undefined;
      try {
        const e = (await res.json()) as WireError;
        code = e.error.code;
        message = e.error.message;
        const d = e.error.details;
        if (d && typeof d === "object" && typeof (d as { reason?: unknown }).reason === "string")
          reason = (d as { reason: string }).reason;
        const friendly = refusalMessage(code, message, d);
        if (friendly) message = friendly;
      } catch {
        // not JSON; keep the generic message
      }
      if (res.status === 401) options.onUnauthenticated?.();
      throw new ApiError(res.status, code, message, reason);
    }
    return (await res.json()) as T;
  }

  let operations: Promise<Set<string>> | null = null;

  return {
    async listMyOrgs() {
      return (await call<{ orgs: MyOrg[] }>("GET", "/account/orgs")).orgs;
    },
    createOrg({ slug, displayName }) {
      return call<CreatedOrg>("POST", "/account/orgs", {}, { slug, display_name: displayName });
    },
    startClaim({ org, popup, installationId }) {
      return call<StartedClaim>(
        "POST",
        "/github/installation-claims",
        {},
        { org, popup, ...(installationId ? { installation_id: installationId } : {}) },
      );
    },
    getClaim({ org, claimId }) {
      return call<ClaimStatus>(
        "GET",
        `/github/installation-claims/${encodeURIComponent(claimId)}`,
        {
          org,
        },
      );
    },
    async listOrgInstallations({ org }) {
      const w = await call<{ installations: OrgInstallation[] }>("GET", "/github/app", { org });
      return w.installations.filter((i) => i.status === "active");
    },
    async listUserInstallations() {
      return (await call<{ installations: UserInstallation[] }>("GET", "/account/installations"))
        .installations;
    },
    bindInstallation({ org, installationId }) {
      return call<BoundInstallation>(
        "POST",
        "/github/installations/bind",
        {},
        { org, installation_id: installationId },
      );
    },
    async listInstallationRepos({ org, installationId }) {
      const out: InstallationRepo[] = [];
      let cursor: string | undefined;
      // The server pages by name; read every page so the table is the whole grant.
      for (let page = 0; page < 50; page++) {
        const w = await call<{ repos: InstallationRepo[]; next_cursor: string | null }>(
          "GET",
          "/installation-repos",
          { org, installation_id: installationId, limit: 100, cursor },
        );
        out.push(...w.repos);
        if (!w.next_cursor) break;
        cursor = w.next_cursor;
      }
      return out;
    },
    async onboardRepos({ org, installationId, repos }) {
      return (
        await call<{ projects: OnboardedProject[] }>(
          "POST",
          "/onboard-repos",
          {},
          { org, installation_id: installationId, repos },
        )
      ).projects;
    },
    addProject({ org, installationId, repo, project, maxConcurrent }) {
      return call<AddedProject>(
        "POST",
        "/projects",
        {},
        {
          org,
          installation_id: installationId,
          repo,
          ...(project ? { project } : {}),
          ...(maxConcurrent !== undefined ? { max_concurrent: maxConcurrent } : {}),
        },
      );
    },
    removeProject({ org, project, deleteHistory, stepUp }) {
      return call<RemovedProject>(
        "POST",
        "/remove-project",
        {},
        {
          org,
          project,
          ...(deleteHistory ? { delete_history: true } : {}),
          ...(stepUp ? { step_up: stepUp } : {}),
        },
      );
    },
    async removeProjectChallenge({ org, project }) {
      const w = await call<{
        step_up_id: string;
        challenge: string;
        rp_id: string;
        passkeys: { approver: string; passkey_id: string }[];
      }>(
        "POST",
        "/session/step-up",
        {},
        {
          org,
          action: "remove_project",
          input: { org, project, delete_history: true },
        },
      );
      return {
        id: w.step_up_id,
        challenge: w.challenge,
        rpId: w.rp_id,
        passkeys: w.passkeys.map((k) => ({ approver: k.approver, passkeyId: k.passkey_id })),
      };
    },
    previewWorkflows({ org, project }) {
      return call<WorkflowPreview>("GET", "/workflow-preview", { org, project });
    },
    async listProjectVars({ org, project }) {
      const out: ProjectVar[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const w = await call<{ vars: ProjectVar[]; next_cursor: string | null }>(
          "GET",
          "/project-vars",
          { org, project, limit: 100, cursor },
        );
        out.push(...w.vars);
        if (!w.next_cursor) break;
        cursor = w.next_cursor;
      }
      return out;
    },
    setProjectVar({ org, project, name, value }) {
      return call<{ name: string; created: boolean }>(
        "POST",
        "/project-vars",
        {},
        { org, project, name, value },
      );
    },
    async deleteProjectVar({ org, project, name }) {
      await call<{ deleted: boolean }>("DELETE", "/project-vars", {}, { org, project, name });
    },
    runDefaultBranch({ org, project, onboardingId }) {
      return call<DefaultBranchRun>(
        "POST",
        "/run-default-branch",
        {},
        { org, project, ...(onboardingId ? { onboarding_id: onboardingId } : {}) },
      );
    },
    runDispatch({ org, project, workflow, ref, inputs }) {
      return call<DispatchedRun>(
        "POST",
        "/dispatches",
        {},
        { org, project, workflow, ref, inputs },
      );
    },
    getRun({ org, runId }) {
      return call<WireRunDetail>("GET", `/runs/${encodeURIComponent(runId)}`, { org });
    },
    async hasOperation(operationId) {
      operations ??= (async () => {
        try {
          const res = await doFetch(`${options.baseUrl ?? ""}/openapi.json`, {
            headers: { accept: "application/json" },
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer",
          });
          if (!res.ok) return new Set<string>();
          const doc = (await res.json()) as {
            paths?: Record<string, Record<string, { operationId?: unknown }>>;
          };
          const ids = new Set<string>();
          for (const item of Object.values(doc.paths ?? {}))
            for (const op of Object.values(item ?? {}))
              if (op && typeof op.operationId === "string") ids.add(op.operationId);
          return ids;
        } catch {
          return new Set<string>();
        }
      })();
      return (await operations).has(operationId);
    },
  };
}
