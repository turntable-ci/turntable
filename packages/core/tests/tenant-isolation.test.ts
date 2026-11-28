// Cross-tenant hostile suite (#52, part 3). Two orgs, each with data; every call org B can make
// is made with org A's ids, names and slugs, and must neither show A's data nor change A's state.
//
// The cases are generated from the ops registry, so a new op is probed the day it is added:
//  - inputs are sampled from each op's zod schema; a field the sampler cannot place with A's data
//    and that looks like an id or name fails the suite until it is mapped (see `FIELD`);
//  - an op the sampler cannot reach (every call is invalid_input) fails unless listed in
//    UNREACHABLE with a reason, so coverage cannot silently rot;
//  - leaks are found by markers (A's ids, slugs, names, log text, secret value) in any output,
//    error or frame B receives, and by a fingerprint of EVERY row of EVERY table owned by A taken
//    before and after, so a write that changed A is caught even when it returned an error;
//  - positive controls run the same inputs as A and must see the markers, so the detector is
//    proven able to see.
// It also runs the same inputs through REST and MCP, and the realtime WebSocket.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { getTableConfig as pgTableConfig, PgTable } from "drizzle-orm/pg-core";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { randomBytes } from "node:crypto";
import { generateEd25519, signEd25519 } from "../src/approvals/keys";
import {
  addCut,
  appendEvent,
  appendLog,
  bindRepo,
  createAttempt,
  createPolledRun,
  insertApprover,
  transitionJob,
  createJob,
  createProject,
  createRun,
  type Db,
  getAttempt,
  getJob,
  getRun,
  listRuns,
  openDatabase,
  readLog,
  recordArtifact,
  schema,
  upsertStep,
} from "../src/db";
import { AGENT_ROLES } from "../src/db/schema";
import type { Op } from "../src/ops";
import { dispatch, registry, type Credential, type Principal } from "../src/ops";
import { createMcpHttp } from "../src/mcp/http";
import { createRestApi } from "../src/ops/rest";
import { createRealtime, type WsData } from "../src/realtime/server";
import type { ServerMessage } from "../src/realtime/protocol";
import { handleRequest } from "../src/server";
import { SecretVault } from "../src/secrets/vault";
import { WebhookService } from "../src/webhooks/service";
import { mintToken, seedTenant, type Tenant } from "./ops-helpers";

// Generated from the op registry: every op is probed per principal, so the cases grow with the
// registry and run slower on Postgres. The 5 s default is too tight for them.
setDefaultTimeout(60_000);

// Two worlds are open at once (the hostile one and the control one): on PGlite, which is one
// connection, each needs its own instance.
process.env.TURNTABLE_TEST_PGLITE_ISOLATED = "1";

// ---- the world ----

const A_VALUE = "A-SECRET-VALUE-0f3a9c";
const A_LOG = "A-LOG-LINE-7d21e0 do not show";
const A_SHA = "c0ffee".repeat(6) + "c0ff"; // 40 hex
const A_SECRET = "a-only-secret";
const A_RULE = "a-only-rule";

type Who = { label: string; cred: Credential; role: string };

type World = {
  db: Db;
  env: {
    registry: typeof registry;
    db: Db;
    vault: SecretVault;
    webhooks: WebhookService;
    webauthn: { rpId: string; origins: string[] };
  };
  a: Tenant;
  b: Tenant;
  aOnly: {
    projectId: string;
    projectSlug: string;
    runId: string;
    jobId: string;
    attemptId: string;
    /** A token of A, named for the marker; the target of revoke_api_token. */
    tokenId: string;
  };
  /** Org A's special-state fixtures, for the ops that need them to succeed. */
  fx: Record<string, string>;
  /** Strings that must never reach org B. */
  markers: string[];
  aWho: Who[];
  bWho: Who[];
};

async function buildWorld(): Promise<World> {
  const db = openDatabase(":memory:");
  const vault = new SecretVault({ db, masterKey: randomBytes(32) });
  const masterKey = randomBytes(32);
  const webhooks = new WebhookService({ db, masterKey });
  const env = {
    registry,
    db,
    vault,
    webhooks,
    webauthn: { rpId: "ci.example.com", origins: ["https://ci.example.com"] },
    // A release challenge binds the lane's config version, and release_public_key reads a key,
    // both from the lane: fixed answers here. The lane's own org scoping is in release-keys.test.ts.
    releaseConfig: {
      call: async (action: string) => ({
        ok: true as const,
        result:
          action === "key_public"
            ? {
                keyid: "k".repeat(64),
                public_key_pem: "-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----\n",
                created_at: 1_700_000_000_000,
                status: "active",
                config_version: 0,
              }
            : { config_version: 0 },
      }),
    },
    githubUsers: { idOfLogin: async (l: string) => `gh-${l.toLowerCase()}` },
    // `run_dispatch` needs the poller and a forge; this stand-in honours its contract (the run
    // lands in the scope the dispatcher resolved, and nowhere else) so the op is reached for
    // real. The ref and sha rules are in run-dispatch.test.ts.
    runDispatcher: async (
      scope: { orgId: string; projectId: string },
      _repo: string | undefined,
      _req: unknown,
    ) => {
      const sha = "c".repeat(40);
      const run = await createRun(db, scope, {
        // Never the sampler's input: B writing A's marker into B's own run is not a leak.
        workflowPath: ".github/workflows/dispatched.yml",
        event: "workflow_dispatch",
        ref: "refs/heads/main",
        sha,
      });
      return {
        runId: run.id,
        repo: "dispatch/stub",
        sha,
        ref: "refs/heads/main",
        trustClass: "protected" as const,
        held: false,
        inputNames: [],
        superseded: [],
      };
    },
  };
  const a = await seedTenant(db, "org-a");
  const b = await seedTenant(db, "org-b");

  // A second project of A with distinct, recognisable data.
  const proj = await createProject(
    db,
    { orgId: a.orgId },
    { slug: "a-only-project", name: "A only" },
  );
  const scope = { orgId: a.orgId, projectId: proj.id };
  const run = await createRun(db, scope, {
    workflowPath: ".github/workflows/a-only-workflow.yml",
    event: "push",
    ref: "refs/heads/a-only-branch",
    sha: A_SHA,
    actor: "a-only-actor",
    commitMessage: "a-only-commit-message",
  });
  const job = (await createJob(db, scope, {
    runId: run.id,
    jobKey: "a-only-job",
    name: "a-only-job",
  }))!;
  const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "test" }))!;
  await appendLog(db, scope, attempt.id, 0, new TextEncoder().encode(`${A_LOG}\n`));
  const step = await upsertStep(db, scope, {
    attemptId: attempt.id,
    stepKey: "a-only-step",
    stage: "main",
    index: 0,
    name: "a-only-step-name",
    logOffset: 0,
  });
  if (!step) throw new Error("fixture step was not stored");
  await addCut(db, scope, {
    attemptId: attempt.id,
    atOffset: 5,
    omittedBytes: 9,
    reason: "a-only-cut",
  });
  await appendEvent(db, scope, {
    type: "run.queued",
    runId: run.id,
    payload: { note: "a-only-event-payload" },
  });
  // The seeded org-A project too gets an artifact.
  await recordArtifact(db, a.scope, {
    runId: a.runId,
    attemptId: a.attemptId,
    name: "a-only-artifact.tgz",
    sha256: "e".repeat(64),
    size: 1,
  });

  // Secrets, proxy rules and passthrough hosts, through A's own operator, so audit rows exist.
  const aRel = (await mintToken(db, { orgId: a.orgId }, "release_operator", { kind: "person" }))
    .secret;
  const asA = (name: string, input: Record<string, unknown>) =>
    dispatch(env, { kind: "bearer", token: aRel }, name, input);
  const mk = async (name: string, input: Record<string, unknown>) => {
    const r = await asA(name, input);
    if (!r.ok) throw new Error(`fixture ${name} failed: ${r.error.code} ${r.error.message}`);
  };
  await mk("set_secret", { name: A_SECRET, value: A_VALUE, destinations: ["a-only.example.com"] });
  await mk("set_proxy_rule", {
    project: "a-only-project",
    name: A_RULE,
    secret: A_SECRET,
    host: "a-only.example.com",
    methods: ["GET"],
    path_prefix: "/",
    inject: { type: "header", name: "authorization", format: "Bearer {secret}" },
  });

  // A failed job (for rerun), a run held for an untrusted author, a run waiting on an environment
  // approval with an enrolled approver, a pending enrolment, a release request.
  await transitionJob(db, scope, job.id, "running").catch(() => undefined);
  await transitionJob(db, scope, job.id, "failure", { exitCode: 1 }).catch(() => undefined);
  const WF = "ab".repeat(32);
  const planned = (key: string, environment?: string) => ({
    key,
    id: key,
    name: key,
    needs: [],
    needsIds: [],
    ...(environment ? { environment } : {}),
    continueOnError: false,
    outputs: {},
    failFast: true,
  });
  const polled = async (
    t: Tenant,
    workflowPath: string,
    sha: string,
    klass: string,
    hold: boolean,
    environment?: string,
  ) =>
    (await createPolledRun(db, t.scope, {
      repo: `${t.slug}/app`,
      provider: "test",
      now: Date.now(),
      hold,
      run: {
        workflowPath,
        event: hold ? "pull_request" : "push",
        ref: hold ? "refs/pull/9/head" : "refs/heads/main",
        sha,
        actor: t === a ? "a-only-actor" : "b-actor",
        trust: JSON.stringify({ class: klass, workflowHash: WF }),
      },
      jobs: [{ key: "deploy", name: "deploy", needs: [], planned: planned("deploy", environment) }],
    }))!.run.id;
  const heldSha = "d1".repeat(20);
  const heldRunId = await polled(a, ".github/workflows/a-held.yml", heldSha, "untrusted_pr", true);
  const envSha = "e2".repeat(20);
  const bEnvRunId = await polled(
    b,
    ".github/workflows/b-release.yml",
    "b3".repeat(20),
    "protected",
    false,
    "production",
  );
  const envRunId = await polled(
    a,
    ".github/workflows/a-release.yml",
    envSha,
    "protected",
    false,
    "production",
  );
  await bindRepo(db, a.scope, { forge: "github", owner: "org-a", repo: "app" });
  const alice = generateEd25519();
  const aliceRow = await insertApprover(
    db,
    a.orgId,
    {
      person: "alice-a-only",
      forgeLogin: "alice-a-only-gh",
      kind: "ed25519",
      publicKey: alice.publicSpki,
      alg: "EdDSA",
      createdBy: "test",
    },
    Date.now(),
  );
  const aOp = (await mintToken(db, { orgId: a.orgId }, "operator")).secret;
  const chal = await dispatch(env, { kind: "bearer", token: aOp }, "approval_challenge", {
    run_id: envRunId,
    environment: "production",
    approver: aliceRow.id,
    project: "app",
  });
  if (!chal.ok) throw new Error(`fixture approval_challenge failed: ${chal.error.message}`);
  const statement = (chal.output as { statement: unknown; canonical: string }).statement;
  const canonical = (chal.output as { canonical: string }).canonical;
  const enrol = await asA("request_enrolment", {
    project: "app",
    person: "carol-a-only",
    forge_login: "carol-a-only-gh",
    ed25519_public_key: generateEd25519().publicSpki,
  }).catch(() => undefined);
  const enrolmentId =
    enrol && enrol.ok ? (enrol.output as { enrolment_id: string }).enrolment_id : "";
  const rel = await asA("request_release", {
    project: "app",
    run_id: a.runId,
    tag: "v1.0.0",
    artifacts: ["a-only-artifact.tgz"],
  });
  const releaseId = rel.ok ? (rel.output as { id: string }).id : "";
  const hook = await webhooks.createEndpoint(
    { orgId: a.orgId },
    {
      url: "https://a-only-hook.example.test/x",
      description: "a-only-webhook",
      eventTypes: null,
      createdBy: "test:setup",
      fromStart: false,
    },
  );
  const fx: Record<string, string> = {
    webhookId: hook.id,
    heldRunId,
    heldSha,
    envRunId,
    bEnvRunId,
    envSha,
    workflowHash: WF,
    aliceId: aliceRow.id,
    enrolmentId,
    releaseId,
    statement: JSON.stringify(statement),
    signature: JSON.stringify({
      kind: "ed25519",
      signature: signEd25519(alice.privatePem, canonical),
    }),
  };

  const aToken = await mintToken(db, { orgId: a.orgId }, "reader", { name: "a-only-token" });

  const who = async (t: Tenant, label: string): Promise<Who[]> => {
    const out: Who[] = [];
    for (const role of AGENT_ROLES) {
      const tok = (await mintToken(db, { orgId: t.orgId }, role)).secret;
      out.push({ label: `${label} ${role} token`, cred: { kind: "bearer", token: tok }, role });
    }
    const scoped = (await mintToken(db, t.scope, "release_operator", { kind: "person" })).secret;
    out.push({
      label: `${label} project-scoped release_operator`,
      cred: { kind: "bearer", token: scoped },
      role: "release_operator",
    });
    const admin: Principal = {
      kind: "member",
      id: `admin-${label}`,
      orgId: t.orgId,
      role: "admin",
    };
    out.push({
      label: `${label} member admin`,
      cred: { kind: "principal", principal: admin },
      role: "admin",
    });
    return out;
  };
  return {
    db,
    env,
    a,
    b,
    aOnly: {
      projectId: proj.id,
      projectSlug: "a-only-project",
      runId: run.id,
      jobId: job.id,
      attemptId: attempt.id,
      tokenId: aToken.id,
    },
    fx,
    markers: [
      a.orgId,
      heldRunId,
      envRunId,
      "alice-a-only",
      "carol-a-only",
      aliceRow.id,
      releaseId,
      a.projectId,
      a.runId,
      a.jobId,
      a.attemptId,
      "org-a",
      proj.id,
      run.id,
      job.id,
      attempt.id,
      aToken.id,
      "a-only-token",
      "a-only-commit-message",
      "a-only-actor",
      "a-only-step-name",
      "a-only-cut",
      "a-only-event-payload",
      "a-only-late",
      "a-only-workflow",
      "a-only-branch",
      "a-only-job",
      A_SHA,
      A_LOG,
      A_VALUE,
      A_SECRET,
      A_RULE,
      "a-only-artifact",
      "a-only-hook.example.test",
      "a-only-webhook",
    ],
    aWho: await who(a, "A"),
    bWho: await who(b, "B"),
  };
}

// ---- generating inputs from the registry ----

/** How a field that names something of A's is filled. Unmapped id-like fields fail the suite. */
const FIELD: Record<string, (w: World) => unknown> = {
  run_id: (w) => w.aOnly.runId,
  consumer_run_id: (w) => w.aOnly.runId, // check_artifact_consumption
  job_id: (w) => w.aOnly.jobId,
  attempt_id: (w) => w.aOnly.attemptId,
  token_id: (w) => w.aOnly.tokenId,
  name: () => A_RULE, // proxy rule name; also a valid secret name
  secret: () => A_SECRET,
  sha: () => A_SHA,
  host: () => "a-only.example.com",
  environment: () => "a-only-env",
  tag: () => "v1.0.0",
  ref: () => "refs/heads/a-only-branch",
  workflow: () => ".github/workflows/a-only-workflow.yml",
  repo: () => "org-a/app",
  after: () => 0,
  from_offset: () => 0,
  offset: () => 0,
  limit: () => 100,
  query: () => "a-only",
  pattern: () => "a-only",
  artifacts: () => ["a-only-artifact.tgz"],
  id: (w) => w.aOnly.runId,
  webhook_id: (w) => w.fx.webhookId!,
  enrolment_id: (w) => w.aOnly.runId,
  installation_id: () => "424242",
  claim_id: () => "a-only-claim", // get_installation_claim
};
/** Fields handled by the variant, not here. */
const VARIANT_FIELDS = new Set(["org", "project"]);
/** Any field whose name looks like it points at something. */
const ID_LIKE = /(^|_)id$|^name$|^slug$|^sha$|^ref$|^tag$/;

type Zod = { _zod: { def: Record<string, any> }; safeParse(v: unknown): { success: boolean } };

function optionalField(s: Zod): boolean {
  return s.safeParse(undefined).success;
}

function leaf(s: Zod): unknown {
  for (const c of [
    "x",
    "xxx",
    "GET",
    "a".repeat(40),
    "a".repeat(64),
    "2026-01-01T00:00:00.000Z",
    1,
    0,
    true,
    [],
    {},
    null,
  ])
    if (s.safeParse(c).success) return c;
  return "x";
}

function sampleValue(s: Zod): unknown {
  const def = s._zod.def;
  switch (def.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(def.shape as Record<string, Zod>)) {
        if (!optionalField(v)) out[k] = sampleValue(v);
      }
      return out;
    }
    case "union":
      for (const opt of def.options as Zod[]) {
        const v = sampleValue(opt);
        if (opt.safeParse(v).success) return v;
      }
      return leaf(s);
    case "array": {
      const one = [sampleValue(def.element as Zod)];
      return s.safeParse(one).success ? one : [];
    }
    case "literal":
      return (def.values as unknown[])[0];
    case "enum":
      return Object.values(def.entries as Record<string, unknown>)[0];
    case "optional":
    case "default":
    case "nullable":
      return sampleValue(def.innerType as Zod);
    default:
      return leaf(s);
  }
}

/** Ops that need A's special-state fixtures to succeed at all. */
const OVERRIDE: Record<string, (w: World, input: Record<string, unknown>) => void> = {
  failure_digest: (_w, i) => void delete i.job_id,
  // The sampler's name for a proxy rule would put the marker into B's own token list.
  create_api_token: (_w, i) => Object.assign(i, { name: "b-minted" }),
  set_proxy_rule: (_w, i) =>
    Object.assign(i, {
      methods: ["GET"],
      path_prefix: "/",
      inject: { type: "header", name: "authorization" },
    }),
  approve_run: (w, i) =>
    Object.assign(i, {
      run_id: w.fx.heldRunId,
      head_sha: w.fx.heldSha,
      workflow_hash: w.fx.workflowHash,
    }),
  approve_run_challenge: (w, i) =>
    Object.assign(i, { run_id: w.fx.heldRunId, approver: w.fx.aliceId }),
  approval_challenge: (w, i) =>
    Object.assign(i, { run_id: w.fx.envRunId, environment: "production", approver: w.fx.aliceId }),
  release_approval_challenge: (w, i) =>
    Object.assign(i, { run_id: w.fx.envRunId, approver: w.fx.aliceId }),
  key_policy_challenge: (w, i) =>
    Object.assign(i, {
      mode: "hardware",
      aaguids: ["00000000-0000-0000-0000-000000000001"],
      approver: w.fx.aliceId,
    }),
  enrolment_challenge: (w, i) =>
    Object.assign(i, { enrolment_id: w.fx.enrolmentId, approver: w.fx.aliceId }),
  request_enrolment: (_w, i) =>
    Object.assign(i, {
      person: "mallory-p",
      forge_login: "mallory-gh",
      ed25519_public_key: generateEd25519().publicSpki,
    }),
  create_webhook: (_w, i) => void (i.url = "https://hooks.example.test/x"),
  get_release_request: (w, i) => Object.assign(i, { id: w.fx.releaseId }),
  submit_approval: (w, i) =>
    Object.assign(i, {
      statement: JSON.parse(w.fx.statement!),
      signature: JSON.parse(w.fx.signature!),
    }),
};

type Variant = "explicit" | "ids-only";

/** Inputs for one op: A's ids and names, and either A's slugs ("explicit") or B's own scope. */
function inputFor(
  op: Op,
  w: World,
  variant: Variant,
): { input: Record<string, unknown>; unmapped: string[] } {
  const input: Record<string, unknown> = {};
  const unmapped: string[] = [];
  const shape = op.input.shape as unknown as Record<string, Zod>;
  for (const [k, s] of Object.entries(shape)) {
    if (VARIANT_FIELDS.has(k)) continue;
    const mapped = FIELD[k];
    if (mapped) {
      input[k] = mapped(w);
      continue;
    }
    if (optionalField(s)) continue;
    if (ID_LIKE.test(k)) unmapped.push(k);
    input[k] = sampleValue(s);
  }
  if (variant === "explicit") {
    input.org = "org-a";
    input.project = w.aOnly.projectSlug;
  } else if (op.scope === "project") {
    input.project = "app"; // B's own project
  }
  OVERRIDE[op.name]?.(w, input);
  return { input, unmapped };
}

// ---- observing ----

/** Every row of every table owned by one org, as a hash: any change to A shows up. */
async function fingerprint(w: World, orgId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of Object.values(schema)) {
    // The schema module hands out the tables of the dialect the suite runs on.
    if (!(t instanceof SQLiteTable) && !(t instanceof PgTable)) continue;
    const cfg = t instanceof PgTable ? pgTableConfig(t) : getTableConfig(t);
    const col = cfg.columns.find((c) => c.name === "org_id");
    if (!col) continue;
    const rows = (await w.db.run((h) => h.orm.select().from(t))) as Record<string, unknown>[];
    const mine = rows
      .filter(
        (r) =>
          Object.values(r).includes(orgId) &&
          r[Object.keys(r).find((k) => (t as never)[k] === col) ?? ""] === orgId,
      )
      .map((r) => {
        // A token's last_used_at moves when its owner uses it, not when someone else does.
        const { lastUsedAt: _l, ...rest } = r as Record<string, unknown>;
        return JSON.stringify(rest, (_k, v) =>
          v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v,
        );
      })
      .toSorted();
    out[cfg.name] = `${mine.length}:${Bun.hash(mine.join("\n"))}`;
  }
  return out;
}

/**
 * Markers found in `text`, except those B itself put in the request (an echo of what you sent is
 * not a leak; the data that would only come from A's rows is).
 */
const leaks = (w: World, text: string, sent: unknown = null): string[] => {
  const mine = JSON.stringify(sent);
  return w.markers.filter((m) => text.includes(m) && !mine.includes(m));
};

type Outcome = { ok: boolean; code: string; text: string };
async function call(w: World, who: Who, op: Op, input: Record<string, unknown>): Promise<Outcome> {
  const r = await dispatch(w.env, who.cred, op.name, input);
  return r.ok
    ? { ok: true, code: "ok", text: JSON.stringify(r.output) }
    : {
        ok: false,
        code: r.error.code,
        text: `${r.error.message} ${JSON.stringify(r.error.details ?? "")}`,
      };
}

/** Ops no token can call, and ops with no input to aim. Each needs a reason. */
const UNREACHABLE: Record<string, string> = {
  set_project_var:
    "the fixture project has no stored ingest settings to hold variables, so the call is refused for A as well; B is still probed and refused. Both orgs' sets, deletes and the cross-org refusal are in project-vars-ops.test.ts",
  delete_project_var:
    "the fixture project has no stored ingest settings to hold variables, so the call is refused for A as well; B is still probed and refused. Both orgs' sets, deletes and the cross-org refusal are in project-vars-ops.test.ts",
  get_artifact:
    "the fixture has no artifact store (artifacts are off), so the call is refused for A as well; B is still probed and finds no such artifact of its own. The bytes, the traversal refusals and the other-org not_found are in release-artifact-bytes.test.ts",
  get_artifact_file:
    "the fixture has no artifact store (artifacts are off), so the call is refused for A as well; B is still probed and finds no such artifact of its own. The bytes, the traversal refusals and the other-org not_found are in release-artifact-bytes.test.ts",
  get_artifact_files:
    "the fixture has no artifact store (artifacts are off), so the call is refused for A as well; B is still probed and finds no such artifact of its own. The bytes, the traversal refusals and the other-org not_found are in release-artifact-bytes.test.ts",
  release_approval_challenge:
    "needs a run whose jobs wait on the project's release environment with recorded release-class artifacts, which the fixture lacks; refused by the handler for A as well. B is still probed: it reaches the handler and finds no such run. The approval itself is covered in release-approval-v2.test.ts",
  key_policy_challenge:
    "a hardware policy needs a counted passkey with an allowed AAGUID, and the fixture approvers are ed25519; refused by the handler for A as well. B is still probed: it reaches the handler and finds no such approver of its own",
  get_approval_policy:
    "owner role: no token holds it, so every token principal of A and B is refused alike; an owner session works in its own org alone, and approval-policy-web.test.ts covers the gate",
  change_project_pr_policy:
    "owner or admin web sessions only (every token of A and B is refused alike); project-pr-policy.test.ts covers the roles, the owner-only widening and the project scoping",
  tighten_project_egress:
    "owner web sessions only (every token of A and B is refused alike); project-egress.test.ts covers the role, the tighten-only rule and the project scoping",
  set_approval_policy:
    "owner web sessions only (every token of A and B is refused alike), and a loosening needs a passkey step-up; approval-policy-web.test.ts covers the gate and the org scoping",
  approval_policy_challenge:
    "needs a counted approver key id and a change that loosens a policy; refused by the handler for A as well. B is still probed: it reaches the handler and finds no such approver of its own. The statement and quorum are in approval-policy-web.test.ts",
  first_approver_challenge:
    "owner web sessions only (every token of A and B is refused alike); a session works in its own org alone, and first-approver-passkey.test.ts covers the gate",
  enrol_first_approver:
    "owner web sessions only (every token of A and B is refused alike); a session works in its own org alone, and first-approver-passkey.test.ts covers the gate",
  instance_rotate_webhook_secret:
    "session only (a token is refused alike) and an owner of the org that owns the GitHub App, with a passkey step-up; B is probed and refused; the checks are in instance-app-secrets.test.ts",
  instance_replace_app_private_key:
    "session only (a token is refused alike) and an owner of the org that owns the GitHub App, with a passkey step-up; B is probed and refused; the checks are in instance-app-secrets.test.ts",
  start_installation_claim:
    "needs a configured GitHub App; the claim flow's tenant checks are in hosted-app.test.ts",
  bind_installation:
    "web sessions only (a token is refused alike) and needs a configured GitHub App and the person's own GitHub token; B is probed and refused; the binding checks are in onboarding-account.test.ts",
  get_installation_claim:
    "needs a configured GitHub App for its claim store; another org's claim is not found for B, which onboarding-claim.test.ts covers",
  resync_installation:
    "needs a configured GitHub App and an installation of A; org B is probed and gets not_found, and the ownership, rate limit and adoption are in github-resync.test.ts",
  list_installation_repos:
    "needs a configured GitHub App to list the installation's repos; org B is probed and gets not_found for A's installation id, and the ownership check is in onboarding-repos.test.ts (another org's installation looks like none)",
  onboard_repos:
    "needs an admin: no token holds that role, so every token principal of A and B is refused alike; the org scoping (an installation of another org looks like none) and the batch are in onboarding-repos.test.ts",
  add_project:
    "needs an admin (no token holds that role) and a configured GitHub App, so every token principal of A and B is refused alike; the installation scoping (another org's installation looks like none), the repo check and the audit are in projects-add-remove.test.ts",
  preview_workflows:
    "needs a configured GitHub App and a repo reader; org B is probed and finds no such project of its own, and the preview itself is in onboarding-repos.test.ts",
  run_default_branch:
    "needs an admin (no token holds that role) and the poller; org B is probed and finds no such project or onboarding of its own, and the run, the onboarding row's org check and the refusals are in onboarding-repos.test.ts",
  release_pin_repo:
    "lane configuration (#541): a signed-in WEB SESSION of an owner of the operator org only; every token principal of A and B is refused alike. Who may call it, per op and per credential, is release-lane-owner.test.ts",
  release_publish_target_set:
    "lane configuration (#541): a signed-in WEB SESSION of an owner of the operator org only; every token principal of A and B is refused alike. Who may call it, per op and per credential, is release-lane-owner.test.ts",
  release_publish_target_delete:
    "lane configuration (#541): a signed-in WEB SESSION of an owner of the operator org only; every token principal of A and B is refused alike. Who may call it, per op and per credential, is release-lane-owner.test.ts",
  release_secret_set:
    "lane configuration (#541): a signed-in WEB SESSION of an owner of the operator org only; every token principal of A and B is refused alike. Who may call it, per op and per credential, is release-lane-owner.test.ts",
  release_init_key:
    "lane configuration (#541): a signed-in WEB SESSION of an owner of the operator org only; every token principal of A and B is refused alike. Who may call it, per op and per credential, is release-lane-owner.test.ts",
  release_set_project_signing:
    "lane configuration (#541): a signed-in WEB SESSION of an owner of the operator org only; every token principal of A and B is refused alike. Who may call it, per op and per credential, is release-lane-owner.test.ts",
  release_publish_target_list:
    "lane configuration (#541): a signed-in WEB SESSION of an owner of the operator org only; every token principal of A and B is refused alike. Who may call it, per op and per credential, is release-lane-owner.test.ts",
  release_key_show:
    "lane configuration (#541): a signed-in WEB SESSION of an owner of the operator org only; every token principal of A and B is refused alike. Who may call it, per op and per credential, is release-lane-owner.test.ts",
  release_cosign_key_set:
    "lane configuration (#541, #544): a signed-in WEB SESSION of an owner of the operator org only; every token principal of A and B is refused alike. Who may call it, per op and per credential, is release-lane-owner.test.ts and release-cosign-manifest.test.ts",
  release_cosign_key_remove:
    "lane configuration (#541, #544): a signed-in WEB SESSION of an owner of the operator org only; every token principal of A and B is refused alike. Who may call it, per op and per credential, is release-lane-owner.test.ts and release-cosign-manifest.test.ts",
  release_cosign_key_list:
    "lane configuration (#541, #544): a signed-in WEB SESSION of an owner of the operator org only; every token principal of A and B is refused alike. Who may call it, per op and per credential, is release-lane-owner.test.ts and release-cosign-manifest.test.ts",
  release_secret_status:
    "lane configuration (#541): a signed-in WEB SESSION of an owner of the operator org only; every token principal of A and B is refused alike. Who may call it, per op and per credential, is release-lane-owner.test.ts",
  doctor:
    "instance operators only: no token holds the owner role it needs, so every token principal of A and B is refused alike; it reports instance facts, never an org's rows (doctor.test.ts covers who may call it)",
  get_setting:
    "the shipped registry has no org or project setting yet, so no key reaches a value for A either; the cross-tenant test with a test registry is in settings.test.ts (tenancy: another org's token ...)",
  set_setting:
    "as get_setting: no shipped org or project setting to set; settings.test.ts covers the cross-tenant write",
  invite_member:
    "needs a GitHub App lookup of the login (a fake is wired in web-sign-in.test.ts, where who may invite, the role cap and replacement are covered); org B is probed and refused alike",
  session_step_up_challenge:
    "web sessions only: no token reaches it (the handler refuses a token principal alike); the binding, org scoping and single use are in session-step-up.test.ts",
  my_pending_approvals:
    "web sessions only: a token of any kind, A's or B's, is refused by the handler (a person's inbox). What a session sees, per org and per person, is in my-pending-approvals.test.ts",
  get_notification_prefs:
    "web sessions only: a token of any kind is refused by the handler (a person's own preferences). Per-person scoping is in notifications.test.ts",
  set_notification_prefs:
    "web sessions only: a token of any kind is refused by the handler (a person's own preferences). Per-person scoping and the org membership check are in notifications.test.ts",
  accept_action_move:
    "needs a recorded action pin and verdict; covered by action-pins.test.ts, re-probed below by repo",
};

let hostile: World;
let control: World;
beforeAll(async () => {
  hostile = await buildWorld();
  control = await buildWorld();
});

const tokenOps = (): Op[] => registry.tokenOps();

describe("generated from the registry: every op, every B principal, A's ids and slugs", () => {
  test("the sampler places every id-like field with A's data (a new op fails here until mapped)", () => {
    const missing: string[] = [];
    for (const op of tokenOps()) {
      for (const v of ["explicit", "ids-only"] as const) {
        for (const f of inputFor(op, hostile, v).unmapped) missing.push(`${op.name}.${f}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  test("org B can neither read nor change anything of org A, through any op", async () => {
    const before = await fingerprint(hostile, hostile.a.orgId);
    const problems: string[] = [];
    const reached = new Set<string>();
    for (const op of tokenOps()) {
      for (const variant of ["explicit", "ids-only"] as const) {
        const { input } = inputFor(op, hostile, variant);
        for (const who of hostile.bWho) {
          const out = await call(hostile, who, op, input);
          if (out.code !== "invalid_input") reached.add(op.name);
          const found = leaks(hostile, out.text, input);
          if (found.length > 0)
            problems.push(`${op.name} [${variant}] as ${who.label} leaked ${found.join(",")}`);
        }
      }
      const after = await fingerprint(hostile, hostile.a.orgId);
      const changed = Object.keys(after).filter((t) => after[t] !== before[t]);
      if (changed.length > 0) {
        problems.push(`${op.name} changed org A's ${changed.join(",")}`);
        Object.assign(before, after); // report each op once
      }
    }
    expect(problems).toEqual([]);
    // every op got past input validation at least once, or has a stated reason
    const unreached = tokenOps()
      .map((o) => o.name)
      .filter((n) => !reached.has(n) && !(n in UNREACHABLE));
    expect(unreached).toEqual([]);
  });

  test("a call that targets A's id looks the same as one that targets an id that does not exist", async () => {
    const differ: string[] = [];
    const mask = (s: string, ...ids: string[]) =>
      ids.reduce((acc, id) => acc.replaceAll(id, "<ID>"), s);
    const fresh = {
      run_id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      job_id: "01HZZZZZZZZZZZZZZZZZZZZZZY",
      attempt_id: "01HZZZZZZZZZZZZZZZZZZZZZZX",
    };
    for (const op of tokenOps()) {
      const shape = Object.keys(op.input.shape);
      const idFields = (["run_id", "job_id", "attempt_id"] as const).filter((f) =>
        shape.includes(f),
      );
      if (idFields.length === 0) continue;
      const { input } = inputFor(op, hostile, "ids-only");
      const guess: Record<string, unknown> = { ...input };
      for (const f of idFields) if (f in guess) guess[f] = fresh[f];
      for (const who of hostile.bWho) {
        const a = await call(hostile, who, op, input);
        const b = await call(hostile, who, op, guess);
        const ids = [
          hostile.aOnly.runId,
          hostile.aOnly.jobId,
          hostile.aOnly.attemptId,
          ...Object.values(fresh),
        ];
        if (a.ok !== b.ok || a.code !== b.code || mask(a.text, ...ids) !== mask(b.text, ...ids)) {
          differ.push(
            `${op.name} as ${who.label}: A's id gives ${a.code}, a missing id gives ${b.code}`,
          );
        }
      }
    }
    expect(differ).toEqual([]);
  });

  test("positive control: the same inputs as org A DO reach A's data and change A's state", async () => {
    const seen = new Set<string>();
    const ok = new Set<string>();
    const wrote = new Set<string>();
    for (const op of tokenOps()) {
      const before = await fingerprint(control, control.a.orgId);
      for (const who of control.aWho) {
        for (const variant of ["explicit", "ids-only"] as const) {
          const { input } = inputFor(op, control, variant);
          const out = await call(control, who, op, input);
          if (out.ok) ok.add(op.name);
          if (out.ok && leaks(control, out.text, input).length > 0) seen.add(op.name);
        }
      }
      const after = await fingerprint(control, control.a.orgId);
      if (Object.keys(after).some((t) => after[t] !== before[t])) wrote.add(op.name);
    }
    // Reached for real: some call as A succeeded, so B's refusal is not just a bad sample.
    expect(
      tokenOps()
        .map((o) => o.name)
        .filter((n) => !ok.has(n) && !(n in UNREACHABLE)),
    ).toEqual([]);
    // If the detector were blind these would be empty and the hostile test would prove nothing.
    const mustSee = [
      "get_run",
      "list_runs",
      "job_log",
      "job_steps",
      "list_secrets",
      "list_proxy_rules",
    ];
    expect(mustSee.filter((n) => !seen.has(n))).toEqual([]);
    expect(["set_secret", "set_proxy_rule"].filter((n) => !wrote.has(n))).toEqual([]);
  });

  test("no org principal of any role reaches an instance op (the instance administrator is not an org)", async () => {
    const before = await fingerprint(hostile, hostile.a.orgId);
    const ops = registry.instanceOps();
    expect(ops.length).toBeGreaterThan(0);
    for (const who of [...hostile.aWho, ...hostile.bWho]) {
      for (const op of ops) {
        const input =
          op.name === "set_quotas"
            ? { target_org: "org-a", max_log_bytes: 1 }
            : op.name === "set_project_settings"
              ? { target_org: "org-a", target_project: "app", max_concurrent: 1 }
              : op.name === "create_project"
                ? { target_org: "org-a", slug: "sneaky", name: "x" }
                : {};
        const out = await call(hostile, who, op, input);
        expect(out.ok, `${who.label} on ${op.name}`).toBe(false);
        expect(out.code, `${who.label} on ${op.name}`).toBe("forbidden");
      }
    }
    // and none of it changed org A
    const after = await fingerprint(hostile, hostile.a.orgId);
    expect(Object.keys(after).filter((t) => after[t] !== before[t])).toEqual([]);
  });

  test("signature ops cannot be called with a token at all", async () => {
    for (const op of registry.ops.filter((o) => o.auth.type === "signature")) {
      for (const who of hostile.bWho) {
        const out = await call(hostile, who, op, inputFor(op, hostile, "explicit").input);
        expect(out.ok).toBe(false);
        expect(["signature_required", "forbidden"]).toContain(out.code);
      }
    }
  });
});

// ---- the same inputs over REST and MCP ----

async function restCall(
  api: ReturnType<typeof createRestApi>,
  op: Op,
  input: Record<string, unknown>,
  token: string,
): Promise<string> {
  let path = op.http.path;
  const rest = { ...input };
  for (const m of path.matchAll(/\{([^}]+)\}/g)) {
    const key = m[1] as string;
    path = path.replace(`{${key}}`, encodeURIComponent(String(rest[key] ?? "x")));
    delete rest[key];
  }
  const query =
    op.http.method === "POST"
      ? ""
      : `?${new URLSearchParams(
          Object.entries(rest)
            .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
            .map(([k, v]): [string, string] => [k, String(v)]),
        )}`;
  const res = await handleRequest(
    new Request(`http://localhost/api/v1${path}${query}`, {
      method: op.http.method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(op.http.method === "POST" ? { body: JSON.stringify(rest) } : {}),
    }),
    api,
  );
  return res ? await res.text() : "";
}

let mcpId = 0;
async function mcpCall(
  mcp: ReturnType<typeof createMcpHttp>,
  op: Op,
  input: Record<string, unknown>,
  token: string,
): Promise<string> {
  const res = await mcp(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++mcpId,
        method: "tools/call",
        params: { name: op.name, arguments: input },
      }),
    }),
  );
  return res ? await res.text() : "";
}

const bearers = (who: Who[]): { label: string; token: string }[] =>
  who.flatMap((x) => (x.cred.kind === "bearer" ? [{ label: x.label, token: x.cred.token }] : []));

describe("REST and MCP: the same hostile inputs through the real transports", () => {
  test("REST: no op returns A's data or changes A's state to a B token", async () => {
    const api = createRestApi(hostile.env);
    const before = await fingerprint(hostile, hostile.a.orgId);
    const problems: string[] = [];
    for (const op of registry.documentedOps()) {
      for (const variant of ["explicit", "ids-only"] as const) {
        const { input } = inputFor(op, hostile, variant);
        for (const who of bearers(hostile.bWho)) {
          const text = await restCall(api, op, input, who.token);
          const found = leaks(hostile, text, input);
          if (found.length > 0)
            problems.push(`REST ${op.name} [${variant}] as ${who.label} leaked ${found.join(",")}`);
        }
      }
    }
    const after = await fingerprint(hostile, hostile.a.orgId);
    for (const t of Object.keys(after))
      if (after[t] !== before[t]) problems.push(`REST changed org A's ${t}`);
    expect(problems).toEqual([]);
  });

  test("REST and MCP positive control: A's own token reads A's data through the same calls", async () => {
    // A fresh world: the registry-wide control above has already changed the other one.
    const fresh = await buildWorld();
    const api = createRestApi(fresh.env);
    const mcp = createMcpHttp(fresh.env);
    const reader = bearers(fresh.aWho)[0]!.token;
    for (const name of ["get_run", "job_log", "list_runs"]) {
      const op = registry.get(name)!;
      const { input } = inputFor(op, fresh, "explicit");
      expect(leaks(fresh, await restCall(api, op, input, reader), input).length).toBeGreaterThan(0);
    }
    const op = registry.get("get_run")!;
    const { input } = inputFor(op, fresh, "explicit");
    expect(leaks(fresh, await mcpCall(mcp, op, input, reader), input).length).toBeGreaterThan(0);
  });

  test("MCP: tools/call with A's ids returns nothing of A's", async () => {
    const mcp = createMcpHttp(hostile.env);
    const before = await fingerprint(hostile, hostile.a.orgId);
    const problems: string[] = [];
    for (const op of registry.mcpOps()) {
      for (const variant of ["explicit", "ids-only"] as const) {
        const { input } = inputFor(op, hostile, variant);
        for (const who of bearers(hostile.bWho)) {
          const text = await mcpCall(mcp, op, input, who.token);
          const found = leaks(hostile, text, input);
          if (found.length > 0)
            problems.push(`MCP ${op.name} [${variant}] as ${who.label} leaked ${found.join(",")}`);
        }
      }
    }
    const after = await fingerprint(hostile, hostile.a.orgId);
    for (const t of Object.keys(after))
      if (after[t] !== before[t]) problems.push(`MCP changed org A's ${t}`);
    expect(problems).toEqual([]);
  });
});

// ---- realtime ----

describe("realtime WebSocket", () => {
  let server: ReturnType<typeof Bun.serve<WsData>>;
  let rt: ReturnType<typeof createRealtime>;
  let base: string;
  beforeAll(() => {
    const api = createRestApi(hostile.env);
    rt = createRealtime({ env: hostile.env, limits: {}, allowedOrigins: [] });
    server = Bun.serve<WsData>({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const r = await rt.handle(req, srv);
        if (r === "upgraded") return undefined;
        if (r) return r;
        return handleRequest(req, api);
      },
      websocket: rt.websocket,
    });
    base = `127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    rt.stop();
    await server.stop(true);
  });

  async function connect(
    token: string,
  ): Promise<{ msgs: ServerMessage[]; send(m: object): void; close(): void }> {
    const ws = new WebSocket(`ws://${base}/api/v1/realtime`, ["turntable.v1", `bearer.${token}`]);
    const msgs: ServerMessage[] = [];
    ws.onmessage = (e) => void msgs.push(JSON.parse(String(e.data)) as ServerMessage);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("socket error"));
    });
    return { msgs, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() };
  }

  test("B subscribes to A's topics, by guessed ids, with replay from zero, and gets nothing", async () => {
    const bTok = (
      hostile.bWho.find((x) => x.role === "release_operator")!.cred as { token: string }
    ).token;
    const aTok = (hostile.aWho.find((x) => x.role === "reader")!.cred as { token: string }).token;
    const c = await connect(bTok);
    const topics = [
      `run:${hostile.aOnly.runId}`,
      `run:${hostile.a.runId}`,
      `attempt:${hostile.aOnly.attemptId}:log`,
      `attempt:${hostile.a.attemptId}:log`,
      `attempt:${hostile.aOnly.attemptId}:steps`,
      `project:${hostile.aOnly.projectSlug}`,
      "org",
    ];
    topics.forEach((topic, i) =>
      c.send({ op: "subscribe", id: `s${i}`, topic, after: 0, from_offset: 0 }),
    );
    // the positive control: A's own reader sees the same topics work
    const ac = await connect(aTok);
    ac.send({
      op: "subscribe",
      id: "a1",
      topic: `attempt:${hostile.aOnly.attemptId}:log`,
      from_offset: 0,
    });
    ac.send({ op: "subscribe", id: "a2", topic: "org", after: 0 });
    await Bun.sleep(150);
    // new activity in A after the subscriptions
    await appendLog(
      hostile.db,
      { orgId: hostile.a.orgId, projectId: hostile.aOnly.projectId },
      hostile.aOnly.attemptId,
      40,
      new TextEncoder().encode("A-LATE-LOG-LINE\n"),
    );
    await appendEvent(
      hostile.db,
      { orgId: hostile.a.orgId, projectId: hostile.aOnly.projectId },
      { type: "run.queued", runId: hostile.aOnly.runId, payload: { late: "a-only-late" } },
    );
    await Bun.sleep(300);
    const mine = JSON.stringify(c.msgs);
    expect(leaks(hostile, mine + "A-LATE-LOG-LINE")).toEqual(
      ["A-LATE-LOG-LINE"].filter(() => false),
    );
    expect(mine).not.toContain("A-LATE-LOG-LINE");
    expect(mine).not.toContain("a-only-late");
    // A's topics are refused as if they did not exist
    const refused = c.msgs.filter((m) => m.type === "error");
    expect(refused.length).toBeGreaterThanOrEqual(5);
    expect(new Set(refused.map((m) => (m as { code: string }).code))).toEqual(
      new Set(["not_found"]),
    );
    // control: A's reader did get A's data
    expect(JSON.stringify(ac.msgs)).toContain("A-LOG-LINE-7d21e0");
    c.close();
    ac.close();
  });
});

// ---- the data layer, by guessed id ----

describe("repos: B's scope never resolves A's rows, even with A's exact ids", () => {
  test("runs, jobs, attempts, logs, artifacts", async () => {
    const w = hostile;
    const bScope = w.b.scope;
    expect(await getRun(w.db, bScope, w.aOnly.runId)).toBeUndefined();
    expect(await getRun(w.db, bScope, w.a.runId)).toBeUndefined();
    expect(await getJob(w.db, bScope, w.aOnly.jobId)).toBeUndefined();
    expect(await getAttempt(w.db, bScope, w.aOnly.attemptId)).toBeUndefined();
    expect(await readLog(w.db, bScope, w.aOnly.attemptId, 0)).toEqual([]);
    expect((await listRuns(w.db, bScope)).map((r) => r.id)).not.toContain(w.aOnly.runId);
    await expect(
      recordArtifact(w.db, bScope, {
        runId: w.a.runId,
        attemptId: w.a.attemptId,
        name: "stolen.tgz",
        sha256: "f".repeat(64),
        size: 1,
      }),
    ).rejects.toThrow(/no such run/);
    // control: A's own scope resolves them
    expect(await getRun(w.db, w.a.scope, w.a.runId)).toBeDefined();
  });
});

// ---- stores the registry does not reach directly ----

describe("vault, proxy rules, approvals and installations", () => {
  test("vault: org B's jobs cannot use A's secret by name, by A's job ids, or by A's org id", async () => {
    const w = hostile;
    const { eq } = await import("drizzle-orm");
    const running = async (t: Tenant) => {
      await w.db.orm
        .update(schema.jobAttempts)
        .set({ state: "running", trustClass: "protected" })
        .where(eq(schema.jobAttempts.id, t.attemptId));
    };
    await running(w.a);
    await running(w.b);
    const req = (t: Tenant, over: Record<string, unknown> = {}) => ({
      orgId: t.orgId,
      projectId: t.projectId,
      runId: t.runId,
      jobId: t.jobId,
      attemptId: t.attemptId,
      name: A_SECRET,
      destination: "a-only.example.com",
      ...over,
    });
    // control: the same secret is usable by A's own job once it is org-wide and deliverable here
    await w.env.vault.set(
      w.a.orgId,
      "test",
      { name: A_SECRET, projectId: null, environment: null, refPattern: null },
      A_VALUE,
      {
        destinations: ["a-only.example.com"],
      },
    );
    const own = await w.env.vault.use(req(w.a) as never);
    expect(own.ok).toBe(true);
    // B's own running job asks for A's secret name: no such secret in B's org
    const byName = await w.env.vault.use(req(w.b) as never);
    expect(byName).toEqual({ ok: false, reason: "no_match" });
    // B's org with A's job ids, and A's org with B's job ids: the run does not resolve
    for (const r of [
      req(w.a, { orgId: w.b.orgId, projectId: w.b.projectId }),
      req(w.b, { orgId: w.a.orgId, projectId: w.a.projectId }),
      req(w.a, { projectId: w.b.projectId }),
    ]) {
      const out = await w.env.vault.use(r as never);
      expect(out.ok).toBe(false);
      expect(JSON.stringify(out)).not.toContain(A_VALUE);
    }
    expect((await w.env.vault.list(w.b.orgId)).map((s) => s.name)).not.toContain(A_SECRET);
    expect(
      await w.env.vault.canDeliver(w.b.orgId, w.b.projectId, A_SECRET, "a-only.example.com"),
    ).toBe(false);
  });

  test("proxy rules and passthrough hosts: B's scope lists none of A's", async () => {
    const { listProxyRules, listPassthroughHosts, deleteProxyRule } =
      await import("../src/db/repos");
    const w = hostile;
    expect((await listProxyRules(w.db, w.b.scope)).map((r) => r.name)).not.toContain(A_RULE);
    expect(await listProxyRules(w.db, { orgId: w.b.orgId, projectId: w.aOnly.projectId })).toEqual(
      [],
    );
    expect(
      await listPassthroughHosts(w.db, { orgId: w.b.orgId, projectId: w.aOnly.projectId }),
    ).toEqual([]);
    // deleting by A's rule name from B's scope removes nothing of A's
    expect(
      await deleteProxyRule(w.db, { orgId: w.b.orgId, projectId: w.b.projectId }, A_RULE),
    ).toBe(false);
    const aRules = await listProxyRules(w.db, { orgId: w.a.orgId, projectId: w.aOnly.projectId });
    expect(aRules.map((r) => r.name)).toContain(A_RULE); // control
  });

  test("approvals: B's approver cannot approve A's run, by challenge, by forged statement, or by replay", async () => {
    const w = hostile;
    const { approvalsRepo } = { approvalsRepo: await import("../src/db/repos") };
    const bob = generateEd25519();
    const bobRow = await insertApprover(
      w.db,
      w.b.orgId,
      {
        person: "bob-b-only",
        forgeLogin: "bob-b-only-gh",
        kind: "ed25519",
        publicKey: bob.publicSpki,
        alg: "EdDSA",
        createdBy: "test",
      },
      Date.now(),
    );
    const bOp = (w.bWho.find((x) => x.role === "operator")!.cred as { token: string }).token;
    const asB = (name: string, input: Record<string, unknown>) =>
      dispatch(w.env, { kind: "bearer", token: bOp }, name, input);
    const before = await fingerprint(w, w.a.orgId);
    const auditBefore = new Set(
      (await listAuditRows(w, w.a.orgId)).map((r) => r.id + r.op + r.outcome + r.input),
    );
    // a challenge for A's run, with A's approver or B's own
    for (const approver of [w.fx.aliceId!, bobRow.id]) {
      const r = await asB("approval_challenge", {
        run_id: w.fx.envRunId,
        environment: "production",
        approver,
        project: "app",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("not_found");
    }
    // B gets a legitimate challenge for ITS run, then edits the statement to name A's run and org
    const own = await asB("approval_challenge", {
      run_id: w.fx.bEnvRunId,
      environment: "production",
      approver: bobRow.id,
      project: "app",
    });
    const forged = [
      { run_id: w.fx.envRunId },
      { org: "org-a" },
      {
        org: "org-a",
        run_id: w.fx.envRunId,
        head_sha: w.fx.envSha,
        workflow_hash: w.fx.workflowHash,
      },
    ];
    expect(own.ok ? "ok" : `${own.error.code}: ${own.error.message}`).toBe("ok"); // a real challenge to start from
    if (own.ok) {
      const st = (own.output as { statement: Record<string, unknown>; canonical: string })
        .statement;
      for (const patch of forged) {
        const statement = { ...st, ...patch };
        const sig = {
          kind: "ed25519",
          signature: signEd25519(bob.privatePem, JSON.stringify(statement)),
        };
        for (const credential of [
          { kind: "signed" as const },
          { kind: "bearer" as const, token: bOp },
        ]) {
          const name = credential.kind === "signed" ? "approve_environment" : "submit_approval";
          const out = await dispatch(w.env, credential, name, { statement, signature: sig });
          expect(out.ok).toBe(false);
        }
      }
    }
    // A's own valid statement and signature, replayed by B's token
    const replay = await asB("submit_approval", {
      project: "app",
      statement: JSON.parse(w.fx.statement!),
      signature: JSON.parse(w.fx.signature!),
    });
    expect(replay.ok).toBe(false);
    // the data layer: B's org never sees A's approvers, enrolments or records
    const repos = approvalsRepo as unknown as {
      getApprover(db: Db, org: string, id: string): Promise<unknown>;
      getEnrolment(db: Db, org: string, id: string): Promise<unknown>;
      listApprovers(db: Db, org: string): Promise<{ id: string }[]>;
      listEnvironmentRecords(db: Db, org: string, runId: string): Promise<unknown[]>;
    };
    expect(await repos.getApprover(w.db, w.b.orgId, w.fx.aliceId!)).toBeUndefined();
    expect(await repos.getApprover(w.db, w.a.orgId, w.fx.aliceId!)).toBeDefined(); // control
    if (w.fx.enrolmentId)
      expect(await repos.getEnrolment(w.db, w.b.orgId, w.fx.enrolmentId)).toBeUndefined();
    expect((await repos.listApprovers(w.db, w.b.orgId)).map((a) => a.id)).not.toContain(
      w.fx.aliceId!,
    );
    expect(await repos.listEnvironmentRecords(w.db, w.b.orgId, w.fx.envRunId!)).toEqual([]);
    // None of it changed A, except that a forged signed statement NAMING org A is recorded as an
    // authentication failure in A's own chain (by design: an attempt against A is visible to A).
    // Those rows are failures only, throttled, and carry no data of A's.
    const after = await fingerprint(w, w.a.orgId);
    expect(Object.keys(after).filter((t) => t !== "audit_log" && after[t] !== before[t])).toEqual(
      [],
    );
    const added = (await listAuditRows(w, w.a.orgId))
      .slice(0, 50 - 0)
      .filter((r) => !auditBefore.has(r.id + r.op + r.outcome + r.input));
    for (const r of added) {
      expect(r.outcome.startsWith("error:")).toBe(true);
      expect(["approve_environment", "submit_approval"]).toContain(r.op);
    }
  });

  test("installations: an installation org A holds cannot be claimed or listed by org B", async () => {
    const { setup, fakeFacts, inst, repo } = await import("./github-helpers");
    const { syncInstallation } = await import("../src/github/installations");
    const { createOrg, listInstallations } = await import("../src/db");
    const s = await setup();
    const orgA = await createOrg(s.db, { slug: "tenant-a", name: "A" });
    const orgB = await createOrg(s.db, { slug: "tenant-b", name: "B" });
    const f = fakeFacts();
    f.installations.set("100", inst("100"));
    f.repos.set("100", [repo("1", "api")]);
    const claimed = await syncInstallation(s.db, f.facts, "100", {
      claimMode: true,
      claimedBy: orgA.id,
    });
    expect(claimed.outcome).toBe("synced");
    await expect(
      syncInstallation(s.db, f.facts, "100", { claimMode: true, claimedBy: orgB.id }),
    ).rejects.toThrow();
    expect(await listInstallations(s.db, { orgId: orgB.id })).toEqual([]);
    expect(
      (await listInstallations(s.db, { orgId: orgA.id })).map((i) => i.installationId),
    ).toEqual(["100"]);
    // a webhook for it, in claim mode, is mapped to its holder only
    const again = await syncInstallation(s.db, f.facts, "100", { claimMode: true });
    expect(again.outcome).toBe("synced");
    expect(await listInstallations(s.db, { orgId: orgB.id })).toEqual([]);
  });
});

async function listAuditRows(w: World, orgId: string) {
  const { listAudit } = await import("../src/db");
  return (await listAudit(w.db, { orgId }, { limit: 500 })).map((r) => ({
    op: r.op,
    kind: r.principalKind,
    id: r.principalId,
    outcome: r.outcome,
    input: r.input,
  }));
}
