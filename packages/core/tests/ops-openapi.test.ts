import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registry } from "../src/ops";
import { lintOutputSchemas, outputFieldNames } from "../src/ops/lint";
import { mcpTools } from "../src/ops/mcp";
import { OPENAPI_DOC_VERSION, buildOpenApi } from "../src/ops/openapi";
import { createRegistry, defineOp } from "../src/ops";
import { z } from "zod";

const DOC = join(import.meta.dir, "../../../docs/openapi.json");

test("docs/openapi.json is current (run `bun run --cwd packages/core openapi:gen`)", () => {
  const committed = JSON.parse(readFileSync(DOC, "utf8"));
  // compare parsed, so formatter whitespace cannot flap this
  expect(committed).toEqual(
    JSON.parse(JSON.stringify(buildOpenApi(registry, OPENAPI_DOC_VERSION))),
  );
});

test("the committed document is fixed; the Turntable-Version header is documented", () => {
  const committed = JSON.parse(readFileSync(DOC, "utf8"));
  expect(committed.info.version).toBe(OPENAPI_DOC_VERSION);
  expect(committed.components.headers.TurntableVersion.schema).toEqual({ type: "string" });
  const ok = committed.paths[Object.keys(committed.paths)[0]!];
  const op = ok[Object.keys(ok)[0]!];
  expect(op.responses["200"].headers["Turntable-Version"]).toEqual({
    $ref: "#/components/headers/TurntableVersion",
  });
  expect(committed.components.responses.Unauthenticated.headers["Turntable-Version"]).toBeDefined();
});

test("the generated document is a structurally valid OpenAPI 3.1 document", () => {
  const doc = buildOpenApi(registry, OPENAPI_DOC_VERSION) as any;
  expect(doc.openapi).toBe("3.1.0");
  expect(doc.info.title).toBeString();
  expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
    type: "http",
    scheme: "bearer",
  });

  const ids = new Set<string>();
  const refs: string[] = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "$ref" && typeof v === "string") refs.push(v);
        else collect(v);
      }
    }
  };
  for (const [path, item] of Object.entries<any>(doc.paths)) {
    expect(path.startsWith("/")).toBe(true);
    for (const [method, op] of Object.entries<any>(item)) {
      expect(["get", "post", "delete"]).toContain(method);
      expect(ids.has(op.operationId)).toBe(false);
      ids.add(op.operationId);
      // A download op (artifact bytes) answers an octet stream, not JSON.
      if (registry.get(op.operationId)?.download) {
        expect(op.responses["200"].content["application/octet-stream"].schema).toMatchObject({
          type: "string",
          format: "binary",
        });
      } else {
        expect(op.responses["200"].content["application/json"].schema.type).toBe("object");
      }
      // Signature ops take a signed statement, and account ops a web session cookie: no bearer token.
      expect(op.security).toEqual(
        ["signature", "account"].includes(registry.get(op.operationId)?.auth.type ?? "")
          ? []
          : [{ bearerAuth: [] }],
      );
      // every {param} in the path is declared, required, and in: path
      for (const m of path.matchAll(/\{(\w+)\}/g)) {
        const p = (op.parameters ?? []).find((x: any) => x.name === m[1]);
        expect(p).toMatchObject({ in: "path", required: true });
      }
      if (method === "get") expect(op.requestBody).toBeUndefined();
    }
  }
  collect(doc);
  for (const ref of refs) {
    const target = ref
      .slice(2)
      .split("/")
      .reduce((n: any, k) => n?.[k], doc);
    expect(target).toBeDefined();
  }
  expect([...ids].toSorted()).toEqual(
    [
      ...registry.documentedOps().filter((o) => o.mcp || o.secretInputFields.length === 0),
      ...registry.signatureOps(),
      ...registry.instanceOps().filter((o) => o.secretInputFields.length === 0),
      ...registry.accountOps(),
    ]
      .map((o) => o.name)
      .toSorted(),
  );
});

test("MCP tool list equals the registry minus signature ops", () => {
  const sig = defineOp({
    name: "sign_thing",
    summary: "Placeholder signature op.",
    description: "Test-only placeholder for a human signed action; excluded from tools.",
    input: z.object({}),
    output: z.object({}),
    effect: "write",
    auth: { type: "signature", minRole: "owner" },
    untrustedOutput: false,
    scope: "org",
    http: { method: "POST", path: "/sign" },
    handler: async () => ({}),
  });
  const withSig = createRegistry([...registry.ops, sig]);
  expect(mcpTools(withSig).map((t) => t.name)).toEqual(withSig.mcpOps().map((o) => o.name));
  expect(withSig.documentedOps().map((o) => o.name)).not.toContain("approve_release");
  // Ops no token role can call are not listed.
  expect(mcpTools(registry).map((t) => t.name)).toEqual(registry.mcpOps().map((o) => o.name));
  // Ops that carry a secret value are REST and CLI only: never in an agent's tool list.
  const hiddenFromMcp = registry.documentedOps().filter((o) => !o.mcp);
  // Secret values never reach an agent's context; the approval ops that build a statement to be
  // signed are REST, UI and CLI only too (an agent may relay a signed one, never make one).
  // The setters that decide where secrets flow, widen egress, bless a moved action tag or end an
  // incident stop are human acts too (removing a rule or a host, which only narrows, stays on MCP).
  expect(hiddenFromMcp.map((o) => o.name).toSorted()).toEqual([
    "accept_action_move",
    "add_proxy_passthrough_host",
    "approval_challenge",
    "approval_policy_challenge",
    "approve_run_challenge",
    "create_api_token",
    "delete_project_var",
    "enrolment_challenge",
    "get_artifact",
    "get_artifact_file",
    "get_installation_claim",
    "get_release_approval",
    "incident_unfreeze",
    "invite_member",
    "key_policy_challenge",
    "register_challenge",
    "release_approval_challenge",
    "request_enrolment",
    "request_release",
    "rotate_secret",
    "session_step_up_challenge",
    "set_project_var",
    "set_proxy_rule",
    "set_secret",
    "start_installation_claim",
  ]);
  expect(
    hiddenFromMcp
      .filter((o) => o.secretInputFields.length > 0)
      .map((o) => o.name)
      .toSorted(),
  ).toEqual(["rotate_secret", "set_secret"]);

  for (const tool of mcpTools(registry)) {
    expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(tool.description.length).toBeGreaterThan(60);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties).toHaveProperty("org");
    const op = registry.get(tool.name)!;
    expect(tool.annotations.readOnlyHint).toBe(op.effect === "read");
    expect(tool.annotations.destructiveHint).toBe(op.effect === "destructive");
    expect(tool.untrustedOutput).toBe(op.untrustedOutput);
  }
});

test("operations meet the agent-facing conventions", () => {
  for (const op of registry.ops) {
    expect(op.name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    // log and forge text is flagged
    if (["job_log", "list_runs", "get_run", "checks_for_sha"].includes(op.name)) {
      expect(op.untrustedOutput).toBe(true);
    }
    // writes need at least the operator role; reads may be readers
    // revoke_api_token is the exception: any token may revoke itself, whatever its role, and the
    // handler refuses a reader revoking anyone else's.
    // notifications_ack and set_notification_prefs change only the caller's own rows and refuse
    // every token: a viewer reads their inbox, so a viewer may clear it.
    if (
      op.effect !== "read" &&
      !["revoke_api_token", "notifications_ack", "set_notification_prefs"].includes(op.name)
    ) {
      expect(op.auth.minRole).not.toBe("reader");
    }
    // list ops page by cursor
    if (op.name.startsWith("list_") && op.auth.type !== "account") {
      const props = Object.keys(
        mcpTools(registry).find((t) => t.name === op.name)!.inputSchema.properties ?? {},
      );
      expect(props).toEqual(expect.arrayContaining(["limit", "cursor"]));
      expect(outputFieldNames(op)).toContain("next_cursor");
    }
  }
});

test("output lint: no secret-looking output field except a declared one-time secret", () => {
  expect(lintOutputSchemas(registry)).toEqual([]);
  expect(registry.get("create_api_token")!.oneTimeSecretFields).toEqual(["token"]);

  const make = (field: string, oneTime: string[] = []) =>
    createRegistry([
      defineOp({
        name: "bad_op",
        summary: "Lint fixture.",
        description: "Fixture op used to prove the output lint catches secret-looking fields.",
        input: z.object({}),
        output: z.object({ nested: z.object({ [field]: z.string() }) }),
        effect: "read",
        auth: { type: "token", minRole: "reader" },
        untrustedOutput: false,
        scope: "org",
        http: { method: "GET", path: "/bad" },
        oneTimeSecretFields: oneTime,
        handler: async () => ({ nested: { [field]: "" } }),
      }),
    ]);
  for (const field of [
    "secret",
    "client_secret",
    "password",
    "token_value",
    "api_key",
    "token",
    "private_key",
  ]) {
    expect(lintOutputSchemas(make(field)).length).toBeGreaterThan(0);
  }
  // a declared one-time secret passes; declaring a field that does not exist is flagged
  expect(lintOutputSchemas(make("token", ["token"]))).toEqual([]);
  expect(lintOutputSchemas(make("name", ["token"]))).toHaveLength(1);
});

test("every non-signature op is in every adapter that exists: REST, OpenAPI and MCP", async () => {
  const { createRestApi } = await import("../src/ops/rest");
  const { handleRequest } = await import("../src/server");
  const { openDatabase } = await import("../src/db");
  void handleRequest;
  const api = createRestApi({ registry, db: openDatabase(":memory:") });
  const doc = buildOpenApi(registry, OPENAPI_DOC_VERSION) as any;
  const tools = new Set(mcpTools(registry).map((t) => t.name));
  const operationIds = new Set(
    Object.values<any>(doc.paths).flatMap((item) =>
      Object.values<any>(item).map((o) => o.operationId),
    ),
  );
  for (const op of registry.ops.filter((o) => o.auth.type !== "signature")) {
    const documented = registry.mcpOps().includes(op);
    // OpenAPI lists every REST route that carries no secret value, MCP only the agent-safe ones.
    // Instance ops are listed in OpenAPI (REST, instance token) and never as MCP tools.
    const inOpenApi =
      op.auth.type === "account" ||
      (op.auth.type === "instance" && op.secretInputFields.length === 0) ||
      (registry.documentedOps().includes(op) && (op.mcp || op.secretInputFields.length === 0));
    expect(tools.has(op.name)).toBe(documented);
    expect(operationIds.has(op.name)).toBe(inOpenApi);
    if (inOpenApi) {
      expect(doc.paths[op.http.path]?.[op.http.method.toLowerCase()]?.operationId).toBe(op.name);
    }
    // REST: the route exists. Unauthenticated, it answers 401, not 404 (no route) or 405.
    const path = op.http.path.replaceAll(/\{[^}]+\}/g, "x");
    const res = await api(new Request(`http://x/api/v1${path}`, { method: op.http.method }));
    expect(res?.status).toBe(401);
  }
  // and nothing extra: no adapter lists an op the registry does not have
  expect([...tools].toSorted()).toEqual(
    registry
      .mcpOps()
      .map((o) => o.name)
      .toSorted(),
  );
  expect([...operationIds].toSorted()).toEqual(
    [
      ...registry.documentedOps().filter((o) => o.mcp || o.secretInputFields.length === 0),
      ...registry.signatureOps(),
      ...registry.instanceOps().filter((o) => o.secretInputFields.length === 0),
      ...registry.accountOps(),
    ]
      .map((o) => o.name)
      .toSorted(),
  );
});
