import type { SafeFetch } from "@turntable/net";
import {
  FileTooLargeError,
  InfraError,
  SandboxNotFoundError,
  SpecError,
  createWrappedExec,
  readCapped,
  shellQuote,
  parsePinnedImage,
  type ClassRealisation,
  type ImageRegistration,
  type ImageRegistrationRequest,
  type Labels,
  type ProviderClassSettings,
  type SandboxResources,
  type Provider,
  type ProviderCheck,
  type ProviderInfo,
  type SandboxHandle,
  type SandboxInfo,
  type SandboxSpec,
  type ShellRunner,
  type WrappedExecOptions,
} from "@turntable/provider-sdk";
import {
  type DaytonaSandbox,
  DaytonaApi,
  DaytonaKeyRejectedError,
  DaytonaQuotaExceededError,
  DEFAULT_BASE_URL,
  readJson,
} from "./api";
import {
  mustNotReachFor,
  networkSettingFor,
  type NetworkSetting,
  RELAY_JS,
  RELAY_PORT,
} from "./relay";
import type { ApiKeySource } from "./key";
import {
  DEFAULT_ORG_CLASS,
  DEFAULT_ORG_CPU_LIMIT,
  DEFAULT_SANDBOX_DISK_GIB,
  DEFAULT_SANDBOX_MEM_GIB,
  orgUsage,
  DEFAULT_ORG_REGION,
  type OwnerCiPreflight,
  type RegionUsageRow,
  LIVE_STATES,
  MAX_TTL_SECONDS,
  OWN_LABEL_VALUE,
  RUN_LABEL,
  clampMaxLive,
  type OwnerCiLabels,
  isForeignCi,
  isLive,
  makeFleet,
  type Fleet,
} from "./policy";

export type UsageRecord = {
  sandboxId: string;
  name: string;
  /** Epoch ms from Daytona's createdAt (or our create call when missing). */
  createdAt: number;
  destroyedAt: number;
  seconds: number;
};

export interface DaytonaProviderOptions {
  /** Where to read the API key at runtime: a file path, an env var name, or a function. */
  apiKey: ApiKeySource;
  baseUrl?: string;
  /** Run id stamped on every sandbox as the `turntable-run` label unless the spec already has one. */
  runId?: string;
  /** Live sandboxes of ours at once. Default 2, never above the hard ceiling. */
  maxLive?: number;
  /**
   * Limits read at each create instead of fixed at construction (#661): the server's settings
   * registry feeds them, so an operator changes them with no restart. A value here beats
   * `maxLive` and `ownerCiPreflight.cpuLimit`; an absent one falls back to them. Still clamped to
   * the hard ceiling. Lowering one never stops a running sandbox: it only holds new creates.
   */
  limits?: () => { maxLive?: number | undefined; cpuLimit?: number | undefined };
  /** Daytona target (region). Omit for the account default. */
  target?: string;
  /**
   * Name of an EXISTING snapshot to start from. This provider never creates snapshots. When a
   * spec also names an `image` (the scheduler always does), the snapshot is used and the image
   * name is ignored: the operator chose what runs, and an image build would create a snapshot.
   * With no snapshot (and no `allowImageBuild`), the image name is ignored too and Daytona starts
   * from the account's default snapshot.
   */
  snapshot?: string;
  /**
   * Allow `spec.image` by asking Daytona to build it. A build creates a snapshot in the account,
   * which the customer-account rules forbid, so it is off by default and must be switched on
   * deliberately.
   */
  allowImageBuild?: boolean;
  /** Longest TTL a sandbox may have, in seconds. Default and ceiling: 1800 (30 minutes). */
  maxTtlSeconds?: number;
  /**
   * What to do with a spec asking for more than `maxTtlSeconds`: refuse it (default, the safe
   * choice for library use) or clamp it, so a scheduler that asks for job timeout plus slack
   * still runs, with the sandbox reaped at the cap.
   */
  clampTtl?: boolean;
  /** Per-file byte cap. Default 64 MiB. */
  maxFileBytes?: number;
  exec?: WrappedExecOptions;
  /** How long to wait for capacity (our own cap or the owner's CI) before giving up. Default 20 min. */
  capacityWaitMs?: number;
  /**
   * The org-wide CPU check before each create (see OwnerCiPreflight). On by default with the
   * defaults; `false` turns it off. If the account has no sandbox to learn the org id from, or the
   * usage endpoint does not exist (404), the check is skipped and the label count still applies.
   */
  ownerCiPreflight?: OwnerCiPreflight | false;
  /**
   * How the account's capacity is judged. `org-usage` (the default) reads the org's CPU in use and
   * needs a key that may read `/organizations/<id>/usage`; if Daytona answers that read with 403
   * (a customer-scoped key with sandbox write and delete only) it falls back to `own-fleet` and
   * says so once. `own-fleet` never reads the org: it counts our own live sandboxes by our label
   * and waits while that is `maxLive` or more. Only a 403 falls back; any other failure of the
   * read (404, 5xx, network, an unreadable body) still refuses the create.
   */
  quotaMode?: "org-usage" | "own-fleet";
  /**
   * How the account owner's CI sandboxes are recognised (a label key and its values). Default:
   * none, so no label check. It only matters together with `ownerCiLabelWaitAt`.
   */
  ownerCiLabels?: OwnerCiLabels;
  /**
   * Wait while this many of the labelled CI sandboxes hold quota. Default: off. The org CPU check
   * (`ownerCiPreflight`) is the gate that does not need to know anyone's labels.
   */
  ownerCiLabelWaitAt?: number;
  /**
   * This instance's fleet in a shared account: the label `<fleet>=1` and the name prefix
   * `<fleet>-`. Everything that counts, lists, verifies or deletes sandboxes is limited to it, so
   * instances with different fleets (a dev machine and a hosted shadow) never touch each other's
   * sandboxes or count against each other's `maxLive`. Lower case, starts with `turntable-`, at
   * most 30 characters. Default `longshore-dev`.
   */
  fleet?: string;
  /** The interpreter that runs the proxy relay in a proxied sandbox. Default `node`. */
  relayInterpreter?: string;
  /**
   * Allow confining a sandbox to the proxy by a domain list. Daytona enforces it on the TLS server
   * name and HTTP Host header, which holds in the measured behaviour but rests on its filter
   * parsing the first bytes correctly, unlike the address allow list. Off by default; on, the
   * provider also offers the weaker `proxy-domain-filtered` policy (never `deny-all-except-proxy`).
   */
  allowDomainListConfinement?: boolean;
  /** The relay's port on the sandbox's loopback. Default 3128. */
  relayPort?: number;
  /** Test seam: a CA the relay trusts for the proxy endpoint, instead of the system roots. */
  proxyTlsCaPem?: string;
  /** Poll interval while waiting for capacity or for a sandbox to start. Default 5 s. */
  pollMs?: number;
  /** How long a sandbox may take to reach `started`. Default 3 min. */
  startTimeoutMs?: number;
  /** Called after a sandbox is deleted, so callers can account for minutes used. */
  onUsage?: (r: UsageRecord) => void;
  /** Debug log (retries, with the call and attempt; never a URL with a token). Default silent. */
  log?: (message: string) => void;
  fetch?: SafeFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const dec = new TextDecoder();

/** Cap on one exec reply from the sandbox (framed, base64). */
const EXEC_REPLY_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Runs argv inside the sandbox and returns binary-safe stdout, stderr and the exit code. Daytona's
 * execute call returns one text string, so the command writes each stream to a temp file and
 * prints them base64-encoded between markers.
 */
const FRAME_SH =
  'O=$(mktemp) || exit 125; E=$(mktemp) || exit 125; "$@" >"$O" 2>"$E" </dev/null; C=$?; ' +
  'echo "tt-ec $C"; echo tt-out; base64 <"$O" | tr -d "\\n"; echo; echo tt-err; base64 <"$E" | tr -d "\\n"; echo; ' +
  'rm -f "$O" "$E"';

function unframe(result: string): { exitCode: number; stdout: Uint8Array; stderr: Uint8Array } {
  const lines = result.split("\n");
  const ec = lines.findIndex((l) => l.startsWith("tt-ec "));
  const out = lines.indexOf("tt-out", ec);
  const err = lines.indexOf("tt-err", out);
  if (ec < 0 || out < 0 || err < 0)
    throw new InfraError("Daytona exec: unexpected reply from the sandbox");
  const code = Number(lines[ec]!.slice(6));
  if (!Number.isInteger(code)) throw new InfraError("Daytona exec: bad exit code in reply");
  const b64 = (s: string | undefined): Uint8Array =>
    Uint8Array.from(Buffer.from(s ?? "", "base64"));
  return { exitCode: code, stdout: b64(lines[out + 1]), stderr: b64(lines[err + 1]) };
}

/** What one new sandbox takes from the org's quotas. */
interface SandboxNeed {
  cpu: number;
  memGiB: number;
  diskGiB: number;
}

type OrgRoom =
  | { ok: true }
  | {
      ok: false;
      resource: "cpu" | "disk" | "memory";
      used: number;
      limit: number;
      need: number;
      unit: string;
    };

/** Daytona's snapshot state as ours: only `active` starts sandboxes; stopped or removing ones do not. */
function snapshotState(s: string | undefined): "pending" | "ready" | "unavailable" {
  if (s === "active") return "ready";
  if (s === "inactive" || s === "removing") return "unavailable";
  return "pending";
}

export class DaytonaProvider implements Provider {
  readonly info: ProviderInfo;
  readonly exec: Provider["exec"];
  readonly files: Provider["files"];
  /** Verified ids -> toolbox base URL. Only sandboxes proven to be ours are ever acted on. */
  private readonly known = new Map<string, string>();
  private readonly api: DaytonaApi;
  private readonly runId: string;
  private readonly staticMaxLive: number;
  private readonly maxFileBytes: number;
  private readonly maxTtl: number;
  private readonly capacityWaitMs: number;
  private readonly pollMs: number;
  private readonly startTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /**
   * The sandboxes we created (or were told about at boot) and have not confirmed gone. This is the
   * own-fleet count's source: Daytona's listings cannot be trusted (a label-filtered list returns
   * nothing for new sandboxes, the unfiltered list shows deleted ones as started), only a get by
   * id is accurate. An id leaves the set only when a get says it is gone (or not ours).
   */
  private readonly recorded = new Set<string>();
  /** Serialises create() so the capacity check and the create cannot interleave in this process. */
  private createChain: Promise<unknown> = Promise.resolve();

  private readonly opts: DaytonaProviderOptions;

  /** The fleet whose sandboxes are ours (see policy.ts). */
  readonly fleet: Fleet;

  /** The live-sandbox ceiling now: the live limit when one is given, else the configured one. */
  private get maxLive(): number {
    const live = this.opts.limits?.().maxLive;
    return live === undefined ? this.staticMaxLive : clampMaxLive(live);
  }

  /** The org CPU limit now: the live limit, else `ownerCiPreflight.cpuLimit`, else the default. */
  private get cpuLimit(): number {
    const o = this.opts.ownerCiPreflight;
    return (
      this.opts.limits?.().cpuLimit ?? (o === false ? 0 : o?.cpuLimit) ?? DEFAULT_ORG_CPU_LIMIT
    );
  }

  constructor(opts: DaytonaProviderOptions) {
    this.opts = opts;
    this.api = new DaytonaApi({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    this.runId = opts.runId ?? crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    this.fleet = makeFleet(opts.fleet);
    this.staticMaxLive = clampMaxLive(opts.maxLive);
    const ttl = opts.maxTtlSeconds ?? MAX_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > MAX_TTL_SECONDS) {
      throw new RangeError(`maxTtlSeconds must be 60 to ${MAX_TTL_SECONDS}`);
    }
    this.maxTtl = ttl;
    this.maxFileBytes = opts.maxFileBytes ?? 64 * 1024 * 1024;
    this.capacityWaitMs = opts.capacityWaitMs ?? 20 * 60_000;
    this.pollMs = opts.pollMs ?? 5000;
    this.startTimeoutMs = opts.startTimeoutMs ?? 180_000;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
    this.now = opts.now ?? Date.now;

    // Declared only what has been exercised against the real service (see docs/providers.mdx).
    this.info = {
      name: "daytona",
      // Verified live: sandboxes report `sandboxClass: container`. The `linux-vm` class exists but
      // has not been exercised, so no stronger level is claimed.
      isolation: "container",
      createFrom: ["snapshot"],
      exec: { detached: true, logsByOffset: true, streaming: false, tty: false },
      files: { upload: true, download: true, maxBytes: this.maxFileBytes },
      network: {
        // The strict policy needs the endpoint's addresses (checked per create); the domain-filtered
        // one is offered only when the operator has opted in.
        egressPolicy: [
          "none",
          "open",
          "deny-all-except-proxy",
          ...(opts.allowDomainListConfinement ? (["proxy-domain-filtered"] as const) : []),
        ],
        ingress: false,
        proxyReachability: true,
      },
      resources: { cpus: true, memoryMb: true, diskGb: true },
      ttl: true,
      ttlSeconds: this.maxTtl,
      labels: true,
      list: true,
      listByLabel: true,
      // Documented by Daytona (Docker-in-Docker in a sandbox). Whether a given class can do it is
      // the operator's snapshot; the job's `docker info` preflight is the check that counts.
      dockerInSandbox: true,
      os: ["linux"],
      arch: ["amd64"],
      cost: "none",
    };

    const runner: ShellRunner = {
      run: async (id, argv, { timeoutMs }) => {
        const base = await this.toolbox(id);
        const command = `sh -c ${shellQuote(FRAME_SH)} tt ${argv.map(shellQuote).join(" ")}`;
        const res = await this.toolboxCall(id, base, "POST", "/process/execute", {
          json: { command, timeout: Math.max(1, Math.ceil(timeoutMs / 1000)) },
          timeoutMs: timeoutMs + 15_000,
        });
        // An exec reply is a framed, base64 copy of at most a log chunk; bound it regardless.
        const body = await readJson<{ exitCode?: number; result?: string }>(
          res,
          EXEC_REPLY_MAX_BYTES,
        );
        if (typeof body.result !== "string") throw new InfraError("Daytona exec: empty reply");
        return unframe(body.result);
      },
    };
    // The toolbox is slow to answer while a heavy job runs, so a status or log read gets longer than
    // the generic default before it counts as a timeout, and a transient failure of one is retried
    // for a few minutes (never the launch itself without checking: see wrapped-exec).
    this.exec = createWrappedExec(runner, {
      commandTimeoutMs: 120_000,
      ...opts.exec,
      retry: {
        sleep: this.sleep,
        now: this.now,
        onRetry: (what, attempt, error) =>
          opts.log?.(`daytona ${what}: attempt ${attempt} failed, retrying: ${error.message}`),
        ...opts.exec?.retry,
      },
    });

    this.files = {
      put: async (id, path, bytes) => {
        if (bytes.length > this.maxFileBytes) {
          throw new FileTooLargeError(`${bytes.length} bytes exceeds ${this.maxFileBytes}`);
        }
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".";
        const mk = await runner.run(id, ["mkdir", "-p", dir], { timeoutMs: 30_000 });
        if (mk.exitCode !== 0)
          throw new SpecError(`put: cannot create ${dir}: ${dec.decode(mk.stderr).trim()}`);
        const base = await this.toolbox(id);
        const form = new FormData();
        form.set("file", new Blob([bytes as unknown as ArrayBuffer]), "upload");
        await this.toolboxCall(id, base, "POST", "/files/upload-v2", {
          query: { path },
          form,
          timeoutMs: 120_000,
        });
      },
      get: async (id, path, maxBytes) => {
        const base = await this.toolbox(id);
        let res: Response;
        try {
          res = await this.toolboxCall(id, base, "GET", "/files/download", {
            query: { path },
            timeoutMs: 120_000,
          });
        } catch (e) {
          // A 404 here can mean the file, not the sandbox: tell them apart.
          if (e instanceof SandboxNotFoundError) {
            await this.verify(id, true);
            throw new SpecError(`get: no such file: ${path}`);
          }
          throw e;
        }
        // Stream with a running count: a big or lying response never gets buffered past maxBytes.
        return readCapped(res, maxBytes);
      },
    };
  }

  // ---- ownership ----

  /**
   * Proves a sandbox is ours (label and name prefix) before anything is done to it, and returns
   * its toolbox URL. A missing sandbox throws SandboxNotFoundError; a foreign one SpecError.
   */
  private async verify(id: string, fresh = false): Promise<string> {
    const cached = this.known.get(id);
    if (cached && !fresh) return cached;
    const sb = await this.api.json<DaytonaSandbox>("GET", `/sandbox/${encodeURIComponent(id)}`);
    if (!this.fleet.isOwn(sb)) {
      throw new SpecError(
        `refusing to touch sandbox ${id}: it is not labelled ${this.fleet.label}=${OWN_LABEL_VALUE}`,
      );
    }
    if (!sb.toolboxProxyUrl) throw new InfraError("Daytona sandbox has no toolbox URL");
    const base = `${sb.toolboxProxyUrl.replace(/\/+$/, "")}/${encodeURIComponent(sb.id)}`;
    this.known.set(id, base);
    return base;
  }

  private async toolbox(id: string): Promise<string> {
    return this.verify(id);
  }

  private async toolboxCall(
    id: string,
    base: string,
    method: string,
    path: string,
    init: { json?: unknown; form?: FormData; query?: Record<string, string>; timeoutMs: number },
  ): Promise<Response> {
    try {
      return await this.api.request(method, `${base}${path}`, init);
    } catch (e) {
      if (e instanceof SandboxNotFoundError) {
        // The toolbox said 404: the sandbox itself may be gone. Re-check before saying so.
        this.known.delete(id);
        await this.verify(id);
      }
      throw e;
    }
  }

  // ---- capacity ----

  private async listAll(
    query: Record<string, string | readonly string[] | undefined>,
  ): Promise<DaytonaSandbox[]> {
    const out: DaytonaSandbox[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 200; page++) {
      const r = await this.api.json<{ items?: DaytonaSandbox[]; nextCursor?: string | null }>(
        "GET",
        "/sandbox",
        {
          query: { limit: 200, ...query, ...(cursor ? { cursor } : {}) },
        },
      );
      out.push(...(r.items ?? []));
      if (!r.nextCursor) return out;
      cursor = r.nextCursor;
    }
    throw new InfraError("Daytona: sandbox listing did not end");
  }

  /**
   * Tells the provider about sandboxes it should own from before this process started (the core
   * reads them from attempts that recorded a sandbox and no confirmed destroy). Nothing is
   * trusted yet: each id is confirmed with a get on its first use, and one that is gone or not
   * ours is dropped there.
   */
  adopt(ids: readonly string[]): void {
    for (const id of ids) if (/^[A-Za-z0-9_-]{1,128}$/.test(id)) this.recorded.add(id);
  }

  /** What the count is made from, for status and logs. */
  private countingMode(): { mode: "recorded-ids"; tracked: number } {
    return { mode: "recorded-ids", tracked: this.recorded.size };
  }

  /**
   * The state of each recorded sandbox, by get (the only accurate read). A sandbox that is gone
   * or destroyed, or does not carry our label, leaves the set. Any other failure is thrown: an
   * unreadable fleet is never taken for an empty one.
   */
  private async recordedSandboxes(): Promise<DaytonaSandbox[]> {
    const out = await Promise.all(
      [...this.recorded].map(async (id): Promise<DaytonaSandbox | undefined> => {
        try {
          const sb = await this.api.json<DaytonaSandbox>(
            "GET",
            `/sandbox/${encodeURIComponent(id)}`,
          );
          if (!this.fleet.isOwn(sb) || sb.state === "destroyed") {
            this.recorded.delete(id);
            this.known.delete(id);
            return undefined;
          }
          return sb;
        } catch (e) {
          if (e instanceof SandboxNotFoundError) {
            this.recorded.delete(id);
            this.known.delete(id);
            return undefined;
          }
          throw e;
        }
      }),
    );
    return out.filter((s): s is DaytonaSandbox => s !== undefined);
  }

  /**
   * Our live sandboxes: the recorded ones confirmed by get, plus strays a best-effort listing finds
   * (confirmed by get too). The listing can only add to the count, never lower it.
   */
  private async ownLive(): Promise<number> {
    return (await this.list({})).length;
  }

  /**
   * Counts the owner's own CI sandboxes that hold quota. Read only: they are never touched.
   * Only the states that hold quota are fetched, because an account can hold thousands of
   * stopped or archived sandboxes that use none.
   */
  private async foreignLive(): Promise<number> {
    // Off unless both the labels and a threshold are configured: no request is made.
    if (!this.opts.ownerCiLabels || this.opts.ownerCiLabelWaitAt === undefined) return 0;
    const live = await this.listAll({ states: LIVE_STATES });
    return live.filter((s) => !this.fleet.isOwn(s) && isForeignCi(s, this.opts.ownerCiLabels))
      .length;
  }

  private orgId: string | undefined;
  private warnedNoOrg = false;
  /** Set once the usage read answered 403: from then on the own-fleet budget is the only gate. */
  private usageForbidden = false;
  /** The limits the last usage check judged against, for capacityStatus(). */
  private readonly limitsUsed: {
    cpu?: number;
    diskGiB?: number | undefined;
    memGiB?: number | undefined;
    diskFrom?: string;
    memFrom?: string;
  } = {};

  /** What gates a create, for status and the logs. */
  capacityStatus(): {
    quotaMode: "off" | "org-usage" | "own-fleet";
    reason: string;
    maxLive: number;
    counting: { mode: "recorded-ids"; tracked: number };
    limits: {
      cpu: number;
      diskGiB: number | null;
      memGiB: number | null;
      diskFrom: string;
      memFrom: string;
    };
  } {
    const o = this.opts.ownerCiPreflight;
    const base = {
      maxLive: this.maxLive,
      counting: this.countingMode(),
      // What the org check judges against: the configured values until a usage read has said more.
      limits: {
        cpu: this.limitsUsed.cpu ?? (o === false ? 0 : this.cpuLimit),
        diskGiB: this.limitsUsed.diskGiB ?? (o === false ? null : (o?.diskLimitGiB ?? null)),
        memGiB: this.limitsUsed.memGiB ?? (o === false ? null : (o?.memLimitGiB ?? null)),
        diskFrom:
          this.limitsUsed.diskFrom ??
          (o !== false && o?.diskLimitGiB !== undefined ? "config" : "not read yet"),
        memFrom:
          this.limitsUsed.memFrom ??
          (o !== false && o?.memLimitGiB !== undefined ? "config" : "not read yet"),
      },
    };
    if (this.opts.ownerCiPreflight === false) {
      return { quotaMode: "off", reason: "ownerCiPreflight is false", ...base };
    }
    if (this.opts.quotaMode === "own-fleet") {
      return { quotaMode: "own-fleet", reason: "configured", ...base };
    }
    if (this.usageForbidden) {
      return { quotaMode: "own-fleet", reason: "org usage forbidden (403)", ...base };
    }
    return { quotaMode: "org-usage", reason: "default", ...base };
  }

  /**
   * The org's CPU in use against the limit: `{ ok: true }` when there is room for `vcpu` more (or
   * the check does not apply), else the reading. Reading errors are thrown: an unreadable usage is
   * never taken for room.
   */
  private async orgRoom(need: SandboxNeed): Promise<OrgRoom> {
    const o = this.opts.ownerCiPreflight;
    if (o === false) return { ok: true };
    // Own-fleet budget: the caller already waits while our live count is at maxLive.
    if (this.opts.quotaMode === "own-fleet" || this.usageForbidden) return { ok: true };
    const limit = this.cpuLimit;
    this.limitsUsed.cpu = limit;
    if (this.orgId === undefined) {
      const first = await this.api.json<{ items?: DaytonaSandbox[] }>("GET", "/sandbox", {
        query: { limit: 1 },
        timeoutMs: 20_000,
      });
      this.orgId = first.items?.find((s) => s.organizationId)?.organizationId;
    }
    // Nothing to learn the org from: an empty account has nobody else in it. The first sandbox we
    // create tells us the org id for the next create.
    if (this.orgId === undefined) {
      if (!this.warnedNoOrg) {
        this.warnedNoOrg = true;
        this.opts.log?.(
          "daytona: no sandbox in the account to learn the org id from, so the org usage check is skipped for this create",
        );
      }
      return { ok: true };
    }
    let usage: { regionUsage?: RegionUsageRow[] };
    try {
      usage = await this.api.json("GET", `/organizations/${encodeURIComponent(this.orgId)}/usage`, {
        timeoutMs: 20_000,
      });
    } catch (e) {
      // A key without the permission to read usage (403): the one failure that falls back, to
      // the own-fleet budget. A 401 is a bad key and still fails, like everything below.
      if (e instanceof DaytonaKeyRejectedError && e.status === 403) {
        this.usageForbidden = true;
        this.opts.log?.(
          `daytona: org usage forbidden (403); own-fleet budget mode, maxLive ${this.maxLive}`,
        );
        return { ok: true };
      }
      // Fail closed: a check that cannot be made is not a check that passed. An operator whose
      // deployment has no usage endpoint opts out with `ownerCiPreflight: false`.
      if (e instanceof SandboxNotFoundError) {
        throw new InfraError(
          "Daytona's org usage endpoint answered 404, so the org's CPU cannot be checked; not creating a sandbox (set ownerCiPreflight: false to run without the check)",
        );
      }
      throw e;
    }
    const u = orgUsage(
      usage.regionUsage,
      o?.region ?? DEFAULT_ORG_REGION,
      o?.sandboxClass ?? DEFAULT_ORG_CLASS,
    );
    if (u.cpu === undefined) throw new InfraError("Daytona usage reply has no CPU reading");
    if (u.cpu + need.cpu > limit) {
      return { ok: false, resource: "cpu", used: u.cpu, limit, need: need.cpu, unit: "vCPU" };
    }
    // Disk and memory: the configured limit, else the quota the reply reports, else not checked.
    // A reading the reply does not carry is skipped, never taken for room or for full.
    const diskLimit = o?.diskLimitGiB ?? u.quota.disk;
    const memLimit = o?.memLimitGiB ?? u.quota.mem;
    this.limitsUsed.diskGiB = diskLimit;
    this.limitsUsed.memGiB = memLimit;
    this.limitsUsed.diskFrom =
      o?.diskLimitGiB !== undefined
        ? "config"
        : u.quota.disk !== undefined
          ? "usage reply"
          : "none";
    this.limitsUsed.memFrom =
      o?.memLimitGiB !== undefined ? "config" : u.quota.mem !== undefined ? "usage reply" : "none";
    if (diskLimit !== undefined && u.disk !== undefined && u.disk + need.diskGiB > diskLimit) {
      return {
        ok: false,
        resource: "disk",
        used: u.disk,
        limit: diskLimit,
        need: need.diskGiB,
        unit: "GiB disk",
      };
    }
    if (memLimit !== undefined && u.mem !== undefined && u.mem + need.memGiB > memLimit) {
      return {
        ok: false,
        resource: "memory",
        used: u.mem,
        limit: memLimit,
        need: need.memGiB,
        unit: "GiB memory",
      };
    }
    return { ok: true };
  }

  /** Waits until we are under our own cap and the owner's CI is not busy, or gives up. */
  private async waitForCapacity(need: SandboxNeed): Promise<void> {
    const deadline = this.now() + this.capacityWaitMs;
    // With no threshold configured the label gate never holds (the count is 0 and never read).
    const foreignAt = this.opts.ownerCiLabelWaitAt ?? Number.POSITIVE_INFINITY;
    for (;;) {
      const [own, foreign, room] = await Promise.all([
        this.ownLive(),
        this.foreignLive(),
        this.orgRoom(need),
      ]);
      if (own < this.maxLive && foreign < foreignAt && room.ok) return;
      if (this.now() >= deadline) {
        if (!room.ok && own < this.maxLive && foreign < foreignAt) {
          throw new InfraError(
            room.resource === "cpu"
              ? `waited ${Math.round(this.capacityWaitMs / 1000)}s: the org has ${room.used} vCPU in use (waiting above ${room.limit}, this sandbox needs ${room.need})`
              : `waited ${Math.round(this.capacityWaitMs / 1000)}s: the org has ${room.used} of ${room.limit} ${room.unit} in use (this sandbox needs ${room.need})`,
          );
        }
        throw new InfraError(
          own >= this.maxLive
            ? `waited ${Math.round(this.capacityWaitMs / 1000)}s: already ${own} live sandboxes of ours (max ${this.maxLive})`
            : `waited ${Math.round(this.capacityWaitMs / 1000)}s: the account's CI has ${foreign} live sandboxes (waiting at ${foreignAt})`,
        );
      }
      await this.sleep(this.pollMs);
    }
  }

  // ---- Provider ----

  /**
   * Creates a Daytona snapshot from a digest-pinned registry image, with the instance's own key
   * (#809). Only the instance operator's `register_sandbox_image` calls it: sandboxes never create
   * snapshots. Daytona pulls the image by its digest once, here; a sandbox then starts from the
   * snapshot by name. A name that already exists is accepted only when it holds the same digest.
   */
  async registerImage(req: ImageRegistrationRequest): Promise<ImageRegistration> {
    const pinned = parsePinnedImage(req.image);
    if (!pinned) throw new SpecError("the image is not pinned by digest (repo@sha256:...)");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(req.name))
      throw new SpecError("a snapshot name is letters, digits, . _ - (up to 128)");
    const r = req.resources;
    const body: Record<string, unknown> = { name: req.name, imageName: req.image };
    if (r?.cpus !== undefined) body.cpu = r.cpus;
    if (r?.memoryMb !== undefined) body.memory = Math.max(1, Math.ceil(r.memoryMb / 1024));
    if (r?.diskGb !== undefined) body.disk = r.diskGb;
    type Snap = { name?: string; state?: string; imageName?: string };
    let snap: Snap;
    try {
      snap = await this.api.json<Snap>("POST", "/snapshots", { json: body, timeoutMs: 60_000 });
    } catch (e) {
      if (!(e instanceof SpecError && / 409 /.test(e.message))) throw e;
      snap = await this.api.json<Snap>("GET", `/snapshots/${encodeURIComponent(req.name)}`, {
        timeoutMs: 20_000,
      });
      if (parsePinnedImage(snap.imageName ?? "")?.digest !== pinned.digest)
        throw new SpecError(`snapshot ${req.name} already exists with another image`);
    }
    // A failed build is an answer, not a pending one: say so, so the operator sees it.
    if (snap.state === "error" || snap.state === "build_failed")
      throw new SpecError(`snapshot ${req.name} failed to build (state ${snap.state})`);
    return {
      name: req.name,
      digest: pinned.digest,
      state: snapshotState(snap.state),
    };
  }

  async healthcheck(): Promise<void> {
    await this.api.json("GET", "/sandbox", { query: { limit: 1 }, timeoutMs: 20_000 });
  }

  /**
   * Readiness checks that only read: the key, the account, the org usage endpoint the CPU check
   * relies on, and the snapshot a sandbox would start from. Nothing is created, started or
   * deleted, and no output carries the key.
   */
  async diagnose(): Promise<ProviderCheck[]> {
    const out: ProviderCheck[] = [];
    const reason = (e: unknown): string =>
      e instanceof SpecError || e instanceof InfraError
        ? e.message.replaceAll(/\bBearer\s+\S+/g, "Bearer [redacted]").slice(0, 200)
        : "request failed";
    let first: { items?: DaytonaSandbox[] } | undefined;
    try {
      first = await this.api.json<{ items?: DaytonaSandbox[] }>("GET", "/sandbox", {
        query: { limit: 1 },
        timeoutMs: 20_000,
      });
      out.push({
        id: "daytona.api",
        status: "pass",
        summary: "the Daytona API key works and the API answers",
      });
    } catch (e) {
      const unreadable = e instanceof SpecError && !(e instanceof SandboxNotFoundError);
      out.push({
        id: "daytona.api",
        status: "fail",
        summary: "the Daytona API is not usable",
        detail: reason(e),
        fix: unreadable
          ? "Check the key file or variable named in the provider config: it must hold only the key, readable by the server's user."
          : "Check that the server can reach the Daytona API and that the key is current.",
      });
      return out;
    }
    const pre = this.opts.ownerCiPreflight;
    if (pre === false) {
      out.push({
        id: "daytona.usage",
        status: "warn",
        summary: "the org CPU check is turned off",
        fix: "Remove ownerCiPreflight: false from the provider config unless this account has no usage endpoint.",
      });
    } else if (this.opts.quotaMode === "own-fleet") {
      out.push({
        id: "daytona.usage",
        status: "pass",
        summary: `own-fleet budget (quotaMode: own-fleet): the org usage is not read, ${this.maxLive} sandboxes of ours at most`,
      });
    } else {
      this.orgId ??= first.items?.find((s) => s.organizationId)?.organizationId;
      if (this.orgId === undefined) {
        out.push({
          id: "daytona.usage",
          status: "warn",
          summary:
            "the account has no sandbox to learn the org id from, so the org usage endpoint was not checked",
          fix: "It is checked on the first create; re-run doctor after one job has run.",
        });
      } else {
        try {
          const usage = await this.api.json<{ regionUsage?: RegionUsageRow[] }>(
            "GET",
            `/organizations/${encodeURIComponent(this.orgId)}/usage`,
            { timeoutMs: 20_000 },
          );
          const u = orgUsage(
            usage.regionUsage,
            pre?.region ?? DEFAULT_ORG_REGION,
            pre?.sandboxClass ?? DEFAULT_ORG_CLASS,
          );
          const diskLimit = pre?.diskLimitGiB ?? u.quota.disk;
          const memLimit = pre?.memLimitGiB ?? u.quota.mem;
          const extra = [
            diskLimit !== undefined && u.disk !== undefined
              ? `${u.disk} of ${diskLimit} GiB disk`
              : undefined,
            memLimit !== undefined && u.mem !== undefined
              ? `${u.mem} of ${memLimit} GiB memory`
              : undefined,
          ].filter((x): x is string => x !== undefined);
          out.push(
            u.cpu === undefined
              ? {
                  id: "daytona.usage",
                  status: "fail",
                  summary: "the org usage reply has no CPU reading, so no sandbox will be created",
                  fix: "Check the region and sandbox class in ownerCiPreflight, or turn the check off.",
                }
              : {
                  id: "daytona.usage",
                  status: "pass",
                  summary: `the org usage endpoint answers (${[
                    `${u.cpu} vCPU in use of ${this.cpuLimit}`,
                    ...extra,
                  ].join(", ")})`,
                },
          );
        } catch (e) {
          if (e instanceof DaytonaKeyRejectedError && e.status === 403) {
            out.push({
              id: "daytona.usage",
              status: "warn",
              summary: `org usage forbidden (403): own-fleet budget mode, ${this.maxLive} sandboxes of ours at most; the org's CPU is not checked`,
              fix: 'Set quotaMode: "own-fleet" to say so explicitly, or use a key that may read the org usage.',
            });
          } else {
            out.push({
              id: "daytona.usage",
              status: "fail",
              summary:
                e instanceof SandboxNotFoundError
                  ? "the org usage endpoint answered 404, so no sandbox will be created (the CPU check fails closed)"
                  : "the org usage endpoint failed",
              ...(e instanceof SandboxNotFoundError ? {} : { detail: reason(e) }),
              fix: "Set ownerCiPreflight: false in the provider config if this deployment has no usage endpoint.",
            });
          }
        }
      }
    }
    const snap = this.opts.snapshot;
    if (snap === undefined) {
      out.push({
        id: "daytona.snapshot",
        status: "pass",
        summary: "no snapshot is named: sandboxes start from the account's default snapshot",
      });
    } else {
      try {
        await this.api.json("GET", `/snapshots/${encodeURIComponent(snap)}`, { timeoutMs: 20_000 });
        out.push({ id: "daytona.snapshot", status: "pass", summary: `snapshot ${snap} exists` });
      } catch (e) {
        out.push({
          id: "daytona.snapshot",
          status: "fail",
          summary:
            e instanceof SandboxNotFoundError
              ? `snapshot ${snap} does not exist`
              : `snapshot ${snap} could not be read`,
          ...(e instanceof SandboxNotFoundError ? {} : { detail: reason(e) }),
          fix: "Create the snapshot in the Daytona account (or register an image with register_sandbox_image), or fix the name in the provider config. Sandboxes never create snapshots.",
        });
      }
    }
    return out;
  }

  /** Validates a spec against the account rules and builds the Daytona request body. */
  buildCreateBody(spec: SandboxSpec): Record<string, unknown> {
    if (!Number.isInteger(spec.ttlSeconds) || spec.ttlSeconds <= 0) {
      throw new SpecError("ttlSeconds must be a positive integer");
    }
    if (spec.ttlSeconds > this.maxTtl && !this.opts.clampTtl) {
      throw new SpecError(
        `ttlSeconds ${spec.ttlSeconds} exceeds the ${this.maxTtl}s limit for this account`,
      );
    }
    const ttlSeconds = Math.min(spec.ttlSeconds, this.maxTtl);
    const strict = spec.network.egress === "deny-all-except-proxy";
    const domain = spec.network.egress === "proxy-domain-filtered";
    const proxied = strict || domain;
    if (spec.network.egress !== "none" && spec.network.egress !== "open" && !proxied) {
      throw new SpecError(
        `egress policy ${spec.network.egress} is not supported by this provider (none, open, deny-all-except-proxy)`,
      );
    }
    let setting: NetworkSetting | undefined;
    if (proxied) {
      if (!spec.network.proxy) throw new SpecError(`${spec.network.egress} needs network.proxy`);
      if (domain && !this.opts.allowDomainListConfinement) {
        throw new SpecError(
          "proxy-domain-filtered is off: confining a sandbox by TLS server name depends on Daytona's filter reading it correctly, so it needs allowDomainListConfinement: true",
        );
      }
      if (strict && !(spec.network.proxy.addresses && spec.network.proxy.addresses.length > 0)) {
        throw new SpecError(
          "deny-all-except-proxy on Daytona needs the proxy endpoint's stable IPv4 addresses (an allow list); without them the only option is proxy-domain-filtered, which the operator must enable",
        );
      }
      try {
        setting = networkSettingFor(spec.network.proxy, domain ? "domain" : "address");
      } catch (e) {
        throw new SpecError(`proxy endpoint: ${(e as Error).message}`);
      }
    }
    if (spec.template !== undefined)
      throw new SpecError("templates are not supported by this provider");
    const labels: Record<string, string> = { ...spec.labels };
    if (labels[this.fleet.label] !== undefined && labels[this.fleet.label] !== OWN_LABEL_VALUE) {
      throw new SpecError(`the ${this.fleet.label} label is reserved`);
    }
    labels[this.fleet.label] = OWN_LABEL_VALUE;
    labels[RUN_LABEL] = labels[RUN_LABEL] || this.runId;

    const minutes = Math.ceil(ttlSeconds / 60);
    const body: Record<string, unknown> = {
      name: this.fleet.ownName(spec.name),
      labels,
      public: false,
      // One of the three mutually exclusive network settings: block all, or the proxy endpoint
      // (an allow list of its addresses, or a domain list of its name), set in this same call so
      // there is no moment with open egress.
      ...(setting ?? { networkBlockAll: spec.network.egress === "none" }),
      // Three independent backstops, all within the limit: hard wall-clock TTL, auto-stop when
      // idle, and delete the moment it stops. No env field exists on a spec, so none is sent.
      ttlMinutes: minutes,
      autoStopInterval: minutes,
      autoDeleteInterval: 0,
    };
    if (this.opts.target) body.target = this.opts.target;
    const r = spec.resources;
    if (r?.cpus !== undefined) body.cpu = r.cpus;
    if (r?.memoryMb !== undefined) body.memory = Math.max(1, Math.ceil(r.memoryMb / 1024));
    if (r?.diskGb !== undefined) body.disk = r.diskGb;

    // Which image the sandbox starts from, in order: a named snapshot (the spec's, else the
    // configured one: the operator chose what runs, so an `image` name the scheduler adds is
    // ignored); an image build, only when explicitly allowed; otherwise neither field is sent and
    // Daytona starts from the account's default snapshot. No snapshot is ever created by default.
    const snapshot = spec.snapshot ?? this.opts.snapshot;
    if (snapshot !== undefined) {
      body.snapshot = snapshot;
    } else if (spec.image !== undefined && this.opts.allowImageBuild) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(spec.image))
        throw new SpecError("invalid image reference");
      body.buildInfo = { dockerfileContent: `FROM ${spec.image}\n` };
    }
    return body;
  }

  /** A class is its resources plus `snapshot`; any other setting is not Daytona's and is refused. */
  realiseClass(cls: SandboxResources, specific?: ProviderClassSettings): ClassRealisation {
    const extra = Object.keys(specific ?? {}).filter((k) => k !== "snapshot");
    if (extra.length > 0) {
      return {
        ok: false,
        reason: `daytona cannot realise the class setting ${extra[0]!.slice(0, 40)}`,
      };
    }
    const snapshot = specific?.snapshot;
    if (snapshot !== undefined && typeof snapshot !== "string") {
      return { ok: false, reason: "daytona needs the class snapshot to be a name" };
    }
    return { ok: true, resources: { ...cls }, ...(snapshot !== undefined ? { snapshot } : {}) };
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const body = this.buildCreateBody(spec); // refuse a bad spec before queueing anything
    const run = async (): Promise<SandboxHandle> => {
      const need: SandboxNeed = {
        cpu: spec.resources?.cpus ?? 1,
        memGiB: spec.resources?.memoryMb
          ? Math.ceil(spec.resources.memoryMb / 1024)
          : DEFAULT_SANDBOX_MEM_GIB,
        diskGiB: spec.resources?.diskGb ?? DEFAULT_SANDBOX_DISK_GIB,
      };
      // A quota 400 on create ("Total disk limit exceeded") is capacity, not a bad request: the
      // account is full, so wait (the same budget as every other capacity wait) and try again.
      const quotaDeadline = this.now() + this.capacityWaitMs;
      let warned = false;
      let startedAt = 0;
      let sb: DaytonaSandbox;
      for (;;) {
        await this.waitForCapacity(need);
        startedAt = this.now();
        try {
          sb = await this.api.json<DaytonaSandbox>("POST", "/sandbox", {
            json: body,
            timeoutMs: 120_000,
          });
          break;
        } catch (e) {
          if (!(e instanceof DaytonaQuotaExceededError)) throw e;
          if (this.now() >= quotaDeadline) {
            throw new InfraError(`waited ${Math.round(this.capacityWaitMs / 1000)}s: ${e.message}`);
          }
          if (!warned) {
            warned = true;
            this.opts.log?.(
              `daytona: ${e.message}; waiting for room (up to ${Math.round(this.capacityWaitMs / 1000)}s)`,
            );
          }
          await this.sleep(this.pollMs);
        }
      }
      // Recorded the moment it exists, before anything can fail, so it is counted and cleaned up.
      this.recorded.add(sb.id);
      try {
        if (!this.fleet.isOwn(sb))
          throw new InfraError("Daytona created a sandbox without our label; refusing to continue");
        // The org id for the next create's usage check, when the account had no sandbox to ask.
        this.orgId ??= sb.organizationId;
        // A proxied sandbox must come back with the setting we asked for. A reply without it
        // means the account did not apply it (a lower tier, an API change): never run on that.
        const wantSetting = body.networkAllowList ?? body.domainAllowList;
        if (wantSetting !== undefined) {
          const got = (body.networkAllowList ? sb.networkAllowList : sb.domainAllowList) ?? "";
          if (got.split(",").sort().join(",") !== String(wantSetting).split(",").sort().join(",")) {
            throw new InfraError(
              "Daytona did not apply the network allow list for the proxy; the sandbox was deleted",
            );
          }
        }
        // Egress none must come back as block-all: a reply without it means the account did not
        // apply it, and the sandbox may have an open network.
        if (spec.network.egress === "none" && sb.networkBlockAll !== true) {
          throw new InfraError(
            "Daytona did not apply networkBlockAll for egress none; the sandbox was deleted",
          );
        }
        await this.waitStarted(sb.id);
        const base = await this.verify(sb.id, true);
        await this.waitToolbox(sb.id, base);
        if (
          (spec.network.egress === "deny-all-except-proxy" ||
            spec.network.egress === "proxy-domain-filtered") &&
          spec.network.proxy
        ) {
          await this.startRelay(sb.id, spec.network.proxy, spec.ttlSeconds);
          return {
            id: sb.id,
            startedAt,
            proxy: { host: "127.0.0.1", port: this.opts.relayPort ?? RELAY_PORT },
            mustNotReach: mustNotReachFor(spec.network.proxy.port, spec.network.proxy.addresses),
          };
        }
        return { id: sb.id, startedAt };
      } catch (e) {
        // Never leave a half-created sandbox behind.
        const gone = await this.api
          .json("DELETE", `/sandbox/${encodeURIComponent(sb.id)}`)
          .then(() => true)
          .catch((err) => err instanceof SandboxNotFoundError);
        this.known.delete(sb.id);
        // A delete that failed leaves it recorded: it still counts, and the next sweep retries it.
        if (gone) this.recorded.delete(sb.id);
        throw e;
      }
    };
    const next = this.createChain.then(run, run);
    this.createChain = next.catch(() => {});
    return next;
  }

  /**
   * Starts the relay inside a proxied sandbox and waits until it listens. It connects to one of
   * the endpoint's addresses when it has them (no resolver is reachable under an allow list), else
   * to its name, and verifies the certificate against the endpoint's name.
   */
  private async startRelay(
    id: string,
    endpoint: NonNullable<SandboxSpec["network"]["proxy"]>,
    ttlSeconds: number,
  ): Promise<void> {
    const target = endpoint.addresses?.[0] ?? endpoint.host;
    const name = endpoint.tlsName ?? endpoint.host;
    let caFile: string[] = [];
    if (this.opts.proxyTlsCaPem !== undefined) {
      const path = "/tmp/turntable-proxy-ca.pem";
      await this.files.put(id, path, new TextEncoder().encode(this.opts.proxyTlsCaPem));
      caFile = [path];
    }
    const { execId } = await this.exec.start(id, {
      argv: [
        this.opts.relayInterpreter ?? "node",
        "-e",
        RELAY_JS,
        String(this.opts.relayPort ?? RELAY_PORT),
        target,
        String(endpoint.port),
        name,
        String(ttlSeconds),
        ...caFile,
      ],
      timeoutSeconds: ttlSeconds,
    });
    const deadline = this.now() + 20_000;
    for (;;) {
      const logs = await this.exec.logs(id, execId, { fromOffset: 0, maxBytes: 4096 });
      if (new TextDecoder().decode(logs.bytes).includes("ready")) return;
      const st = await this.exec.status(id, execId);
      if (st.state !== "running") {
        throw new InfraError("the proxy relay in the sandbox exited (is node in the image?)");
      }
      if (this.now() > deadline) throw new InfraError("the proxy relay did not start");
      await this.sleep(Math.min(this.pollMs, 250));
    }
  }

  private async waitStarted(id: string): Promise<void> {
    const deadline = this.now() + this.startTimeoutMs;
    for (;;) {
      const sb = await this.api.json<DaytonaSandbox>("GET", `/sandbox/${encodeURIComponent(id)}`);
      if (sb.state === "started") return;
      if (sb.state === "error" || sb.state === "build_failed" || sb.state === "destroyed") {
        throw new InfraError(
          `Daytona sandbox failed to start (${sb.state}${sb.errorReason ? `: ${sb.errorReason}` : ""})`,
        );
      }
      if (this.now() >= deadline)
        throw new InfraError(
          `Daytona sandbox did not start within ${this.startTimeoutMs} ms (${sb.state})`,
        );
      await this.sleep(Math.min(this.pollMs, 2000));
    }
  }

  private async waitToolbox(id: string, base: string): Promise<void> {
    const deadline = this.now() + 60_000;
    for (;;) {
      try {
        const res = await this.toolboxCall(id, base, "POST", "/process/execute", {
          json: { command: "true", timeout: 10 },
          timeoutMs: 20_000,
        });
        await readCapped(res, 64 * 1024);
        return;
      } catch (e) {
        if (e instanceof SandboxNotFoundError || e instanceof SpecError) throw e;
        if (this.now() >= deadline) throw e;
        await this.sleep(1000);
      }
    }
  }

  async destroy(id: string): Promise<void> {
    let sb: DaytonaSandbox;
    try {
      sb = await this.api.json<DaytonaSandbox>("GET", `/sandbox/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof SandboxNotFoundError) {
        this.recorded.delete(id);
        return;
      }
      throw e;
    }
    if (!this.fleet.isOwn(sb)) {
      this.recorded.delete(id);
      throw new SpecError(
        `refusing to delete sandbox ${id}: it is not labelled ${this.fleet.label}=${OWN_LABEL_VALUE}`,
      );
    }
    try {
      await this.api.json("DELETE", `/sandbox/${encodeURIComponent(id)}`);
    } catch (e) {
      if (!(e instanceof SandboxNotFoundError)) throw e;
    }
    this.known.delete(id);
    await this.waitGone(id);
    this.recorded.delete(id);
    const destroyedAt = this.now();
    const createdAt = sb.createdAt ? Date.parse(sb.createdAt) : destroyedAt;
    this.opts.onUsage?.({
      sandboxId: id,
      name: sb.name,
      createdAt,
      destroyedAt,
      seconds: Math.max(0, Math.round((destroyedAt - createdAt) / 1000)),
    });
  }

  /** Deletion is asynchronous: wait until the sandbox is really gone so counts and caps are true. */
  private async waitGone(id: string): Promise<void> {
    const deadline = this.now() + 120_000;
    for (;;) {
      try {
        const sb = await this.api.json<DaytonaSandbox>("GET", `/sandbox/${encodeURIComponent(id)}`);
        if (sb.state === "destroyed") return;
      } catch (e) {
        if (e instanceof SandboxNotFoundError) return;
        throw e;
      }
      if (this.now() >= deadline)
        throw new InfraError(`Daytona sandbox ${id} is still being deleted after 120 s`);
      await this.sleep(Math.min(this.pollMs, 500));
    }
  }

  async destroyByLabels(labels: Labels): Promise<number> {
    if (Object.keys(labels).length === 0) throw new SpecError("destroyByLabels needs labels");
    const found = await this.list({ labels });
    for (const s of found) await this.destroy(s.id);
    return found.length;
  }

  /**
   * Our sandboxes, live and matching `filter`. The recorded ids (confirmed by get) are the
   * authority. The label-filtered listing is added as a best effort, to find strays an earlier
   * process lost track of; it can miss new sandboxes and show deleted ones, so it never lowers a
   * count and an empty answer from it means nothing. A failing listing is ignored.
   */
  async list(filter: { labels?: Labels }): Promise<SandboxInfo[]> {
    // Our own label is always part of the query and is checked again on every result, so a
    // listing can never include (and a delete can never reach) a sandbox that is not ours.
    const want = { ...filter.labels, [this.fleet.label]: OWN_LABEL_VALUE };
    const mine = (s: DaytonaSandbox): boolean =>
      this.fleet.isOwn(s) &&
      isLive(s.state) &&
      Object.entries(want).every(([k, v]) => s.labels?.[k] === v);
    const byId = new Map<string, DaytonaSandbox>();
    for (const s of await this.recordedSandboxes()) if (mine(s)) byId.set(s.id, s);
    let strays: DaytonaSandbox[] = [];
    try {
      strays = await this.listAll({ labels: JSON.stringify(want) });
    } catch {
      // best effort only
    }
    for (const s of strays) {
      if (byId.has(s.id) || !mine(s)) continue;
      // The listing may be stale: confirm with a get before counting or acting on it.
      try {
        const fresh = await this.api.json<DaytonaSandbox>(
          "GET",
          `/sandbox/${encodeURIComponent(s.id)}`,
        );
        if (mine(fresh)) {
          byId.set(fresh.id, fresh);
          this.recorded.add(fresh.id);
        }
      } catch {
        // gone, or unreadable: not counted
      }
    }
    return [...byId.values()].map((s) => ({
      id: s.id,
      name: s.name,
      labels: s.labels ?? {},
      createdAt: s.createdAt ? Date.parse(s.createdAt) : 0,
    }));
  }

  async count(filter: { labels?: Labels }): Promise<number> {
    return (await this.list(filter)).length;
  }
}

/** Creates a sandbox, runs `fn`, and always deletes the sandbox, even when `fn` throws. */
export async function withSandbox<T>(
  provider: Provider,
  spec: SandboxSpec,
  fn: (sandboxId: string) => Promise<T>,
): Promise<T> {
  const { id } = await provider.create(spec);
  try {
    return await fn(id);
  } finally {
    await provider.destroy(id);
  }
}
