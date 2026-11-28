// Project vars (`vars.*`): set with `policy set --ingest on --var`, audited, and visible to the
// workflow's `if:` at plan time, so a job can be gated on `vars.TURNTABLE_CI`. With no vars set a
// workflow sees exactly what it saw before.
import { beforeEach, expect, test } from "bun:test";
import {
  bindRepo,
  createOrg,
  createProject,
  listAudit,
  listJobs,
  listRuns,
  openDatabase,
  type Db,
} from "../src/db";
import { setIngestPolicy, showIngest } from "../src/ops/policy-cli";
import { workflowReadiness } from "../src/scheduler";
import { Poller, pollConfigSchema } from "../src/poll";
import { ingestSettingsSchema } from "../src/poll/config";
import { makeGithub } from "./github-stub";

const WORKFLOW = `name: CI
on: [push]
jobs:
  everywhere:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
  not-under-turntable:
    if: vars.TURNTABLE_CI != 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo b
  only-under-turntable:
    if: vars.TURNTABLE_CI == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo c
  mac-ungated:
    runs-on: macos-latest
    steps:
      - run: echo d
  docker-ungated:
    runs-on: ubuntu-latest
    steps:
      - run: docker ps
  docker-gated:
    if: vars.TURNTABLE_CI != 'true'
    runs-on: ubuntu-latest
    steps:
      - run: docker ps
`;

let db: Db;
beforeEach(() => {
  db = openDatabase(":memory:");
});

async function ingest(vars: Record<string, string> | undefined) {
  const org = await createOrg(db, { slug: "acme", name: "acme" });
  const project = await createProject(db, { orgId: org.id }, { slug: "web", name: "web" });
  const scope = { orgId: org.id, projectId: project.id };
  await bindRepo(db, scope, { forge: "github", owner: "acme", repo: "web" });
  await setIngestPolicy(db, "acme", "web", "on", { defaultBranch: "main", vars });
  const gh = makeGithub();
  gh.state.files.set("*", WORKFLOW);
  const p = new Poller({
    db,
    config: pollConfigSchema.parse({
      allowUnauthenticated: true,
      repos: [
        { repo: "static/other", workflow: ".github/workflows/ci.yml", defaultBranch: "main" },
      ],
    }),
    fetch: gh.fetch,
    now: () => 1_800_000_000_000,
    log: () => {},
    bindings: true,
  });
  await p.pollAll();
  const [run] = await listRuns(db, scope);
  expect(run).toBeDefined();
  const jobs = await listJobs(db, scope, run!.id);
  return {
    run: run!,
    scope,
    jobs: Object.fromEntries(jobs.map((j) => [j.jobKey, workflowReadiness(j, [], run!)])),
  };
}

/** The vars stored in a run's plan. */
const planned = (run: { plan: string | null }): unknown =>
  (JSON.parse(run.plan ?? "{}") as { vars?: unknown }).vars;

test("with no vars set, the gate reads an unset var: only the not-under-turntable job runs", async () => {
  const { run, jobs } = await ingest(undefined);
  expect(planned(run)).toEqual({});
  expect(jobs.everywhere).toEqual({ decision: "ready" });
  expect(jobs["not-under-turntable"]).toEqual({ decision: "ready" });
  expect(jobs["only-under-turntable"]).toMatchObject({ decision: "skip" });
});

test("with TURNTABLE_CI=true the plan carries the var and the jobs flip", async () => {
  const { run, jobs } = await ingest({ TURNTABLE_CI: "true" });
  expect(planned(run)).toEqual({ TURNTABLE_CI: "true" });
  expect(jobs.everywhere).toEqual({ decision: "ready" });
  expect(jobs["not-under-turntable"]).toMatchObject({ decision: "skip" });
  expect(jobs["only-under-turntable"]).toEqual({ decision: "ready" });
});

test("the settings are validated: reserved and malformed names, long values and too many are refused", () => {
  const base = { defaultBranch: "main" };
  for (const vars of [
    { GITHUB_X: "1" },
    { "1BAD": "1" },
    { "a-b": "1" },
    { OK: "x".repeat(1025) },
    Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`V${i}`, "1"])),
  ])
    expect(
      ingestSettingsSchema.safeParse({ ...base, vars }).success,
      JSON.stringify(vars).slice(0, 40),
    ).toBe(false);
  expect(ingestSettingsSchema.safeParse({ ...base, vars: { TURNTABLE_CI: "true" } }).success).toBe(
    true,
  );
});

test("setting vars is audited, and policy show lists the names", async () => {
  const org = await createOrg(db, { slug: "acme", name: "acme" });
  const project = await createProject(db, { orgId: org.id }, { slug: "web", name: "web" });
  const scope = { orgId: org.id, projectId: project.id };
  await setIngestPolicy(db, "acme", "web", "on", {
    defaultBranch: "main",
    vars: { TURNTABLE_CI: "true" },
  });
  const audit = JSON.stringify(await listAudit(db, scope));
  expect(audit).toContain("TURNTABLE_CI");
  const shown = await showIngest(db, "acme");
  expect(shown[0]?.ingest?.vars).toEqual({ TURNTABLE_CI: "true" });
});

test("a job Turntable cannot run is ready (the runner fails it) unless its own if: opts out", async () => {
  const on = await ingest({ TURNTABLE_CI: "true" });
  // the workflow's own gate is false: a legitimate skip
  expect(on.jobs["docker-gated"]).toMatchObject({ decision: "skip" });
  // no gate: never skipped (a skipped required check passes); the runner ends it as a failure
  expect(on.jobs["docker-ungated"]).toEqual({ decision: "ready" });
  expect(on.jobs["mac-ungated"]).toEqual({ decision: "ready" });
});

test("without TURNTABLE_CI the docker gate is open, so the job is ready and the runner refuses it", async () => {
  const off = await ingest(undefined);
  expect(off.jobs["docker-gated"]).toEqual({ decision: "ready" });
});
