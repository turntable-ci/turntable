// list_project_vars, set_project_var and delete_project_var (#798): roles, tenant isolation,
// the reserved TURNTABLE_CI, audit by name only, and preview_workflows reflecting a change.
import { beforeEach, expect, test } from "bun:test";
import { bindRepo, getProjectIngest, listAudit, setProjectIngest, type Db } from "../src/db";
import { upsertInstallation } from "../src/db/repos";
import { dispatch, registry, type DispatchEnv } from "../src/ops";
import { ingestSettingsSchema } from "../src/poll/config";
import type { RepoReader } from "../src/poll/onboarding-forge";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";
import { SHA } from "./github-stub";

let db: Db;
let a: Tenant;
let b: Tenant;
let env: DispatchEnv;
let reader: string;
let operator: string;
let bOperator: string;

const WORKFLOW = `name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "$KEY"
        env:
          KEY: \${{ vars.VITE_PUBLIC_KEY }}
`;
const repoReader: RepoReader = {
  defaultBranch: async () => "main",
  head: async () => SHA("a"),
  listWorkflows: async () => [{ path: ".github/workflows/ci.yml", size: WORKFLOW.length }],
  fileAt: async () => WORKFLOW,
};

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  env = { registry, db, now: () => 1_800_000_000_000, repoReader: async () => repoReader };
  reader = (await mintToken(db, a.scope, "reader")).secret;
  operator = (await mintToken(db, a.scope, "operator")).secret;
  bOperator = (await mintToken(db, b.scope, "operator")).secret;
  for (const t of [a, b]) {
    await setProjectIngest(
      db,
      t.scope,
      JSON.stringify(
        ingestSettingsSchema.parse({ defaultBranch: "main", vars: { TURNTABLE_CI: "true" } }),
      ),
    );
  }
  await upsertInstallation(
    db,
    { orgId: a.orgId },
    {
      installationId: "9001",
      appId: "42",
      accountLogin: "acme",
      accountId: "7",
      accountType: "Organization",
      repositorySelection: "all",
      status: "active",
    },
  );
  await bindRepo(db, a.scope, {
    forge: "github",
    owner: "acme",
    repo: "web",
    installationId: "9001",
    forgeRepoId: "1001",
  });
});

const call = (token: string, op: string, input: Record<string, unknown> = {}) =>
  dispatch(env, { kind: "bearer", token }, op, input);
type Var = { name: string; value: string; reserved: boolean };
const list = async (token: string, t: Tenant = a): Promise<Var[]> => {
  const r = await call(token, "list_project_vars", {});
  if (!r.ok) throw new Error(r.error.message);
  expect(t).toBeDefined();
  return (r.output as { vars: Var[] }).vars;
};
const storedVars = async (t: Tenant) =>
  ingestSettingsSchema.parse(JSON.parse((await getProjectIngest(db, t.scope))!)).vars;

test("an operator sets, replaces and deletes; a reader can list but not change", async () => {
  expect((await call(reader, "set_project_var", { name: "VITE_X", value: "1" })).ok).toBe(false);
  expect((await call(reader, "delete_project_var", { name: "TURNTABLE_CI" })).ok).toBe(false);
  const set = await call(operator, "set_project_var", { name: "VITE_X", value: "1" });
  expect(set.ok && (set.output as { created: boolean }).created).toBe(true);
  const again = await call(operator, "set_project_var", { name: "vite_x", value: "2" });
  expect(again.ok && (again.output as { created: boolean }).created).toBe(false);
  expect(await list(reader)).toEqual([
    { name: "TURNTABLE_CI", value: "true", reserved: true },
    { name: "vite_x", value: "2", reserved: false },
  ]);
  expect((await call(operator, "delete_project_var", { name: "VITE_X" })).ok).toBe(true);
  expect((await call(operator, "delete_project_var", { name: "VITE_X" })).ok).toBe(false);
  expect(Object.keys((await storedVars(a))!)).toEqual(["TURNTABLE_CI"]);
});

test("names follow GitHub's rules and a project holds at most 1000", async () => {
  for (const name of ["GITHUB_FOO", "github_x", "1BAD", "has space", "__proto__"]) {
    const r = await call(operator, "set_project_var", { name, value: "v" });
    expect(r.ok, name).toBe(false);
  }
  const vars: Record<string, string> = { TURNTABLE_CI: "true" };
  for (let i = 0; i < 999; i++) vars[`V${i}`] = "x";
  await setProjectIngest(
    db,
    a.scope,
    JSON.stringify(ingestSettingsSchema.parse({ defaultBranch: "main", vars })),
  );
  const over = await call(operator, "set_project_var", { name: "ONE_TOO_MANY", value: "x" });
  expect(over.ok).toBe(false);
  expect((await call(operator, "set_project_var", { name: "V1", value: "y" })).ok).toBe(true);
});

test("TURNTABLE_CI is reserved: it cannot be changed or removed", async () => {
  for (const name of ["TURNTABLE_CI", "turntable_ci"]) {
    expect((await call(operator, "set_project_var", { name, value: "false" })).ok).toBe(false);
    expect((await call(operator, "delete_project_var", { name })).ok).toBe(false);
  }
  expect((await storedVars(a))?.TURNTABLE_CI).toBe("true");
});

test("a project that is not ingested refuses a set instead of inventing settings", async () => {
  await setProjectIngest(db, a.scope, null);
  const r = await call(operator, "set_project_var", { name: "VITE_X", value: "1" });
  expect(!r.ok && r.error.code).toBe("conflict");
  expect(await list(reader)).toEqual([]);
});

test("the audit log names the variable and never records the value", async () => {
  const value = `v-${crypto.randomUUID()}`;
  await call(operator, "set_project_var", { name: "VITE_X", value });
  await call(operator, "delete_project_var", { name: "VITE_X" });
  const rows = (await listAudit(db, a.scope)).filter((r) => r.op.endsWith("_project_var"));
  expect(rows.map((r) => r.op).toSorted()).toEqual(["delete_project_var", "set_project_var"]);
  for (const r of rows) {
    expect(r.input).toContain("VITE_X");
    expect(r.input).not.toContain(value);
  }
});

test("tenant isolation: org B cannot see or change org A's variables", async () => {
  await call(operator, "set_project_var", { name: "VITE_A_ONLY", value: "secret-ish" });
  expect((await list(bOperator, b)).map((v) => v.name)).toEqual(["TURNTABLE_CI"]);
  expect((await call(bOperator, "delete_project_var", { name: "VITE_A_ONLY" })).ok).toBe(false);
  await call(bOperator, "set_project_var", { name: "VITE_B", value: "b" });
  expect(Object.keys((await storedVars(a))!).toSorted()).toEqual(["TURNTABLE_CI", "VITE_A_ONLY"]);
  expect(Object.keys((await storedVars(b))!).toSorted()).toEqual(["TURNTABLE_CI", "VITE_B"]);
  // another org's project, named explicitly, is refused too
  const named = await call(bOperator, "set_project_var", {
    project: a.projectSlug,
    name: "VITE_X",
    value: "1",
  });
  expect(named.ok && Object.keys((await storedVars(a))!)).not.toContain("VITE_X");
});

test("preview_workflows marks the var provided once it is set", async () => {
  type P = { workflows: { jobs: { refs: { name: string; provided: boolean }[] }[] }[] };
  const provided = async (): Promise<boolean | undefined> => {
    const r = await call(reader, "preview_workflows", {});
    if (!r.ok) throw new Error(r.error.message);
    return (r.output as P).workflows[0]?.jobs[0]?.refs.find((x) => x.name === "VITE_PUBLIC_KEY")
      ?.provided;
  };
  expect(await provided()).toBe(false);
  await call(operator, "set_project_var", { name: "VITE_PUBLIC_KEY", value: "pk_live_x" });
  expect(await provided()).toBe(true);
  await call(operator, "delete_project_var", { name: "VITE_PUBLIC_KEY" });
  expect(await provided()).toBe(false);
});
