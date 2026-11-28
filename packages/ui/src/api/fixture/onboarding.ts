// A small in-memory onboarding backend for `bun run dev` (fixture mode): one org, one installation
// with three repos, and a claim that completes a few seconds after it starts. Nothing here is
// shipped to a server; it only lets the wizard be clicked through without GitHub.
import { ApiError } from "../http-adapter";
import type {
  ChecksMode,
  ClaimStatus,
  InstallationRepo,
  OnboardingApi,
  OnboardedProject,
} from "../onboarding";
import type { WireRunDetail } from "../wire";

export function createFixtureOnboarding(): OnboardingApi {
  const orgs = [{ slug: "acme", display_name: "Acme", role: "owner" as string }];
  let bound = false;
  const projectVars = [{ name: "TURNTABLE_CI", value: "true", reserved: true }];
  const repos: InstallationRepo[] = [
    {
      repo: "acme/web",
      repo_id: "1",
      private: true,
      project: "web",
      status: "in_org",
      mode: "off",
      paused: false,
    },
    {
      repo: "acme/api",
      repo_id: "2",
      private: true,
      project: null,
      status: "new",
      mode: null,
      paused: false,
    },
    {
      repo: "acme/docs",
      repo_id: "3",
      private: false,
      project: null,
      status: "new",
      mode: null,
      paused: false,
    },
  ];
  const claims = new Map<string, number>();
  return {
    async listMyOrgs() {
      return [...orgs];
    },
    async createOrg({ slug, displayName }) {
      if (orgs.some((o) => o.slug === slug))
        throw new ApiError(409, "conflict", "an org with that slug already exists");
      orgs.push({ slug, display_name: displayName, role: "owner" });
      return { org: { id: slug, slug, display_name: displayName }, role: "owner" };
    },
    async startClaim() {
      const id = `fixture-${claims.size + 1}`;
      claims.set(id, Date.now() + 3000);
      return {
        url: "https://github.com/apps/turntable-fixture/installations/new",
        expires_at: Date.now() + 900_000,
        claim_id: id,
      };
    },
    async getClaim({ claimId }): Promise<ClaimStatus> {
      const at = claims.get(claimId);
      if (at === undefined) throw new ApiError(404, "not_found", "no such claim");
      return Date.now() >= at
        ? ((bound = true), { state: "completed", installation_id: "100", account_login: "acme" })
        : { state: "pending" };
    },
    async listOrgInstallations() {
      return bound
        ? [
            {
              installation_id: "100",
              account_login: "acme",
              account_type: "Organization",
              status: "active",
            },
          ]
        : [];
    },
    async listUserInstallations() {
      return [
        {
          installation_id: "100",
          account_login: "acme",
          account_type: "Organization",
          repository_selection: "selected",
          bound: "none",
        },
        {
          installation_id: "200",
          account_login: "someone-else",
          account_type: "User",
          repository_selection: "all",
          bound: "other_org",
        },
      ];
    },
    async bindInstallation({ installationId }) {
      bound = true;
      return { installation_id: installationId, account_login: "acme", projects: [] };
    },
    async listInstallationRepos() {
      return repos.map((r) => ({ ...r }));
    },
    async onboardRepos({ repos: rows }): Promise<OnboardedProject[]> {
      for (const row of rows) {
        const r = repos.find((x) => x.repo_id === row.repo_id);
        if (!r) continue;
        const name = r.repo.split("/")[1] as string;
        r.project ??= name;
        r.status = "in_org";
        r.paused = !row.enable;
        r.mode = (row.mode ?? r.mode ?? "off") as ChecksMode;
      }
      return repos
        .filter((r) => r.project)
        .map((r) => ({
          slug: r.project as string,
          repo: r.repo,
          enabled: !r.paused,
          mode: (r.mode ?? "off") as ChecksMode,
          paused: r.paused,
        }));
    },
    async addProject({ repo }) {
      const r = repos.find((x) => x.repo === repo);
      if (!r)
        throw new ApiError(400, "invalid_input", `${repo} is not reachable by this installation`);
      const created = r.project === null;
      r.project ??= repo.split("/")[1] as string;
      r.status = "in_org";
      return { project: r.project, repo, created, reattached: false };
    },
    async removeProject({ project, deleteHistory }) {
      const r = repos.find((x) => x.project === project);
      if (r) {
        r.project = null;
        r.status = "new";
        r.mode = null;
      }
      return { project, unbound: r ? [r.repo] : [], deleted: deleteHistory === true };
    },
    async removeProjectChallenge() {
      throw new ApiError(400, "unavailable", "The demo has no passkeys to confirm with.");
    },
    async listProjectVars() {
      return projectVars.map((v) => ({ ...v }));
    },
    async setProjectVar({ name, value }) {
      if (name.toUpperCase() === "TURNTABLE_CI")
        throw new ApiError(400, "invalid_input", "TURNTABLE_CI is reserved and cannot be set");
      const cur = projectVars.find((v) => v.name.toUpperCase() === name.toUpperCase());
      if (cur) cur.value = value;
      else projectVars.push({ name, value, reserved: false });
      return { name, created: !cur };
    },
    async deleteProjectVar({ name }) {
      const at = projectVars.findIndex((v) => v.name === name && !v.reserved);
      if (at < 0) throw new ApiError(400, "invalid_input", `${name} cannot be removed`);
      projectVars.splice(at, 1);
    },
    async previewWorkflows() {
      return {
        sha: "0123456789abcdef0123456789abcdef01234567",
        truncated: false,
        default_branch: "main",
        workflows: [
          {
            path: ".github/workflows/ci.yml",
            name: "ci",
            triggers: ["push", "pull_request"],
            ingested: true,
            too_large: false,
            dispatch_inputs: null,
            jobs: [
              {
                job_id: "test",
                name: "test",
                verdict: "run",
                will_run: true,
                refs: [
                  { kind: "secret", name: "GITHUB_TOKEN", where: ["step env"], provided: true },
                  { kind: "var", name: "TURNTABLE_CI", where: ["job if"], provided: false },
                ],
              },
              {
                job_id: "mac",
                name: "mac",
                verdict: "fail",
                reason: "runs-on macos-latest is not supported",
                fix: "Use an ubuntu runner for this job.",
                will_run: false,
                refs: [
                  { kind: "secret", name: "DEPLOY_KEY", where: ["step env"], provided: false },
                ],
              },
            ],
          },
        ],
        needs_summary: { needed: [], text: "0 secrets needed" },
      };
    },
    async runDispatch({ ref }) {
      return {
        run_id: "fixture-dispatch",
        ref: `refs/heads/${ref}`,
        sha: "0123456789abcdef0123456789abcdef01234567",
        trust_class: "protected",
        state: "queued" as const,
      };
    },
    async runDefaultBranch() {
      return {
        run_id: "fixture-run",
        sha: "0123456789abcdef0123456789abcdef01234567",
        trust_class: "protected",
        created: true,
      };
    },
    async getRun({ runId }): Promise<WireRunDetail> {
      return {
        id: runId,
        project: "web",
        workflow_path: ".github/workflows/ci.yml",
        event: "push",
        ref: "refs/heads/main",
        sha: "0123456789abcdef0123456789abcdef01234567",
        workflow_name: "ci",
        commit_message: null,
        actor: null,
        head_branch: "main",
        pr_number: null,
        state: "success",
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        duration_ms: null,
        jobs: [],
      };
    },
    async hasOperation() {
      return false;
    },
  };
}
