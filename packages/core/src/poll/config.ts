import { readFileSync } from "node:fs";
import { splitRuleProblem } from "@turntable/act-runner";
import { z } from "zod";

/**
 * Tags the poller turns into runs: patterns over full tag refs, for example `refs/tags/v*`. Empty
 * (the default) means tags are never ingested. A tag is a name anyone with write access can
 * create or move, so a run is made only when its commit is on the default branch and the class
 * is decided by the same trust decision as any run (a tag matching these patterns is a release).
 * A pattern is an exact tag ref, or `refs/tags/<literal prefix>*` with at least one literal
 * character: nothing broader, so one setting cannot make every tag a release.
 */
export const tagRefsSchema = z
  .array(
    z
      .string()
      .regex(
        /^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._\-/]{0,99}\*?$/,
        "an exact tag ref or refs/tags/<literal prefix>*, with a prefix of at least one letter or digit: refs/tags/* alone would make every tag a release",
      ),
  )
  .refine((all) => all.every((p) => !p.split("/").some((s) => s === ".." || s === ".")), {
    message: "a tag ref pattern has no . or .. segment",
  })
  .max(10)
  .default([]);

/**
 * Non-secret variables for `${{ vars.NAME }}` in a workflow's `if:` and expressions (what GitHub
 * calls repository variables). Values are stored in the clear and shown in `policy show`: never
 * put a secret here. Names follow GitHub's rule (no `GITHUB_` prefix).
 */
export const MAX_VARS = 1000;

export const varsSchema = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "a variable name")
      .refine((n) => !/^github_/i.test(n), {
        message: "a variable name cannot start with GITHUB_",
      })
      .refine((n) => n !== "__proto__", { message: "a variable name is reserved" }),
    z.string().max(1024),
  )
  .refine((v) => Object.keys(v).length <= MAX_VARS, {
    message: `at most ${MAX_VARS} variables`,
  });

/**
 * Operator rules that run one job as several shards, each in its own sandbox, without changing
 * the workflow: `[{ "job": "tests", "shards": [{ "steps": ["Rules tests"] }, { "steps": ["Audit
 * engine tests"] }] }]`. Steps are named by their `name:` or `#<n>` (counted from 1); a step no
 * shard names runs in every shard. A shard may add `paths` (workflow path-filter globs, `!`
 * negation included): it then runs only when a changed file matches, and always when the changed
 * files are unknown. Never read from the repository.
 */
export const splitsSchema = z
  .array(
    z
      .object({
        job: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/, "a job id"),
        shards: z
          .array(
            z
              .object({
                steps: z.array(z.string().min(1).max(200)).min(1).max(20),
                // Glob validity and the empty-list rule are checked by splitRuleProblem below.
                paths: z.array(z.string().max(200)).max(50).optional(),
              })
              .strict(),
          )
          .min(2)
          .max(8),
      })
      .strict()
      .superRefine((r, ctx) => {
        const problem = splitRuleProblem(r);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }),
  )
  .max(10)
  .refine((all) => new Set(all.map((r) => r.job)).size === all.length, {
    message: "a job has two split rules",
  });

const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name");

/**
 * Poll config. Strict: an unknown key is an error, so a typo cannot silently weaken the gate and
 * a secret pasted inline (`token`) is refused. The token lives in a file named by `tokenFile`.
 */
export const pollConfigSchema = z
  .object({
    /**
     * File holding a GitHub token (mode 0600, outside the repo). Required: polling is
     * authenticated so the rate limit is not shared with every other unauthenticated client.
     */
    tokenFile: z.string().min(1).optional(),
    /**
     * Name of an environment variable holding the token, for a platform with no shell and no
     * files (Railway). The config never carries the token itself, only this name.
     */
    tokenEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]{0,63}$/, "an environment variable name")
      .optional(),
    /** Explicitly allow polling with no token (tests, a tiny setup). Default false. */
    allowUnauthenticated: z.boolean().default(false),
    /** For tests and GitHub Enterprise. */
    apiBaseUrl: z.url().default("https://api.github.com"),
    /** Provider name stamped on the attempts the poller creates. */
    provider: z.string().min(1).default("docker"),
    repos: z
      .array(
        z
          .object({
            repo: repoName,
            /** Where runs land. Default: the built-in local org and project. */
            org: z.string().min(1).default("local"),
            project: z.string().min(1).default("local"),
            workflow: z.string().min(1).describe("Workflow path, e.g. .github/workflows/ci.yml"),
            /**
             * The primary workflow of this project's repo (#549): its jobs keep the plain check
             * names (`turntable / <job>`), so required contexts never move. Any other workflow of
             * the same repo posts `turntable / <workflow name> / <job>`. Exactly one entry per
             * project and repo is primary; a single entry is primary by default, and with several
             * and none marked the first one is.
             */
            primary: z.boolean().optional(),
            defaultBranch: z.string().min(1),
            /** Seconds between polls of this repo. 60 to 120 is the intended range. */
            intervalSeconds: z.int().min(30).max(3600).default(60),
            /**
             * `off`: pull requests are never run. `allowlist`: only same-repo PRs by listed authors
             * run, and nothing else is looked at. `approval`: every open PR is ingested and its
             * trust class decided from re-fetched facts (same repo, and the author's collaborator
             * permission); an untrusted class is created but waits in awaiting_approval until a
             * maintainer approves that sha. Listed `authors` count as trusted in both modes.
             */
            prMode: z.enum(["off", "allowlist", "approval"]).default("off"),
            /**
             * Only these pull request numbers are considered (both PR modes). Unset: every open
             * pull request. For targeted parity runs without picking up every open PR.
             */
            prNumbers: z.array(z.int().positive()).max(100).optional(),
            /**
             * The first poll with PR mode on records every open pull request's current head as
             * seen and runs nothing; after that only a new head (a push, or a newly opened PR)
             * runs. Set false to ingest every open PR on that first poll. Turning PR mode off and
             * on again takes a new baseline. `prNumbers` PRs are always ingested.
             */
            prBaseline: z.boolean().default(true),
            /**
             * Ingest merge queue runs (`merge_group`). Each poll lists the repo's
             * `gh-readonly-queue/<defaultBranch>/` branches and runs one only when it is a verified
             * GitHub-made commit for an open same-repo PR by a listed author. Off by default.
             */
            mergeQueue: z.boolean().default(false),
            /**
             * Make a run for each default-branch push the poller missed between two polls (at most
             * 5 a poll, the newest), as GitHub would have run CI for each. Off: only the head.
             */
            everyPush: z.boolean().default(false),
            /** GitHub logins trusted without asking the forge. Compared case-insensitively. */
            authors: z.array(z.string().min(1)).default([]),
            /** Extra protected ref patterns (refs/heads/release/**). The default branch always is. */
            protectedRefs: z.array(z.string().min(1)).default([]),
            /** Tag ref patterns to ingest as release runs (refs/tags/v*). Default none: tags are not ingested. */
            tagRefs: tagRefsSchema,
            /**
             * Sandbox egress for this repo's runs: `none`, `open` or `allowlist`. Unset: the
             * project's setting (`projects.egress`), which defaults to `none`.
             */
            egress: z.enum(["none", "open", "allowlist"]).optional(),
            /**
             * Egress for runs classified untrusted_pr, whatever `egress` says: never `open`
             * (untrusted code with network is a mining and exfiltration vector). Default `none`.
             */
            untrustedEgress: z.enum(["none", "allowlist"]).default("none"),
            /**
             * Most pull requests from authors who are not on `authors` that one poll will look at
             * (each costs forge API calls). The rest wait for the next poll.
             */
            maxNewPrsPerPoll: z.int().min(1).max(100).default(5),
            /** Most runs of this repo that may wait for approval at once. */
            maxWaitingRuns: z.int().min(1).max(500).default(20),
            maxRunsPerHour: z.int().min(1).max(1000).default(30),
            /** Non-secret `vars.*` for this repo's workflows. */
            vars: varsSchema.optional(),
            /** Jobs to run as several shards (see splitsSchema). */
            splits: splitsSchema.optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    const marked = new Map<string, number>();
    c.repos.forEach((r, i) => {
      if (r.primary !== true) return;
      const key = primaryGroup(r);
      if (marked.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["repos", i, "primary"],
          message: `two poll entries of ${r.repo} in project ${r.org}/${r.project} are marked primary (repos.${marked.get(key)} and repos.${i}); exactly one may be`,
        });
      } else marked.set(key, i);
    });
  })
  .refine((c) => c.tokenFile === undefined || c.tokenEnv === undefined, {
    path: ["tokenEnv"],
    message: "set only one of tokenFile and tokenEnv",
  })
  .refine((c) => c.tokenFile !== undefined || c.tokenEnv !== undefined || c.allowUnauthenticated, {
    path: ["tokenFile"],
    message:
      "required (polling must be authenticated): tokenFile or tokenEnv; set allowUnauthenticated to opt out",
  });

type PrimaryKey = { org: string; project: string; repo: string };

/** The entries one primary is chosen among: one project's entries for one repo. */
function primaryGroup(r: PrimaryKey): string {
  return `${r.org}\u0000${r.project}\u0000${r.repo.toLowerCase()}`;
}

/**
 * Whether `entry` is the primary workflow of its project and repo: the one marked `primary`, else
 * (none marked) the first entry of that group. A lone entry is primary. `all` is the static
 * entries in file order.
 */
export function isPrimaryEntry(
  all: readonly (PrimaryKey & { primary?: boolean | undefined })[],
  entry: PrimaryKey & { primary?: boolean | undefined },
): boolean {
  const key = primaryGroup(entry);
  const group = all.filter((r) => primaryGroup(r) === key);
  if (group.length === 0) return true;
  const marked = group.find((r) => r.primary === true);
  return (marked ?? group[0]) === entry;
}

/**
 * What a project stores to have a repo ingested from its installation binding, with no entry in
 * the poll config. The same knobs as a poll repo, minus where it lands (the project) and which
 * repo (the binding). `defaultBranch` is required and fixed when the settings are made: the
 * poller never asks GitHub which branch is default, because a repo admin changing it would move
 * the branch that counts as protected.
 */
export const ingestSettingsSchema = z
  .object({
    workflow: z.string().min(1).default(".github/workflows/ci.yml"),
    defaultBranch: z.string().min(1),
    prMode: z.enum(["off", "allowlist", "approval"]).default("off"),
    /** See the poll entry: the first poll takes a baseline of open PR heads. */
    prBaseline: z.boolean().default(true),
    authors: z.array(z.string().min(1)).default([]),
    protectedRefs: z.array(z.string().min(1)).default([]),
    /** Tag ref patterns to ingest as release runs (refs/tags/v*). Default none. */
    tagRefs: tagRefsSchema,
    mergeQueue: z.boolean().default(false),
    /** A run for each default-branch push missed between polls (at most 5 a poll). Default off. */
    everyPush: z.boolean().default(false),
    intervalSeconds: z.int().min(30).max(3600).default(60),
    egress: z.enum(["none", "open", "allowlist"]).optional(),
    /** Non-secret `vars.*` for the workflows (set with `policy set --ingest on --var NAME=value`). */
    vars: varsSchema.optional(),
    /** Jobs to run as several shards (set with `policy set --ingest on --splits-json`). */
    splits: splitsSchema.optional(),
  })
  .strict();
export type IngestSettings = z.infer<typeof ingestSettingsSchema>;

export type PollConfig = z.infer<typeof pollConfigSchema>;
export type PollRepoConfig = PollConfig["repos"][number];

/** Validates poll config text. Errors name the source and the field, never a secret. */
export function parsePollConfig(text: string, source: string): PollConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `cannot read poll config ${source}: ${err instanceof Error ? err.message : "error"}`,
    );
  }
  const parsed = pollConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid poll config ${source}:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}

/** Parses a config file. */
export function loadPollConfig(path: string): PollConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read poll config ${path}: ${err instanceof Error ? err.message : "error"}`,
    );
  }
  return parsePollConfig(text, path);
}

/** The poll token from its file or its environment variable; undefined when neither is set. */
export function readPollToken(
  c: { tokenFile?: string | undefined; tokenEnv?: string | undefined },
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (c.tokenFile) return readToken(c.tokenFile);
  if (c.tokenEnv) {
    const v = env[c.tokenEnv]?.trim();
    if (!v) throw new Error(`environment variable ${c.tokenEnv} (the poll token) is not set`);
    return v;
  }
  return undefined;
}

/** Reads the token file, trimmed. Errors never include the content. */
export function readToken(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(`cannot read token file ${path}`);
  }
  if (text === "") throw new Error(`token file ${path} is empty`);
  return text;
}

/** GitHub's anonymous budget, per address per hour. 304 answers to conditional requests count too. */
export const ANONYMOUS_REQUESTS_PER_HOUR = 60;

/**
 * Requests one steady-state poll of a repo makes: the default branch's head, its protection, then
 * one each for tag refs, open pull requests and merge queue branches when those are on.
 */
export function requestsPerPoll(r: {
  tagRefs?: readonly unknown[] | undefined;
  prMode?: string | undefined;
  mergeQueue?: boolean | undefined;
}): number {
  return (
    2 +
    ((r.tagRefs?.length ?? 0) > 0 ? 1 : 0) +
    (r.prMode && r.prMode !== "off" ? 1 : 0) +
    (r.mergeQueue ? 1 : 0)
  );
}

/**
 * The shortest interval, in seconds, that keeps polling `requests` requests per cycle under 75%
 * of the anonymous budget, leaving a quarter for the extra calls a change costs and for webhook
 * wake-ups. All repos share one address, so pass the total of every repo's requests.
 */
export function minAnonymousIntervalSeconds(requestsPerCycleTotal: number): number {
  return Math.ceil((requestsPerCycleTotal * 3600) / (ANONYMOUS_REQUESTS_PER_HOUR * 0.75));
}
