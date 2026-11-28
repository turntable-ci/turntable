import type { PrPolicy, TurntableApi } from "../client";
import type {
  ChangeEvent,
  ConnectionStatus,
  Realtime,
  RealtimeMessage,
  SubscribeOptions,
  Topic,
} from "../realtime";
import type { ActivityRun, ApprovalPolicy, CheckSummary, RunDetail, Whoami } from "../types";
import { createFixtureSettings } from "./settings";
import { createRng } from "./prng";
import { createWorld, type World } from "./world";

export type FixtureOptions = {
  /** Simulated network latency range in ms. Use 0 in tests. */
  latency?: [number, number];
  /** Simulation tick interval in ms. */
  tickMs?: number;
  seed?: string;
  /** Role the fixture session holds; decides whether approval is allowed. */
  role?: Whoami["role"];
  /** Whether the fixture org is the operator org (default true). */
  operatorOrg?: boolean;
};

export type Fixture = {
  api: TurntableApi;
  realtime: Realtime;
  world: World;
  stop(): void;
};

function matches(world: World, topic: Topic, ev: ChangeEvent): boolean {
  const v = ev.value;
  switch (topic.kind) {
    case "org":
      return v.orgId === topic.orgId;
    case "project":
      return v.projectId === topic.projectId;
    case "run": {
      if (ev.entity === "run") return v.id === topic.runId;
      if (ev.entity === "job") return (v as { runId: string }).runId === topic.runId;
      const job = world.jobs.get((v as { jobId: string }).jobId);
      return job?.runId === topic.runId;
    }
    case "attempt-log":
      return false;
  }
}

/** In-memory world with a live simulation, behind the same interfaces as the real adapters. */
export function createFixture(options: FixtureOptions = {}): Fixture {
  const [minLat, maxLat] = options.latency ?? [50, 160];
  const world = createWorld(options.seed !== undefined ? { seed: options.seed } : {});
  const lagRng = createRng("latency");
  const delay = <T>(value: () => T): Promise<T> =>
    new Promise((resolve, reject) =>
      setTimeout(
        () => {
          try {
            resolve(value());
          } catch (e) {
            reject(e);
          }
        },
        minLat + lagRng.next() * (maxLat - minLat),
      ),
    );

  const settings = createFixtureSettings(() => options.role ?? "owner");
  let demoPr: PrPolicy = { prMode: "allowlist", authors: ["octocat"], ingestEnabled: true };
  let demoEgress: "none" | "allowlist" | "open" = "open";
  const demoPolicy: ApprovalPolicy = {
    environments: ["production", "release"].map((environment) => ({
      environment,
      required: 2,
      allowAuthorApproval: false,
      keyPolicy: "any" as const,
      gated: true,
      source: "default" as const,
    })),
    source: "default",
    locked: false,
    lockedBy: null,
    approvers: 2,
  };

  const timer = setInterval(() => {
    world.tick();
    world.maybeSpawn();
  }, options.tickMs ?? 1000);

  const api: TurntableApi = {
    capabilities: { rerun: true, approve: true, humanApproval: true, simulatedCeremony: true },
    listOrgs: () => delay(() => world.orgs.map((o) => ({ ...o }))),
    listProjects: (orgId) =>
      delay(() => world.projects.filter((p) => p.orgId === orgId).map((p) => ({ ...p }))),
    myActivityFeed: (f = {}) =>
      delay(() => {
        const projectOf = new Map(world.projects.map((p) => [p.id, p]));
        const orgOf = new Map(world.orgs.map((o) => [o.id, o]));
        const rows: ActivityRun[] = [];
        for (const r of world.runs.values()) {
          const p = projectOf.get(r.projectId);
          const o = p ? orgOf.get(p.orgId) : undefined;
          if (!p || !o) continue;
          if (f.org && o.slug !== f.org) continue;
          if (f.project && p.slug !== f.project) continue;
          const live =
            r.status === "queued" || r.status === "running" || r.status === "awaiting_approval";
          if (f.status === "running" && !live) continue;
          if (f.status === "failed" && r.status !== "failure" && r.status !== "infra_error")
            continue;
          rows.push({
            runId: r.id,
            org: o.slug,
            orgName: o.name,
            orgAvatarUrl: null,
            project: p.slug,
            projectName: p.name,
            projectAvatarUrl: null,
            workflow: r.workflowName,
            ref: r.ref.replace(/^refs\/(heads|tags)\//, ""),
            refType: r.ref.startsWith("refs/tags/") ? "tag" : "branch",
            sha: r.sha,
            event: r.event,
            commitMessage: r.commitMessage,
            actor: r.actor || null,
            actorAvatarUrl: null,
            state: live ? (r.status as ActivityRun["state"]) : "completed",
            conclusion: live ? null : (r.status as ActivityRun["conclusion"]),
            createdAt: r.createdAt,
            startedAt: r.startedAt ?? null,
            finishedAt: r.finishedAt ?? null,
          });
        }
        rows.sort((a, b) => b.createdAt - a.createdAt || (a.runId < b.runId ? 1 : -1));
        const start = f.cursor ? Number(f.cursor) : 0;
        const limit = f.limit ?? 50;
        return {
          runs: rows.slice(start, start + limit),
          nextCursor: start + limit < rows.length ? String(start + limit) : null,
        };
      }),
    listRuns: (f) =>
      delay(() => {
        let rows = [...world.runs.values()].filter((r) => r.projectId === f.projectId);
        if (f.status) rows = rows.filter((r) => r.status === f.status);
        if (f.event) rows = rows.filter((r) => r.event === f.event);
        if (f.branch) rows = rows.filter((r) => r.ref.endsWith(f.branch!));
        rows.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
        const start = f.cursor ? Number(f.cursor) : 0;
        const limit = f.limit ?? 50;
        const page = rows.slice(start, start + limit).map((r) => ({ ...r }));
        return {
          runs: page,
          nextCursor: start + limit < rows.length ? String(start + limit) : null,
        };
      }),
    getRun: (runId) =>
      delay((): RunDetail => {
        const run = world.runs.get(runId);
        if (!run) throw new Error(`Run ${runId} was not found`);
        const jobs = world.jobsOf(runId);
        const attempts = jobs.flatMap((j) => world.attemptsOf(j.id));
        return {
          run: { ...run },
          jobs: jobs.map((j) => ({ ...j })),
          attempts: attempts.map((a) => ({ ...a })),
        };
      }),
    jobLog: ({ attemptId, offset, limit }) =>
      delay(() => {
        const l = world.logOf(attemptId);
        if (!l) return { attemptId, offset, bytes: new Uint8Array(0), size: 0, done: false };
        const end = Math.min(l.available, offset + limit);
        const bytes = l.log.bytes.slice(Math.min(offset, l.available), end);
        return { attemptId, offset, bytes, size: l.available, done: l.done && end >= l.available };
      }),
    jobSteps: ({ attemptId }) =>
      delay(() => (world.logOf(attemptId)?.steps ?? []).map((st) => ({ ...st, attemptId }))),
    jobCuts: ({ attemptId }) =>
      delay(() => (world.logOf(attemptId)?.cuts ?? []).map((c) => ({ ...c, attemptId }))),
    jobNotices: ({ attemptId }) =>
      delay(() => (world.logOf(attemptId)?.notices ?? []).map((n) => ({ ...n, attemptId }))),
    checksForSha: ({ projectId, sha }) =>
      delay((): CheckSummary => {
        const rows = [...world.runs.values()].filter(
          (r) => r.projectId === projectId && r.sha === sha,
        );
        const worst =
          rows.find((r) => r.status === "failure") ??
          rows.find((r) => r.status === "running") ??
          rows[0];
        return {
          sha,
          state: worst?.status ?? "none",
          runs: rows.map((r) => ({ runId: r.id, workflowName: r.workflowName, status: r.status })),
        };
      }),
    rerun: ({ runId, jobKeys }) => delay(() => world.rerun(runId, jobKeys)),
    whoami: () =>
      delay((): Whoami => ({
        kind: "member",
        id: "01FIXTUREMEMBER",
        name: "Fixture user",
        role: options.role ?? "owner",
        org: world.orgs[0]?.slug ?? "org",
        project: null,
        operatorOrg: options.operatorOrg ?? true,
      })),
    approveRun: ({ runId, headSha, workflowHash }) =>
      delay(() => world.approve(runId, headSha, workflowHash)),
    failureDigest: ({ runId, jobId }) => delay(() => world.failureDigest(runId, jobId)),
    grepLog: ({ attemptId, pattern, regex, ignoreCase, context, maxMatches }) =>
      delay(() =>
        world.grepLog(attemptId, pattern, {
          ...(regex !== undefined ? { regex } : {}),
          ...(ignoreCase !== undefined ? { ignoreCase } : {}),
          ...(context !== undefined ? { context } : {}),
          ...(maxMatches !== undefined ? { maxMatches } : {}),
        }),
      ),
    ingestStatus: () => delay(() => world.ingestStatus()),
    approvalStatus: ({ runId }) => delay(() => world.approvalStatus(runId)),
    approversOverview: () => delay(() => world.approversOverview()),
    myPendingApprovals: () => delay(() => []),
    myNotifications: () => delay(() => ({ notifications: [], unreadCount: 0, nextCursor: null })),
    notificationsAck: () => delay(() => 0),
    getNotificationPrefs: () => delay(() => ({ prefs: [], defaults: [] })),
    setNotificationPref: () => delay(() => undefined),
    sandboxUsage: ({ days }) => delay(() => world.sandboxUsage(days)),
    getArtifacts: ({ runId }) => delay(() => world.getArtifacts(runId)),
    checkArtifactConsumption: (a) => delay(() => world.checkArtifactConsumption(a)),
    getQuotas: () => delay(() => world.getQuotas()),
    listSettings: (a) => delay(() => settings.list(a?.project)),
    setSetting: (a) => delay(() => settings.set(a)),
    getApprovalPolicy: () => delay(() => structuredClone(demoPolicy)),
    getProjectPrPolicy: () => delay(() => structuredClone(demoPr)),
    changeProjectPrPolicy: ({ prMode, authors }) =>
      delay(() => {
        demoPr = { prMode, authors, ingestEnabled: true };
        return structuredClone(demoPr);
      }),
    getProjectEgress: () => delay(() => demoEgress),
    tightenProjectEgress: ({ egress }) =>
      delay(() => {
        const rank = { open: 0, allowlist: 1, none: 2 };
        if (rank[egress] < rank[demoEgress]) throw new Error("egress can only be tightened here");
        demoEgress = egress;
        return { egress, warnings: [] };
      }),
    setApprovalPolicy: (a) =>
      delay(() => {
        const e = demoPolicy.environments.find((x) => x.environment === a.environment);
        const row = {
          environment: a.environment,
          required: a.required,
          allowAuthorApproval: a.allowAuthorApproval,
          keyPolicy: a.keyPolicy,
          gated: true,
          source: "configured" as const,
        };
        if (e) Object.assign(e, row);
        else demoPolicy.environments.push(row);
        return structuredClone(demoPolicy);
      }),
    stepUpChallenge: () => Promise.reject(new Error("The demo has no passkeys to confirm with.")),
    laneWrite: () => Promise.reject(new Error("The demo has no release lane to configure.")),
    laneConfig: () => Promise.reject(new Error("The demo has no release lane to configure.")),
    laneKey: () => Promise.reject(new Error("The demo has no release lane to configure.")),
    laneCosignKeys: () => Promise.reject(new Error("The demo has no release lane to configure.")),
    laneSecretStatus: () => Promise.reject(new Error("The demo has no release lane to configure.")),
    rotateWebhookSecret: () => Promise.reject(new Error("The demo has no GitHub App.")),
    replaceAppPrivateKey: () => Promise.reject(new Error("The demo has no GitHub App.")),
    approvalChallenge: ({ runId, environment, approver }) =>
      delay(() => world.approvalChallenge(runId, environment, approver)),
    // The fixture world has no release environment (its approval is "production").
    releaseApprovalChallenge: () =>
      Promise.reject(new Error("no job of this run waits for approval in the release environment")),
    approveRelease: () =>
      Promise.reject(new Error("no job of this run waits for approval in the release environment")),
    approveEnvironment: ({ statement, signature }) =>
      delay(() => world.approveEnvironment(statement, signature)),
    registerChallenge: () =>
      delay(() => ({
        challenge: "cmVnaXN0ZXItY2hhbGxlbmdl",
        rpId: "localhost",
        expiresAt: Date.now() + 600_000,
        attestation: "none" as const,
      })),
    firstApproverChallenge: () =>
      delay(() => ({
        challenge: "Zmlyc3QtYXBwcm92ZXItY2hhbGxlbmdl",
        rpId: "localhost",
        expiresAt: Date.now() + 600_000,
        attestation: "none" as const,
      })),
    enrolFirstApprover: ({ person }) =>
      delay(() => ({
        approverId: "ap_first",
        person: person ?? "you",
        keyFingerprint: "c1".repeat(32),
        warnings: [],
      })),
    keyPolicyChallenge: (args) => delay(() => world.keyPolicyChallenge(args)),
    approveKeyPolicy: ({ statement }) => delay(() => world.approveKeyPolicy(statement)),
    requestEnrolment: ({ person }) =>
      delay(() => ({
        enrolmentId: "en_new",
        keyFingerprint: "c0".repeat(32),
        required: 2,
        expiresAt: Date.now() + 7 * 86_400_000,
      })).then((r) => ({ ...r, person }) as typeof r),
    enrolmentChallenge: ({ enrolmentId, approver }) =>
      delay(() => world.enrolmentChallenge(enrolmentId, approver)),
    approveEnrolment: ({ statement }) => delay(() => world.approveEnrolment(statement)),
    incidentStatus: () => delay(() => world.incidentStatus()),
    cancel: ({ runId }) => delay(() => void world.cancel(runId)),
    events: ({ cursor, limit }) =>
      delay(() => {
        const after = cursor ?? "";
        const evs = world.events.filter((e) => e.cursor > after).slice(0, limit ?? 200);
        return { events: evs, cursor: evs.at(-1)?.cursor ?? after };
      }),
  };

  let status: ConnectionStatus = "live";
  const statusListeners = new Set<(s: ConnectionStatus) => void>();

  const realtime: Realtime = {
    subscribe(topic, opts: SubscribeOptions, handler: (m: RealtimeMessage) => void) {
      let closed = false;
      const deliver = (m: RealtimeMessage) => {
        if (!closed) handler(m);
      };
      if (topic.kind === "attempt-log")
        return subscribeLog(
          world,
          topic.attemptId,
          opts.offset ?? 0,
          deliver,
          () => (closed = true),
        );
      // Replay missed events after the cursor, then stream live, without gaps or duplicates.
      let last = opts.cursor ?? world.cursor();
      queueMicrotask(() => {
        for (const ev of world.events) {
          if (ev.cursor > last && matches(world, topic, ev)) {
            last = ev.cursor;
            deliver(ev);
          }
        }
      });
      const off = world.onEvent((ev) => {
        if (ev.cursor > last && matches(world, topic, ev)) {
          last = ev.cursor;
          // Deferred like a socket would: never re-enter the caller mid-mutation.
          queueMicrotask(() => deliver(ev));
        }
      });
      return () => {
        closed = true;
        off();
      };
    },
    status: () => status,
    onStatus(l) {
      statusListeners.add(l);
      l(status);
      return () => statusListeners.delete(l);
    },
  };

  return {
    api,
    realtime,
    world,
    stop() {
      clearInterval(timer);
    },
  };
}

function subscribeLog(
  world: World,
  attemptId: string,
  fromOffset: number,
  deliver: (m: RealtimeMessage) => void,
  markClosed: () => void,
): () => void {
  const rng = createRng(`chunks:${attemptId}:${fromOffset}`);
  let offset = fromOffset;
  let stepsSent = 0;
  let cutsSent = 0;
  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const step = () => {
    if (stopped) return;
    const l = world.logOf(attemptId);
    if (l && offset < l.available) {
      // Chunks end at arbitrary byte positions, so lines and UTF-8 sequences straddle chunks.
      const size = Math.min(l.available - offset, rng.int(180, 5200));
      const data = l.log.bytes.slice(offset, offset + size);
      offset += size;
      const eof = l.done && offset >= l.available;
      deliver({
        type: "log",
        attemptId,
        offset: offset - size,
        data,
        ...(eof ? { eof: true } : {}),
      });
      // Step boundaries travel out of band, once the log has reached their offset. A resume may
      // replay some; the client applies them idempotently.
      const due = l.steps.filter((st) => st.logOffset >= fromOffset && st.logOffset <= offset);
      for (; stepsSent < due.length; stepsSent++) {
        deliver({ type: "step", attemptId, ...(due[stepsSent] as (typeof due)[number]) });
      }
      const dueCuts = l.cuts.filter((c) => c.atOffset >= fromOffset && c.atOffset <= offset);
      for (; cutsSent < dueCuts.length; cutsSent++) {
        deliver({ type: "cut", attemptId, ...(dueCuts[cutsSent] as (typeof dueCuts)[number]) });
      }
      if (eof) return;
      handle = setTimeout(step, rng.int(20, 90));
      return;
    }
    if (l?.done) {
      deliver({ type: "log", attemptId, offset, data: new Uint8Array(0), eof: true });
      return;
    }
    handle = setTimeout(step, 300);
  };
  handle = setTimeout(step, 30);
  return () => {
    stopped = true;
    markClosed();
    if (handle) clearTimeout(handle);
  };
}
