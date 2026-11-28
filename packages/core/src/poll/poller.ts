import type { Db } from "../db";
import {
  appendAudit,
  listIngestBindings,
  listInstalledRepos,
  queryRuns,
  type Scope,
} from "../db/repos";
import type { TrustClass } from "../trust";
import { backoffMs } from "./backoff";
import {
  ANONYMOUS_REQUESTS_PER_HOUR,
  ingestSettingsSchema,
  isPrimaryEntry,
  minAnonymousIntervalSeconds,
  type PollConfig,
  type PollRepoConfig,
  readPollToken,
  requestsPerPoll,
} from "./config";
import { type FetchLike, GithubClient, RateLimited } from "./github";
import {
  DispatchError,
  dispatchWorkflow,
  refuseAgentByName,
  type DispatchRequest,
  type DispatchResult,
} from "./dispatch";
import { newTagCaches, pollRepo, targetScope } from "./ingest";
import { githubNoticeWriter, type PrNoticeWriter } from "./pr-notices";
import type { DefaultBranchRunResult, RepoReader } from "./onboarding-forge";
import {
  ingestStatus,
  POLL_RESERVE,
  skippedFromRefused,
  type PollAuthMode,
  type RepoStatus,
} from "./status";

/** What the poller needs from the GitHub App: the one mint function (it caches until near expiry). */
export interface InstallationMinter {
  mint(
    installationId: string,
    scope: {
      repositories?: readonly string[];
      permissions?: Readonly<Record<string, "read" | "write">>;
    },
  ): Promise<{ token: string }>;
}

/** What a poll reads: nothing is written, so nothing more is asked for. */
/** What the App is asked for to remove a stale approval label and comment once (#666). */
const NOTICE_PERMISSIONS = { issues: "write", metadata: "read" } as const;

const POLL_PERMISSIONS = { contents: "read", metadata: "read", pull_requests: "read" } as const;

export type PollerOptions = {
  db: Db;
  /**
   * The GitHub App. A repo bound through an installation is then read with a token minted for that
   * one repo (read-only), which has its own 5,000 an hour budget; the poll token or no token
   * stays the fallback for every other repo and whenever a mint fails.
   */
  auth?: InstallationMinter | undefined;
  config: PollConfig;
  fetch?: FetchLike;
  now?: () => number;
  log?: (message: string) => void;
  /**
   * Also poll repos bound to a project through an installation, for projects that have ingest
   * settings (`turntable policy set --ingest`). A binding alone never causes ingest. A repo in the
   * static config wins over a binding of the same name.
   */
  bindings?: boolean;
  /** Called after a poll that queued runs, so the scheduler can start them at once. */
  onQueued?: () => void;
  /**
   * Called when a cancel-in-progress run took over running attempts of older runs: their workers
   * must stop and their sandboxes be destroyed.
   */
  onSuperseded?: (
    running: { attemptId: string; sandboxId: string | null; provider: string }[],
  ) => void;
};

const CLASSES: readonly TrustClass[] = ["protected", "release", "trusted_pr", "untrusted_pr"];

/** The class a stored run was decided to have (`runs.trust` JSON); unreadable reads as the strictest. */
function trustClassOfRun(trust: string | null): TrustClass {
  try {
    const c = (JSON.parse(trust ?? "null") as { class?: unknown } | null)?.class;
    return CLASSES.find((k) => k === c) ?? "untrusted_pr";
  } catch {
    return "untrusted_pr";
  }
}

/** Below this many requests left in the window the poller stops asking until it resets. */
const RESERVE = POLL_RESERVE;
/** The longest the first poll waits for the installations to load at startup. */
const INSTALLS_WARMUP_MS = 5000;
/** The fewest ms between two polls of one repo that webhooks asked for. */
export const MIN_NUDGE_GAP_MS = 5000;

/**
 * Polls every configured repo on its own interval. The token (read once from its file) is handed
 * to the read-only client and never logged. Failures back off exponentially, never shorter than
 * `Retry-After` or the rate-limit reset GitHub reported; a success resets the backoff. When the
 * remaining budget is nearly gone the poller waits for the reset instead of spending it.
 */
export class Poller {
  readonly #o: PollerOptions;
  readonly #github: GithubClient;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #failures = new Map<string, number>();
  readonly #overCap = new Set<string>();
  /** One client per installed repo: its own ETag cache and its own rate-limit reading. */
  readonly #installed = new Map<string, GithubClient>();
  /** Installation id per lower-case `owner/name`, for repos whose binding is in the repo's project. */
  #installs = new Map<string, string>();
  /** When a mint failure was last logged, per repo: one warning per interval. */
  readonly #mintWarned = new Map<string, number>();
  readonly #anonCancelNoted = new Set<string>();
  readonly #tagCaches = newTagCaches();
  readonly #busy = new Set<string>();
  readonly #again = new Set<string>();
  readonly #lastStart = new Map<string, number>();
  /** Repos from installation bindings with ingest settings, by lower-case `owner/name`. */
  readonly #bound = new Map<string, PollRepoConfig>();
  /** Ids of bound repos' projects, for auditing drift in the right chain. */
  readonly #boundIds = new Map<string, { orgId: string; projectId: string }>();
  /** The GitHub default branch last reported as drifted, per repo, so each change is said once. */
  readonly #drift = new Map<string, string>();
  /** Static entries whose repo moved: lower-case configured slug to the slug of the binding found by forge repo id. */
  readonly #effective = new Map<string, string>();
  /** The forge repo id each `org/project/slug` entry had when its slug matched a binding. */
  readonly #slugIds = new Map<string, string>();
  /** Failed id checks (`key|binding id`), so a stale entry costs one GitHub call per interval. */
  readonly #notMoved = new Map<string, number>();
  #refreshing: Promise<void> | undefined;
  #lastRefresh = 0;
  #refreshTimer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #anonymous = false;

  constructor(o: PollerOptions) {
    this.#o = o;
    const token = readPollToken(o.config);
    this.#anonymous = token === undefined;
    ingestStatus.fallbackAuth = token === undefined ? "anonymous" : "token";
    this.#github = new GithubClient({
      ...(o.fetch ? { fetch: o.fetch } : {}),
      baseUrl: o.config.apiBaseUrl,
      token,
      ...(o.now ? { now: o.now } : {}),
    });
    for (const r of o.config.repos) this.#track(r);
  }

  /** The config of a repo this poller serves: the static config first, then a binding. */
  #cfg(repo: string): PollRepoConfig | undefined {
    const l = repo.toLowerCase();
    return this.#o.config.repos.find((r) => r.repo.toLowerCase() === l) ?? this.#bound.get(l);
  }

  #allRepos(): PollRepoConfig[] {
    return [...this.#o.config.repos, ...this.#bound.values()];
  }

  /**
   * Every entry one poll of `repo` runs. A repo may have several static entries (one per workflow,
   * for example `ci.yml` plus a tag-triggered `release.yml`, #549); each is planned on its own,
   * keyed by its workflow. A bound repo has the one entry its settings make.
   */
  #cfgsFor(repo: string): PollRepoConfig[] {
    const l = repo.toLowerCase();
    const all = this.#o.config.repos;
    const eff = this.#effective.get(l);
    const fixed = all
      .filter((r) => r.repo.toLowerCase() === l)
      // The primary workflow keeps the plain check names; the others are named by workflow.
      .map((r) => ({ ...r, primary: isPrimaryEntry(all, r), ...(eff ? { repo: eff } : {}) }));
    if (fixed.length > 0) return fixed;
    const bound = this.#bound.get(l);
    return bound ? [bound] : [];
  }

  /** Repo names once each (several entries of one repo are polled together). */
  #repoNames(staticOnly = false): string[] {
    const seen = new Map<string, string>();
    for (const c of staticOnly ? this.#o.config.repos : this.#allRepos()) {
      if (!seen.has(c.repo.toLowerCase())) seen.set(c.repo.toLowerCase(), c.repo);
    }
    return [...seen.values()];
  }

  /**
   * Reads the repos bound to projects that have ingest settings. New ones start polling (when
   * running), removed ones stop at their next tick. Invalid settings are logged and skipped.
   * Coalesced, and at most once per MIN_NUDGE_GAP_MS.
   */
  refreshBindings(): Promise<void> {
    if (!this.#o.bindings) return Promise.resolve();
    if (this.#refreshing) return this.#refreshing;
    if (this.#now() - this.#lastRefresh < MIN_NUDGE_GAP_MS) return Promise.resolve();
    this.#refreshing = this.#refresh().finally(() => {
      this.#refreshing = undefined;
      this.#lastRefresh = this.#now();
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<void> {
    const log = this.#o.log ?? (() => {});
    const next = new Map<string, PollRepoConfig>();
    const rows = await listIngestBindings(this.#o.db);
    for (const b of rows) {
      const name = `${b.owner}/${b.repo}`;
      const key = name.toLowerCase();
      if (this.#o.config.repos.some((r) => r.repo.toLowerCase() === key)) continue;
      if (next.has(key)) {
        log(`ingest ${name}: bound to more than one project; only the first is ingested`);
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(b.config);
      } catch {
        log(`ingest ${name}: settings are not JSON; skipped`);
        continue;
      }
      const parsed = ingestSettingsSchema.safeParse(raw);
      if (!parsed.success) {
        log(`ingest ${name}: invalid settings; skipped`);
        continue;
      }
      next.set(key, {
        repo: name,
        org: b.orgSlug,
        project: b.projectSlug,
        ...parsed.data,
        untrustedEgress: "none",
        maxNewPrsPerPoll: 5,
        maxWaitingRuns: 20,
        maxRunsPerHour: 30,
      });
    }
    await this.#refreshInstalls(next).catch((e) =>
      log(`ingest installations: ${e instanceof Error ? e.message : String(e)}`),
    );
    for (const key of this.#bound.keys()) if (!next.has(key)) this.#bound.delete(key);
    this.#boundIds.clear();
    for (const b of rows) {
      const key = `${b.owner}/${b.repo}`.toLowerCase();
      // Only the project the repo is actually ingested into (a static entry or a second binding is not).
      if (next.get(key)?.project === b.projectSlug && next.get(key)?.org === b.orgSlug)
        this.#boundIds.set(key, { orgId: b.orgId, projectId: b.projectId });
    }
    for (const [key, cfg] of next) {
      const fresh = !this.#bound.has(key);
      this.#bound.set(key, cfg);
      if (fresh) {
        this.#track(cfg);
        if (this.#running) void this.#loop(cfg.repo);
      }
    }
  }

  #track(r: PollRepoConfig): void {
    const known = ingestStatus.repos.get(r.repo);
    if (known) {
      known.intervalSeconds = r.intervalSeconds;
      return;
    }
    ingestStatus.repos.set(r.repo, {
      repo: r.repo,
      org: r.org,
      project: r.project,
      intervalSeconds: r.intervalSeconds,
      lastPollAt: null,
      lastSuccessAt: null,
      lastOutcome: null,
      lastError: null,
      nextPollAt: null,
      consecutiveFailures: 0,
      runsCreated: 0,
      authMode: null,
      rateLimit: undefined,
    });
  }

  /**
   * The installation of each polled repo, from the bindings of the same org and project the repo
   * is polled into (a binding in another tenant never lends its installation). Best effort.
   */
  async #refreshInstalls(pending: ReadonlyMap<string, PollRepoConfig>): Promise<void> {
    if (!this.#o.auth) return;
    const rows = await listInstalledRepos(this.#o.db);
    const next = new Map<string, string>();
    const moved = new Map<string, string>();
    const cfgs = new Map<string, PollRepoConfig>();
    for (const [key, cfg] of pending) cfgs.set(key, cfg);
    for (const c of this.#o.config.repos) cfgs.set(c.repo.toLowerCase(), c);
    for (const [key, cfg] of cfgs) {
      const org = cfg.org ?? "local";
      const project = cfg.project ?? "local";
      const mine = rows.filter((b) => b.orgSlug === org && b.projectSlug === project);
      const same = mine.find((b) => `${b.owner}/${b.repo}`.toLowerCase() === key);
      if (same) {
        next.set(key, same.installationId);
        if (same.forgeRepoId !== null)
          this.#slugIds.set(`${org}/${project}/${key}`, same.forgeRepoId);
        continue;
      }
      // The entry's slug matches no binding of its own project. The repo may have been renamed or
      // transferred and its binding followed it by forge repo id: take that binding only when it
      // is this project's and its id is the one this entry's slug had (recorded, or confirmed with
      // GitHub). Never by name alone, never a binding of another project or org.
      if (!this.#o.config.repos.some((c) => c.repo.toLowerCase() === key)) continue;
      const taken = new Set(this.#o.config.repos.map((c) => c.repo.toLowerCase()));
      const candidates = mine.filter(
        (b) => b.forgeRepoId !== null && !taken.has(`${b.owner}/${b.repo}`.toLowerCase()),
      );
      const recorded = this.#slugIds.get(`${org}/${project}/${key}`);
      let found =
        recorded === undefined ? undefined : candidates.find((b) => b.forgeRepoId === recorded);
      if (!found && recorded === undefined) {
        const hits: typeof candidates = [];
        for (const b of candidates.slice(0, 5)) {
          if (await this.#sameRepoId(cfg.repo, b)) hits.push(b);
        }
        if (hits.length === 1) found = hits[0];
      }
      if (!found) continue;
      next.set(key, found.installationId);
      moved.set(key, `${found.owner}/${found.repo}`);
    }
    this.#installs = next;
    this.#effective.clear();
    for (const [key, v] of moved) this.#effective.set(key, v);
    for (const key of this.#installed.keys()) if (!next.has(key)) this.#installed.delete(key);
    for (const c of this.#o.config.repos) {
      const st = ingestStatus.repos.get(c.repo);
      if (st) st.effectiveRepo = moved.get(c.repo.toLowerCase());
    }
  }

  /** Whether GitHub says `slug` (redirected when renamed) is the repo with `b`'s forge repo id. */
  async #sameRepoId(
    slug: string,
    b: { owner: string; repo: string; installationId: string; forgeRepoId: string | null },
  ): Promise<boolean> {
    const memo = `${slug.toLowerCase()}|${b.owner}/${b.repo}|${b.forgeRepoId}`;
    const last = this.#notMoved.get(memo);
    if (last !== undefined && this.#now() - last < 600_000) return false;
    try {
      const { token } = await (this.#o.auth as InstallationMinter).mint(b.installationId, {
        repositories: [b.repo],
        permissions: POLL_PERMISSIONS,
      });
      const client = new GithubClient({
        ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
        baseUrl: this.#o.config.apiBaseUrl,
        ...(this.#o.now ? { now: this.#o.now } : {}),
        token,
      });
      if ((await client.repoIdentity(slug)).id === b.forgeRepoId) return true;
    } catch {
      // unknown: treated as not the same repo
    }
    this.#notMoved.set(memo, this.#now());
    return false;
  }

  /**
   * The client for one poll of `cfg`: for an installed repo, one carrying a token minted now for
   * that repo alone (the App's cache keeps it until near expiry and drops it on a freeze), else the
   * fallback. A failed mint is logged once per interval and never stalls the poll.
   */
  async #clientFor(cfg: PollRepoConfig): Promise<{ github: GithubClient; mode: PollAuthMode }> {
    const fallback = {
      github: this.#github,
      mode: this.#anonymous ? ("anonymous" as const) : ("token" as const),
    };
    const key = cfg.repo.toLowerCase();
    const installationId = this.#installs.get(key);
    if (!this.#o.auth || !installationId) return fallback;
    const slug = this.#effective.get(key) ?? cfg.repo;
    try {
      const { token } = await this.#o.auth.mint(installationId, {
        repositories: [slug.split("/")[1] as string],
        permissions: POLL_PERMISSIONS,
      });
      let client = this.#installed.get(key);
      if (!client) {
        client = new GithubClient({
          ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
          baseUrl: this.#o.config.apiBaseUrl,
          ...(this.#o.now ? { now: this.#o.now } : {}),
        });
        this.#installed.set(key, client);
      }
      client.setToken(token);
      return { github: client, mode: "installation" };
    } catch (err) {
      const now = this.#now();
      const last = this.#mintWarned.get(key);
      if (last === undefined || now - last >= cfg.intervalSeconds * 1000) {
        this.#mintWarned.set(key, now);
        this.#o.log?.(
          `poll ${cfg.repo}: could not mint an installation token, using ${fallback.mode}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return fallback;
    }
  }

  /**
   * A writer for the stale-label notices of one repo, minted only when called (a label turned out
   * stale) with `issues: write` for that one repo. Undefined when the repo has no installation or
   * the mint fails: the label stays and the run still waits.
   */
  #noticesFor(cfg: PollRepoConfig): () => Promise<PrNoticeWriter | undefined> {
    return async () => {
      const key = cfg.repo.toLowerCase();
      const installationId = this.#installs.get(key);
      if (!this.#o.auth || !installationId) return undefined;
      const slug = this.#effective.get(key) ?? cfg.repo;
      try {
        const { token } = await this.#o.auth.mint(installationId, {
          repositories: [slug.split("/")[1] as string],
          permissions: NOTICE_PERMISSIONS,
        });
        return githubNoticeWriter({
          baseUrl: this.#o.config.apiBaseUrl,
          token,
          ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
        });
      } catch {
        return undefined;
      }
    };
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /**
   * The one repo config of this project (a static poll entry, or its binding with ingest
   * settings), after a refresh of the bindings. `repo` is needed only when the project ingests
   * several. Throws a DispatchError when there is none, or several.
   */
  async #projectCfg(scope: Required<Scope>, repo: string | undefined): Promise<PollRepoConfig> {
    await this.refreshBindings().catch(() => {});
    const mine: PollRepoConfig[] = [];
    for (const key of new Set(this.#allRepos().map((c) => c.repo.toLowerCase()))) {
      if (repo !== undefined && key !== repo.toLowerCase()) continue;
      // The same config the poll loop uses: a static entry wins over a binding of the same name.
      // Of several static entries for the repo, the primary one (#552), not the first listed.
      const statics = this.#o.config.repos.filter((r) => r.repo.toLowerCase() === key);
      const primary = statics.find((r) => isPrimaryEntry(this.#o.config.repos, r));
      const cfg = (primary ?? this.#cfg(key)) as PollRepoConfig;
      const target = this.#o.config.repos.includes(cfg)
        ? await targetScope(this.#o.db, cfg).catch(() => undefined)
        : this.#boundIds.get(key);
      if (target && target.orgId === scope.orgId && target.projectId === scope.projectId) {
        mine.push(cfg);
      }
    }
    if (mine.length === 0) {
      throw new DispatchError(
        "not_found",
        repo === undefined
          ? "this project has no repo with ingest enabled"
          : `${repo} is not ingested by this project`,
      );
    }
    if (mine.length > 1) {
      throw new DispatchError(
        "invalid_input",
        `this project ingests several repos (${mine.map((c) => c.repo).join(", ")}): name one`,
      );
    }
    const only = mine[0] as PollRepoConfig;
    // A static entry carries its resolved primary flag, as the poll loop gives it.
    return this.#o.config.repos.includes(only)
      ? { ...only, primary: isPrimaryEntry(this.#o.config.repos, only) }
      : only;
  }

  /**
   * A read-only reader for one repo of an installation: a token minted now for that repo alone
   * (contents and metadata read). Used by the onboarding preview, which runs before a project has
   * ingest settings, so it cannot go through the project's config.
   */
  async repoReader(installationId: string, repo: string): Promise<RepoReader> {
    const auth = this.#o.auth;
    if (!auth) throw new DispatchError("unavailable", "this server has no GitHub App");
    const { token } = await auth.mint(installationId, {
      repositories: [repo.split("/")[1] as string],
      permissions: POLL_PERMISSIONS,
    });
    const client = new GithubClient({
      ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
      baseUrl: this.#o.config.apiBaseUrl,
      ...(this.#o.now ? { now: this.#o.now } : {}),
      token,
    });
    return {
      defaultBranch: () => client.repoDefaultBranch(repo),
      head: async (branch) => (await client.branchHead(repo, branch)).sha,
      listWorkflows: async (sha) =>
        (await client.listDir(repo, ".github/workflows", sha))
          .filter((e) => e.isFile)
          .map((e) => ({ path: e.path, size: e.size })),
      fileAt: (path, sha) => client.fileAt(repo, path, sha),
    };
  }

  /**
   * A push run of the default branch's head, through the same ingest path a poll takes: the same
   * trust decision (the default branch is protected), the same caps, the same dedupe marker. Only
   * the default-branch push candidate is considered (no PRs, tags or merge queue). Idempotent per
   * sha: a run that already exists for that head's push is returned with `created: false`.
   */
  async runDefaultBranch(
    scope: Required<Scope>,
    repo: string | undefined,
  ): Promise<DefaultBranchRunResult> {
    const configured = await this.#projectCfg(scope, repo);
    const { github, mode } = await this.#clientFor(configured);
    const eff = this.#effective.get(configured.repo.toLowerCase());
    const cfg = eff ? { ...configured, repo: eff } : configured;
    const head = await github.branchHead(cfg.repo, cfg.defaultBranch);
    const existing = async (): Promise<DefaultBranchRunResult | undefined> => {
      const [run] = await queryRuns(this.#o.db, scope, {
        sha: head.sha,
        event: "push",
        branch: cfg.defaultBranch,
        limit: 1,
      });
      if (!run) return undefined;
      return {
        runId: run.id,
        sha: head.sha,
        trustClass: trustClassOfRun(run.trust),
        created: false,
        repo: cfg.repo,
      };
    };
    const before = await existing();
    if (before) return before;
    const out = await pollRepo(
      {
        db: this.#o.db,
        github,
        provider: this.#o.config.provider,
        authMode: mode,
        ...(this.#o.now ? { now: this.#o.now } : {}),
        ...(this.#o.log ? { log: this.#o.log } : {}),
      },
      { ...cfg, prMode: "off", tagRefs: [], mergeQueue: false, everyPush: false },
    );
    if (out.superseded.length > 0) this.#o.onSuperseded?.(out.superseded);
    if (out.created.length > 0) this.#o.onQueued?.();
    // A poll of this repo may have raced us and made the run: it counts as the existing one.
    const after = await existing();
    if (after) return { ...after, created: out.created.includes(after.runId) };
    throw new DispatchError(
      "conflict",
      `no run was created: ${out.refused[0]?.reason ?? out.skipped ?? "the head was already handled"}`,
    );
  }

  /**
   * Starts one `workflow_dispatch` run for a repo of this project. The repo is one the project
   * ingests (a static poll entry for it, or its binding with ingest settings): a project with
   * neither refuses. `repo` is needed only when the project ingests several. The forge client is
   * the poller's own (read-only, an installation token when the repo has one).
   */
  async dispatch(
    scope: Required<Scope>,
    repo: string | undefined,
    req: DispatchRequest,
  ): Promise<DispatchResult & { repo: string }> {
    const repoCfg = await this.#projectCfg(scope, repo);
    // The entry for THIS workflow decides the vars, protected refs and tag rules; never the first
    // entry of the repo.
    const wanted = req.workflow.trim();
    const cfg = this.#cfgsFor(repoCfg.repo).find((c) => c.workflow === wanted);
    if (!cfg) {
      throw new DispatchError("invalid_input", `no poll entry for ${wanted} in ${repoCfg.repo}`);
    }
    // An agent token's policy is checked from the ref name before any forge call (a client may
    // mint an installation token).
    refuseAgentByName(cfg, req);
    const { github } = await this.#clientFor(repoCfg);
    const out = await dispatchWorkflow(
      {
        db: this.#o.db,
        github,
        provider: this.#o.config.provider,
        ...(this.#o.now ? { now: this.#o.now } : {}),
        ...(this.#o.log ? { log: this.#o.log } : {}),
      },
      cfg,
      scope,
      req,
    );
    if (out.superseded.length > 0) this.#o.onSuperseded?.(out.superseded);
    this.#o.onQueued?.();
    return { ...out, repo: cfg.repo };
  }

  /** Polls every repo once, now. For tests. */
  async pollAll(): Promise<void> {
    await this.refreshBindings();
    for (const repo of this.#repoNames()) await this.#pollOne(repo);
  }

  /**
   * Polling with no token is limited to 60 requests an hour for the whole address, and GitHub
   * counts a 304 against it for an anonymous caller. Say so when the intervals cannot fit.
   */
  #warnAnonymous(): void {
    const repos = this.#o.config.repos;
    const total = repos.reduce((n, r) => n + requestsPerPoll(r), 0);
    const perHour = repos.reduce((n, r) => n + (requestsPerPoll(r) * 3600) / r.intervalSeconds, 0);
    const log = this.#o.log ?? (() => {});
    log(
      `polling without a token: GitHub allows ${ANONYMOUS_REQUESTS_PER_HOUR} requests an hour per address; this config makes about ${Math.round(perHour)} an hour in steady state`,
    );
    if (perHour > ANONYMOUS_REQUESTS_PER_HOUR * 0.75) {
      log(
        `warning: use intervalSeconds of at least ${minAnonymousIntervalSeconds(total)} for ${repos.length} repo(s), or set tokenFile or tokenEnv`,
      );
    }
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    ingestStatus.running = true;
    ingestStatus.startedAt = this.#now();
    if (this.#anonymous) this.#warnAnonymous();
    const begin = (): void => {
      if (this.#running) for (const repo of this.#repoNames(true)) void this.#loop(repo);
    };
    const log = (e: unknown): void =>
      this.#o.log?.(`ingest bindings: ${e instanceof Error ? e.message : String(e)}`);
    if (this.#o.bindings) {
      this.#refreshTimer = setInterval(() => void this.refreshBindings().catch(log), 60_000);
    }
    if (!this.#o.auth) {
      begin();
      if (this.#o.bindings) void this.refreshBindings().catch(log);
      return;
    }
    // The installations are read before the first poll (a short wait, best effort), so a repo
    // with an installation is not polled with the fallback token after a restart (#568).
    const warm = this.#o.bindings
      ? this.refreshBindings()
      : this.#refreshInstalls(new Map()).catch(log);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, INSTALLS_WARMUP_MS);
    });
    void Promise.race([warm.catch(log), limit]).then(() => {
      clearTimeout(timer);
      begin();
    });
  }

  stop(): void {
    this.#running = false;
    ingestStatus.running = false;
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#refreshTimer = undefined;
  }

  /** Polls one repo and returns how long to wait before the next poll. */
  async #pollOne(repo: string): Promise<number> {
    const cfg = this.#cfg(repo)!;
    const cfgs = this.#cfgsFor(repo);
    const log = this.#o.log ?? (() => {});
    const status = ingestStatus.repos.get(repo) as RepoStatus;
    const intervalMs = Math.min(...cfgs.map((c) => c.intervalSeconds)) * 1000;
    const now = this.#now();

    const { github, mode } = await this.#clientFor(cfg);
    status.authMode = mode;
    if (mode === "anonymous" && !this.#anonCancelNoted.has(repo)) {
      this.#anonCancelNoted.add(repo);
      log(`poll ${repo}: anonymous poll, the closed-PR cancel check is skipped`);
    }

    const finish = (
      outcome: RepoStatus["lastOutcome"],
      error: string | null,
      waitMs: number,
    ): number => {
      status.lastPollAt = now;
      status.lastOutcome = outcome;
      status.lastError = error;
      status.nextPollAt = now + waitMs;
      status.consecutiveFailures = this.#failures.get(repo) ?? 0;
      status.rateLimit = github.rateLimit ?? status.rateLimit;
      // The fallback budget only moves with the fallback client; an installation has its own.
      if (mode !== "installation")
        ingestStatus.rateLimit = github.rateLimit ?? ingestStatus.rateLimit;
      return waitMs;
    };

    // Nearly out of budget: do not spend the rest, wait for the window to reset.
    const rate = github.rateLimit;
    if (
      rate?.remaining !== undefined &&
      rate.remaining <= RESERVE &&
      rate.resetAt !== undefined &&
      rate.resetAt > now
    ) {
      const wait = Math.max(rate.resetAt - now, intervalMs);
      log(
        `poll ${repo}: ${rate.remaining} requests left, waiting ${Math.round(wait / 1000)}s for the reset`,
      );
      return finish("rate_limited", "rate limit budget nearly spent", wait);
    }

    try {
      await this.#checkDrift(cfg, github);
      let created = 0;
      let skipped = false;
      const refused: { what: string; reason: string }[] = [];
      for (const entry of cfgs) {
        const res = await pollRepo(
          {
            db: this.#o.db,
            github,
            provider: this.#o.config.provider,
            overCap: this.#overCap,
            tagCaches: this.#tagCaches,
            authMode: mode,
            notices: this.#noticesFor(entry),
            ...(this.#o.now ? { now: this.#o.now } : {}),
            log,
          },
          entry,
        );
        if (res.skipped) {
          skipped = true;
          continue;
        }
        created += res.created.length + (res.released?.length ?? 0);
        refused.push(...res.refused);
        if (res.superseded.length > 0) this.#o.onSuperseded?.(res.superseded);
      }
      this.#failures.delete(repo);
      if (skipped)
        return finish("error", "bound to another project; poll entry is stale", intervalMs);
      status.lastSuccessAt = now;
      status.runsCreated += created;
      status.skippedPrs = skippedFromRefused(refused, status.skippedPrs, now);
      if (created > 0) this.#o.onQueued?.();
      return finish("ok", null, intervalMs);
    } catch (err) {
      const failures = (this.#failures.get(repo) ?? 0) + 1;
      this.#failures.set(repo, failures);
      if (err instanceof RateLimited) {
        const wait = backoffMs({
          intervalMs,
          failures,
          retryAfterMs: err.retryAfterMs,
          resetAt: err.resetAt,
          now,
        });
        log(`poll ${repo}: rate limited, backing off ${Math.round(wait / 1000)}s`);
        return finish("rate_limited", "rate limited by GitHub", wait);
      }
      const message = err instanceof Error ? err.message : "error";
      const wait = backoffMs({ intervalMs, failures, capMs: 900_000, now });
      log(`poll ${repo} failed: ${message}`);
      return finish("error", message, wait);
    }
  }

  /**
   * A repo ingested from its binding keeps the default branch stored when its settings were made;
   * it is never re-resolved, because a repo admin changing GitHub's default branch would move the
   * branch that counts as protected. If GitHub now says another branch, that is logged and
   * audited once per change and the stored one stays in use. Best effort: a failed look is not a
   * failed poll.
   */
  async #checkDrift(cfg: PollRepoConfig, github: GithubClient): Promise<void> {
    const key = cfg.repo.toLowerCase();
    const ids = this.#boundIds.get(key);
    if (!ids) return; // a static-config repo names its own branch
    let live: string;
    try {
      live = await github.repoDefaultBranch(cfg.repo);
    } catch {
      return;
    }
    if (live === cfg.defaultBranch) {
      this.#drift.delete(key);
      return;
    }
    if (this.#drift.get(key) === live) return;
    this.#drift.set(key, live);
    this.#o.log?.(
      `ingest ${cfg.repo}: GitHub's default branch is now ${live}; still using the stored ${cfg.defaultBranch}`,
    );
    await appendAudit(this.#o.db, ids, {
      principalKind: "system",
      principalId: "poller",
      op: "ingest_default_branch_drift",
      effect: "read",
      outcome: "ok",
      input: { repo: cfg.repo, stored: cfg.defaultBranch, github: live },
    }).catch(() => {});
  }

  /**
   * A webhook said something happened in `repo`: poll it now instead of at the next interval.
   * Only a repo this poller is configured for is acted on (the name from a payload selects, it
   * never adds), polls of one repo never overlap (an event during a poll asks for one more), and
   * events cannot poll a repo more than once per MIN_NUDGE_GAP_MS, so a flood costs one poll.
   */
  nudge(repo: string): boolean {
    if (!this.#running) return false;
    // A webhook naming the new slug of a moved repo wakes the entry that still has the old one.
    for (const [key, eff] of this.#effective) {
      if (eff.toLowerCase() === repo.toLowerCase()) repo = key;
    }
    const cfg = this.#cfg(repo);
    if (!cfg) {
      // Maybe a project was just given ingest settings: look once, then act if it is now known.
      if (this.#o.bindings) {
        void this.refreshBindings()
          .then(() => {
            if (this.#cfg(repo)) this.nudge(repo);
          })
          .catch(() => {});
      }
      return false;
    }
    // A repo that is backing off after errors or a rate limit stays backed off.
    if ((this.#failures.get(cfg.repo) ?? 0) > 0) return false;
    if (this.#busy.has(cfg.repo)) {
      this.#again.add(cfg.repo);
      return true;
    }
    const wait = Math.max(0, (this.#lastStart.get(cfg.repo) ?? 0) + MIN_NUDGE_GAP_MS - this.#now());
    const t = this.#timers.get(cfg.repo);
    if (t) clearTimeout(t);
    this.#timers.set(
      cfg.repo,
      setTimeout(() => void this.#loop(cfg.repo), wait),
    );
    return true;
  }

  async #loop(repo: string): Promise<void> {
    if (!this.#running) return;
    // A binding that lost its settings (or was unbound) stops here.
    if (!this.#cfg(repo)) return;
    this.#busy.add(repo);
    this.#lastStart.set(repo, this.#now());
    let next: number;
    try {
      next = await this.#pollOne(repo);
    } finally {
      this.#busy.delete(repo);
    }
    if (!this.#running) return;
    // An event arrived while polling: poll once more, soon, not at the full interval.
    if (this.#again.delete(repo)) next = Math.min(next, MIN_NUDGE_GAP_MS);
    this.#timers.set(
      repo,
      setTimeout(() => void this.#loop(repo), next),
    );
  }
}
