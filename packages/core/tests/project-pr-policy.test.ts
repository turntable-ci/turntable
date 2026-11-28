// get_project_pr_policy, change_project_pr_policy (owner or admin) and set_project_pr_policy
// (instance administrator): roles, loosening needs the owner, bot logins, audit, MCP read-only,
// and the skipped-PR list in ingest_status.
import { beforeEach, describe, expect, test } from "bun:test";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { getProjectIngest, listAudit, setProjectIngest, type Db } from "../src/db";
import { dispatch, type Credential, type DispatchEnv, registry } from "../src/ops";
import { mcpTools } from "../src/ops/mcp";
import {
  ingestStatus,
  MAX_SKIPPED_PRS,
  resetIngestStatus,
  skippedFromRefused,
} from "../src/poll/status";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let env: DispatchEnv;
let inst: string;

const INGEST = {
  defaultBranch: "main",
  prMode: "allowlist",
  authors: ["octocat"],
  tagRefs: ["refs/tags/v*"],
};

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  env = { registry, db, allowInstance: true };
  inst = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
  await setProjectIngest(db, a, JSON.stringify(INGEST));
  resetIngestStatus();
});

const member = (role: "owner" | "admin" | "member"): Credential =>
  ({
    kind: "principal",
    principal: { kind: "member", id: "m", orgId: a.orgId, role },
  }) as Credential;
const change = (cred: Credential, input: object) =>
  dispatch(env, cred, "change_project_pr_policy", { project: "app", ...input });
const asInstance = (input: object) =>
  dispatch(env, { kind: "bearer", token: inst }, "set_project_pr_policy", {
    target_org: "org-a",
    target_project: "app",
    ...input,
  });
const stored = async () => JSON.parse((await getProjectIngest(db, a)) as string);

describe("project pr policy", () => {
  test("a bot login is allowlisted by the owner, audited, and other ingest settings are kept", async () => {
    const r = await change(member("owner"), { authors: ["octocat", "longshore-x[bot]"] });
    expect(r.ok && r.output).toMatchObject({ loosened: true });
    const s = await stored();
    expect(s.authors).toEqual(["octocat", "longshore-x[bot]"]);
    expect(s.tagRefs).toEqual(["refs/tags/v*"]);
    expect(s.prMode).toBe("allowlist");
    const e = (await listAudit(db, a)).find(
      (x) => x.op === "change_project_pr_policy" && String(x.input).includes("from"),
    );
    expect(JSON.parse(String(e?.input))).toMatchObject({
      from: { authors: ["octocat"] },
      to: { authors: ["octocat", "longshore-x[bot]"] },
      loosened: true,
    });
  });

  test("an admin may tighten but not widen the list or switch to approval", async () => {
    const adm = member("admin");
    const widen = await change(adm, { authors: ["octocat", "newbie"] });
    expect(!widen.ok && widen.error.code).toBe("forbidden");
    expect((await change(adm, { pr_mode: "approval" })).ok).toBe(false);
    expect((await stored()).prMode).toBe("allowlist");
    expect((await change(adm, { authors: [] })).ok).toBe(true);
    expect((await change(adm, { pr_mode: "off" })).ok).toBe(true);
    // going back from off needs the owner
    expect((await change(adm, { pr_mode: "allowlist" })).ok).toBe(false);
    expect((await change(member("owner"), { pr_mode: "allowlist" })).ok).toBe(true);
  });

  test("adding an author while the mode is off still needs the owner (the merge queue reads authors)", async () => {
    await setProjectIngest(db, a, JSON.stringify({ ...INGEST, prMode: "off", mergeQueue: true }));
    const adm = member("admin");
    const widen = await change(adm, { authors: ["octocat", "mallory"] });
    expect(!widen.ok && widen.error.code).toBe("forbidden");
    expect((await stored()).authors).toEqual(["octocat"]);
    const r = await change(member("owner"), { authors: ["octocat", "mallory"] });
    expect(r.ok && r.output).toMatchObject({ loosened: true });
  });

  test("a member and an operator token are refused", async () => {
    expect((await change(member("member"), { pr_mode: "off" })).ok).toBe(false);
    const op = (await mintToken(db, a, "operator")).secret;
    expect((await change({ kind: "bearer", token: op }, { pr_mode: "off" })).ok).toBe(false);
    expect((await stored()).prMode).toBe("allowlist");
  });

  test("the instance administrator sets any change, an org owner cannot call the instance op", async () => {
    const r = await asInstance({ pr_mode: "approval", authors: ["Octocat", "octocat", "a[bot]"] });
    expect(r.ok && r.output).toMatchObject({
      to: { pr_mode: "approval", authors: ["Octocat", "a[bot]"] },
    });
    expect((await stored()).prMode).toBe("approval");
    const denied = await dispatch(env, member("owner"), "set_project_pr_policy", {
      target_org: "org-a",
      target_project: "app",
      pr_mode: "off",
    });
    expect(denied.ok).toBe(false);
  });

  test("invalid logins, an empty change and a project without ingest are refused", async () => {
    const owner = member("owner");
    expect((await change(owner, { authors: ["bad login"] })).ok).toBe(false);
    expect((await change(owner, { authors: ["x[bot"] })).ok).toBe(false);
    expect((await change(owner, {})).ok).toBe(false);
    await setProjectIngest(db, a, null);
    const r = await change(owner, { pr_mode: "off" });
    expect(!r.ok && r.error.code).toBe("conflict");
  });

  test("a no-op change writes no audit row", async () => {
    await change(member("owner"), { authors: ["octocat"] });
    expect(
      (await listAudit(db, a)).filter(
        (e) => e.op === "change_project_pr_policy" && String(e.input).includes("from"),
      ),
    ).toHaveLength(0);
  });

  test("get is an MCP tool for a reader, the setters are not", async () => {
    const names = mcpTools(registry).map((t) => t.name);
    expect(names).toContain("get_project_pr_policy");
    expect(names).not.toContain("change_project_pr_policy");
    expect(names).not.toContain("set_project_pr_policy");
    const reader = (await mintToken(db, a, "reader")).secret;
    const r = await dispatch(env, { kind: "bearer", token: reader }, "get_project_pr_policy", {
      project: "app",
    });
    expect(r.ok && r.output).toMatchObject({
      ingest_enabled: true,
      pr_mode: "allowlist",
      authors: ["octocat"],
    });
  });

  test("ingest_status lists skipped PRs with the reason", async () => {
    ingestStatus.repos.set("acme/web", {
      repo: "acme/web",
      org: "org-a",
      project: "app",
      intervalSeconds: 60,
      lastPollAt: null,
      lastSuccessAt: null,
      lastOutcome: null,
      lastError: null,
      nextPollAt: null,
      consecutiveFailures: 0,
      runsCreated: 0,
      authMode: null,
      rateLimit: undefined,
      skippedPrs: [{ number: 4, reason: "author not allowlisted", at: 1_800_000_000_000 }],
    });
    const tok = (await mintToken(db, a, "reader")).secret;
    const r = await dispatch(env, { kind: "bearer", token: tok }, "ingest_status", {});
    const repos = r.ok ? (r.output as { repos: { skipped_prs: unknown[] }[] }).repos : [];
    expect(repos[0]?.skipped_prs).toEqual([
      {
        number: 4,
        reason: "author not allowlisted",
        since: new Date(1_800_000_000_000).toISOString(),
      },
    ]);
  });
});

describe("skippedFromRefused cap", () => {
  const refuse = (n: number, reason: string) => ({ what: `pr #${n}`, reason });
  const fork = (n: number) => refuse(n, "fork PRs are refused");

  test("an author-refused PR stays listed across polls past the cap", () => {
    const refused = [
      ...Array.from({ length: MAX_SKIPPED_PRS + 4 }, (_, i) => fork(i + 1)),
      refuse(500, "author is not on the allowlist"),
    ];
    let prior = skippedFromRefused(refused, undefined, 1000);
    for (let poll = 1; poll <= 8; poll++) {
      const next = skippedFromRefused(refused, prior, 1000 + poll * 60_000);
      expect(next).toHaveLength(MAX_SKIPPED_PRS);
      const bot = next.find((p) => p.number === 500);
      expect(bot?.reason).toBe("author not allowlisted");
      expect(bot?.at).toBe(1000);
      prior = next;
    }
  });
});
