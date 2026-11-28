// What the onboarding ops need from the forge and the poller, as seams the server fills in. A
// reader holds a read-only installation token for ONE repo and can only list the workflow
// directory and read files at a commit. Nothing here writes to GitHub.
import type { TrustClass } from "../trust";

export type WorkflowFileEntry = { path: string; size: number };

export interface RepoReader {
  /** The repo's default branch on GitHub. */
  defaultBranch(): Promise<string>;
  /** The commit a branch points at now. */
  head(branch: string): Promise<string>;
  /** The files directly in `.github/workflows` at a commit (names and sizes). */
  listWorkflows(sha: string): Promise<WorkflowFileEntry[]>;
  /** Raw file content at a commit, undefined when it does not exist there. */
  fileAt(path: string, sha: string): Promise<string | undefined>;
}

/** A reader for one repo of an installation. Rejects when the server has no GitHub App. */
export type RepoReaderFactory = (installationId: string, repo: string) => Promise<RepoReader>;

/**
 * Whether this instance can run a job that needs a container runtime (`services:`,
 * `container:`; `need` is the planner's reason), for a trusted run: `runnable`, or the refusal the
 * scheduler would give. Undefined when this process has no worker to ask.
 */
export type ContainerJobs = (
  need: string,
) => { runnable: true } | { runnable: false; reason: string } | undefined;

export type DefaultBranchRunResult = {
  runId: string;
  sha: string;
  trustClass: TrustClass;
  /** False when a run for that sha and event already existed and was returned. */
  created: boolean;
  repo: string;
};

/**
 * Starts a push run of the default branch's head through the poller's own ingest path, or returns
 * the run that already exists for that sha. Throws a DispatchError with the reason when it cannot.
 */
export type DefaultBranchRunner = (
  scope: { orgId: string; projectId: string },
  repo: string | undefined,
) => Promise<DefaultBranchRunResult>;
