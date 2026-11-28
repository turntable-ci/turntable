// set_project_egress (instance administrator) and tighten_project_egress (owner, never widens):
// roles, the tighten-only rule, the audit with old and new values, the provider capability check
// and the get_project_settings field.
import { beforeEach, describe, expect, test } from "bun:test";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { getProjectEgress, listAudit, setProjectEgress, type Db } from "../src/db";
import { dispatch, type Credential, type DispatchEnv, registry } from "../src/ops";
import { mcpTools } from "../src/ops/mcp";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let env: DispatchEnv;
let inst: string;
let writer: string;
let caps: readonly string[] | undefined;

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  caps = ["none", "allowlist", "open"];
  env = { registry, db, allowInstance: true, providerEgress: () => caps };
  inst = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
  writer = (await mintToken(db, a, "operator")).secret;
});

const asInstance = (egress: string) =>
  dispatch(env, { kind: "bearer", token: inst }, "set_project_egress", {
    target_org: "org-a",
    target_project: "app",
    egress,
  });
const member = (role: "owner" | "member"): Credential =>
  ({
    kind: "principal",
    principal: { kind: "member", id: "m", orgId: a.orgId, role },
  }) as Credential;
const tighten = (cred: Credential, egress: string) =>
  dispatch(env, cred, "tighten_project_egress", { project: "app", egress });

describe("egress ops", () => {
  test("instance admin sets any mode, audited with old and new", async () => {
    const r = await asInstance("open");
    expect(r.ok && r.output).toMatchObject({ from: "none", to: "open", warnings: [] });
    expect(await getProjectEgress(db, a)).toBe("open");
    const entry = (await listAudit(db, a)).find((e) => e.op === "set_project_egress");
    expect(JSON.parse(String(entry?.input))).toMatchObject({ from: "none", to: "open" });
  });

  test("get_project_settings shows egress", async () => {
    await setProjectEgress(db, a, "allowlist");
    const r = await dispatch(env, member("owner"), "get_project_settings", { project: "app" });
    expect(r.ok && (r.output as { egress: string }).egress).toBe("allowlist");
  });

  test("an owner may tighten but never widen", async () => {
    await setProjectEgress(db, a, "open");
    expect((await tighten(member("owner"), "allowlist")).ok).toBe(true);
    const widen = await tighten(member("owner"), "open");
    expect(widen.ok).toBe(false);
    expect(await getProjectEgress(db, a)).toBe("allowlist");
    expect((await tighten(member("owner"), "none")).ok).toBe(true);
    expect((await tighten(member("owner"), "allowlist")).ok).toBe(false);
    expect(await getProjectEgress(db, a)).toBe("none");
  });

  test("a writer cannot tighten, and an owner token cannot call the instance op", async () => {
    await setProjectEgress(db, a, "open");
    expect((await tighten({ kind: "bearer", token: writer }, "none")).ok).toBe(false);
    expect((await tighten(member("member"), "none")).ok).toBe(false);
    const r = await dispatch(env, member("owner"), "set_project_egress", {
      target_org: "org-a",
      target_project: "app",
      egress: "open",
    });
    expect(r.ok).toBe(false);
  });

  test("neither egress op is an MCP tool", () => {
    const names = mcpTools(registry).map((t) => t.name);
    expect(names).not.toContain("set_project_egress");
    expect(names).not.toContain("tighten_project_egress");
  });

  test("allowlist and open the provider cannot enforce are refused", async () => {
    caps = ["none"];
    expect((await asInstance("allowlist")).ok).toBe(false);
    expect((await asInstance("open")).ok).toBe(false);
    expect(await getProjectEgress(db, a)).toBe("none");
  });

  test("none the provider cannot enforce is allowed with a warning", async () => {
    await setProjectEgress(db, a, "open");
    caps = ["open"];
    const r = await asInstance("none");
    expect(r.ok && (r.output as { warnings: string[] }).warnings[0]).toContain("cannot enforce");
    expect(await getProjectEgress(db, a)).toBe("none");
  });

  test("unknown provider capabilities refuse allowlist and open, and warn for none", async () => {
    caps = undefined;
    expect((await asInstance("open")).ok).toBe(false);
    expect((await asInstance("allowlist")).ok).toBe(false);
    const r = await asInstance("none");
    expect(r.ok && (r.output as { warnings: string[] }).warnings.length).toBe(1);
  });

  test("re-setting none on a provider that cannot enforce it still warns", async () => {
    caps = ["open"];
    const r = await asInstance("none");
    expect(r.ok && (r.output as { warnings: string[] }).warnings[0]).toContain("cannot enforce");
  });

  test("a tighten is audited once by the handler with the session kind and slugs, a no-op not at all", async () => {
    await setProjectEgress(db, a, "open");
    const owner = member("owner");
    await tighten(owner, "none");
    await tighten(owner, "none");
    const rows = (await listAudit(db, a)).filter(
      (e) => e.op === "tighten_project_egress" && String(e.input).includes("from"),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.principalKind).toBe("member");
    expect(JSON.parse(String(rows[0]?.input))).toMatchObject({
      target_org: "org-a",
      target_project: "app",
      from: "open",
      to: "none",
    });
  });
});
