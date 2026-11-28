import { expect, test } from "bun:test";
import { join } from "node:path";
import type {
  WireActivity,
  WireApprovalStatus,
  WireArtifacts,
  WireSandboxUsage,
  WireConsumption,
  WireQuotas,
  WireApprovers,
  WireMyNotifications,
  WireMyPendingApprovals,
  WireNotificationPrefs,
  WireChallenge,
  WireEnrolmentApproval,
  WireEnrolmentRequest,
  WireEnvironmentApproval,
  WireRegisterChallenge,
  WireApprove,
  WireAttempt,
  WireChecks,
  WireCancel,
  WireCuts,
  WireDigest,
  WireFailureDigest,
  WireIncident,
  WireIngestStatus,
  WireJob,
  WireLog,
  WireOrgs,
  WireProjects,
  WireRerun,
  WireRun,
  WireSetting,
  WireSteps,
  WireStep,
  WireTrust,
  WireWhoami,
} from "../src/api/wire";

// Keeps the hand-written wire types honest: if docs/openapi.json drops or renames a field the
// adapter reads, this fails. Regenerate the spec with the core's openapi script after API changes.

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
  maximum?: number;
};
type Param = { name: string; in: string; schema: Schema };
type Op = {
  operationId: string;
  parameters?: Param[];
  requestBody?: { content: { "application/json": { schema: Schema } } };
  responses: Record<string, { content?: { "application/json": { schema: Schema } } }>;
};
const spec = (await Bun.file(join(import.meta.dir, "../../../docs/openapi.json")).json()) as {
  paths: Record<string, Record<string, Op>>;
};

const op = (path: string, method: string): Op => {
  const o = spec.paths[path]?.[method];
  if (!o) throw new Error(`spec has no ${method} ${path}`);
  return o;
};
const ok = (o: Op): Schema => o.responses["200"]!.content!["application/json"].schema;

/** Property names the adapter reads must exist in the spec (and be required). */
function expectKeys(schema: Schema, keys: string[]): void {
  const props = Object.keys(schema.properties ?? {});
  for (const k of keys) expect(props).toContain(k);
  for (const k of keys) expect(schema.required ?? []).toContain(k);
}

const keysOf = <T>(sample: Record<keyof T, true>): string[] => Object.keys(sample);

test("list_runs: path, params and run fields", () => {
  const o = op("/runs", "get");
  expect(o.operationId).toBe("list_runs");
  const names = (o.parameters ?? []).map((p) => p.name);
  for (const n of ["org", "project", "state", "branch", "event", "limit", "cursor"])
    expect(names).toContain(n);
  expect((o.parameters ?? []).find((p) => p.name === "limit")?.schema.maximum).toBe(100);
  const body = ok(o);
  expectKeys(body, ["runs", "next_cursor"]);
  expectKeys(
    body.properties!.runs!.items!,
    keysOf<Omit<WireRun, "trust_class" | "trust">>({
      id: true,
      project: true,
      workflow_path: true,
      event: true,
      ref: true,
      sha: true,
      workflow_name: true,
      run_name: true,
      commit_message: true,
      actor: true,
      head_branch: true,
      pr_number: true,
      state: true,
      created_at: true,
      started_at: true,
      finished_at: true,
      duration_ms: true,
    }),
  );
});

test("get_run: run, job and attempt fields", () => {
  const body = ok(op("/runs/{run_id}", "get"));
  expectKeys(body, ["id", "project", "state", "created_at", "jobs"]);
  const job = body.properties!.jobs!.items!;
  expectKeys(
    job,
    keysOf<WireJob>({
      id: true,
      job_key: true,
      name: true,
      state: true,
      needs: true,
      matrix: true,
      shard: true,
      approval_kind: true,
      exit_code: true,
      started_at: true,
      finished_at: true,
      duration_ms: true,
      infra_error_reason: true,
      waiting_reason: true,
      attempts: true,
      log_path: true,
    }),
  );
  expectKeys(
    job.properties!.attempts!.items!,
    keysOf<WireAttempt>({
      id: true,
      attempt: true,
      state: true,
      provider: true,
      exit_code: true,
      error_class: true,
      started_at: true,
      finished_at: true,
      duration_ms: true,
      sandbox_created_at: true,
      sandbox_destroyed_at: true,
      sandbox_seconds: true,
      waiting_reason: true,
      queued_ms_by_reason: true,
    }),
  );
});

test("job_log: offset range reads fit the adapter's page size", () => {
  const o = op("/jobs/{job_id}/log", "get");
  const params = Object.fromEntries((o.parameters ?? []).map((p) => [p.name, p]));
  for (const n of ["job_id", "attempt", "mode", "offset", "max_bytes", "org"])
    expect(params[n]).toBeDefined();
  // Whole-log search in the log viewer.
  for (const n of ["pattern", "regex", "ignore_case", "context", "max_matches"])
    expect(params[n]).toBeDefined();
  expect(params.mode!.schema).toMatchObject({ enum: expect.arrayContaining(["grep"]) });
  expect(params.max_bytes!.schema.maximum).toBeGreaterThanOrEqual(262_144);
  expectKeys(
    ok(o),
    keysOf<WireLog>({
      job_id: true,
      attempt: true,
      mode: true,
      matches: true,
      text: true,
      offset: true,
      bytes: true,
      total_bytes: true,
      next_offset: true,
      truncated: true,
    }),
  );
});

test("checks_for_sha and cancel", () => {
  expectKeys(
    ok(op("/checks/{sha}", "get")),
    keysOf<WireChecks>({ sha: true, state: true, counts: true, runs: true }),
  );
  const cancel = op("/runs/{run_id}/cancel", "post");
  expectKeys(
    ok(cancel),
    keysOf<WireCancel>({ run_id: true, state: true, cancelled_jobs: true, unchanged_jobs: true }),
  );
  expect(Object.keys(cancel.requestBody!.content["application/json"].schema.properties!)).toContain(
    "org",
  );
});

const ids = Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));

test("the spec has every operation the UI uses", () => {
  for (const known of [
    "list_runs",
    "get_run",
    "job_log",
    "checks_for_sha",
    "cancel",
    "rerun",
    "events",
    "whoami",
    "list_orgs",
    "list_projects",
    "job_steps",
    "job_cuts",
    "failure_digest",
    "ingest_status",
    "incident_status",
  ]) {
    expect(ids).toContain(known);
  }
});

test("whoami, list_orgs and list_projects", () => {
  expectKeys(
    ok(op("/whoami", "get")),
    keysOf<Omit<WireWhoami, never>>({
      kind: true,
      id: true,
      name: true,
      role: true,
      org: true,
      project: true,
      expires_at: true,
      operator_org: true,
    }),
  );
  const orgs = ok(op("/orgs", "get"));
  expectKeys(orgs, keysOf<WireOrgs>({ orgs: true, next_cursor: true }));
  expectKeys(orgs.properties!.orgs!.items!, ["id", "slug", "name"]);
  const projects = ok(op("/projects", "get"));
  expectKeys(projects, keysOf<WireProjects>({ projects: true, next_cursor: true }));
  expectKeys(projects.properties!.projects!.items!, ["id", "slug", "name", "setup", "repos"]);
});

test("my_activity_feed", () => {
  const feed = ok(op("/activity", "get"));
  expectKeys(feed, keysOf<WireActivity>({ runs: true, next_cursor: true }));
  expectKeys(feed.properties!.runs!.items!, [
    "run_id",
    "org",
    "org_name",
    "org_avatar_url",
    "project",
    "project_name",
    "project_avatar_url",
    "workflow",
    "ref",
    "ref_type",
    "sha",
    "event",
    "commit_message",
    "actor",
    "actor_avatar_url",
    "state",
    "conclusion",
    "created_at",
    "started_at",
    "finished_at",
  ]);
  const params = (op("/activity", "get").parameters ?? []).map((p) => p.name);
  for (const q of ["org", "project", "status", "limit", "cursor"]) expect(params).toContain(q);
});

test("job_steps and job_cuts", () => {
  const steps = ok(op("/jobs/{job_id}/steps", "get"));
  expectKeys(steps, keysOf<WireSteps>({ job_id: true, attempt: true, steps: true }));
  expectKeys(
    steps.properties!.steps!.items!,
    keysOf<WireStep>({
      key: true,
      stage: true,
      index: true,
      name: true,
      result: true,
      started_at: true,
      finished_at: true,
      duration_ms: true,
      log_offset: true,
    }),
  );
  const cuts = ok(op("/jobs/{job_id}/cuts", "get"));
  expectKeys(cuts, keysOf<WireCuts>({ job_id: true, attempt: true, cuts: true, notices: true }));
  expectKeys(cuts.properties!.cuts!.items!, ["at_offset", "omitted_bytes", "reason"]);
  expectKeys(cuts.properties!.notices!.items!, ["at_offset", "source", "text"]);
});

test("failure_digest", () => {
  const o = op("/failure-digest", "get");
  const names = (o.parameters ?? []).map((p) => p.name);
  for (const n of ["org", "run_id", "job_id"]) expect(names).toContain(n);
  const body = ok(o);
  expectKeys(body, keysOf<WireFailureDigest>({ failing_jobs: true, digests: true }));
  expectKeys(
    body.properties!.digests!.items!,
    keysOf<WireDigest>({
      job_id: true,
      job_key: true,
      state: true,
      attempt: true,
      step: true,
      basis: true,
      excerpt: true,
      truncated: true,
      infra_error_reason: true,
    }),
  );
});

test("rerun takes a reason and optional jobs, and reports each rerun job", () => {
  const o = op("/runs/{run_id}/rerun", "post");
  const req = o.requestBody!.content["application/json"].schema;
  for (const k of ["org", "reason", "jobs"]) expect(Object.keys(req.properties!)).toContain(k);
  expect(req.required ?? []).toContain("reason");
  const body = ok(o);
  expectKeys(
    body,
    keysOf<Pick<WireRerun, "run_id" | "state" | "reruns">>({
      run_id: true,
      state: true,
      reruns: true,
    }),
  );
  expectKeys(body.properties!.reruns!.items!, [
    "job_id",
    "job_key",
    "attempt",
    "previous_state",
    "state",
  ]);
});

test("ingest_status", () => {
  const body = ok(op("/ingest/status", "get"));
  expectKeys(body, keysOf<WireIngestStatus>({ running: true, rate_limit: true, repos: true }));
  expectKeys(body.properties!.repos!.items!, [
    "repo",
    "project",
    "last_poll_at",
    "last_outcome",
    "last_error",
    "next_poll_at",
    "consecutive_failures",
    "runs_created",
  ]);
  const rate = body.properties!.rate_limit!;
  const rateProps = (rate.anyOf?.find((s) => s.properties) ?? rate).properties!;
  for (const k of ["limit", "remaining", "reset_at", "resource", "observed_at"])
    expect(Object.keys(rateProps)).toContain(k);
});

// Trust and approvals landed with #98: the run carries its class and decision, and approve_run
// exists. The UI still reads them optionally, so it works against an older server.
test("the run schema carries trust_class and trust, and approve_run is in the spec", () => {
  const run = ok(op("/runs/{run_id}", "get")).properties!;
  expect(run).toHaveProperty("trust_class");
  expect(run).toHaveProperty("trust");
  expect(run).toHaveProperty("approval");
  expect(ids.includes("approve_run")).toBe(true);
});

test("when the spec carries trust, it matches the wire types the adapter reads", () => {
  const run = ok(op("/runs/{run_id}", "get")).properties!;
  if (!("trust" in run)) return;
  const trust = run.trust as Schema;
  const props = (trust.anyOf?.find((s) => s.properties) ?? trust).properties ?? {};
  for (const k of Object.keys({
    class: 1,
    reasons: 1,
    workflow_hash: 1,
    decided_at: 1,
  } satisfies Record<
    keyof Pick<WireTrust, "class" | "reasons" | "workflow_hash" | "decided_at">,
    1
  >))
    expect(Object.keys(props)).toContain(k);
});

test("approve_run, once it exists, takes head_sha and workflow_hash", () => {
  const path = Object.entries(spec.paths).find(([, m]) =>
    Object.values(m).some((o) => o.operationId === "approve_run"),
  );
  if (!path) return;
  const o = Object.values(path[1]).find((x) => x.operationId === "approve_run")!;
  const req = o.requestBody!.content["application/json"].schema;
  for (const k of ["org", "head_sha", "workflow_hash"])
    expect(Object.keys(req.properties!)).toContain(k);
  expectKeys(
    ok(o),
    keysOf<WireApprove>({
      run_id: true,
      state: true,
      released_jobs: true,
      approved_by: true,
      head_sha: true,
      workflow_hash: true,
    }),
  );
});

test("run and job metadata from #66 are in the spec", () => {
  const run = ok(op("/runs/{run_id}", "get")).properties!;
  for (const key of ["workflow_name", "commit_message", "actor", "head_branch", "pr_number"]) {
    expect(run).toHaveProperty(key);
  }
  const jobs = (run.jobs as { items: { properties: Record<string, unknown> } }).items.properties;
  for (const key of ["needs", "matrix", "approval_kind"]) expect(jobs).toHaveProperty(key);
});

test("artifacts: provenance and consumption shapes the adapter reads", () => {
  const arts = ok(op("/runs/{run_id}/artifacts", "get"));
  expectKeys(arts, keysOf<WireArtifacts>({ artifacts: true }));
  expectKeys(arts.properties!.artifacts!.items!, [
    "name",
    "size",
    "sha256",
    "digest_source",
    "trust_class",
    "run_sha",
    "attempt_id",
    "created_at",
  ]);
  const chk = ok(op("/artifacts/check-consumption", "post"));
  expectKeys(chk, keysOf<WireConsumption>({ results: true }));
  // The request takes a consumer run or a class: the adapter sends one of the two.
  expect(
    Object.keys(
      op("/artifacts/check-consumption", "post").requestBody!.content["application/json"].schema
        .properties!,
    ),
  ).toEqual(expect.arrayContaining(["consumer_run_id", "consumer_class", "sources", "quarantine"]));
  expectKeys(chk.properties!.results!.items!, [
    "run_id",
    "name",
    "decision",
    "reason",
    "trust_class",
    "sha256",
  ]);
});

test("quotas: get and set return the shape the adapter reads", () => {
  // Read only: there is no API operation that sets quotas.
  expect(Object.keys(spec.paths["/quotas"] ?? {})).toEqual(["get"]);
  for (const [path, method] of [["/quotas", "get"]] as const) {
    const out = ok(op(path, method));
    expectKeys(out, keysOf<WireQuotas>({ limits: true, usage: true }));
    expectKeys(out.properties!.limits!, [
      "max_concurrent",
      "max_runs_per_hour",
      "max_sandbox_minutes_per_day",
      "max_log_bytes",
      "max_stored_bytes",
    ]);
    expectKeys(out.properties!.usage!.items!, ["metric", "used", "limit", "percent", "held"]);
  }
});

test("list_settings and set_setting: the setting fields and the request body", () => {
  const list = op("/settings", "get");
  expect(list.operationId).toBe("list_settings");
  const names = (list.parameters ?? []).map((p) => p.name);
  for (const n of ["org", "project", "limit", "cursor"]) expect(names).toContain(n);
  expect((list.parameters ?? []).find((p) => p.name === "limit")?.schema.maximum).toBe(100);
  const body = ok(list);
  expectKeys(body, ["settings", "next_cursor"]);
  const fields = keysOf<WireSetting>({
    key: true,
    scope: true,
    description: true,
    value: true,
    default: true,
    source: true,
    locked: true,
    locked_by: true,
    role: true,
    mcp_editable: true,
    trust: true,
    strictness: true,
    warning: true,
  });
  expectKeys(body.properties!.settings!.items!, fields);
  const set = op("/settings", "post");
  expect(set.operationId).toBe("set_setting");
  const req = set.requestBody!.content["application/json"].schema;
  for (const k of ["key", "value", "unset", "org", "project"])
    expect(Object.keys(req.properties ?? {})).toContain(k);
  expectKeys(ok(set), fields);
});

test("human approvals: status, approvers, challenges, enrolment and the signature routes", () => {
  const status = ok(op("/approvals/status", "get"));
  expectKeys(
    status,
    keysOf<WireApprovalStatus>({
      run_id: true,
      head_sha: true,
      workflow_hash: true,
      author: true,
      environments: true,
    }),
  );
  expectKeys(status.properties!.environments!.items!, [
    "environment",
    "required",
    "allow_author_approval",
    "waiting",
    "approvals",
  ]);
  const approvers = ok(op("/approvers", "get"));
  expectKeys(
    approvers,
    keysOf<WireApprovers>({
      approvers: true,
      key_policy: true,
      pending_enrolments: true,
      policies: true,
      warnings: true,
      default_mode: true,
      instance_loosenings: true,
    }),
  );
  expectKeys(approvers.properties!.approvers!.items!, [
    "id",
    "person",
    "forge_login",
    "kind",
    "passkey_id",
    "created_at",
    "not_counting",
    "attested",
    "aaguid",
  ]);
  expectKeys(approvers.properties!.pending_enrolments!.items!, [
    "id",
    "person",
    "forge_login",
    "kind",
    "key_fingerprint",
    "approvals",
    "required",
    "expires_at",
  ]);
  for (const path of ["/approvals/challenge", "/approvers/challenge"]) {
    expectKeys(
      ok(op(path, "post")),
      keysOf<WireChallenge>({
        statement: true,
        canonical: true,
        statement_hash: true,
        challenge: true,
        rp_id: true,
        passkey_id: true,
        challenge_expires_at: true,
      }),
    );
  }
  expect(
    Object.keys(
      op("/approvals/challenge", "post").requestBody!.content["application/json"].schema
        .properties!,
    ),
  ).toEqual(expect.arrayContaining(["run_id", "environment", "approver", "project", "org"]));
  expectKeys(
    ok(op("/approvers/register-challenge", "post")),
    keysOf<WireRegisterChallenge>({
      challenge: true,
      rp_id: true,
      expires_at: true,
      attestation: true,
    }),
  );
  expectKeys(
    ok(op("/approvers/enrolments", "post")),
    keysOf<WireEnrolmentRequest>({
      enrolment_id: true,
      kind: true,
      key_fingerprint: true,
      required: true,
      expires_at: true,
    }),
  );
  // The signature routes take no bearer token: the document says so (security: []).
  for (const [path, keys] of [
    [
      "/approvals",
      keysOf<WireEnvironmentApproval>({
        run_id: true,
        environment: true,
        approvals: true,
        required: true,
        released_jobs: true,
        state: true,
      }),
    ],
    [
      "/approvers/approve",
      keysOf<WireEnrolmentApproval>({
        enrolment_id: true,
        approvals: true,
        required: true,
        activated: true,
        approver_id: true,
      }),
    ],
  ] as const) {
    const o = op(path, "post") as Op & { security?: unknown[] };
    expect(o.security).toEqual([]);
    expectKeys(ok(o), keys);
    const req = o.requestBody!.content["application/json"].schema.properties!;
    expect(Object.keys(req)).toEqual(expect.arrayContaining(["statement", "signature"]));
  }
  // The environment statement binds exactly these fields.
  const stmt = (
    op("/approvals", "post").requestBody!.content["application/json"].schema.properties!
      .statement as Schema
  ).properties!;
  expect(Object.keys(stmt).toSorted()).toEqual([
    "approver",
    "environment",
    "expires_at",
    "head_sha",
    "nonce",
    "org",
    "project",
    "run_id",
    "type",
    "workflow_hash",
  ]);
});

test("incident_status", () => {
  const o = op("/incident", "get");
  const names = (o.parameters ?? []).map((p) => p.name);
  for (const n of ["org", "project"]) expect(names).toContain(n);
  const body = ok(o);
  expectKeys(
    body,
    keysOf<WireIncident>({
      frozen: true,
      level: true,
      reason: true,
      frozen_at: true,
      frozen_by: true,
      rotation_required_count: true,
      rotation_required: true,
    }),
  );
  expectKeys(body.properties!.rotation_required!.items!, [
    "name",
    "reason",
    "flagged_by",
    "flagged_at",
  ]);
});

test("sandbox_usage: the days and totals the Usage page reads", () => {
  const o = op("/usage/sandbox", "get");
  expect((o.parameters ?? []).map((p) => p.name)).toEqual(
    expect.arrayContaining(["days", "group_by"]),
  );
  const out = ok(o);
  expectKeys(
    out,
    keysOf<Omit<WireSandboxUsage, "projects">>({
      days: true,
      total_seconds: true,
      total_minutes: true,
    }),
  );
  // `projects` is optional: only an answer to group_by=project has it.
  expect(Object.keys(out.properties!)).toContain("projects");
  expectKeys(out.properties!.projects!.items!, [
    "project_id",
    "project_slug",
    "project_name",
    "days",
    "total_seconds",
    "total_minutes",
  ]);
  expectKeys(out.properties!.days!.items!, [
    "day",
    "sandbox_seconds",
    "sandbox_minutes",
    "attempts",
    "estimated_attempts",
  ]);
});

test("my_pending_approvals: path and item fields", () => {
  const o = op("/my/pending-approvals", "get");
  expect(o.operationId).toBe("my_pending_approvals");
  const body = ok(o);
  expectKeys(body, ["items"]);
  const item = body.properties!.items!.items!;
  expectKeys(item, ["id", "kind", "org", "project", "created_at", "link"]);
  expect(Object.keys(item.properties ?? {})).toEqual(
    expect.arrayContaining(
      keysOf<WireMyPendingApprovals["items"][number]>({
        id: true,
        kind: true,
        org: true,
        project: true,
        environment: true,
        created_at: true,
        expires_at: true,
        link: true,
      }),
    ),
  );
});

test("my_notifications, get_notification_prefs: paths and fields", () => {
  const o = op("/my/notifications", "get");
  expect(o.operationId).toBe("my_notifications");
  const body = ok(o);
  expectKeys(body, ["notifications", "unread_count", "next_cursor"]);
  const item = body.properties!.notifications!.items!;
  expect(Object.keys(item.properties ?? {})).toEqual(
    expect.arrayContaining(
      keysOf<WireMyNotifications["notifications"][number]>({
        id: true,
        kind: true,
        org: true,
        project: true,
        run_id: true,
        count: true,
        title: true,
        created_at: true,
        read_at: true,
        link: true,
      }),
    ),
  );
  const prefs = op("/my/notification-prefs", "get");
  expect(prefs.operationId).toBe("get_notification_prefs");
  expectKeys(ok(prefs), keysOf<WireNotificationPrefs>({ prefs: true, defaults: true }));
  expect(op("/my/notifications/ack", "post").operationId).toBe("notifications_ack");
  expect(op("/my/notification-prefs/set", "post").operationId).toBe("set_notification_prefs");
});
