// The instance administrator (#205): a `tti_` token minted on the host, accepted over REST only,
// able to call the instance operations and nothing else, and unreachable by any org token.
import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { systemOrgId } from "../src/audit/failures";
import {
  type Db,
  getOrgQuotas,
  getProjectSandboxSettings,
  insertApiToken,
  listAudit,
  listProjects,
} from "../src/db";
import { AGENT_ROLES } from "../src/db/schema";
import { findInstanceTokenByHash } from "../src/db/repos";
import { mcpTools } from "../src/ops/mcp";
import {
  createInstanceTokenFromCli,
  listInstanceTokensFromCli,
  revokeInstanceTokenFromCli,
} from "../src/ops/instance-token-cli";
import { dispatch, type DispatchEnv, registry, type Credential, type Principal } from "../src/ops";
import { createMcpHttp } from "../src/mcp/http";
import { createRestApi } from "../src/ops/rest";
import { handleRequest } from "../src/server";
import { hashToken } from "../src/ops/tokens";
import { report } from "../src/doctor/types";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let env: DispatchEnv; // the REST adapter's: instance tokens allowed, instance cap 4
let secret: string;
let tokenId: string;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  env = {
    registry,
    db,
    allowInstance: true,
    instanceOrgCap: 4,
    githubUsers: { idOfLogin: async (l: string) => `gh-${l.toLowerCase()}` },
  };
  const made = await createInstanceTokenFromCli(db, { name: "ops laptop" });
  secret = made.secret;
  tokenId = made.id;
});

const asInstance = (name: string, input: Record<string, unknown> = {}, e: DispatchEnv = env) =>
  dispatch(e, { kind: "bearer", token: secret }, name, input);

const orgCreds = async (t: Tenant): Promise<{ label: string; cred: Credential }[]> => {
  const out: { label: string; cred: Credential }[] = [];
  for (const role of AGENT_ROLES) {
    out.push({
      label: `${t.slug} ${role}`,
      cred: { kind: "bearer", token: (await mintToken(db, { orgId: t.orgId }, role)).secret },
    });
  }
  out.push({
    label: `${t.slug} project-scoped release_operator`,
    cred: { kind: "bearer", token: (await mintToken(db, t.scope, "release_operator")).secret },
  });
  const admin: Principal = { kind: "member", id: `admin-${t.slug}`, orgId: t.orgId, role: "admin" };
  out.push({ label: `${t.slug} member admin`, cred: { kind: "principal", principal: admin } });
  const owner: Principal = { kind: "member", id: `owner-${t.slug}`, orgId: t.orgId, role: "owner" };
  out.push({ label: `${t.slug} member owner`, cred: { kind: "principal", principal: owner } });
  return out;
};

describe("minting is host-only and the token is stored hashed", () => {
  test("tti_ prefix, hash only in the database, audited in the system org's chain, no org op mints one", async () => {
    expect(secret.startsWith("tti_")).toBe(true);
    expect(secret.length).toBe(4 + 43);
    const row = await findInstanceTokenByHash(db, hashToken(secret));
    expect(row?.id).toBe(tokenId);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row!.tokenHash).toBe(createHash("sha256").update(secret).digest("hex"));
    const sys = await systemOrgId(db);
    const rows = await listAudit(db, { orgId: sys }, { limit: 50 });
    const made = rows.find((r) => r.op === "create_instance_token");
    expect(made).toMatchObject({ principalKind: "cli", outcome: "ok" });
    expect(made!.input).not.toContain(secret);
    // no registered op creates, lists or revokes instance tokens; the one exception is rotation
    // (#330), which an instance administrator calls over REST and which is never an MCP tool
    expect(registry.ops.map((o) => o.name).filter((n) => /instance_token/.test(n))).toEqual([
      "rotate_instance_token",
    ]);
  });

  test("a bad name or expiry is refused; list shows status and never a secret; revoke ends it", async () => {
    await expect(createInstanceTokenFromCli(db, { name: "" })).rejects.toThrow(/--name/);
    await expect(createInstanceTokenFromCli(db, { name: "x", expiresInDays: 91 })).rejects.toThrow(
      /1 to 90/,
    );
    const list = await listInstanceTokensFromCli(db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: tokenId, status: "active" });
    expect(JSON.stringify(list)).not.toContain(secret);
    expect((await asInstance("instance_whoami")).ok).toBe(true);
    await revokeInstanceTokenFromCli(db, tokenId);
    expect((await listInstanceTokensFromCli(db))[0]!.status).toBe("revoked");
    const after = await asInstance("instance_whoami");
    expect(!after.ok && after.error.code).toBe("unauthenticated");
    await expect(revokeInstanceTokenFromCli(db, "nope")).rejects.toThrow(/no instance token/);
  });
});

describe("what the instance administrator can do", () => {
  test("whoami and the org list (the system org is not listed)", async () => {
    const w = await asInstance("instance_whoami");
    expect(w.ok && w.output).toMatchObject({ id: tokenId, name: "ops laptop" });
    const l = await asInstance("instance_list_orgs");
    expect(l.ok && (l.output as { orgs: { slug: string }[] }).orgs.map((o) => o.slug)).toEqual([
      "org-a",
      "org-b",
    ]);
  });

  test("set_quotas changes the named limits only, audited in the system chain and in the org's", async () => {
    const r = await asInstance("set_quotas", {
      target_org: "org-a",
      max_runs_per_hour: 30,
      max_concurrent: 3,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.output as { limits: Record<string, number | null> }).limits).toMatchObject({
      max_concurrent: 3,
      max_runs_per_hour: 30,
      max_log_bytes: null,
    });
    expect(await getOrgQuotas(db, a.orgId)).toMatchObject({ maxConcurrent: 3, maxRunsPerHour: 30 });
    expect(await getOrgQuotas(db, b.orgId)).toMatchObject({ maxConcurrent: null }); // others untouched
    const sys = await systemOrgId(db);
    const sysRow = (await listAudit(db, { orgId: sys }, { limit: 50 })).find(
      (x) => x.op === "set_quotas",
    );
    expect(sysRow).toMatchObject({
      principalKind: "instance",
      principalId: tokenId,
      outcome: "ok",
    });
    const orgRow = (await listAudit(db, { orgId: a.orgId }, { limit: 50 })).find(
      (x) => x.op === "set_quotas",
    );
    expect(orgRow).toMatchObject({
      principalKind: "instance",
      principalId: tokenId,
      outcome: "ok",
    });
    expect(JSON.parse(orgRow!.input)).toMatchObject({ target_org: "org-a", maxRunsPerHour: 30 });
    // null removes a limit
    await asInstance("set_quotas", { target_org: "org-a", max_runs_per_hour: null });
    expect((await getOrgQuotas(db, a.orgId)).maxRunsPerHour).toBeNull();
  });

  test("max_concurrent can only lower the instance cap: above it is refused, at it and none are fine", async () => {
    const over = await asInstance("set_quotas", { target_org: "org-a", max_concurrent: 5 });
    expect(!over.ok && over.error.code).toBe("invalid_input");
    expect(!over.ok && over.error.message).toContain("per-org cap of 4");
    expect((await getOrgQuotas(db, a.orgId)).maxConcurrent).toBeNull();
    expect((await asInstance("set_quotas", { target_org: "org-a", max_concurrent: 4 })).ok).toBe(
      true,
    );
    expect((await asInstance("set_quotas", { target_org: "org-a", max_concurrent: 0 })).ok).toBe(
      true,
    );
    expect((await asInstance("set_quotas", { target_org: "org-a", max_concurrent: null })).ok).toBe(
      true,
    );
    // without a configured cap the other limits are unaffected by the clamp
    const noCap = { ...env, instanceOrgCap: undefined };
    expect(
      (await asInstance("set_quotas", { target_org: "org-a", max_concurrent: 99 }, noCap)).ok,
    ).toBe(true);
  });

  test("bad input: unknown or system org, nothing named, an org or project field, unknown keys", async () => {
    for (const input of [
      { target_org: "nope", max_log_bytes: 1 },
      { target_org: "_system", max_log_bytes: 1 },
      { target_org: "org-a" },
      { target_org: "org-a", max_log_bytes: -1 },
      { target_org: "org-a", max_log_bytes: 1, org: "org-a" },
      { target_org: "org-a", max_log_bytes: 1, project: "app" },
      { target_org: "org-a", max_log_bytes: 1, extra: true },
    ]) {
      const r = await asInstance("set_quotas", input);
      expect(r.ok).toBe(false);
    }
    expect(await getOrgQuotas(db, a.orgId)).toMatchObject({ maxLogBytes: null });
  });
});

describe("no org principal reaches an instance op, and the instance token reaches no org op", () => {
  test("every org token of every role, project-scoped, and members, on every instance op: forbidden, nothing changed", async () => {
    const before = JSON.stringify(await getOrgQuotas(db, a.orgId));
    for (const t of [a, b]) {
      for (const { label, cred } of await orgCreds(t)) {
        for (const op of registry.instanceOps()) {
          const input =
            op.name === "set_quotas"
              ? { target_org: "org-a", max_log_bytes: 1 }
              : op.name === "set_project_pr_policy"
                ? { target_org: "org-a", target_project: "app", pr_mode: "off" }
                : op.name === "set_project_egress"
                  ? { target_org: "org-a", target_project: "app", egress: "open" }
                  : op.name === "set_project_settings"
                    ? { target_org: "org-a", target_project: "app", max_concurrent: 1 }
                    : op.name === "instance_set_setting"
                      ? { key: "backup_keep", value: 1 }
                      : op.name === "bootstrap_approver"
                        ? { target_org: "org-a", person: "x", forge_login: "x", public_key: "k" }
                        : op.name === "create_project"
                          ? { target_org: "org-a", slug: "sneaky", name: "x" }
                          : op.name === "create_org"
                            ? { slug: "sneaky-org", name: "x" }
                            : op.name === "instance_bind_github_login"
                              ? {
                                  target_org: "org-a",
                                  github_login: "x",
                                  role: "viewer",
                                  reason: "x",
                                }
                              : op.name === "instance_start_installation_claim"
                                ? { target_org: "org-a", github_login: "x", reason: "x" }
                                : op.name === "instance_bind_installation"
                                  ? {
                                      installation_id: "1",
                                      target_org: "org-a",
                                      expected_account: "x",
                                      reason: "x",
                                    }
                                  : op.name === "move_repo_binding"
                                    ? {
                                        owner: "acme",
                                        repo: "api",
                                        to_org: "org-a",
                                        to_project: "app",
                                      }
                                    : op.name === "create_org_token"
                                      ? {
                                          target_org: "org-a",
                                          name: "x",
                                          role: "reader",
                                          expires_days: 1,
                                        }
                                      : {};
          const r = await dispatch(env, cred, op.name, input);
          expect(r.ok, `${label} on ${op.name}`).toBe(false);
          if (!r.ok) expect(r.error.code, `${label} on ${op.name}`).toBe("forbidden");
        }
      }
    }
    expect(JSON.stringify(await getOrgQuotas(db, a.orgId))).toBe(before);
    expect(await getProjectSandboxSettings(db, a.scope)).toMatchObject({
      sandboxSnapshot: null,
      maxConcurrent: null,
    });
    expect(
      registry
        .instanceOps()
        .map((o) => o.name)
        .toSorted(),
    ).toEqual([
      "bootstrap_approver",
      "create_org",
      "create_org_token",
      "create_project",
      "db_backup",
      "instance_audit_verify",
      "instance_bind_github_login",
      "instance_bind_installation",
      "instance_db_copy",
      "instance_doctor",
      "instance_drain",
      "instance_drain_status",
      "instance_get_setting",
      "instance_github_app_status",
      "instance_infra_errors",
      "instance_ingest_status",
      "instance_list_orgs",
      "instance_list_settings",
      "instance_network_status",
      "instance_org_summary",
      "instance_prune_unconfigured_projects",
      "instance_revoke_org_token",
      "instance_run_activity",
      "instance_run_summary",
      "instance_sandbox_limits",
      "instance_set_setting",
      "instance_start_installation_claim",
      "instance_whoami",
      "log_store_migrate",
      "move_repo_binding",
      "register_sandbox_image",
      "rotate_instance_token",
      "set_project_egress",
      "set_project_pr_policy",
      "set_project_settings",
      "set_quotas",
    ]);
    expect((await listProjects(db, { orgId: a.orgId })).map((p) => p.slug)).toEqual(["app"]);
  });

  test("the instance token on every other op: forbidden (it holds no org grant), even with an org named", async () => {
    for (const op of registry.ops.filter((o) => o.auth.type !== "instance")) {
      const r = await asInstance(op.name, { org: "org-a" });
      expect(r.ok, op.name).toBe(false);
      if (!r.ok) expect(["forbidden", "signature_required"], op.name).toContain(r.error.code);
    }
  });

  test("a tti_-shaped string is never an org token, even if its hash is in api_tokens", async () => {
    const fake = `tti_${"A".repeat(43)}`;
    await insertApiToken(
      db,
      { orgId: a.orgId },
      { name: "x", role: "operator", tokenHash: hashToken(fake), createdBy: "t" },
    );
    const r = await dispatch(env, { kind: "bearer", token: fake }, "list_runs", {});
    expect(!r.ok && r.error.code).toBe("unauthenticated");
    // and an org token is not an instance token
    const org = (await mintToken(db, { orgId: a.orgId }, "release_operator")).secret;
    const r2 = await dispatch(env, { kind: "bearer", token: org }, "set_quotas", {
      target_org: "org-a",
      max_log_bytes: 1,
    });
    expect(!r2.ok && r2.error.code).toBe("forbidden");
  });
});

describe("REST only", () => {
  test("REST accepts it; MCP and a dispatcher without allowInstance do not; no MCP tool is an instance op", async () => {
    const api = createRestApi({ registry, db, instanceOrgCap: 4 });
    const rest = await handleRequest(
      new Request("http://localhost/api/v1/instance/quotas", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ target_org: "org-a", max_log_bytes: 123 }),
      }),
      api,
    );
    expect(rest!.status).toBe(200);
    expect((await getOrgQuotas(db, a.orgId)).maxLogBytes).toBe(123);
    const whoami = await handleRequest(
      new Request("http://localhost/api/v1/instance/whoami", {
        headers: { authorization: `Bearer ${secret}` },
      }),
      api,
    );
    expect(whoami!.status).toBe(200);
    // an org token over the same route
    const org = (await mintToken(db, { orgId: a.orgId }, "release_operator")).secret;
    const denied = await handleRequest(
      new Request("http://localhost/api/v1/instance/quotas", {
        method: "POST",
        headers: { authorization: `Bearer ${org}`, "content-type": "application/json" },
        body: JSON.stringify({ target_org: "org-a", max_log_bytes: 1 }),
      }),
      api,
    );
    expect(denied!.status).toBe(403);
    // MCP: the instance token is not a credential there
    const mcp = createMcpHttp({ registry, db });
    const res = await mcp(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res!.status).toBe(401);
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("set_quotas");
    for (const op of registry.instanceOps()) expect(op.mcp).toBe(false);
    // a dispatcher that does not allow instance tokens treats one as an unknown token
    const plain = await dispatch(
      { registry, db },
      { kind: "bearer", token: secret },
      "instance_whoami",
      {},
    );
    expect(!plain.ok && plain.error.code).toBe("unauthenticated");
  });

  test("the realtime socket's authentication refuses an instance token too", async () => {
    const { resolveCallerScope } = await import("../src/ops/dispatch");
    await expect(
      resolveCallerScope({ registry, db }, { kind: "bearer", token: secret }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  test("a bad, expired or unknown tti_ token fails like any bad token, and is audited in the system chain", async () => {
    const unknown = `tti_${"B".repeat(43)}`;
    const r = await dispatch(env, { kind: "bearer", token: unknown }, "instance_whoami", {});
    expect(!r.ok && r.error.code).toBe("unauthenticated");
    expect(!r.ok && r.error.message).toBe(
      await dispatch(env, { kind: "bearer", token: `tt_${"B".repeat(43)}` }, "list_runs", {}).then(
        (x) => (!x.ok ? x.error.message : ""),
      ),
    );
    const expiring = await createInstanceTokenFromCli(db, {
      name: "short",
      now: () => Date.now() - 40 * 86_400_000,
    });
    const old = await dispatch(
      env,
      { kind: "bearer", token: expiring.secret },
      "instance_whoami",
      {},
    );
    expect(!old.ok && old.error.code).toBe("unauthenticated");
    const sys = await systemOrgId(db);
    const rows = await listAudit(db, { orgId: sys }, { limit: 50 });
    expect(rows.some((x) => x.outcome === "error:unauthenticated")).toBe(true);
  });
});

describe("instance_doctor", () => {
  // The raw text and the "secret" are built at run time: no secret-like literal in the file.
  const fakeSecret = () => `sk_${"Z9".repeat(12)}`;
  const seeded = (raw: string) => async () =>
    report([
      { id: "master_key", area: "secrets", status: "pass", summary: "the master key is set" },
      {
        id: "database",
        area: "database",
        status: "fail",
        summary: "the database cannot be read",
        detail: raw,
        fix: "Check the database connection.",
      },
    ]);

  test("a tti_ token gets the report: names and states, no raw error text or secret", async () => {
    const raw = `connect failed postgres://u:${fakeSecret()}@10.1.2.3/db /etc/secret/path`;
    const e: DispatchEnv = { ...env, doctor: seeded(raw) };
    const r = await asInstance("instance_doctor", {}, e);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.output as ReturnType<typeof report>;
    expect(out.status).toBe("fail");
    expect(out.counts).toEqual({ pass: 1, warn: 0, fail: 1 });
    expect(out.checks.map((c) => c.id)).toEqual(["master_key", "database"]);
    const text = JSON.stringify(r.output);
    expect(text).not.toContain(fakeSecret());
    expect(text).not.toContain("10.1.2.3");
    expect(text).not.toContain("/etc/secret/path");
    expect(text).not.toContain("detail");
    expect(text).not.toContain(secret);
    expect(r.untrusted).toBe(false);
  });

  test("is a read: the dispatcher writes no entry for it, and no entry holds the raw text", async () => {
    const e: DispatchEnv = { ...env, doctor: seeded(`raw ${fakeSecret()}`) };
    await asInstance("instance_doctor", {}, e);
    const sys = await systemOrgId(db);
    const rows = await listAudit(db, { orgId: sys }, { limit: 50 });
    expect(rows.some((x) => x.op === "instance_doctor" && x.effect !== "read")).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(fakeSecret());
  });

  test("without a server runner it says so, in one warning", async () => {
    const r = await asInstance("instance_doctor");
    expect(r.ok && (r.output as ReturnType<typeof report>).counts).toEqual({
      pass: 0,
      warn: 1,
      fail: 0,
    });
  });

  test("org tokens of every role, project-scoped, members and MCP are refused", async () => {
    const e: DispatchEnv = { ...env, doctor: seeded(`raw ${fakeSecret()}`) };
    for (const t of [a, b]) {
      for (const { label, cred } of await orgCreds(t)) {
        const r = await dispatch(e, cred, "instance_doctor", {});
        expect(r.ok, label).toBe(false);
        if (!r.ok) expect(r.error.code, label).toBe("forbidden");
      }
    }
    const op = registry.ops.find((o) => o.name === "instance_doctor")!;
    expect(op.mcp).toBe(false);
    expect(op.effect).toBe("read");
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("instance_doctor");
    // a dispatcher that does not allow instance tokens treats one as unknown
    const plain = await dispatch(
      { registry, db, doctor: e.doctor },
      { kind: "bearer", token: secret },
      "instance_doctor",
      {},
    );
    expect(!plain.ok && plain.error.code).toBe("unauthenticated");
  });
});
