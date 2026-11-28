import type { AttemptCredential } from "@turntable/proxy";
import { probeEgress, probeProxy } from "./egress-canary";
import {
  EXPORT_STEP_NAME,
  missingTool,
  missingToolNotice,
  resumeJob,
  runJob,
  type ActEvent,
  type ActTarball,
  type ActionFetcher,
  type InfraKind,
  type JobPlan,
} from "@turntable/act-runner";
import type { Provider, ProxyEndpoint, SandboxResources } from "@turntable/provider-sdk";
import { Redactor, SecretRegistry, redactString } from "@turntable/redact";
import {
  isCreateTimeout,
  isSandboxLostMessage,
  processCreateStats,
} from "../scheduler/create-stats";
import { type ErrorDetail, errorDetailOf } from "../scheduler/error-detail";
import { renderEvent, stepLabel } from "./render";
import type { JobIds, RunStore, StepRecord } from "./store";

/** Node 22 with bash, git and tar, which act host mode needs. Multi-arch index digest. */
export const DEFAULT_IMAGE =
  "node:22-bookworm@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb";

export type Verdict = "success" | "failure" | "skipped" | "infra_error" | "cancelled";

/** Process exit code: 0 success or skipped, 1 failure, 2 infra_error, 130 cancelled. */
export type ExitCode = 0 | 1 | 2 | 130;

export const EXIT: Record<Verdict, ExitCode> = {
  success: 0,
  skipped: 0,
  failure: 1,
  infra_error: 2,
  cancelled: 130,
};

/** Everything executeJob needs that does not change between jobs of one run. */
export interface JobEnv {
  provider: Provider;
  store: RunStore;
  /** Not needed to resume. */
  image?: string;
  /** Not needed to resume. */
  repoTarball?: Uint8Array;
  /**
   * The provider snapshot to start the sandbox from: the project's, which beats a size class's
   * and the provider config's. Unset: the provider's own choice.
   */
  snapshot?: string;
  /** Sink for the (redacted) log text. */
  out: (text: string) => void;
  /** `none` (default) gives the sandbox no network. `open` is an explicit opt-in. */
  egress?: "none" | "open";
  /** The sandbox's size, from the operator's size map (see scheduler/sandbox-size.ts). Absent: the provider's default. */
  sandbox?: { resources?: SandboxResources; snapshot?: string; image?: string };
  registry: SecretRegistry;
  signal?: AbortSignal | undefined;
  idleFlushMs?: number;
  act?: ActTarball;
  fetchAction?: ActionFetcher;
  pollMs?: number;
  timeoutSeconds?: number;
  /**
   * Prove the sandbox cannot reach out before the job runs, when egress is `none`: a probe tries a
   * public IP and the metadata IP. A breach is infra_error. If the probe cannot run (no tool in the
   * image) the job proceeds with a notice, unless it is `secretBearing`, which is then refused.
   */
  canary?: boolean;
  /** The job holds secrets: it never runs on `open` egress or without a verified `none`. */
  secretBearing?: boolean;
  /** Lines written to the top of the log before anything else (a fresh run, not a re-attach). */
  notices?: readonly string[];
  /**
   * Run the job behind the secrets proxy: the sandbox gets no route but to the proxy (the
   * provider must enforce `deny-all-except-proxy`), and its env points everything at it. Verified
   * before the job runs: the direct path must be closed and the proxy open, or the job is not
   * run. `listen` is the proxy as the provider's host reaches it.
   */
  proxy?: { listen: ProxyEndpoint; credential: AttemptCredential };
  /**
   * The value of GITHUB_TOKEN inside the job. The real token for a trusted class with no proxy
   * (the caller has registered it with `registry`), or a placeholder behind the proxy, which
   * attaches the real one.
   */
  githubToken?: string;
  /** GitHub's OIDC request variables for the steps; the token is a placeholder (see oidc/job-delivery). */
  oidc?: { requestUrl: string; requestToken: string };
  /** Seconds to wait for the sandbox's Docker daemon (a container-mode plan). Default 30. */
  dockerWaitSeconds?: number;
  /**
   * Hand-off (#761): when this aborts, the job stops watching at once and leaves everything as it
   * is for another controller to re-attach: the exec keeps running, the sandbox is not destroyed,
   * nothing is finished, and the log stops at its last checkpoint. Only a scheduler that releases
   * the lease right after sets it.
   */
  detach?: AbortSignal | undefined;
  /** Least time between two log checkpoints. Default 1000 ms. */
  checkpointMs?: number;
}

export interface JobOutcome {
  state: Verdict;
  exitCode: ExitCode;
  reason: string;
  /** act's exit code when it ran to the end. */
  actExitCode?: number;
  outputs?: Record<string, string>;
  /** For infra_error: the named kind, when one is known. */
  infraKind?: InfraKind;
  /** For infra_error: the underlying error's name and code (identifiers only), when known. */
  errorName?: string;
  errorCode?: string;
}

const enc = new TextEncoder();

/** Re-attach to an exec a dead controller started, instead of starting one. */
export interface ResumeFrom {
  sandboxId: string;
  execId: string;
  /**
   * The previous controller's log checkpoint (#761). With it the stored log is kept up to
   * `logOffset` and only the exec's output from `execOffset` on is rendered after it. Without it
   * the stored output is reset and the whole exec log replayed.
   */
  checkpoint?: { execOffset: number; logOffset: number } | undefined;
}

/** What `executeJob` returns for a run that was handed off (#761): no verdict, nothing finished. */
export const DETACHED = "detached for another controller";

/** act's stage as `attempt_steps` stores it. */
const storedStage = (stage: string): string =>
  stage === "Pre" ? "pre" : stage === "Post" ? "post" : "main";

/**
 * Runs one planned job in a fresh sandbox: streams redacted log text to `out` and the store
 * (with offsets), records steps, writes the job's final state, and always destroys the sandbox.
 *
 * With `resume` it re-attaches to the exec of a dead controller instead (`plan` is then only used
 * to tell the job's own events from stub-needs events and to read outputs; pass it when the job has
 * either): the store's output is reset, the whole exec log is replayed by offset, and the real
 * verdict is derived from it, even for a job that finished while nobody was watching.
 */
export async function executeJob(
  env: JobEnv,
  ids: JobIds,
  plan: JobPlan | undefined,
  resume?: ResumeFrom,
): Promise<JobOutcome> {
  const clean = (text: string): string => redactString(text, env.registry);

  const finish = async (
    state: Verdict,
    rawReason: string,
    code?: number,
    outputs?: Record<string, string>,
    infraKind?: InfraKind,
    detail?: ErrorDetail,
  ): Promise<JobOutcome> => {
    const reason = clean(rawReason);
    const exitCode =
      state === "success" ? 0 : state === "failure" ? (code && code !== 0 ? code : 1) : undefined;
    await env.store.finishJob(ids, state, {
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(state === "infra_error" ? { errorClass: reason.slice(0, 200) } : {}),
    });
    return {
      state,
      exitCode: EXIT[state],
      reason,
      ...(code !== undefined ? { actExitCode: code } : {}),
      ...(outputs ? { outputs } : {}),
      ...(state === "infra_error" && infraKind ? { infraKind } : {}),
      ...(state === "infra_error" && detail?.name ? { errorName: detail.name } : {}),
      ...(state === "infra_error" && detail?.code ? { errorCode: detail.code } : {}),
    };
  };

  const log = new LogPipe(env, ids.attemptId);
  const idle = setInterval(() => log.idleFlush(env.idleFlushMs ?? 1000), 250);
  if (!resume) for (const n of env.notices ?? []) log.push(`${n}\n`);

  const steps = new Map<string, StepRecord>();
  /** Steps the previous controller stored before its checkpoint, by `stepKey\0stage` (stored stage). */
  const kept = new Map<string, { index: number; startedAt?: number; logOffset: number }>();
  const hidden = new Set<string>();
  const watch = new MissingToolWatch();
  /**
   * `replay`: the event comes from output the stored log already holds (before the checkpoint).
   * It rebuilds the step map and the missing-tool watch, and writes nothing.
   */
  const onAct = (e: ActEvent, replay = false): void => {
    // The generated output-export step is plumbing, not part of the user's job.
    if ((e.type === "step-start" || e.type === "step-end") && e.name === EXPORT_STEP_NAME) {
      hidden.add(e.stepKey);
      return;
    }
    if ((e.type === "output" || e.type === "command") && hidden.has(e.stepKey)) return;
    if (e.type === "step-start") {
      const was = replay ? kept.get(`${e.stepKey}\0${storedStage(e.stage)}`) : undefined;
      const rec: StepRecord = {
        stepKey: e.stepKey,
        stage: e.stage,
        index: was?.index ?? steps.size,
        name: clean(stepLabel(e.name, e.stage)),
        startedAt: replay ? (was?.startedAt ?? Date.now()) : Date.now(),
        logOffset: was?.logOffset ?? log.stored,
      };
      steps.set(`${e.stepKey}\0${e.stage}`, rec);
      if (!replay) log.chain(() => env.store.recordStep(ids.attemptId, { ...rec }));
    } else if (e.type === "step-end") {
      const rec = steps.get(`${e.stepKey}\0${e.stage}`);
      if (rec) {
        rec.result = e.result;
        rec.endedAt = Date.now();
        if (e.durationMs !== undefined) rec.durationMs = e.durationMs;
        if (!replay) log.chain(() => env.store.recordStep(ids.attemptId, { ...rec }));
      }
    }
    const tool = watch.see(e);
    if (replay) return;
    log.push(renderEvent(e));
    // A failed step whose output ends in a shell "not found" says which tool the image lacks. The
    // result is act's, unchanged.
    if (tool) log.push(missingToolNotice(tool));
  };

  const settle = async (
    state: Verdict,
    reason: string,
    code?: number,
    outputs?: Record<string, string>,
    infraKind?: InfraKind,
    detail?: ErrorDetail,
  ): Promise<JobOutcome> => {
    clearInterval(idle);
    watch.clear();
    await log.close();
    return finish(state, reason, code, outputs, infraKind, detail);
  };

  // A resumed job owns the sandbox it re-attaches to from the start, so every exit destroys it.
  let sandboxId: string | undefined = resume?.sandboxId;
  // Handed off (#761): the sandbox and exec now belong to the next controller.
  let detached = false;
  const detachedP = new Promise<"detach">((resolve) => {
    if (env.detach?.aborted) resolve("detach");
    env.detach?.addEventListener("abort", () => resolve("detach"), { once: true });
  });
  let cancelled = env.signal?.aborted ?? false;
  // True while `provider.create` is in flight: a throw then is a sandbox that could not be made.
  let creating = false;
  const aborted = new Promise<"abort">((resolve) => {
    if (cancelled) resolve("abort");
    env.signal?.addEventListener("abort", () => {
      cancelled = true;
      resolve("abort");
    });
  });
  try {
    if (cancelled) return await settle("cancelled", "cancelled by user");
    let run;
    if (resume) {
      sandboxId = resume.sandboxId;
      const cp = resume.checkpoint;
      if (cp && env.store.truncateOutput) {
        // Keep what the previous controller stored up to its checkpoint; render only what follows.
        for (const st of await env.store.truncateOutput(ids.attemptId, cp.logOffset)) {
          kept.set(`${st.stepKey}\0${st.stage}`, st);
        }
        log.resumeAt(cp.execOffset, cp.logOffset);
      } else {
        await env.store.resetOutput?.(ids.attemptId);
      }
      run = resumeJob(
        env.provider,
        resume.sandboxId,
        resume.execId,
        {
          pollMs: env.pollMs ?? 500,
          ...(cp && env.store.truncateOutput ? { replayBefore: cp.execOffset } : {}),
        },
        plan,
      );
    } else {
      if (!plan || !env.image || !env.repoTarball) {
        throw new Error("plan, image and repoTarball are required to start a job");
      }
      const proxied = env.proxy;
      const pick = proxied
        ? proxyEgress(env.provider.info.network.egressPolicy, proxied.listen)
        : undefined;
      if (proxied && pick === undefined) {
        return await settle(
          "infra_error",
          `provider ${env.provider.info.name} cannot confine a sandbox to the secrets proxy; the job was not run`,
        );
      }
      const ttlSeconds = (env.timeoutSeconds ?? 3600) + 900;
      creating = true;
      const sb = await env.provider.create({
        name: `tt-run-${ids.attemptId.toLowerCase()}`,
        labels: { "turntable.run": ids.runId, "turntable.job": ids.jobId },
        // A realised class's image (the operator's, per provider) beats the runner's default image.
        image: env.sandbox?.image ?? env.image,
        ...(env.sandbox?.resources ? { resources: env.sandbox.resources } : {}),
        // The project's snapshot (set by the instance operator) beats a size class's, which beats the provider's.
        ...((env.snapshot ?? env.sandbox?.snapshot)
          ? { snapshot: (env.snapshot ?? env.sandbox?.snapshot) as string }
          : {}),
        ttlSeconds,
        network:
          proxied && pick
            ? { egress: pick, proxy: proxied.listen }
            : { egress: env.egress ?? "none" },
      });
      creating = false;
      processCreateStats.record(env.provider.info.name, false);
      sandboxId = sb.id;
      // A provider with its own cap (Daytona) may end the sandbox sooner than asked: that is how
      // long it can outlive the attempt, so the quota grace follows it.
      const cap = env.provider.info.ttlSeconds;
      await env.store.setSandbox(
        ids.attemptId,
        sb.id,
        Date.now(),
        cap === undefined ? undefined : Math.min(ttlSeconds, cap),
      );
      // `provider.create` takes no signal, so a stop (a drain cut, a cancel) that landed while it
      // ran is seen only now: settle before anything is uploaded or act starts, so a cut attempt
      // provably never ran a step (#784).
      if (cancelled) return await settle("cancelled", "cancelled by user");
      let proxyUrl: string | undefined;
      if (proxied) {
        if (!sb.proxy) {
          return await settle(
            "infra_error",
            "the provider did not say how the sandbox reaches the proxy; the job was not run",
          );
        }
        proxyUrl = proxied.credential.proxyUrl(sb.proxy.host, sb.proxy.port);
        // The credential is the job's own, but it is not for the log.
        env.registry.register(proxied.credential.password);
        // Direct path closed, proxy path open, verified from inside; anything else is no run.
        const direct = await probeEgress(env.provider, sb.id, {
          ...(env.pollMs ? { pollMs: env.pollMs } : {}),
          signal: env.signal,
        });
        if (direct.kind !== "blocked") {
          return await settle(
            "infra_error",
            direct.kind === "reachable"
              ? `proxy canary: the sandbox reached ${direct.target} without the proxy; the job was not run`
              : `proxy canary could not verify isolation (${direct.why}); the job was not run`,
          );
        }
        // The host's address on the sandbox's own network must be closed too: a listener on the
        // host (the proxy's own port included) is not a way around the proxy's rules.
        // Fail closed: a provider that cannot name what must be closed cannot be trusted to have
        // closed it.
        if (!sb.mustNotReach || sb.mustNotReach.length === 0) {
          return await settle(
            "infra_error",
            "the provider did not name the host addresses to verify closed; the job was not run",
          );
        }
        const host = await probeEgress(env.provider, sb.id, {
          targets: sb.mustNotReach,
          ...(env.pollMs ? { pollMs: env.pollMs } : {}),
          signal: env.signal,
        });
        if (host.kind !== "blocked") {
          return await settle(
            "infra_error",
            host.kind === "reachable"
              ? `proxy canary: the sandbox reached the host at ${host.target}; the job was not run`
              : `proxy canary could not verify host isolation (${host.why}); the job was not run`,
          );
        }
        const via = await probeProxy(env.provider, sb.id, sb.proxy, {
          ...(env.pollMs ? { pollMs: env.pollMs } : {}),
          signal: env.signal,
        });
        if (via.kind !== "open") {
          return await settle(
            "infra_error",
            `proxy canary: the sandbox cannot reach the proxy (${via.why}); the job was not run`,
          );
        }
      }
      // A job that holds a secret is always probed, whatever `canary` says, and an answer the probe
      // cannot give refuses it (below).
      if (!proxied && (env.canary || env.secretBearing) && (env.egress ?? "none") === "none") {
        const v = await probeEgress(env.provider, sb.id, {
          ...(env.pollMs ? { pollMs: env.pollMs } : {}),
          signal: env.signal,
        });
        if (v.kind === "reachable") {
          return await settle(
            "infra_error",
            `egress canary: the sandbox reached ${v.target} although egress is none; the job was not run`,
          );
        }
        if (v.kind === "unknown") {
          if (env.secretBearing) {
            return await settle(
              "infra_error",
              `egress canary could not verify isolation (${v.why}); a job with secrets was not run`,
            );
          }
          log.push(
            `[turntable] egress canary could not run (${v.why}); egress none is unverified\n`,
          );
        }
      }
      run = runJob(
        env.provider,
        sb.id,
        plan,
        {
          repoTarball: env.repoTarball,
          ...(proxied && proxyUrl
            ? { proxy: { url: proxyUrl, caPem: proxied.credential.caPem } }
            : {}),
          ...(env.githubToken !== undefined ? { githubToken: env.githubToken } : {}),
          ...(env.oidc ? { oidc: env.oidc } : {}),
          ...(plan.docker
            ? {
                docker: {
                  egress: env.egress ?? "none",
                  ...(env.dockerWaitSeconds !== undefined
                    ? { waitSeconds: env.dockerWaitSeconds }
                    : {}),
                },
              }
            : {}),
          ...(env.act ? { act: env.act } : {}),
          ...(env.fetchAction ? { fetchAction: env.fetchAction } : {}),
        },
        {
          pollMs: env.pollMs ?? 500,
          ...(env.timeoutSeconds ? { timeoutSeconds: env.timeoutSeconds } : {}),
          // As soon as the exec exists, record it: a restarted controller needs it to re-attach.
          onExec: ({ execId }) => env.store.setExec?.(ids.attemptId, execId) ?? Promise.resolve(),
        },
      );
    }
    for (;;) {
      const next = await Promise.race([run.next(), aborted, detachedP]);
      if (next === "detach") {
        // Stop here and leave the exec and sandbox to the next controller. The log ends at its last
        // checkpoint: what was written after it is rendered again by whoever re-attaches.
        detached = true;
        void run.return({ state: "infra_error", reason: DETACHED });
        clearInterval(idle);
        watch.clear();
        await log.detach();
        return { state: "cancelled", exitCode: EXIT.cancelled, reason: DETACHED };
      }
      if (next === "abort") {
        void run.return({ state: "infra_error", reason: "cancelled" });
        return await settle("cancelled", "cancelled by user");
      }
      if (next.done) {
        const r = next.value;
        return await settle(r.state, r.reason, r.exitCode, r.outputs, r.infraKind);
      }
      const ev = next.value;
      if (ev.kind === "act") onAct(ev.event, ev.replay === true);
      else if (ev.kind === "cut" && !ev.replay) log.cut(ev.omittedBytes);
      else if (ev.kind === "mark") log.mark(ev.offset, env.checkpointMs ?? 1000);
    }
  } catch (e) {
    if (cancelled) return await settle("cancelled", "cancelled by user");
    const message = e instanceof Error ? e.message : String(e);
    if (creating) processCreateStats.record(env.provider.info.name, isCreateTimeout(message));
    return await settle(
      "infra_error",
      message,
      undefined,
      undefined,
      // A sandbox that vanished before it could be reached (Daytona: "failed to resolve container
      // IP ... Is the Sandbox started?", #814) is a lost sandbox, not an unknown error.
      creating
        ? "sandbox_create_failed"
        : isSandboxLostMessage(message)
          ? "sandbox_lost"
          : "unknown",
      errorDetailOf(e),
    );
  } finally {
    clearInterval(idle);
    if (sandboxId && !detached) {
      try {
        await env.provider.destroy(sandboxId);
        // Confirmed gone: the sandbox's billed life ends here. A destroy that failed records
        // nothing, so the time is never guessed (the provider's TTL ended it).
        await env.store.setSandboxDestroyed?.(ids.attemptId, Date.now());
      } catch (e) {
        env.out(`warning: could not destroy sandbox ${sandboxId}: ${String(e)}\n`);
      }
    }
  }
}

const OUTPUT_KEEP = 8 * 1024;

/**
 * Finds the tool a failed step's image lacks, from a bounded tail of what the step printed. Output
 * can arrive after the step's end, so the tail of a failed step is kept until `clear`, and the tool
 * is reported at most once per step whichever order the events come in.
 */
export class MissingToolWatch {
  readonly #tails = new Map<string, string>();
  readonly #failed = new Set<string>();
  readonly #noticed = new Set<string>();

  /** Feeds one event; returns the missing tool to announce, once per step. */
  see(e: ActEvent): string | undefined {
    if (e.type === "output") {
      if (this.#noticed.has(e.stepKey)) return undefined;
      const kept = this.#tails.get(e.stepKey) ?? "";
      // The tail is what shows the last error; keep a bounded window of it.
      this.#tails.set(e.stepKey, `${kept}${e.text}`.slice(-OUTPUT_KEEP));
      return this.#failed.has(e.stepKey) ? this.#check(e.stepKey) : undefined;
    }
    if (e.type !== "step-end") return undefined;
    if (e.result !== "failure") {
      this.#tails.delete(e.stepKey);
      return undefined;
    }
    this.#failed.add(e.stepKey);
    return this.#noticed.has(e.stepKey) ? undefined : this.#check(e.stepKey);
  }

  /** Drops every tail; call when the job settles. */
  clear(): void {
    this.#tails.clear();
    this.#failed.clear();
    this.#noticed.clear();
  }

  #check(key: string): string | undefined {
    const tool = missingTool(this.#tails.get(key) ?? "");
    if (!tool) return undefined;
    this.#noticed.add(key);
    this.#tails.delete(key);
    return tool;
  }
}

const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 19);

/** The line that stands in the stored log for output that could not be retrieved. UTC times. */
export function cutMarker(
  bytes: number,
  fromMs: number,
  toMs: number,
  reason: string,
  atLineStart: boolean,
): string {
  return `${atLineStart ? "" : "\n"}[turntable] ${bytes} bytes of output from ${clock(fromMs)} to ${clock(toMs)} could not be retrieved: ${reason}\n`;
}

/** Redacts text, shows it, and stores it in order with byte offsets (offsets of what is stored). */
export class LogPipe {
  stored = 0;
  #redactor: Redactor;
  readonly #env: JobEnv;
  readonly #attemptId: string;
  #lastPush = Date.now();
  #atLineStart = true;
  #writes: Promise<void> = Promise.resolve();

  /** The last clean point (#761): exec offset and stored length, and the last one recorded. */
  #clean: { exec: number; log: number } | undefined;
  #recorded: { exec: number; at: number } | undefined;

  constructor(env: JobEnv, attemptId: string) {
    this.#redactor = new Redactor({ registry: env.registry });
    this.#env = env;
    this.#attemptId = attemptId;
  }

  /** Continues a stored log from a checkpoint: the next byte is written at `logOffset`. */
  resumeAt(execOffset: number, logOffset: number): void {
    this.stored = logOffset;
    this.#clean = { exec: execOffset, log: logOffset };
    this.#recorded = { exec: execOffset, at: Date.now() };
  }

  /**
   * The exec's output before `execOffset` has all been pushed (#761). When nothing is held for
   * redaction, the stored log up to `stored` is exactly its rendering: a checkpoint. Recorded in
   * order with the log writes, at most once per `everyMs`.
   */
  mark(execOffset: number, everyMs: number): void {
    if (this.#redactor.holding) return;
    this.#clean = { exec: execOffset, log: this.stored };
    const last = this.#recorded;
    if (last && (last.exec === execOffset || Date.now() - last.at < everyMs)) return;
    this.#record();
  }

  #record(): void {
    const cp = this.#clean;
    if (!cp || !this.#env.store.setLogCheckpoint) return;
    if (this.#recorded?.exec === cp.exec) return;
    this.#recorded = { exec: cp.exec, at: Date.now() };
    this.chain(() => this.#env.store.setLogCheckpoint!(this.#attemptId, cp.exec, cp.log));
  }

  /**
   * Hand-off: records the last clean point and waits for every pending write. What the redactor
   * holds is dropped, never flushed: it is past the checkpoint, so the next controller renders it.
   */
  async detach(): Promise<void> {
    this.#record();
    await this.#writes;
  }

  push(text: string): void {
    this.#lastPush = Date.now();
    this.#emit(this.#redactor.push(text));
  }

  idleFlush(afterMs: number): void {
    if (Date.now() - this.#lastPush >= afterMs) this.#emit(this.#redactor.flushIdle());
  }

  chain(fn: () => Promise<void>): void {
    this.#writes = this.#writes.then(fn);
  }

  /**
   * Records, as metadata at the current position of the stored log, that `omittedBytes` of output
   * were dropped, and writes a marker line after it so a reader of the text sees the gap too
   * (the log is never silently short). The metadata (`log_cuts`, `log_incomplete`) is the
   * authoritative record: a job can print the same words, which only makes a false alarm. What
   * was held for redaction is flushed first and redaction starts afresh after the cut, so text
   * from either side of the gap is never joined.
   */
  cut(omittedBytes: number, reason = "output cap"): void {
    const from = this.#lastPush;
    this.#emit(this.#redactor.end());
    this.#redactor = new Redactor({ registry: this.#env.registry });
    const atOffset = this.stored;
    this.chain(
      () =>
        this.#env.store.addCut?.(this.#attemptId, {
          atOffset,
          omittedBytes,
          reason,
        }) ?? Promise.resolve(),
    );
    const why =
      reason === "output cap"
        ? "the sandbox kept only the first and last part of the output (output cap)"
        : reason;
    this.#emit(cutMarker(omittedBytes, from, Date.now(), why, this.#atLineStart));
  }

  /** Flushes the held tail and waits for every pending write. */
  async close(): Promise<void> {
    this.#emit(this.#redactor.end());
    await this.#writes;
  }

  #emit(text: string): void {
    if (text === "") return;
    this.#env.out(text);
    this.#atLineStart = text.endsWith("\n");
    const bytes = enc.encode(text);
    const at = this.stored;
    this.stored += bytes.length;
    this.chain(() => this.#env.store.appendLog(this.#attemptId, at, bytes));
  }
}

/**
 * The confinement a proxied job asks its provider for. The strict one, whenever the provider has
 * it, unless the proxy endpoint has no stable address and the provider also offers the
 * domain-filtered one (which its operator enabled on purpose): then that. A provider with neither
 * cannot run a proxied job.
 */
export function proxyEgress(
  offered: readonly string[],
  listen: { addresses?: readonly string[] | undefined },
): "deny-all-except-proxy" | "proxy-domain-filtered" | undefined {
  const hasAddresses = (listen.addresses?.length ?? 0) > 0;
  if (!hasAddresses && offered.includes("proxy-domain-filtered")) return "proxy-domain-filtered";
  if (offered.includes("deny-all-except-proxy")) return "deny-all-except-proxy";
  return undefined;
}
