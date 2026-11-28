import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Db,
  ensureLocalTenant,
  getJob,
  listAttempts,
  listAudit,
  listJobs,
  listRepos,
  listRuns,
  openDatabase,
  type Scope,
} from "../src/db";
import {
  backoffMs,
  gateHeadCommit,
  gatePullRequest,
  GithubClient,
  ingestStatus,
  resetIngestStatus,
  loadPollConfig,
  type PollConfig,
  Poller,
  pollConfigSchema,
  pollRepo,
  RateLimited,
} from "../src/poll";
import type { PollAuthMode } from "../src/poll/status";

let db: Db;
let scope: Required<Scope>;

const WORKFLOW = `name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
const SHA = (c: string) => c.repeat(40);

type PullStub = {
  number: number;
  title?: string;
  user: string | null;
  headSha: string;
  headRef?: string;
  headRepo: string | null;
  baseRepo?: string;
  /** Login of the head commit's author; defaults to the opener. null: no linked account. */
  headAuthor?: string | null;
  /** The head commit's message; defaults to a fixed text naming the PR. */
  commitMessage?: string;
};

/** A GitHub API stand-in served through fetch. */
function makeGithub(repo = "acme/web") {
  const state = {
    head: { sha: SHA("a"), message: "feat: first", login: "octocat" as string | null },
    pulls: [] as PullStub[],
    /** Numbers of pull requests GitHub reports as closed or merged (`GET /pulls/{n}`). */
    closed: new Set<number>(),
    files: new Map<string, string>(),
    calls: [] as { path: string; headers: Record<string, string> }[],
    fail: undefined as undefined | { status: number; headers?: Record<string, string> },
  };
  const workflowPath = ".github/workflows/ci.yml";
  const fetchStub = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    state.calls.push({ path: u.pathname + u.search, headers });
    if (state.fail) {
      return new Response("nope", { status: state.fail.status, headers: state.fail.headers ?? {} });
    }
    const etagged = (body: string, etag: string, type: string): Response => {
      if (headers["if-none-match"] === etag) return new Response(null, { status: 304 });
      return new Response(body, { headers: { etag, "content-type": type } });
    };
    if (u.pathname === `/repos/${repo}/commits/main`) {
      return etagged(
        JSON.stringify({
          sha: state.head.sha,
          commit: { message: state.head.message },
          author: state.head.login === null ? null : { login: state.head.login },
        }),
        `"head-${state.head.sha}"`,
        "application/json",
      );
    }
    if (u.pathname === `/repos/${repo}/branches/main`) return Response.json({ protected: true });
    const commit = new RegExp(`^/repos/${repo}/commits/([0-9a-f]{40})$`).exec(u.pathname);
    if (commit) {
      const pull = state.pulls.find((p) => p.headSha === commit[1]);
      const author = pull ? (pull.headAuthor === undefined ? pull.user : pull.headAuthor) : null;
      return etagged(
        JSON.stringify({
          sha: commit[1],
          commit: { message: pull?.commitMessage ?? `head commit of #${pull?.number}` },
          author: author === null ? null : { login: author },
        }),
        `"c-${commit[1]}"`,
        "application/json",
      );
    }
    const one = new RegExp(`^/repos/${repo}/pulls/(\\d+)$`).exec(u.pathname);
    if (one) return Response.json({ state: state.closed.has(Number(one[1])) ? "closed" : "open" });
    if (u.pathname === `/repos/${repo}/pulls`) {
      const body = state.pulls.map((p) => ({
        number: p.number,
        title: p.title ?? `PR ${p.number}`,
        user: p.user === null ? null : { login: p.user },
        head: {
          sha: p.headSha,
          ref: p.headRef ?? "topic",
          repo: p.headRepo === null ? null : { full_name: p.headRepo },
        },
        base: { repo: { full_name: p.baseRepo ?? repo } },
      }));
      return etagged(
        JSON.stringify(body),
        `"pulls-${JSON.stringify(body).length}"`,
        "application/json",
      );
    }
    if (u.pathname === `/repos/${repo}/contents/${workflowPath}`) {
      const sha = u.searchParams.get("ref") ?? "";
      const text = state.files.get(sha) ?? state.files.get("*");
      return text === undefined ? new Response("not found", { status: 404 }) : new Response(text);
    }
    return new Response("unexpected", { status: 500 });
  };
  state.files.set("*", WORKFLOW);
  return { state, fetch: fetchStub };
}

function config(
  over: Partial<PollConfig["repos"][number]> = {},
  top: Partial<PollConfig> = {},
): PollConfig {
  return pollConfigSchema.parse({
    allowUnauthenticated: true,
    ...top,
    repos: [
      {
        repo: "acme/web",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        prMode: "allowlist",
        prBaseline: false,
        authors: ["octocat", "hubot"],
        ...over,
      },
    ],
  });
}

const clientFor = (gh: ReturnType<typeof makeGithub>, token?: string) =>
  new GithubClient({ fetch: gh.fetch, baseUrl: "https://api.github.com", token });

beforeEach(async () => {
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
});

async function poll(gh: ReturnType<typeof makeGithub>, cfg = config(), now = 1_800_000_000_000) {
  return pollRepo({ db, github: clientFor(gh), provider: "docker", now: () => now }, cfg.repos[0]!);
}

test("a new default-branch commit becomes a queued run with its metadata and jobs", async () => {
  const gh = makeGithub();
  const res = await poll(gh);
  expect(res.created).toHaveLength(1);
  const [run] = await listRuns(db, scope);
  expect(run).toMatchObject({
    event: "push",
    ref: "refs/heads/main",
    sha: SHA("a"),
    actor: "octocat",
    commitMessage: "feat: first",
    headBranch: "main",
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    prNumber: null,
    status: "queued",
  });
  const jobs = await listJobs(db, scope, run!.id);
  expect(jobs.map((j) => [j.jobKey, JSON.parse(j.needs)])).toEqual([
    ["build", []],
    ["test", ["build"]],
  ]);
  for (const job of jobs) {
    expect((await getJob(db, scope, job.id))?.state).toBe("queued");
    expect((await listAttempts(db, scope, job.id)).map((a) => [a.state, a.provider])).toEqual([
      ["queued", "docker"],
    ]);
  }
  // the project is bound to the repo, so the worker knows what to fetch
  expect((await listRepos(db, scope)).map((r) => `${r.forge}:${r.owner}/${r.repo}`)).toEqual([
    "github:acme/web",
  ]);
});

test("ingest is idempotent per (repo, workflow, event, sha)", async () => {
  const gh = makeGithub();
  await poll(gh);
  await poll(gh);
  await poll(gh);
  expect(await listRuns(db, scope)).toHaveLength(1);
  gh.state.head = { sha: SHA("b"), message: "fix", login: "hubot" };
  await poll(gh);
  expect((await listRuns(db, scope)).map((r) => r.sha)).toEqual([SHA("b"), SHA("a")]);
  // the same sha as a push and as a PR head are different events: both run
  gh.state.pulls = [{ number: 3, user: "octocat", headSha: SHA("b"), headRepo: "acme/web" }];
  await poll(gh);
  const runs = await listRuns(db, scope);
  expect(runs.map((r) => [r.event, r.sha])).toEqual([
    ["pull_request", SHA("b")],
    ["push", SHA("b")],
    ["push", SHA("a")],
  ]);
  await poll(gh);
  expect(await listRuns(db, scope)).toHaveLength(3);
  // a new head sha of the same PR is a new run
  gh.state.pulls = [{ number: 3, user: "octocat", headSha: SHA("c"), headRepo: "acme/web" }];
  await poll(gh);
  expect(await listRuns(db, scope)).toHaveLength(4);
});

test("a same-repo PR by an allowlisted author runs, with its PR metadata", async () => {
  const gh = makeGithub();
  gh.state.pulls = [
    {
      number: 17,
      title: "Add feature",
      user: "HubOT",
      headSha: SHA("d"),
      headRef: "feature/x",
      headRepo: "acme/web",
      commitMessage: "feat: add the feature\n\nlonger body",
    },
  ];
  const res = await poll(gh);
  expect(res.created).toHaveLength(2); // the push and the PR
  const pr = (await listRuns(db, scope)).find((r) => r.event === "pull_request")!;
  expect(pr).toMatchObject({
    ref: "refs/pull/17/head",
    sha: SHA("d"),
    actor: "HubOT",
    prNumber: 17,
    headBranch: "feature/x",
    commitMessage: "feat: add the feature\n\nlonger body",
  });
});

test("the PR gate: a fork is never run, whatever else is true", () => {
  const cfg = { repo: "acme/web", prMode: "allowlist" as const, authors: ["octocat"] };
  const ok = {
    baseRepo: "acme/web",
    headRepo: "acme/web",
    author: "octocat",
    headAuthor: "octocat",
  };
  expect(gatePullRequest(cfg, ok).ok).toBe(true);
  expect(gatePullRequest(cfg, { ...ok, author: "OCTOCAT" }).ok).toBe(true); // logins are case-insensitive
  expect(gatePullRequest({ ...cfg, repo: "Acme/Web" }, ok).ok).toBe(true); // so are repo names

  const refused: [string, Parameters<typeof gatePullRequest>[1]][] = [
    ["fork under another owner", { ...ok, headRepo: "octocat/web" }],
    ["fork with the same name elsewhere", { ...ok, headRepo: "evil/web" }],
    ["lookalike name", { ...ok, headRepo: "acme/web2" }],
    ["lookalike owner", { ...ok, headRepo: "acme-x/web" }],
    ["prefix of the name", { ...ok, headRepo: "acme/we" }],
    ["suffix on the owner", { ...ok, headRepo: "acme/web-fork" }],
    ["deleted fork", { ...ok, headRepo: null }],
    ["base is another repo", { ...ok, baseRepo: "acme/other" }],
    ["no author login", { ...ok, author: null }],
    ["author not on the allowlist", { ...ok, author: "mallory" }],
    ["author contains an allowlisted login", { ...ok, author: "octocat-evil" }],
  ];
  for (const [name, pr] of refused) {
    const v = gatePullRequest(cfg, pr);
    expect(v.ok, name).toBe(false);
  }
  // an allowlisted author on a FORK is still refused
  const fork = gatePullRequest(cfg, {
    baseRepo: "acme/web",
    headRepo: "octocat/web",
    author: "octocat",
    headAuthor: "octocat",
  });
  expect(fork).toEqual({ ok: false, reason: "head repo is a fork" });
  // and PR mode off refuses everything, even a perfect PR
  expect(gatePullRequest({ ...cfg, prMode: "off" }, ok).ok).toBe(false);
  // an empty allowlist refuses every PR
  expect(gatePullRequest({ ...cfg, authors: [] }, ok).ok).toBe(false);
});

test("through the poller: forks and non-allowlisted PRs create no run at all", async () => {
  const gh = makeGithub();
  gh.state.pulls = [
    { number: 1, user: "octocat", headSha: SHA("1"), headRepo: "octocat/web" }, // allowlisted, but a fork
    { number: 2, user: "mallory", headSha: SHA("2"), headRepo: "acme/web" }, // same repo, not allowlisted
    { number: 3, user: "octocat", headSha: SHA("3"), headRepo: null }, // deleted fork
    { number: 4, user: "octocat", headSha: SHA("4"), headRepo: "acme/web", baseRepo: "acme/other" },
    { number: 5, user: "hubot", headSha: SHA("5"), headRepo: "acme/web" }, // the only good one
  ];
  const res = await poll(gh);
  const prs = (await listRuns(db, scope)).filter((r) => r.event === "pull_request");
  expect(prs.map((r) => r.prNumber)).toEqual([5]);
  expect(res.refused.map((r) => r.what).toSorted()).toEqual(["pr #1", "pr #2", "pr #3", "pr #4"]);
  expect(res.refused.find((r) => r.what === "pr #1")?.reason).toBe("head repo is a fork");
  // the workflow of a refused PR is never even fetched
  for (const sha of ["1", "2", "3", "4"]) {
    expect(gh.state.calls.some((c) => c.path.includes(`ref=${SHA(sha)}`))).toBe(false);
  }
  // with PR mode off, even the good PR is ignored and the PR list is not requested
  const gh2 = makeGithub();
  gh2.state.pulls = [{ number: 9, user: "octocat", headSha: SHA("9"), headRepo: "acme/web" }];
  const db2 = openDatabase(":memory:");
  await pollRepo(
    { db: db2, github: clientFor(gh2), provider: "docker" },
    config({ prMode: "off" }).repos[0]!,
  );
  expect(gh2.state.calls.some((c) => c.path.includes("/pulls"))).toBe(false);
  expect((await listRuns(db2, await ensureLocalTenant(db2))).map((r) => r.event)).toEqual(["push"]);
});

test("the hourly cap stops runs and lifts an hour later", async () => {
  const gh = makeGithub();
  const cfg = config({ maxRunsPerHour: 2 });
  const T = 1_800_000_000_000;
  await poll(gh, cfg, T);
  gh.state.head = { sha: SHA("b"), message: "m", login: "octocat" };
  await poll(gh, cfg, T + 60_000);
  gh.state.head = { sha: SHA("c"), message: "m", login: "octocat" };
  const capped = await poll(gh, cfg, T + 120_000);
  expect(capped.created).toEqual([]);
  expect(capped.refused[0]?.reason).toBe("hourly run cap reached");
  expect(await listRuns(db, scope)).toHaveLength(2);
  const later = await poll(gh, cfg, T + 3_700_000);
  expect(later.created).toHaveLength(1);
  expect(await listRuns(db, scope)).toHaveLength(3);
});

test("a workflow that is missing or invalid at the commit creates no run", async () => {
  const gh = makeGithub();
  gh.state.files.clear();
  const missing = await poll(gh);
  expect(missing.refused[0]?.reason).toContain("workflow not found");
  gh.state.files.set("*", "jobs: [not, a, map");
  expect((await poll(gh)).refused[0]?.reason).toContain("plan rejected");
  gh.state.files.set("*", "name: empty\non: push\n");
  expect((await poll(gh)).created).toEqual([]);
  expect(await listRuns(db, scope)).toHaveLength(0);
});

test("conditional requests: an unchanged repo is answered with 304 and costs nothing", async () => {
  const gh = makeGithub();
  const client = clientFor(gh);
  const cfg = config().repos[0]!;
  const deps = { db, github: client, provider: "docker" };
  await pollRepo(deps, cfg);
  await pollRepo(deps, cfg);
  const heads = gh.state.calls.filter((c) => c.path.endsWith("/commits/main"));
  expect(heads).toHaveLength(2);
  expect(heads[0]!.headers["if-none-match"]).toBeUndefined();
  expect(heads[1]!.headers["if-none-match"]).toBe(`"head-${SHA("a")}"`);
  expect(await listRuns(db, scope)).toHaveLength(1);
});

test("rate limits surface as RateLimited with the reset time, and the poller backs off", async () => {
  const gh = makeGithub();
  gh.state.fail = {
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000100" },
  };
  const err = await pollRepo(
    { db, github: clientFor(gh), provider: "docker" },
    config().repos[0]!,
  ).catch((e) => e);
  expect(err).toBeInstanceOf(RateLimited);
  expect((err as RateLimited).resetAt).toBe(1_800_000_100_000);
  // a plain 403 (not a rate limit) is an ordinary error
  gh.state.fail = { status: 403 };
  const plain = await pollRepo(
    { db, github: clientFor(gh), provider: "docker" },
    config().repos[0]!,
  ).catch((e) => e);
  expect(plain).not.toBeInstanceOf(RateLimited);

  const logs: string[] = [];
  gh.state.fail = { status: 429, headers: { "x-ratelimit-reset": "1800000100" } };
  const poller = new Poller({
    db,
    config: config(),
    fetch: gh.fetch,
    now: () => 1_800_000_000_000,
    log: (m) => logs.push(m),
  });
  await poller.pollAll();
  expect(logs.some((l) => l.includes("rate limited, backing off 100s"))).toBe(true);
});

test("the token comes from a file, goes only into the Authorization header, and is never logged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-poll-"));
  try {
    const secret = `tok-${randomUUID()}`;
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, `${secret}\n`);
    const gh = makeGithub();
    const logs: string[] = [];
    const queued: number[] = [];
    const poller = new Poller({
      db,
      config: config({}, { tokenFile }),
      fetch: gh.fetch,
      log: (m) => logs.push(m),
      onQueued: () => queued.push(1),
    });
    await poller.pollAll();
    expect(queued).toHaveLength(1);
    expect(gh.state.calls.length).toBeGreaterThan(0);
    for (const c of gh.state.calls) expect(c.headers.authorization).toBe(`Bearer ${secret}`);

    // failures never echo the token, the headers or the file's content
    gh.state.fail = { status: 500 };
    await poller.pollAll();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(secret);

    // no token configured: no Authorization header at all
    const anon = makeGithub();
    await new Poller({
      db: openDatabase(":memory:"),
      config: config(),
      fetch: anon.fetch,
    }).pollAll();
    for (const c of anon.state.calls) expect(c.headers.authorization).toBeUndefined();

    // a missing or empty token file is a startup error that does not leak content
    expect(
      () =>
        new Poller({ db, config: config({}, { tokenFile: join(dir, "nope") }), fetch: gh.fetch }),
    ).toThrow(/cannot read token file/);
    writeFileSync(join(dir, "empty"), "\n");
    expect(
      () =>
        new Poller({ db, config: config({}, { tokenFile: join(dir, "empty") }), fetch: gh.fetch }),
    ).toThrow(/is empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: strict, defaults to safe values, and refuses an inline token", () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-poll-"));
  try {
    const write = (obj: unknown) => {
      const p = join(dir, "c.json");
      writeFileSync(p, JSON.stringify(obj));
      return p;
    };
    const base = {
      allowUnauthenticated: true,
      repos: [{ repo: "acme/web", workflow: ".github/workflows/ci.yml", defaultBranch: "main" }],
    };
    const cfg = loadPollConfig(write(base));
    expect(cfg.repos[0]).toMatchObject({
      intervalSeconds: 60,
      prMode: "off",
      authors: [],
      maxRunsPerHour: 30,
      org: "local",
      project: "local",
    });
    expect(cfg.apiBaseUrl).toBe("https://api.github.com");

    expect(() => loadPollConfig(write({ ...base, token: "hunter2hunter2" }))).toThrow(
      /invalid poll config/,
    );
    expect(() => loadPollConfig(write({ ...base, token: "hunter2hunter2" }))).not.toThrow(
      /hunter2/,
    );
    expect(() =>
      loadPollConfig(write({ repos: [{ ...base.repos[0], prmode: "allowlist" }] })),
    ).toThrow(/prmode|Unrecognized/i);
    expect(() =>
      loadPollConfig(write({ repos: [{ ...base.repos[0], repo: "not-a-repo" }] })),
    ).toThrow(/owner\/name/);
    expect(() => loadPollConfig(write({ repos: [{ ...base.repos[0], prMode: "all" }] }))).toThrow(
      /prMode/,
    );
    expect(() => loadPollConfig(write({ repos: [] }))).toThrow(/invalid poll config/);
    expect(() => loadPollConfig(join(dir, "missing.json"))).toThrow(/cannot read poll config/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a poll that fails on one repo does not stop the others, and is retried", async () => {
  const gh = makeGithub();
  const logs: string[] = [];
  const cfg = pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      { repo: "acme/missing", workflow: ".github/workflows/ci.yml", defaultBranch: "main" },
      { repo: "acme/web", workflow: ".github/workflows/ci.yml", defaultBranch: "main" },
    ],
  });
  const poller = new Poller({ db, config: cfg, fetch: gh.fetch, log: (m) => logs.push(m) });
  await poller.pollAll();
  expect(logs.some((l) => l.includes("acme/missing failed"))).toBe(true);
  expect(await listRuns(db, scope)).toHaveLength(1);
});

// ---- head commit author ----

test("the gate also needs the HEAD COMMIT's author on the allowlist", async () => {
  const gh = makeGithub();
  gh.state.pulls = [
    // opened by an allowlisted login, but the commit that would run was written by someone else
    { number: 1, user: "octocat", headSha: SHA("1"), headRepo: "acme/web", headAuthor: "mallory" },
    // no GitHub account linked to the head commit's author email
    { number: 2, user: "octocat", headSha: SHA("2"), headRepo: "acme/web", headAuthor: null },
    // a bot that is not listed
    { number: 3, user: "octocat", headSha: SHA("3"), headRepo: "acme/web", headAuthor: "nc9[bot]" },
    // opener not allowlisted, commit author is: still refused (both must pass)
    { number: 4, user: "mallory", headSha: SHA("4"), headRepo: "acme/web", headAuthor: "octocat" },
    // both allowlisted: runs
    { number: 5, user: "hubot", headSha: SHA("5"), headRepo: "acme/web", headAuthor: "octocat" },
  ];
  const res = await poll(gh);
  expect(
    (await listRuns(db, scope)).filter((r) => r.event === "pull_request").map((r) => r.prNumber),
  ).toEqual([5]);
  const why = Object.fromEntries(res.refused.map((r) => [r.what, r.reason]));
  expect(why["pr #1"]).toBe("head commit author is not on the allowlist");
  expect(why["pr #2"]).toBe("head commit has no linked GitHub account");
  expect(why["pr #3"]).toBe("head commit author is not on the allowlist");
  expect(why["pr #4"]).toBe("author is not on the allowlist");
  // the head commit is only fetched for PRs that passed the cheap checks, and cached by ETag (and
  // the default branch's head, once, for its push's `before`)
  const commitCalls = gh.state.calls.filter((c) => /\/commits\/[0-9a-f]{40}$/.test(c.path));
  expect(commitCalls.map((c) => c.path.slice(-40)).toSorted()).toEqual([
    SHA("1"),
    SHA("2"),
    SHA("3"),
    SHA("5"),
    SHA("a"),
  ]);
  // the workflow of a refused PR is never fetched
  for (const sha of ["1", "2", "3", "4"]) {
    expect(gh.state.calls.some((c) => c.path.includes(`ref=${SHA(sha)}`))).toBe(false);
  }
  // a listed bot is accepted only because its exact login is listed
  const cfg = config({ authors: ["octocat", "dependabot[bot]"] });
  gh.state.pulls = [
    {
      number: 6,
      user: "dependabot[bot]",
      headSha: SHA("6"),
      headRepo: "acme/web",
      headAuthor: "dependabot[bot]",
    },
  ];
  await pollRepo({ db, github: clientFor(gh), provider: "docker" }, cfg.repos[0]!);
  expect((await listRuns(db, scope)).some((r) => r.prNumber === 6)).toBe(true);
  expect(gateHeadCommit({ authors: ["nc9"] }, "NC9").ok).toBe(true);
  expect(gateHeadCommit({ authors: ["nc9"] }, "nc9[bot]").ok).toBe(false);
});

// ---- the client is read-only and keeps the token out of URLs ----

test("the GitHub client only ever sends GET, never puts the token in a URL, and has no write methods", async () => {
  const gh = makeGithub();
  gh.state.pulls = [{ number: 1, user: "octocat", headSha: SHA("1"), headRepo: "acme/web" }];
  const secret = `tok-${randomUUID()}`;
  const seen: { url: string; method: string | undefined; headers: Record<string, string> }[] = [];
  const spying = async (url: string, init?: RequestInit) => {
    seen.push({
      url,
      method: init?.method,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    });
    return gh.fetch(url, init);
  };
  const client = new GithubClient({
    fetch: spying,
    baseUrl: "https://api.github.com",
    token: secret,
  });
  await client.branchHead("acme/web", "main");
  await client.openPulls("acme/web");
  await client.commitInfo("acme/web", SHA("1"));
  await client.fileAt("acme/web", ".github/workflows/ci.yml", SHA("a"));
  await client.branchHead("acme/web", "main"); // a conditional repeat
  await client.collaboratorPermission("acme/web", "octocat").catch(() => {});
  await client.branchProtected("acme/web", "main").catch(() => {});
  // listDir is a read-only contents listing (a single GET); the stub's 500 is swallowed here
  await client.listDir("acme/web", ".github/workflows", SHA("a")).catch(() => {});
  expect(seen.some((s) => s.url.includes("/contents/.github/workflows?ref="))).toBe(true);
  expect(seen.length).toBeGreaterThanOrEqual(5);
  for (const s of seen) {
    expect(s.method).toBe("GET");
    expect(s.url.startsWith("https://api.github.com/")).toBe(true);
    expect(s.url).not.toContain(secret);
    expect(s.headers.authorization).toBe(`Bearer ${secret}`);
  }
  // the public surface offers nothing that writes
  const methods = Object.getOwnPropertyNames(GithubClient.prototype).filter(
    (m) => m !== "constructor",
  );
  expect(methods.toSorted()).toEqual([
    "branchHead",
    "branchProtected",
    "changedFiles",
    "collaboratorPermission",
    "commitInfo",
    "fileAt",
    "firstParentChain",
    "firstParentsSince",
    "listDir",
    "openPulls",
    "peelTag",
    "prTimeline",
    "pullState",
    "pushEvents",
    "queueBranches",
    "queueCommit",
    "rateLimit",
    "refObject",
    "repoDefaultBranch",
    "repoIdentity",
    "setToken",
    "tagRefs",
    "tagRulesets",
  ]);
  for (const m of methods)
    expect(m).not.toMatch(/post|put|patch|delete|create|update|merge|comment|dispatch/i);
  // a sha that is not hex cannot be smuggled into a path
  await expect(client.commitInfo("acme/web", "../../user")).rejects.toThrow();
  expect(seen.every((s) => !s.url.includes(".."))).toBe(true);
  // the whole poll path obeys the same rule
  const all: string[] = [];
  const poller = new Poller({
    db,
    config: config(),
    fetch: async (u, i) => {
      all.push(i?.method ?? "");
      return gh.fetch(u, i);
    },
  });
  await poller.pollAll();
  expect(all.length).toBeGreaterThan(0);
  expect(new Set(all)).toEqual(new Set(["GET"]));
});

// ---- backoff, Retry-After, budget ----

test("backoff is exponential, capped, and never shorter than the server asked", () => {
  const base = { intervalMs: 60_000, now: 1_000_000 };
  expect(backoffMs({ ...base, failures: 1 })).toBe(60_000);
  expect(backoffMs({ ...base, failures: 2 })).toBe(120_000);
  expect(backoffMs({ ...base, failures: 3 })).toBe(240_000);
  expect(backoffMs({ ...base, failures: 20 })).toBe(3_600_000); // capped
  expect(backoffMs({ ...base, failures: 20, capMs: 900_000 })).toBe(900_000);
  expect(backoffMs({ ...base, failures: 1, retryAfterMs: 300_000 })).toBe(300_000);
  expect(backoffMs({ ...base, failures: 1, resetAt: base.now + 500_000 })).toBe(500_000);
  expect(backoffMs({ ...base, failures: 3, retryAfterMs: 10_000 })).toBe(240_000); // exponential wins
  expect(backoffMs({ ...base, failures: 1, resetAt: base.now - 5 })).toBe(60_000); // reset already passed
});

test("the poller honours Retry-After on a secondary limit and backs off harder on repeats", async () => {
  resetIngestStatus();
  const gh = makeGithub();
  const logs: string[] = [];
  let now = 1_800_000_000_000;
  const poller = new Poller({
    db,
    config: config(),
    fetch: gh.fetch,
    now: () => now,
    log: (m) => logs.push(m),
  });
  gh.state.fail = { status: 403, headers: { "retry-after": "240" } }; // no x-ratelimit-remaining at all
  await poller.pollAll();
  expect(logs.at(-1)).toContain("rate limited, backing off 240s");
  expect(ingestStatus.repos.get("acme/web")).toMatchObject({
    lastOutcome: "rate_limited",
    consecutiveFailures: 1,
  });
  await poller.pollAll();
  gh.state.fail = { status: 500 };
  await poller.pollAll();
  expect(ingestStatus.repos.get("acme/web")?.consecutiveFailures).toBe(3);
  expect(ingestStatus.repos.get("acme/web")?.lastError).toBe(
    "GitHub API 500 for /repos/acme/web/commits/main",
  );
  const st = ingestStatus.repos.get("acme/web")!;
  expect(st.nextPollAt! - now).toBe(240_000); // 3rd failure: 60s * 4
  // a success resets it
  gh.state.fail = undefined;
  now += 1000;
  await poller.pollAll();
  expect(ingestStatus.repos.get("acme/web")).toMatchObject({
    lastOutcome: "ok",
    consecutiveFailures: 0,
    runsCreated: 1,
  });
});

test("the remaining budget is tracked from the headers, and a nearly spent budget stops polling", async () => {
  resetIngestStatus();
  const gh = makeGithub();
  const logs: string[] = [];
  const now = 1_800_000_000_000;
  const resetAt = now + 1_800_000;
  const withBudget = async (url: string, init?: RequestInit) => {
    const res = await gh.fetch(url, init);
    const headers = new Headers(res.headers);
    headers.set("x-ratelimit-limit", "5000");
    headers.set("x-ratelimit-remaining", String(budget));
    headers.set("x-ratelimit-reset", String(resetAt / 1000));
    headers.set("x-ratelimit-resource", "core");
    return new Response(res.status === 304 ? null : await res.text(), {
      status: res.status,
      headers,
    });
  };
  let budget = 4000;
  const poller = new Poller({
    db,
    config: config(),
    fetch: withBudget,
    now: () => now,
    log: (m) => logs.push(m),
  });
  await poller.pollAll();
  expect(ingestStatus.rateLimit).toMatchObject({
    limit: 5000,
    remaining: 4000,
    resetAt,
    resource: "core",
  });
  const calls = gh.state.calls.length;

  budget = 3; // at or below the reserve
  await poller.pollAll(); // observes 3 via a real request
  const afterObserve = gh.state.calls.length;
  expect(afterObserve).toBeGreaterThan(calls);
  await poller.pollAll(); // now it should not spend the rest
  expect(gh.state.calls.length).toBe(afterObserve);
  expect(logs.at(-1)).toContain("waiting 1800s for the reset");
  expect(ingestStatus.repos.get("acme/web")).toMatchObject({ lastOutcome: "rate_limited" });
});

test("ingest_status reports the caller's org repos and the budget over the ops registry", async () => {
  resetIngestStatus();
  const { dispatch, registry } = await import("../src/ops");
  const { mintToken } = await import("./ops-helpers");
  const org = (await import("../src/db")).getOrgById;
  const o = (await org(db, scope.orgId))!;
  const gh = makeGithub();
  const poller = new Poller({
    db,
    config: config(),
    fetch: gh.fetch,
    now: () => 1_800_000_000_000,
  });
  await poller.pollAll();
  const tok = (await mintToken(db, { orgId: scope.orgId }, "reader")).secret;
  const res = await dispatch({ registry, db }, { kind: "bearer", token: tok }, "ingest_status", {});
  expect(res.ok).toBe(true);
  if (res.ok) {
    const out = res.output as {
      running: boolean;
      repos: { repo: string; last_outcome: string; runs_created: number }[];
      rate_limit: unknown;
    };
    expect(out.repos).toEqual([
      expect.objectContaining({ repo: "acme/web", last_outcome: "ok", runs_created: 1 }),
    ]);
    expect(JSON.stringify(out)).not.toContain("tokenFile");
  }
  // another org sees nothing, and no budget either
  const other = await (await import("../src/db")).createOrg(db, { slug: "other", name: "o" });
  const otherTok = (await mintToken(db, { orgId: other.id }, "reader")).secret;
  const none = await dispatch(
    { registry, db },
    { kind: "bearer", token: otherTok },
    "ingest_status",
    {},
  );
  expect(none.ok && none.output).toEqual({
    running: false,
    rate_limit: null,
    rate_limit_by_mode: { anonymous: null, poll_token: null, installation: null },
    repos: [],
  });
  void o;
});

// ---- config: authenticated, sane interval ----

test("polling must be authenticated unless explicitly opted out, and intervals are sane", () => {
  const repo = { repo: "acme/web", workflow: "w.yml", defaultBranch: "main" };
  expect(() => pollConfigSchema.parse({ repos: [repo] })).toThrow(/authenticated/);
  expect(() => pollConfigSchema.parse({ tokenFile: "/x/token", repos: [repo] })).not.toThrow();
  expect(() => pollConfigSchema.parse({ allowUnauthenticated: true, repos: [repo] })).not.toThrow();
  expect(() =>
    pollConfigSchema.parse({ tokenFile: "/x", repos: [{ ...repo, intervalSeconds: 5 }] }),
  ).toThrow();
  expect(() =>
    pollConfigSchema.parse({ tokenFile: "/x", repos: [{ ...repo, intervalSeconds: 120 }] }),
  ).not.toThrow();
});

// ---- job graph validation at ingest ----

test("ingest refuses unknown needs, cycles, self-dependencies and more than 256 jobs", async () => {
  const wf = (jobs: Record<string, string[]>) =>
    `name: g\non: push\njobs:\n${Object.entries(jobs)
      .map(
        ([k, n]) =>
          `  ${k}:\n    runs-on: x\n${n.length ? `    needs: [${n.join(", ")}]\n` : ""}    steps:\n      - run: echo\n`,
      )
      .join("")}`;
  const cases: [string, string, RegExp][] = [
    ["unknown need", wf({ a: ["ghost"] }), /needs unknown job "ghost"/],
    ["self dependency", wf({ a: ["a"] }), /needs cycle: a -> a/],
    ["two-cycle", wf({ a: ["b"], b: ["a"] }), /needs cycle/],
    ["long cycle", wf({ a: ["c"], b: ["a"], c: ["b"], d: [] }), /needs cycle/],
    [
      "too many",
      wf(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`j${i}`, []]))),
      /257 jobs; the limit is 256/,
    ],
  ];
  for (const [name, yaml, reason] of cases) {
    const gh = makeGithub();
    gh.state.files.set("*", yaml);
    const fresh = openDatabase(":memory:");
    const sc = await ensureLocalTenant(fresh);
    const res = await pollRepo(
      { db: fresh, github: clientFor(gh), provider: "docker" },
      config().repos[0]!,
    );
    expect(res.created, name).toEqual([]);
    expect(res.refused[0]?.reason, name).toMatch(reason);
    expect(await listRuns(fresh, sc), name).toHaveLength(0);
  }
  // the limit itself and a valid diamond are fine
  const ok = makeGithub();
  ok.state.files.set(
    "*",
    wf(Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`j${i}`, []]))),
  );
  expect((await poll(ok)).created).toHaveLength(1);
  const diamond = makeGithub();
  diamond.state.files.set("*", wf({ a: [], b: ["a"], c: ["a"], d: ["b", "c"] }));
  const d2 = openDatabase(":memory:");
  await ensureLocalTenant(d2);
  expect(
    (await pollRepo({ db: d2, github: clientFor(diamond), provider: "docker" }, config().repos[0]!))
      .created,
  ).toHaveLength(1);
  // the repo layer refuses too, so no other caller can create a cyclic run
  const { validateJobGraph } = await import("../src/db");
  expect(
    validateJobGraph([
      { key: "a", needs: ["b"] },
      { key: "b", needs: ["a"] },
    ]),
  ).toMatch(/cycle/);
  expect(
    validateJobGraph([
      { key: "a", needs: [] },
      { key: "a", needs: [] },
    ]),
  ).toMatch(/duplicate/);
}, 30_000);

test("ingest_status narrows to the project for a project-scoped token", async () => {
  resetIngestStatus();
  const { dispatch, registry } = await import("../src/ops");
  const { mintToken } = await import("./ops-helpers");
  const { createProject, getOrgById } = await import("../src/db");
  const org = (await getOrgById(db, scope.orgId))!;
  const second = await createProject(
    db,
    { orgId: scope.orgId },
    { slug: "second", name: "Second" },
  );
  const cfg = pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      { repo: "acme/web", workflow: ".github/workflows/ci.yml", defaultBranch: "main" },
      {
        repo: "acme/other",
        org: org.slug,
        project: "second",
        workflow: "w.yml",
        defaultBranch: "main",
      },
    ],
  });
  const poller = new Poller({ db, config: cfg, fetch: makeGithub().fetch });
  await poller.pollAll(); // acme/other errors (the stub has no such repo); both are tracked
  const call = async (secret: string, input: object = {}) => {
    const res = await dispatch(
      { registry, db },
      { kind: "bearer", token: secret },
      "ingest_status",
      input,
    );
    if (!res.ok) throw new Error(res.error.message);
    return res.output as { repos: { repo: string }[]; rate_limit: unknown };
  };
  const orgWide = (await mintToken(db, { orgId: scope.orgId }, "reader")).secret;
  expect((await call(orgWide)).repos.map((r) => r.repo).toSorted()).toEqual([
    "acme/other",
    "acme/web",
  ]);
  expect((await call(orgWide, { project: "second" })).repos.map((r) => r.repo)).toEqual([
    "acme/other",
  ]);

  const pinnedLocal = (await mintToken(db, scope, "reader")).secret;
  expect((await call(pinnedLocal)).repos.map((r) => r.repo)).toEqual(["acme/web"]);

  // a token pinned to a project nothing polls sees nothing, and no budget
  const quiet = await createProject(db, { orgId: scope.orgId }, { slug: "quiet", name: "Quiet" });
  const pinnedQuiet = (await mintToken(db, { orgId: scope.orgId, projectId: quiet.id }, "reader"))
    .secret;
  const none = await call(pinnedQuiet);
  expect(none.repos).toEqual([]);
  expect(none.rate_limit).toBeNull();
  void second;
});

test("collaboratorPermission: role_name wins, a custom role gets at most the legacy verdict, errors are classified", async () => {
  const reply =
    (status: number, body: unknown = {}) =>
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
  const ask = (fetch: (u: string) => Promise<Response>, token: string | null = "stub-token-xyz") =>
    new GithubClient({
      fetch,
      baseUrl: "https://api.github.com",
      token: token ?? undefined,
    }).collaboratorPermission("acme/web", "dev");
  // maintain and triage are folded into write and read by the legacy field; role_name keeps them.
  expect(await ask(reply(200, { permission: "write", role_name: "maintain" }))).toBe("maintain");
  expect(await ask(reply(200, { permission: "read", role_name: "triage" }))).toBe("triage");
  // A custom role is read from the legacy field only, and never above write.
  expect(await ask(reply(200, { permission: "admin", role_name: "deployers" }))).toBe("write");
  expect(await ask(reply(200, { permission: "read", role_name: "auditors" }))).toBe("read");
  expect(await ask(reply(200, { role_name: "???" }))).toBe("unknown");
  // Not a collaborator or no such user: none. The token cannot ask, or there is none: unknown.
  expect(await ask(reply(404))).toBe("none");
  expect(await ask(reply(403))).toBe("unknown");
  expect(await ask(reply(401))).toBe("unknown");
  expect(await ask(reply(200, { role_name: "admin" }), null)).toBe("unknown");
  // A server error and a rate limit are not an answer: they propagate so the poll retries.
  await expect(ask(reply(500))).rejects.toThrow();
  await expect(
    ask(async () => new Response("slow down", { status: 429, headers: { "retry-after": "5" } })),
  ).rejects.toBeInstanceOf(RateLimited);
  // A login that is not a plain login never reaches the URL.
  const seen: string[] = [];
  const odd = new GithubClient({
    fetch: async (u) => {
      seen.push(u);
      return new Response("{}");
    },
    baseUrl: "https://api.github.com",
    token: "stub-token-xyz",
  });
  expect(await odd.collaboratorPermission("acme/web", "../../x")).toBe("none");
  expect(seen).toEqual([]);
});

test("prNumbers limits pull request ingest to the listed numbers", async () => {
  const gh = makeGithub();
  gh.state.pulls = [
    { number: 3, user: "octocat", headSha: SHA("3"), headRepo: "acme/web" },
    { number: 7, user: "octocat", headSha: SHA("7"), headRepo: "acme/web" },
  ];
  await poll(gh, config({ prNumbers: [7] }));
  const prRuns = (await listRuns(db, scope)).filter((r) => r.event === "pull_request");
  expect(prRuns.map((r) => r.prNumber)).toEqual([7]);
});

test("changedFiles lists a rename by its old and new path and a deletion by its path", async () => {
  const body = {
    files: [
      { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed" },
      { filename: "src/gone.ts", status: "removed" },
    ],
  };
  const client = new GithubClient({
    baseUrl: "https://api.github.com",
    fetch: async () =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
  });
  expect(await client.changedFiles("acme/web", "main", SHA("a"))).toEqual([
    "src/new.ts",
    "src/old.ts",
    "src/gone.ts",
  ]);
});

test("a closed PR's queued runs are cancelled with an audit entry; push runs and open PRs are untouched (#600)", async () => {
  const gh = makeGithub();
  gh.state.pulls = [
    { number: 3, user: "octocat", headSha: SHA("b"), headRepo: "acme/web" },
    { number: 4, user: "octocat", headSha: SHA("c"), headRepo: "acme/web" },
  ];
  await poll(gh);
  const byEvent = async (event: string, pr?: number) =>
    (await listRuns(db, scope)).filter(
      (r) => r.event === event && (pr === undefined || r.prNumber === pr),
    );
  expect((await byEvent("pull_request", 3))[0]!.status).toBe("queued");
  expect((await byEvent("push"))[0]!.status).toBe("queued");
  // PR 3 merges: gone from the open list and reported closed. PR 4 drops off the (one-page) list
  // but is still open, so it must not be cancelled.
  gh.state.closed.add(3);
  gh.state.pulls = [];
  await poll(gh);
  expect((await byEvent("pull_request", 3))[0]!.status).toBe("cancelled");
  expect((await byEvent("pull_request", 4))[0]!.status).toBe("queued");
  expect((await byEvent("push"))[0]!.status).toBe("queued");
  const audit = (await listAudit(db, { orgId: scope.orgId })).filter((a) => a.op === "cancel");
  expect(audit).toHaveLength(1);
  expect(audit[0]!.principalKind).toBe("system");
  expect(JSON.stringify(audit[0])).toContain("PR closed");
  // idempotent: a further poll changes nothing and writes no second entry
  await poll(gh);
  expect(
    (await listAudit(db, { orgId: scope.orgId })).filter((a) => a.op === "cancel"),
  ).toHaveLength(1);
});

test("an anonymous poll makes no pulls/{n} calls and cancels nothing; an installation poll cancels (#600)", async () => {
  const gh = makeGithub();
  gh.state.pulls = [{ number: 3, user: "octocat", headSha: SHA("b"), headRepo: "acme/web" }];
  await poll(gh);
  gh.state.closed.add(3);
  gh.state.pulls = [];
  gh.state.calls.length = 0;
  const cfg = config().repos[0]!;
  const run = (authMode: PollAuthMode) =>
    pollRepo(
      { db, github: clientFor(gh), provider: "docker", now: () => 1_800_000_000_000, authMode },
      cfg,
    );
  const prRuns = async () =>
    (await listRuns(db, scope)).filter((r) => r.event === "pull_request" && r.prNumber === 3);
  await run("anonymous");
  expect(gh.state.calls.filter((c) => /\/pulls\/\d+$/.test(c.path))).toHaveLength(0);
  expect((await prRuns())[0]!.status).toBe("queued");
  await run("installation");
  expect(gh.state.calls.filter((c) => /\/pulls\/\d+$/.test(c.path))).toHaveLength(1);
  expect((await prRuns())[0]!.status).toBe("cancelled");
});

test("a PR skipped by the author gate is listed in ingest status, and runs once its bot author is allowlisted", async () => {
  resetIngestStatus();
  const gh = makeGithub();
  gh.state.pulls = [
    {
      number: 9,
      user: "app[bot]",
      headSha: SHA("9"),
      headRepo: "acme/web",
      headAuthor: "app[bot]",
    },
  ];
  let now = 1_800_000_000_000;
  const mk = (authors: string[]) =>
    new Poller({ db, config: config({ authors }), fetch: gh.fetch, now: () => now });
  await mk(["octocat"]).pollAll();
  expect(ingestStatus.repos.get("acme/web")?.skippedPrs).toEqual([
    { number: 9, reason: "author not allowlisted", at: now },
  ]);
  expect((await listRuns(db, scope)).filter((r) => r.event === "pull_request")).toHaveLength(0);
  // still skipped a poll later: the first-seen time is kept
  const first = now;
  now += 60_000;
  await mk(["octocat"]).pollAll();
  expect(ingestStatus.repos.get("acme/web")?.skippedPrs?.[0]?.at).toBe(first);
  // allowlisting the exact bot login ingests the PR and clears the skip
  await mk(["octocat", "app[bot]"]).pollAll();
  expect(
    (await listRuns(db, scope)).filter((r) => r.event === "pull_request").map((r) => r.prNumber),
  ).toEqual([9]);
  expect(ingestStatus.repos.get("acme/web")?.skippedPrs).toEqual([]);
});
