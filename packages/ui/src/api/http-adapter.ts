import type { ApiCapabilities, PrMode, TurntableApi } from "./client";
import { refusalMessage } from "./refusal";
import { stepEvents } from "./step-events";
import { observeServerVersion } from "@/lib/build-version";
import type {
  ActivityRun,
  ApprovalChallenge,
  ApprovalStatement,
  ReleaseStatement,
  ApprovalStatus,
  ApproversOverview,
  AppNotification,
  NotificationPage,
  NotificationPrefs,
  PendingApproval,
  SandboxUsage,
  PolicyStatement,
  ApproveResult,
  EnrolStatement,
  EnvironmentApprovalResult,
  CheckSummary,
  CutRecord,
  LogNotice,
  GrepHit,
  GrepResult,
  IncidentStatus,
  IngestStatus,
  Job,
  JobDigest,
  RerunResult,
  Setting,
  LaneAction,
  LaneConfig,
  LaneKey,
  LaneCosignKey,
  LaneSecretStatus,
  ApprovalPolicy,
  StepUpChallenge,
  Whoami,
  JobAttempt,
  JobState,
  LogSlice,
  Org,
  Project,
  Run,
  RunApproval,
  RunDetail,
  StepEvent,
  Artifact,
  ConsumeResult,
  OrgQuotas,
} from "./types";
import type {
  WireActivity,
  WireSandboxUsage,
  WireApprovalStatus,
  WireReleaseChallenge,
  WireApprovers,
  WireMyNotifications,
  WireMyPendingApprovals,
  WireNotificationPrefs,
  WireChallenge,
  WireEnrolmentApproval,
  WireEnrolmentRequest,
  WireEnvironmentApproval,
  WireRegisterChallenge,
  WireArtifacts,
  WireConsumption,
  WireQuotas,
  WireAttempt,
  WireChecks,
  WireApprove,
  WireCuts,
  WireError,
  WireFailureDigest,
  WireIncident,
  WireIngestStatus,
  WireJob,
  WireLog,
  WireOrgs,
  WireProjects,
  WireRerun,
  WireRun,
  WireApproval,
  WireRunDetail,
  WireRunList,
  WireSetting,
  WireSettings,
  WireSteps,
  WireWhoami,
} from "./wire";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** `details.reason` of a refusal, when the server named one (for example `step_up_required`). */
  readonly reason: string | undefined;
  constructor(status: number, code: string, message: string, reason?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

export type HttpApiOptions = {
  /** Receives the `Turntable-Version` header of every response (default: the update prompt). */
  observeVersion?: (version: string | null) => void;
  /** Where `/api/v1` lives; empty for same-origin. */
  baseUrl?: string;
  /** The org slug requests are made for. */
  org: () => string | null;
  /** The bearer token, read per request so it is never captured. */
  token: () => string | null;
  /**
   * True while a web session (cookie) stands in for the bearer token: requests then send the
   * same-origin cookie, and no Authorization header. The browser adds the Origin header the
   * server's CSRF check needs to non-GET requests.
   */
  session?: () => boolean;
  /** Called when the server says the token is not accepted (401). */
  onUnauthenticated?: () => void;
  fetch?: typeof fetch;
};

/** The server caps a log read at 256 KiB. */
const LOG_PAGE_BYTES = 262_144;

const ms = (iso: string | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

function workflowName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(ya?ml)$/i, "");
}

/**
 * Parses `job_log` mode=grep text: one `<byte offset><sep><line>` per row, with `:` for a hit and
 * `-` for context, and `--` between groups. The line text is untrusted and shown as text.
 */
export function parseGrep(text: string): GrepHit[] {
  const hits: GrepHit[] = [];
  for (const row of text.split("\n")) {
    const m = /^(\d+)([:-])(.*)$/.exec(row);
    if (m) hits.push({ offset: Number(m[1]), text: m[3] ?? "", context: m[2] === "-" });
  }
  return hits;
}

function branchOf(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

function challengeOf<S>(w: WireChallenge): ApprovalChallenge<S> {
  return {
    statement: w.statement as S,
    canonical: w.canonical,
    statementHash: w.statement_hash,
    challenge: w.challenge,
    rpId: w.rp_id,
    passkeyId: w.passkey_id,
    challengeExpiresAt: ms(w.challenge_expires_at) ?? 0,
  };
}

export function mapSetting(w: WireSetting): Setting {
  return {
    key: w.key,
    scope: w.scope,
    description: w.description,
    value: w.value,
    default: w.default,
    source: w.source,
    locked: w.locked,
    lockedBy: w.locked_by,
    role: w.role as Setting["role"],
    mcpEditable: w.mcp_editable,
    ...(w.strictness ? { strictness: w.strictness } : {}),
    warning: w.warning,
    ...(w.trust ? { trust: w.trust } : {}),
  };
}

export function mapRun(w: WireRun, org: string): Run {
  const name = w.workflow_name ?? workflowName(w.workflow_path);
  const branch = w.head_branch ?? branchOf(w.ref);
  return {
    id: w.id,
    orgId: org,
    projectId: w.project,
    workflowPath: w.workflow_path,
    workflowName: name,
    runName: w.run_name ?? null,
    event: w.event,
    ref: w.ref,
    sha: w.sha,
    // Forge text (untrusted; rendered as text). A run with no message shows its workflow and branch.
    commitMessage: w.commit_message ?? `${name} on ${branch}`,
    actor: w.actor ?? "",
    status: w.state,
    prNumber: w.pr_number,
    headBranch: w.head_branch,
    trustClass: w.trust_class ?? null,
    trust: w.trust
      ? {
          reasons: w.trust.reasons,
          workflowHash: w.trust.workflow_hash,
          decidedAt: ms(w.trust.decided_at),
        }
      : null,
    createdAt: ms(w.created_at) ?? 0,
    startedAt: ms(w.started_at),
    finishedAt: ms(w.finished_at),
  };
}

function mapApproval(a: WireApproval): RunApproval {
  return {
    by: a.by,
    at: ms(a.at),
    ...(a.via
      ? { via: { kind: "label" as const, label: a.via.label, eventId: a.via.event_id } }
      : {}),
  };
}

function mapAttempt(a: WireAttempt, job: WireJob, run: WireRun, org: string): JobAttempt {
  return {
    id: a.id,
    orgId: org,
    projectId: run.project,
    jobId: job.id,
    attempt: a.attempt,
    state: a.state,
    provider: a.provider,
    sandboxId: null,
    exitCode: a.exit_code,
    errorClass: a.error_class,
    createdAt: ms(a.started_at) ?? ms(run.created_at) ?? 0,
    startedAt: ms(a.started_at),
    finishedAt: ms(a.finished_at),
    sandboxCreatedAt: ms(a.sandbox_created_at),
    sandboxDestroyedAt: ms(a.sandbox_destroyed_at),
    sandboxSeconds: a.sandbox_seconds,
    waitingReason: a.waiting_reason ?? null,
    queuedMsByReason: a.queued_ms_by_reason ?? {},
  };
}

function mapJob(j: WireJob, run: WireRun, org: string): Job {
  return {
    id: j.id,
    orgId: org,
    projectId: run.project,
    runId: run.id,
    jobKey: j.job_key,
    name: j.name,
    state: j.state,
    needs: j.needs,
    matrix: j.matrix
      ? Object.fromEntries(Object.entries(j.matrix).map(([k, v]) => [k, String(v)]))
      : null,
    // Legs of one matrix share the name before " (": "test (ubuntu, 20)" belongs to "test".
    matrixGroup: j.matrix ? j.name.replace(/\s*\(.*\)$/, "") : null,
    shard: j.shard ?? null,
    approval: j.approval_kind,
    exitCode: j.exit_code,
    createdAt: ms(run.created_at) ?? 0,
    startedAt: ms(j.started_at),
    finishedAt: ms(j.finished_at),
  };
}

const FINISHED: readonly JobState[] = ["success", "failure", "infra_error", "cancelled", "skipped"];

function quotasOf(w: WireQuotas): OrgQuotas {
  return {
    limits: {
      maxConcurrent: w.limits.max_concurrent,
      maxRunsPerHour: w.limits.max_runs_per_hour,
      maxSandboxMinutesPerDay: w.limits.max_sandbox_minutes_per_day,
      maxLogBytes: w.limits.max_log_bytes,
      maxStoredBytes: w.limits.max_stored_bytes,
    },
    usage: w.usage,
  };
}

const LANE_PATHS: Record<LaneAction, string> = {
  release_pin_repo: "/release-lane/pin-repo",
  release_init_key: "/release-lane/keys",
  release_publish_target_set: "/release-lane/publish-targets",
  release_publish_target_delete: "/release-lane/publish-targets/delete",
  release_set_project_signing: "/release-lane/project-signing",
  release_secret_set: "/release-lane/secrets",
  release_cosign_key_set: "/release-lane/cosign-keys",
  release_cosign_key_remove: "/release-lane/cosign-keys/delete",
};

export function createHttpApi(options: HttpApiOptions): TurntableApi {
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const observe = options.observeVersion ?? observeServerVersion;
  const base = `${options.baseUrl ?? ""}/api/v1`;
  /** attemptId -> where to read its log, learned from get_run. */
  const attempts = new Map<string, { jobId: string; attempt: number; state: JobState }>();
  const org = (): string => {
    const o = options.org();
    if (!o) throw new ApiError(401, "unauthenticated", "Not connected");
    return o;
  };

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    query: Record<string, string | number | undefined> = {},
    body?: unknown,
  ): Promise<T> {
    const token = options.token();
    const viaSession = !token && options.session?.() === true;
    if (!token && !viaSession) throw new ApiError(401, "unauthenticated", "Not connected");
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== "") qs.set(k, String(v));
    const url = `${base}${path}${qs.size > 0 ? `?${qs}` : ""}`;
    const res = await doFetch(url, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      credentials: viaSession ? "same-origin" : "omit",
      referrerPolicy: "no-referrer",
    });
    // Errors and 401s carry the header too, so look before the status check.
    observe(res.headers.get("turntable-version"));
    if (!res.ok) {
      let code = "internal";
      let message = `Request failed (${res.status})`;
      let reason: string | undefined;
      try {
        const e = (await res.json()) as WireError;
        code = e.error.code;
        message = e.error.message;
        const d = e.error.details;
        if (d && typeof d === "object" && typeof (d as { reason?: unknown }).reason === "string")
          reason = (d as { reason: string }).reason;
        const friendly = viaSession ? refusalMessage(code, message, d) : undefined;
        if (friendly) message = friendly;
      } catch {
        // not JSON; keep the generic message
      }
      if (res.status === 401) options.onUnauthenticated?.();
      throw new ApiError(res.status, code, message, reason);
    }
    return (await res.json()) as T;
  }

  const known = (attemptId: string) => {
    const k = attempts.get(attemptId);
    if (!k) throw new ApiError(404, "not_found", "Open the run first so the attempt is known");
    return k;
  };

  const api: TurntableApi = {
    capabilities: {
      rerun: true,
      approve: true,
      humanApproval: true,
      simulatedCeremony: false,
    } satisfies ApiCapabilities,

    async listOrgs(): Promise<Org[]> {
      const w = await call<WireOrgs>("GET", "/orgs", { limit: 100 });
      return w.orgs.map((o) => ({ id: o.slug, slug: o.slug, name: o.name }));
    },

    async listProjects(orgId: string): Promise<Project[]> {
      const w = await call<WireProjects>("GET", "/projects", {
        org: orgId,
        limit: 100,
        include_available: "true",
      });
      return w.projects.map((p) => ({
        setup: p.setup,
        ...(p.no_access ? { noAccess: true } : {}),
        id: p.slug,
        orgId,
        slug: p.slug,
        name: p.name,
        repo: p.repos[0] ? `${p.repos[0].owner}/${p.repos[0].repo}` : "",
      }));
    },

    async myActivityFeed(f = {}) {
      // No `org()` here: the feed spans the person's orgs, and `org` is only a filter.
      const w = await call<WireActivity>("GET", "/activity", {
        org: f.org,
        project: f.project,
        status: f.status,
        limit: f.limit ? Math.min(100, f.limit) : undefined,
        cursor: f.cursor,
      });
      return {
        runs: w.runs.map((r): ActivityRun => ({
          runId: r.run_id,
          org: r.org,
          orgName: r.org_name,
          orgAvatarUrl: r.org_avatar_url,
          project: r.project,
          projectName: r.project_name,
          projectAvatarUrl: r.project_avatar_url,
          workflow: r.workflow,
          ref: r.ref,
          refType: r.ref_type,
          sha: r.sha,
          event: r.event,
          commitMessage: r.commit_message,
          actor: r.actor,
          actorAvatarUrl: r.actor_avatar_url,
          state: r.state,
          conclusion: r.conclusion,
          createdAt: ms(r.created_at) ?? 0,
          startedAt: ms(r.started_at),
          finishedAt: ms(r.finished_at),
        })),
        nextCursor: w.next_cursor,
      };
    },

    async listRuns(f) {
      const slug = org();
      const page = await call<WireRunList>("GET", "/runs", {
        org: slug,
        project: f.projectId || undefined,
        state: f.status,
        branch: f.branch,
        event: f.event,
        limit: f.limit ? Math.min(100, f.limit) : undefined,
        cursor: f.cursor,
      });
      return { runs: page.runs.map((r) => mapRun(r, slug)), nextCursor: page.next_cursor };
    },

    async getRun(runId: string): Promise<RunDetail> {
      const slug = org();
      const w = await call<WireRunDetail>("GET", `/runs/${encodeURIComponent(runId)}`, {
        org: slug,
      });
      const jobs: Job[] = [];
      const atts: JobAttempt[] = [];
      for (const j of w.jobs) {
        jobs.push(mapJob(j, w, slug));
        for (const a of j.attempts) {
          atts.push(mapAttempt(a, j, w, slug));
          attempts.set(a.id, { jobId: j.id, attempt: a.attempt, state: a.state });
        }
      }
      const run = mapRun(w, slug);
      if (w.approval) run.approval = mapApproval(w.approval);
      return { run, jobs, attempts: atts };
    },

    async jobLog({ attemptId, offset, limit }): Promise<LogSlice> {
      const k = known(attemptId);
      const slug = org();
      const chunks: Uint8Array[] = [];
      let at = offset;
      let size = 0;
      let more = true;
      const enc = new TextEncoder();
      while (more && at - offset < limit) {
        const page = await call<WireLog>("GET", `/jobs/${encodeURIComponent(k.jobId)}/log`, {
          org: slug,
          attempt: k.attempt,
          mode: "range",
          offset: at,
          max_bytes: Math.min(LOG_PAGE_BYTES, limit - (at - offset)),
        });
        size = page.total_bytes;
        // Keep byte offsets exact: the text should re-encode to `page.bytes`; if the server
        // substituted characters, pad or trim so the parser's offsets stay in step with the server's.
        let bytes = enc.encode(page.text);
        if (bytes.length !== page.bytes) {
          const fixed = new Uint8Array(page.bytes).fill(0x20);
          fixed.set(bytes.subarray(0, page.bytes));
          bytes = fixed;
        }
        chunks.push(bytes);
        at += page.bytes;
        more = page.next_offset !== null && page.bytes > 0;
      }
      const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let p = 0;
      for (const c of chunks) {
        joined.set(c, p);
        p += c.length;
      }
      const finished = FINISHED.includes(k.state);
      return { attemptId, offset, bytes: joined, size, done: finished && at >= size };
    },

    async jobSteps({ attemptId }): Promise<StepEvent[]> {
      const k = known(attemptId);
      const w = await call<WireSteps>("GET", `/jobs/${encodeURIComponent(k.jobId)}/steps`, {
        org: org(),
        attempt: k.attempt,
      });
      return stepEvents(attemptId, w.steps).flatMap((m) => {
        if (m.type !== "step") return [];
        const { type: _t, ...rest } = m;
        return [rest];
      });
    },

    async jobCuts({ attemptId }): Promise<CutRecord[]> {
      const k = known(attemptId);
      const w = await call<WireCuts>("GET", `/jobs/${encodeURIComponent(k.jobId)}/cuts`, {
        org: org(),
        attempt: k.attempt,
      });
      return w.cuts.map((c) => ({
        attemptId,
        kind: "cut" as const,
        atOffset: c.at_offset,
        omittedBytes: c.omitted_bytes,
        reason: c.reason,
      }));
    },

    async jobNotices({ attemptId }): Promise<LogNotice[]> {
      const k = known(attemptId);
      const w = await call<WireCuts>("GET", `/jobs/${encodeURIComponent(k.jobId)}/cuts`, {
        org: org(),
        attempt: k.attempt,
      });
      return w.notices.map((n) => ({
        attemptId,
        kind: "notice" as const,
        atOffset: n.at_offset,
        source: n.source,
        text: n.text,
      }));
    },

    async checksForSha({ projectId, sha }): Promise<CheckSummary> {
      const w = await call<WireChecks>("GET", `/checks/${encodeURIComponent(sha)}`, {
        org: org(),
        project: projectId || undefined,
      });
      const map = {
        GREEN: "success",
        PENDING: "running",
        RED: "failure",
        NONE: "none",
        CANCELLED: "cancelled",
      } as const;
      return {
        sha: w.sha,
        state: map[w.state],
        runs: w.runs.map((r) => ({
          runId: r.id,
          workflowName: workflowName(r.workflow_path),
          status: r.state,
        })),
      };
    },

    async rerun({ runId, jobKeys, reason }): Promise<RerunResult> {
      const w = await call<WireRerun>(
        "POST",
        `/runs/${encodeURIComponent(runId)}/rerun`,
        {},
        { reason, org: org(), ...(jobKeys && jobKeys.length > 0 ? { jobs: jobKeys } : {}) },
      );
      return {
        runId: w.run_id,
        state: w.state,
        reruns: w.reruns.map((r) => ({
          jobId: r.job_id,
          jobKey: r.job_key,
          attempt: r.attempt,
          previousState: r.previous_state,
          state: r.state,
        })),
      };
    },

    async whoami(): Promise<Whoami> {
      // A token names its own org. A web session acts in the org the call names.
      const w = await call<WireWhoami>(
        "GET",
        "/whoami",
        options.token() === null && options.session?.() ? { org: org() } : {},
      );
      return {
        kind: w.kind,
        id: w.id,
        name: w.name,
        role: w.role,
        org: w.org,
        project: w.project,
        operatorOrg: w.operator_org === true,
      };
    },

    async approveRun({ runId, headSha, workflowHash }): Promise<ApproveResult> {
      const w = await call<WireApprove>(
        "POST",
        `/runs/${encodeURIComponent(runId)}/approve`,
        {},
        { head_sha: headSha, workflow_hash: workflowHash, org: org() },
      );
      return {
        runId: w.run_id,
        state: w.state,
        releasedJobs: w.released_jobs,
        approvedBy: w.approved_by,
        headSha: w.head_sha,
        workflowHash: w.workflow_hash,
      };
    },

    async failureDigest({ runId, jobId }): Promise<{ failingJobs: number; digests: JobDigest[] }> {
      const w = await call<WireFailureDigest>("GET", "/failure-digest", {
        org: org(),
        run_id: runId,
        job_id: jobId,
      });
      return {
        failingJobs: w.failing_jobs,
        digests: w.digests.map((d) => ({
          jobId: d.job_id,
          jobKey: d.job_key,
          state: d.state,
          attempt: d.attempt,
          step: d.step,
          basis: d.basis,
          excerpt: d.excerpt,
          truncated: d.truncated,
          infraErrorReason: d.infra_error_reason,
        })),
      };
    },

    async grepLog({
      attemptId,
      pattern,
      regex,
      ignoreCase,
      context,
      maxMatches,
      fromOffset,
    }): Promise<GrepResult> {
      const k = known(attemptId);
      const w = await call<WireLog>("GET", `/jobs/${encodeURIComponent(k.jobId)}/log`, {
        org: org(),
        attempt: k.attempt,
        mode: "grep",
        pattern,
        regex: regex ? "true" : undefined,
        ignore_case: ignoreCase ? "true" : undefined,
        context,
        max_matches: maxMatches,
        offset: fromOffset,
      });
      return {
        hits: parseGrep(w.text),
        matches: w.matches,
        nextOffset: w.next_offset,
        totalBytes: w.total_bytes,
      };
    },

    async listSettings(args): Promise<Setting[]> {
      const out: WireSetting[] = [];
      let cursor: string | undefined;
      do {
        const w = await call<WireSettings>("GET", "/settings", {
          org: org(),
          project: args?.project,
          limit: 100,
          cursor,
        });
        out.push(...w.settings);
        cursor = w.next_cursor ?? undefined;
      } while (cursor);
      // With a project the op returns the org's settings too; a project is asked for its own.
      return out
        .map(mapSetting)
        .filter((s) => (args?.project === undefined ? s.scope === "org" : s.scope === "project"));
    },

    async stepUpChallenge({ action, input }): Promise<StepUpChallenge> {
      const w = await call<{
        step_up_id: string;
        challenge: string;
        rp_id: string;
        passkeys: { approver: string; passkey_id: string }[];
      }>("POST", "/session/step-up", {}, { org: org(), action, input: { org: org(), ...input } });
      return {
        id: w.step_up_id,
        challenge: w.challenge,
        rpId: w.rp_id,
        passkeys: w.passkeys.map((k) => ({ approver: k.approver, passkeyId: k.passkey_id })),
      };
    },

    async laneWrite({ action, input, stepUp }) {
      return call<Record<string, unknown>>(
        "POST",
        LANE_PATHS[action],
        {},
        { org: org(), ...input, step_up: stepUp },
      );
    },

    async laneConfig({ targetOrg, targetProject }): Promise<LaneConfig> {
      const w = await call<{
        pinned_repo: string | null;
        config_version: number;
        targets: {
          key: string;
          kind: string;
          mode: string;
          has_credential: boolean;
          settings: Record<string, unknown>;
        }[];
      }>("GET", "/release-lane/publish-targets", {
        org: org(),
        target_org: targetOrg,
        target_project: targetProject,
      });
      return {
        pinnedRepo: w.pinned_repo,
        configVersion: w.config_version,
        targets: w.targets.map((t) => ({
          key: t.key,
          kind: t.kind,
          mode: t.mode,
          hasCredential: t.has_credential,
          settings: t.settings,
        })),
      };
    },

    async laneKey({ targetOrg, name }): Promise<LaneKey> {
      const w = await call<{ keyid: string; public_key_pem: string; created_at: string }>(
        "GET",
        `/release-lane/keys/${encodeURIComponent(name)}`,
        { org: org(), target_org: targetOrg },
      );
      return { keyid: w.keyid, publicKeyPem: w.public_key_pem, createdAt: w.created_at };
    },

    async laneCosignKeys({ targetOrg, targetProject }) {
      const w = await call<{
        keys: {
          name: string;
          key_id: string;
          spki_sha256: string;
          signs: string;
          output_name: string;
          format: string;
          manifest: boolean;
        }[];
        config_version: number;
      }>("GET", "/release-lane/cosign-keys", {
        org: org(),
        target_org: targetOrg,
        target_project: targetProject,
      });
      const keys: LaneCosignKey[] = w.keys.map((k) => ({
        name: k.name,
        keyId: k.key_id,
        spkiSha256: k.spki_sha256,
        signs: k.signs,
        outputName: k.output_name,
        format: k.format,
        manifest: k.manifest,
      }));
      return { keys, configVersion: w.config_version };
    },

    async laneSecretStatus({ targetOrg, targetProject, name }): Promise<LaneSecretStatus> {
      const w = await call<{ set: boolean; set_at: string | null; set_by: string | null }>(
        "GET",
        "/release-lane/secrets",
        { org: org(), target_org: targetOrg, target_project: targetProject, name },
      );
      return { set: w.set, setAt: w.set_at, setBy: w.set_by };
    },

    async rotateWebhookSecret({ overlapMinutes, stepUp }) {
      const w = await call<{ fingerprint: string; overlap_until: string }>(
        "POST",
        "/app-secrets/webhook-secret/rotate",
        {},
        { org: org(), overlap_minutes: overlapMinutes, step_up: stepUp },
      );
      return { fingerprint: w.fingerprint, overlapUntil: w.overlap_until };
    },

    async replaceAppPrivateKey({ privateKey, stepUp }) {
      const w = await call<{ fingerprint: string; app_id: string }>(
        "POST",
        "/app-secrets/private-key",
        {},
        { org: org(), private_key: privateKey, step_up: stepUp },
      );
      return { fingerprint: w.fingerprint, appId: w.app_id };
    },

    async setSetting({ key, value, unset, project, stepUp }): Promise<Setting> {
      return mapSetting(
        await call<WireSetting>(
          "POST",
          "/settings",
          {},
          {
            org: org(),
            key,
            ...(project !== undefined ? { project } : {}),
            ...(unset ? { unset: true } : { value }),
            ...(stepUp ? { step_up: stepUp } : {}),
          },
        ),
      );
    },

    async getApprovalPolicy(): Promise<ApprovalPolicy> {
      return mapApprovalPolicy(
        await call<WireApprovalPolicy>("GET", "/approval-policy", { org: org() }),
      );
    },

    async getProjectEgress({ project }) {
      const w = await call<{ egress: "none" | "allowlist" | "open" }>("GET", "/project-settings", {
        org: org(),
        project,
      });
      return w.egress;
    },

    async tightenProjectEgress({ project, egress }) {
      const w = await call<{ to: "none" | "allowlist" | "open"; warnings: string[] }>(
        "POST",
        "/project-egress",
        { org: org(), project },
        { egress },
      );
      return { egress: w.to, warnings: w.warnings };
    },

    async getProjectPrPolicy({ project }) {
      const w = await call<{ pr_mode: PrMode; authors: string[]; ingest_enabled: boolean }>(
        "GET",
        "/project-pr-policy",
        { org: org(), project },
      );
      return { prMode: w.pr_mode, authors: w.authors, ingestEnabled: w.ingest_enabled };
    },

    async changeProjectPrPolicy({ project, prMode, authors }) {
      const w = await call<{ to: { pr_mode: PrMode; authors: string[] } }>(
        "POST",
        "/project-pr-policy",
        { org: org(), project },
        { pr_mode: prMode, authors },
      );
      return { prMode: w.to.pr_mode, authors: w.to.authors, ingestEnabled: true };
    },

    async setApprovalPolicy({
      environment,
      required,
      allowAuthorApproval,
      keyPolicy,
      stepUp,
    }): Promise<ApprovalPolicy> {
      return mapApprovalPolicy(
        await call<WireApprovalPolicy>(
          "POST",
          "/approval-policy",
          {},
          {
            org: org(),
            environment,
            required,
            allow_author_approval: allowAuthorApproval,
            key_policy: keyPolicy,
            ...(stepUp ? { step_up: stepUp } : {}),
          },
        ),
      );
    },

    async incidentStatus(args): Promise<IncidentStatus> {
      const w = await call<WireIncident>("GET", "/incident", {
        org: org(),
        project: args?.project,
      });
      return {
        frozen: w.frozen,
        level: w.level,
        reason: w.reason,
        frozenAt: w.frozen_at,
        frozenBy: w.frozen_by,
        rotationRequiredCount: w.rotation_required_count,
        rotationRequired: w.rotation_required.map((r) => ({
          name: r.name,
          reason: r.reason,
          flaggedBy: r.flagged_by,
          flaggedAt: r.flagged_at,
        })),
      };
    },

    async approvalStatus({ runId }): Promise<ApprovalStatus> {
      const w = await call<WireApprovalStatus>("GET", "/approvals/status", {
        org: org(),
        run_id: runId,
      });
      return {
        runId: w.run_id,
        headSha: w.head_sha,
        workflowHash: w.workflow_hash,
        author: w.author,
        environments: w.environments.map((e) => ({
          environment: e.environment,
          required: e.required,
          allowAuthorApproval: e.allow_author_approval,
          waiting: e.waiting,
          release: e.release,
          approvals: e.approvals.map((a) => ({
            person: a.person,
            method: a.method,
            approvedAt: ms(a.approved_at) ?? 0,
            expiresAt: ms(a.expires_at) ?? 0,
          })),
        })),
      };
    },

    async getArtifacts({ runId, project }): Promise<Artifact[]> {
      const w = await call<WireArtifacts>("GET", `/runs/${encodeURIComponent(runId)}/artifacts`, {
        org: org(),
        project,
      });
      return w.artifacts.map((a) => ({
        name: a.name,
        size: a.size,
        sha256: a.sha256,
        digestSource: a.digest_source,
        trustClass: a.trust_class,
        runSha: a.run_sha,
        attemptId: a.attempt_id,
        createdAt: ms(a.created_at) ?? 0,
      }));
    },

    async checkArtifactConsumption({
      project,
      consumer,
      sources,
      quarantine,
    }): Promise<ConsumeResult[]> {
      const pair = (x: { runId: string; name: string }) => ({ run_id: x.runId, name: x.name });
      const w = await call<WireConsumption>(
        "POST",
        "/artifacts/check-consumption",
        {},
        {
          org: org(),
          project,
          ...("klass" in consumer
            ? { consumer_class: consumer.klass }
            : { consumer_run_id: consumer.runId }),
          sources: sources.map(pair),
          ...(quarantine ? { quarantine: quarantine.map(pair) } : {}),
        },
      );
      return w.results.map((r) => ({
        runId: r.run_id,
        name: r.name,
        decision: r.decision,
        reason: r.reason,
        trustClass: r.trust_class,
        sha256: r.sha256,
      }));
    },

    async getQuotas(): Promise<OrgQuotas> {
      return quotasOf(await call<WireQuotas>("GET", "/quotas", { org: org() }));
    },

    async sandboxUsage({ days, byProject }): Promise<SandboxUsage> {
      const w = await call<WireSandboxUsage>("GET", "/usage/sandbox", {
        org: org(),
        days,
        ...(byProject ? { group_by: "project" } : {}),
      });
      const mapDay = (d: WireSandboxUsage["days"][number]) => ({
        day: d.day,
        seconds: d.sandbox_seconds,
        minutes: d.sandbox_minutes,
        attempts: d.attempts,
        estimatedAttempts: d.estimated_attempts,
      });
      let limit: number | null = null;
      try {
        // The quota limit is optional context: a token that cannot read quotas still gets the chart.
        const q = await call<{ limits: { max_sandbox_minutes_per_day: number | null } }>(
          "GET",
          "/quotas",
          { org: org() },
        );
        limit = q.limits.max_sandbox_minutes_per_day;
      } catch {
        limit = null;
      }
      return {
        days: w.days.map(mapDay),
        totalMinutes: w.total_minutes,
        projects: (w.projects ?? []).map((p) => ({
          id: p.project_id,
          slug: p.project_slug,
          name: p.project_name,
          days: p.days.map(mapDay),
          totalMinutes: p.total_minutes,
          preemptions: p.preemptions ?? 0,
          preemptedMinutes: p.preempted_minutes ?? 0,
          usefulMinutes: p.useful_minutes ?? p.total_minutes,
        })),
        limitMinutesPerDay: limit,
      };
    },

    async myPendingApprovals(): Promise<PendingApproval[]> {
      // The op answers for every org the person belongs to; the call itself needs one named.
      const w = await call<WireMyPendingApprovals>("GET", "/my/pending-approvals", {
        org: org(),
      });
      return w.items.map((i) => ({
        id: i.id,
        kind: i.kind,
        org: i.org,
        project: i.project,
        ...(i.environment !== undefined ? { environment: i.environment } : {}),
        createdAt: ms(i.created_at) ?? 0,
        ...(i.expires_at !== undefined ? { expiresAt: i.expires_at } : {}),
        link: i.link,
      }));
    },

    async myNotifications(f = {}): Promise<NotificationPage> {
      // Like the feed: it spans the person's orgs, so no `org()` is needed.
      const w = await call<WireMyNotifications>("GET", "/my/notifications", {
        unread: f.unread ? "true" : undefined,
        ...(f.kinds && f.kinds.length > 0 ? { kinds: f.kinds.join(",") } : {}),
        limit: f.limit ? Math.min(100, f.limit) : undefined,
        cursor: f.cursor,
      });
      return {
        notifications: w.notifications.map((n): AppNotification => ({
          id: n.id,
          kind: n.kind,
          org: n.org,
          project: n.project,
          runId: n.run_id,
          count: n.count,
          title: n.title,
          createdAt: ms(n.created_at) ?? 0,
          readAt: ms(n.read_at),
          link: n.link,
        })),
        unreadCount: w.unread_count,
        nextCursor: w.next_cursor,
      };
    },

    async notificationsAck({ ids, org: named }): Promise<number> {
      const w = await call<{ acked: number }>(
        "POST",
        "/my/notifications/ack",
        {},
        { org: named ?? org(), ...(ids ? { ids } : {}) },
      );
      return w.acked;
    },

    async getNotificationPrefs({ org: named } = {}): Promise<NotificationPrefs> {
      const w = await call<WireNotificationPrefs>("GET", "/my/notification-prefs", {
        org: named ?? org(),
      });
      return {
        prefs: w.prefs,
        defaults: w.defaults.map((d) => ({
          kind: d.kind,
          enabled: d.enabled,
          operatorOnly: d.operator_only,
        })),
      };
    },

    async setNotificationPref({ kind, enabled, org: named, scopeOrg }): Promise<void> {
      await call(
        "POST",
        "/my/notification-prefs/set",
        {},
        {
          org: named ?? org(),
          kind,
          ...(enabled === null ? {} : { enabled }),
          ...(scopeOrg ? { scope_org: scopeOrg } : {}),
        },
      );
    },

    async approversOverview(): Promise<ApproversOverview> {
      const w = await call<WireApprovers>("GET", "/approvers", { org: org() });
      return {
        approvers: w.approvers.map((a) => ({
          id: a.id,
          person: a.person,
          forgeLogin: a.forge_login,
          kind: a.kind,
          passkeyId: a.passkey_id,
          createdAt: ms(a.created_at) ?? 0,
          notCounting: a.not_counting,
          attested: a.attested,
          aaguid: a.aaguid,
        })),
        keyPolicy: w.key_policy,
        pendingEnrolments: w.pending_enrolments.map((e) => ({
          id: e.id,
          person: e.person,
          forgeLogin: e.forge_login,
          kind: e.kind,
          keyFingerprint: e.key_fingerprint,
          approvals: e.approvals,
          required: e.required,
          expiresAt: ms(e.expires_at) ?? 0,
        })),
        policies: w.policies.map((p) => ({
          environment: p.environment,
          required: p.required,
          allowAuthorApproval: p.allow_author_approval,
          source: p.source,
        })),
        warnings: w.warnings,
        defaultMode: w.default_mode,
        instanceLoosenings: w.instance_loosenings.map((l) => ({
          at: ms(l.at) ?? 0,
          by: l.by,
          reason: l.reason,
          loosened: l.loosened,
        })),
      };
    },

    async approvalChallenge({ runId, environment, approver, project }) {
      const w = await call<WireChallenge>(
        "POST",
        "/approvals/challenge",
        {},
        { run_id: runId, environment, approver, org: org(), project },
      );
      return challengeOf<ApprovalStatement>(w);
    },

    async releaseApprovalChallenge({ runId, approver, project }) {
      const w = await call<WireReleaseChallenge>(
        "POST",
        "/approvals/release-challenge",
        {},
        { run_id: runId, approver, org: org(), project },
      );
      return {
        ...challengeOf<ReleaseStatement>(w),
        manifestSha256: w.manifest_sha256,
        artifacts: w.artifacts.map((a) => ({ name: a.name, sha256: a.sha256, size: a.size })),
      };
    },

    async approveRelease({ statement, signature }): Promise<EnvironmentApprovalResult> {
      const w = await call<WireEnvironmentApproval>(
        "POST",
        "/approvals/release",
        {},
        { statement, signature },
      );
      return {
        runId: w.run_id,
        environment: w.environment,
        approvals: w.approvals,
        required: w.required,
        releasedJobs: w.released_jobs,
        state: w.state,
      };
    },

    async approveEnvironment({ statement, signature }): Promise<EnvironmentApprovalResult> {
      // The signature is the credential; the server ignores the bearer token on this route.
      const w = await call<WireEnvironmentApproval>(
        "POST",
        "/approvals",
        {},
        { statement, signature },
      );
      return {
        runId: w.run_id,
        environment: w.environment,
        approvals: w.approvals,
        required: w.required,
        releasedJobs: w.released_jobs,
        state: w.state,
      };
    },

    async registerChallenge() {
      const w = await call<WireRegisterChallenge>(
        "POST",
        "/approvers/register-challenge",
        {},
        { org: org() },
      );
      return {
        challenge: w.challenge,
        rpId: w.rp_id,
        expiresAt: ms(w.expires_at) ?? 0,
        attestation: w.attestation,
      };
    },

    async firstApproverChallenge() {
      const w = await call<WireRegisterChallenge>(
        "POST",
        "/approvers/first/challenge",
        {},
        { org: org() },
      );
      return {
        challenge: w.challenge,
        rpId: w.rp_id,
        expiresAt: ms(w.expires_at) ?? 0,
        attestation: w.attestation,
      };
    },

    async enrolFirstApprover({ person, webauthn }) {
      const w = await call<{
        approver_id: string;
        person: string;
        key_fingerprint: string;
        warnings: string[];
      }>(
        "POST",
        "/approvers/first",
        {},
        {
          ...(person ? { person } : {}),
          webauthn: {
            challenge: webauthn.challenge,
            client_data_json: webauthn.clientDataJson,
            attestation_object: webauthn.attestationObject,
          },
          org: org(),
        },
      );
      return {
        approverId: w.approver_id,
        person: w.person,
        keyFingerprint: w.key_fingerprint,
        warnings: w.warnings,
      };
    },

    async keyPolicyChallenge({ mode, presets, aaguids, approver }) {
      const w = await call<WireChallenge>(
        "POST",
        "/approvers/key-policy/challenge",
        {},
        { mode, presets, aaguids, approver, org: org() },
      );
      return challengeOf<PolicyStatement>(w);
    },

    async approveKeyPolicy({ statement, signature }) {
      return call<{ approvals: number; required: number; applied: boolean }>(
        "POST",
        "/approvers/key-policy",
        {},
        { statement, signature },
      );
    },

    async requestEnrolment({ person, forgeLogin, webauthn }) {
      const w = await call<WireEnrolmentRequest>(
        "POST",
        "/approvers/enrolments",
        {},
        {
          person,
          forge_login: forgeLogin,
          webauthn: {
            challenge: webauthn.challenge,
            client_data_json: webauthn.clientDataJson,
            attestation_object: webauthn.attestationObject,
          },
          org: org(),
        },
      );
      return {
        enrolmentId: w.enrolment_id,
        keyFingerprint: w.key_fingerprint,
        required: w.required,
        expiresAt: ms(w.expires_at) ?? 0,
      };
    },

    async enrolmentChallenge({ enrolmentId, approver }) {
      const w = await call<WireChallenge>(
        "POST",
        "/approvers/challenge",
        {},
        { enrolment_id: enrolmentId, approver, org: org() },
      );
      return challengeOf<EnrolStatement>(w);
    },

    async approveEnrolment({ statement, signature }) {
      const w = await call<WireEnrolmentApproval>(
        "POST",
        "/approvers/approve",
        {},
        { statement, signature },
      );
      return {
        enrolmentId: w.enrolment_id,
        approvals: w.approvals,
        required: w.required,
        activated: w.activated,
      };
    },

    async ingestStatus(): Promise<IngestStatus> {
      const w = await call<WireIngestStatus>("GET", "/ingest/status", { org: org() });
      return {
        running: w.running,
        rateLimit: w.rate_limit
          ? {
              limit: w.rate_limit.limit,
              remaining: w.rate_limit.remaining,
              resetAt: ms(w.rate_limit.reset_at),
              resource: w.rate_limit.resource,
              observedAt: ms(w.rate_limit.observed_at) ?? 0,
            }
          : null,
        repos: w.repos.map((r) => ({
          repo: r.repo,
          project: r.project,
          lastPollAt: ms(r.last_poll_at),
          lastOutcome: r.last_outcome,
          lastError: r.last_error,
          nextPollAt: ms(r.next_poll_at),
          consecutiveFailures: r.consecutive_failures,
          runsCreated: r.runs_created,
        })),
      };
    },

    async cancel({ runId }): Promise<void> {
      await call("POST", `/runs/${encodeURIComponent(runId)}/cancel`, {}, { org: org() });
    },

    async events({ cursor }) {
      return { events: [], cursor: cursor ?? "" }; // the event feed has not landed yet
    },
  };
  return api;
}

type WireApprovalPolicy = {
  environments: {
    environment: string;
    required: number;
    allow_author_approval: boolean;
    key_policy: "any" | "hardware";
    gated: boolean;
    source: "configured" | "default";
  }[];
  source: ApprovalPolicy["source"];
  locked: boolean;
  locked_by: string | null;
  approvers: number;
};

export function mapApprovalPolicy(w: WireApprovalPolicy): ApprovalPolicy {
  return {
    environments: w.environments.map((e) => ({
      environment: e.environment,
      required: e.required,
      allowAuthorApproval: e.allow_author_approval,
      keyPolicy: e.key_policy,
      gated: e.gated,
      source: e.source,
    })),
    source: w.source,
    locked: w.locked,
    lockedBy: w.locked_by,
    approvers: w.approvers,
  };
}
