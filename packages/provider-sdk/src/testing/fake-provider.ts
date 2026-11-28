import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  FileTooLargeError,
  InfraError,
  SandboxNotFoundError,
  SpecError,
  type ProviderError,
} from "../errors";
import {
  parsePinnedImage,
  type ImageRegistration,
  type ImageRegistrationRequest,
  type Labels,
  type Provider,
  type ProviderInfo,
  type SandboxInfo,
  type SandboxSpec,
} from "../types";
import { createWrappedExec, type ShellRunner, type WrappedExecOptions } from "../wrapped-exec";

export type FakeOp =
  "healthcheck" | "create" | "destroy" | "list" | "exec" | "files" | "registerImage";

export interface FakeWorldOptions {
  /** Shell used for `sh`. Point at /bin/dash to exercise the dash code path. Default /bin/sh. */
  shell?: string;
  /** Per-file byte cap advertised and enforced. Default 1 MiB. */
  maxFileBytes?: number;
  /** Artificial latency per call, in milliseconds. */
  latencyMs?: number;
  /** Absolute host path prefixes that files.put/get use as-is (tests that need fixed paths). */
  hostPaths?: string[];
  /** Tuning passed to the wrapped exec (small head/tail make cut tests cheap). */
  exec?: WrappedExecOptions;
  /** Advertise `info.dockerInSandbox`. Default false. */
  dockerInSandbox?: boolean;
  /** Advertise `info.isolation`. Default `container`. */
  isolation?: ProviderInfo["isolation"];
}

interface FakeSandbox {
  id: string;
  name: string;
  labels: Labels;
  createdAt: number;
  expiresAt: number;
  dir: string;
}

const matches = (have: Labels, want: Labels | undefined): boolean =>
  want === undefined || Object.entries(want).every(([k, v]) => have[k] === v);

/**
 * A fake provider world. Sandboxes are temp dirs and commands run as real local `sh` processes
 * with a scrubbed environment, so the real wrapper is exercised. Not a security boundary.
 * Provider instances share the world: dropping one and making another models a controller
 * restart or a lost control connection.
 */
export class FakeWorld {
  readonly root = mkdtempSync(join(tmpdir(), "tt-fake-"));
  private readonly binDir = join(this.root, "bin");
  private readonly sandboxes = new Map<string, FakeSandbox>();
  private readonly failures = new Map<FakeOp, { remaining: number; error: ProviderError }[]>();
  private generation = 0;
  private seq = 0;
  readonly opts: Required<Pick<FakeWorldOptions, "maxFileBytes" | "latencyMs" | "shell">> &
    Pick<FakeWorldOptions, "exec" | "hostPaths" | "dockerInSandbox" | "isolation">;

  constructor(opts: FakeWorldOptions = {}) {
    this.opts = {
      shell: opts.shell ?? "/bin/sh",
      maxFileBytes: opts.maxFileBytes ?? 1024 * 1024,
      latencyMs: opts.latencyMs ?? 0,
      ...(opts.exec ? { exec: opts.exec } : {}),
      ...(opts.hostPaths ? { hostPaths: opts.hostPaths } : {}),
      ...(opts.dockerInSandbox ? { dockerInSandbox: true } : {}),
      ...(opts.isolation ? { isolation: opts.isolation } : {}),
    };
    mkdirSync(this.binDir);
    // The wrapper itself invokes `sh`; make that resolve to the chosen shell.
    symlinkSync(this.opts.shell, join(this.binDir, "sh"));
  }

  /** A fresh provider instance with no state of its own. */
  provider(): Provider {
    return new FakeProvider(this, this.generation);
  }

  /** Snapshots registered with `registerImage`, by name: the pinned image each was made from. */
  readonly images = new Map<string, { image: string; digest: string }>();

  /** Kills every existing provider instance: their next call throws InfraError. */
  dropConnections(): void {
    this.generation += 1;
  }

  /** The next `times` calls of `op` fail with `error` (default InfraError). */
  failNext(op: FakeOp, times = 1, error: ProviderError = new InfraError("scripted failure")): void {
    const q = this.failures.get(op) ?? [];
    q.push({ remaining: times, error });
    this.failures.set(op, q);
  }

  /** Makes an exec vanish (as if the sandbox rebooted): status becomes `lost`. */
  loseExec(sandboxId: string, execId: string): void {
    const sb = this.sandboxes.get(sandboxId);
    if (!sb) return;
    killExecDir(join(sb.dir, "x", execId));
    rmSync(join(sb.dir, "x", execId), { recursive: true, force: true });
  }

  /** Absolute dir of a sandbox on the host. Paths under it pass through files.put/get as-is. */
  sandboxDir(id: string): string {
    return this.get(id).dir;
  }

  setLatency(ms: number): void {
    this.opts.latencyMs = ms;
  }

  /** Destroys everything and removes the world's temp dir. */
  dispose(): void {
    for (const sb of this.sandboxes.values()) this.removeSandbox(sb);
    this.sandboxes.clear();
    rmSync(this.root, { recursive: true, force: true });
  }

  // Internals used by FakeProvider.

  async enter(op: FakeOp, gen: number): Promise<void> {
    if (gen !== this.generation) throw new InfraError("fake: control connection dropped");
    if (this.opts.latencyMs > 0) await Bun.sleep(this.opts.latencyMs);
    const q = this.failures.get(op);
    const f = q?.[0];
    if (f) {
      f.remaining -= 1;
      if (f.remaining <= 0) q.shift();
      throw f.error;
    }
  }

  nextId(): string {
    this.seq += 1;
    return `fake-${process.pid}-${this.seq}-${crypto.randomUUID().slice(0, 8)}`;
  }

  add(spec: SandboxSpec): FakeSandbox {
    const id = this.nextId();
    const dir = join(this.root, "sb", id);
    mkdirSync(join(dir, "x"), { recursive: true });
    const now = Date.now();
    const sb: FakeSandbox = {
      id,
      name: spec.name,
      labels: { ...spec.labels },
      createdAt: now,
      expiresAt: now + spec.ttlSeconds * 1000,
      dir,
    };
    this.sandboxes.set(id, sb);
    return sb;
  }

  get(id: string): FakeSandbox {
    this.reap();
    const sb = this.sandboxes.get(id);
    if (!sb) throw new SandboxNotFoundError(`no such sandbox: ${id}`);
    return sb;
  }

  all(): FakeSandbox[] {
    this.reap();
    return [...this.sandboxes.values()];
  }

  remove(id: string): boolean {
    const sb = this.sandboxes.get(id);
    if (!sb) return false;
    this.removeSandbox(sb);
    this.sandboxes.delete(id);
    return true;
  }

  private reap(): void {
    const now = Date.now();
    for (const sb of this.sandboxes.values()) {
      if (sb.expiresAt <= now) this.remove(sb.id);
    }
  }

  private removeSandbox(sb: FakeSandbox): void {
    const x = join(sb.dir, "x");
    try {
      for (const e of readdirSync(x)) killExecDir(join(x, e));
    } catch {
      // already gone
    }
    // Only ever delete inside our own root.
    if (resolve(sb.dir).startsWith(resolve(this.root) + sep)) {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  }

  scrubbedEnv(sb: FakeSandbox): Record<string, string> {
    return { PATH: `${this.binDir}:/usr/bin:/bin`, HOME: sb.dir, LANG: "C" };
  }
}

function killExecDir(dir: string): void {
  for (const f of ["cpid", "pid"]) {
    try {
      const pid = Number(readFileSync(join(dir, f), "utf8").trim());
      if (pid > 1) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          process.kill(pid, "SIGKILL");
        }
      }
    } catch {
      // not present or already dead
    }
  }
}

const FAKE_INFO: ProviderInfo = {
  name: "fake",
  isolation: "container",
  createFrom: ["image", "snapshot", "template"],
  exec: { detached: true, logsByOffset: true, streaming: false, tty: false },
  files: { upload: true, download: true },
  network: { egressPolicy: ["open"], ingress: false, proxyReachability: false },
  resources: { cpus: false, memoryMb: false, diskGb: false },
  ttl: true,
  labels: true,
  list: true,
  listByLabel: true,
  os: [process.platform],
  arch: [process.arch],
  cost: "none",
};

class FakeProvider implements Provider {
  readonly info: ProviderInfo;
  readonly exec: Provider["exec"];
  readonly files: Provider["files"];

  private readonly world: FakeWorld;
  private readonly gen: number;

  constructor(world: FakeWorld, gen: number) {
    this.world = world;
    this.gen = gen;
    this.info = {
      ...FAKE_INFO,
      files: { ...FAKE_INFO.files, maxBytes: world.opts.maxFileBytes },
      ...(world.opts.dockerInSandbox ? { dockerInSandbox: true } : {}),
      ...(world.opts.isolation ? { isolation: world.opts.isolation } : {}),
    };
    const runner: ShellRunner = {
      run: async (id, argv, { timeoutMs }) => {
        await world.enter("exec", gen);
        const sb = world.get(id);
        const cmd = argv[0] === "sh" ? [world.opts.shell, ...argv.slice(1)] : [...argv];
        const proc = Bun.spawn(cmd, {
          cwd: sb.dir,
          env: world.scrubbedEnv(sb),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: timeoutMs,
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).bytes(),
          new Response(proc.stderr).bytes(),
          proc.exited,
        ]);
        return { exitCode, stdout, stderr };
      },
    };
    const execFor = (id: string) =>
      createWrappedExec(runner, { ...world.opts.exec, baseDir: join(world.get(id).dir, "x") });
    this.exec = {
      start: (id, o) => execFor(id).start(id, o),
      status: (id, e) => execFor(id).status(id, e),
      logs: (id, e, o) => execFor(id).logs(id, e, o),
      kill: (id, e, s) => execFor(id).kill(id, e, s),
    };
    const resolveIn = (id: string, path: string): string => {
      const sb = world.get(id);
      if (world.opts.hostPaths?.some((h) => path === h || path.startsWith(h + sep))) {
        return path;
      }
      if (path.startsWith(sb.dir + sep)) path = path.slice(sb.dir.length);
      const full = resolve(sb.dir, "." + (path.startsWith("/") ? path : "/" + path));
      if (!full.startsWith(sb.dir + sep)) throw new SpecError(`path escapes sandbox: ${path}`);
      return full;
    };
    this.files = {
      put: async (id, path, bytes) => {
        await world.enter("files", gen);
        if (bytes.length > world.opts.maxFileBytes) {
          throw new FileTooLargeError(`${bytes.length} bytes exceeds ${world.opts.maxFileBytes}`);
        }
        const full = resolveIn(id, path);
        mkdirSync(dirname(full), { recursive: true });
        await Bun.write(full, bytes);
      },
      get: async (id, path, maxBytes) => {
        await world.enter("files", gen);
        const f = Bun.file(resolveIn(id, path));
        if (!(await f.exists())) throw new SpecError(`no such file: ${path}`);
        if (f.size > maxBytes) throw new FileTooLargeError(`${f.size} bytes exceeds ${maxBytes}`);
        return f.bytes();
      },
    };
  }

  async registerImage(req: ImageRegistrationRequest): Promise<ImageRegistration> {
    await this.world.enter("registerImage", this.gen);
    const pinned = parsePinnedImage(req.image);
    if (!pinned) throw new SpecError("the image is not pinned by digest");
    const had = this.world.images.get(req.name);
    // Like a real account: a name is taken once; re-registering the same digest is a no-op.
    if (had && had.digest !== pinned.digest)
      throw new SpecError(`snapshot ${req.name} already exists with another image`);
    this.world.images.set(req.name, { image: req.image, digest: pinned.digest });
    return { name: req.name, digest: pinned.digest, state: "ready" };
  }

  async healthcheck(): Promise<void> {
    await this.world.enter("healthcheck", this.gen);
  }

  async create(spec: SandboxSpec) {
    await this.world.enter("create", this.gen);
    if (!(spec.ttlSeconds > 0)) throw new SpecError("ttlSeconds must be positive");
    const sb = this.world.add(spec);
    return { id: sb.id, startedAt: sb.createdAt };
  }

  async destroy(id: string): Promise<void> {
    await this.world.enter("destroy", this.gen);
    this.world.remove(id);
  }

  async destroyByLabels(labels: Labels): Promise<number> {
    await this.world.enter("destroy", this.gen);
    if (Object.keys(labels).length === 0) throw new SpecError("destroyByLabels needs labels");
    let n = 0;
    for (const sb of this.world.all()) {
      if (matches(sb.labels, labels) && this.world.remove(sb.id)) n += 1;
    }
    return n;
  }

  async list(filter: { labels?: Labels }): Promise<SandboxInfo[]> {
    await this.world.enter("list", this.gen);
    return this.world
      .all()
      .filter((sb) => matches(sb.labels, filter.labels))
      .map((sb) => ({ id: sb.id, name: sb.name, labels: sb.labels, createdAt: sb.createdAt }));
  }

  async count(filter: { labels?: Labels }): Promise<number> {
    return (await this.list(filter)).length;
  }
}
