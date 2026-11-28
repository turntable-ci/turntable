// An in-process stand-in for the Daytona REST API and a sandbox's toolbox. Toolbox commands run
// for real with `sh` in a scratch directory (clean environment), so the provider's exec wrapper,
// framing and file calls are exercised end to end without any network.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type MockSandbox = {
  id: string;
  name: string;
  state: string;
  labels: Record<string, string>;
  createdAt: string;
  toolboxProxyUrl: string;
  networkBlockAll: boolean;
  networkAllowList?: string | undefined;
  domainAllowList?: string | undefined;
  dir: string;
  readyAt: number;
  snapshot?: string | undefined;
  desired?: string;
};

export type Recorded = { method: string; path: string; query: string; body: unknown };

export const MOCK_KEY = "test-key-not-a-secret";

export function startMock(
  opts: {
    pageSize?: number;
    startDelayMs?: number;
    deleteDelayMs?: number;
    /** New sandboxes appear in listings, and deleted ones disappear, only after this long. */
    listLagMs?: number;
    /**
     * What Daytona was measured doing: a label-filtered list returns nothing for new sandboxes
     * (not even a minute later), and the unfiltered list is stale both ways: it omits new
     * sandboxes and keeps showing deleted ones as started. Only a get by id is accurate.
     */
    listBroken?: boolean;
    /** Behave like an account that accepts an allow list but does not apply it. */
    ignoreNetworkLists?: boolean;
  } = {},
) {
  // The mock listens on loopback, which the outbound client refuses unless it is allowlisted.
  const hadAllow = process.env.TURNTABLE_NET_ALLOW_HOSTS;
  const allow = new Set((hadAllow ?? "").split(",").filter(Boolean));
  allow.add("127.0.0.1");
  process.env.TURNTABLE_NET_ALLOW_HOSTS = [...allow].join(",");
  const sandboxes = new Map<string, MockSandbox>();
  const requests: Recorded[] = [];
  /** Chunks the server managed to push to a client that read a huge body. */
  const stats = { hugePulled: 0, hugeCancelled: false };
  const bornAt = new Map<string, number>();
  const diedAt = new Map<string, number>();
  let hugeList = false;
  const ghosts = new Map<string, MockSandbox>();
  let seq = 0;
  /** Extra sandboxes that belong to someone else; the provider must never touch them. */
  const failNext: {
    createStatus?: number | undefined;
    /** Answer the next `times` creates with this status and message (a quota 400, say). */
    createReply?: { status: number; message: string; times: number } | undefined;
  } = {};
  /** What the org usage endpoint answers. `status` other than 200 makes it fail. */
  const usage: { rows: unknown[]; status: number; calls: number } = {
    rows: [],
    status: 200,
    calls: 0,
  };

  /** Names of the snapshots that exist in the mock account. */
  const snapshots = new Set<string>();
  /** The image each snapshot created through POST /snapshots was made from. */
  const snapshotImages = new Map<string, string>();

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const ctype = req.headers.get("content-type") ?? "";
      let body: unknown;
      if (ctype.includes("json")) body = await req.clone().json();
      requests.push({ method: req.method, path: url.pathname, query: url.search, body });
      if (req.headers.get("authorization") !== `Bearer ${MOCK_KEY}`) {
        return Response.json({ message: "bad key" }, { status: 401 });
      }
      const origin = url.origin;
      if (/^\/api\/organizations\/[^/]+\/usage$/.test(url.pathname)) {
        usage.calls += 1;
        if (usage.status !== 200) return Response.json({ message: "no" }, { status: usage.status });
        return Response.json({ regionUsage: usage.rows });
      }
      const snap = /^\/api\/snapshots\/([^/]+)$/.exec(url.pathname);
      if (snap && req.method === "GET") {
        const name = decodeURIComponent(snap[1]!);
        const imageName = snapshotImages.get(name);
        return snapshots.has(name)
          ? Response.json({ name, state: "active", ...(imageName ? { imageName } : {}) })
          : Response.json({ message: "no such snapshot" }, { status: 404 });
      }
      if (url.pathname === "/api/snapshots" && req.method === "POST") {
        const b = body as { name?: string; imageName?: string };
        if (!b.name || !b.imageName)
          return Response.json({ message: "name and imageName are required" }, { status: 400 });
        if (snapshots.has(b.name))
          return Response.json({ message: "snapshot already exists" }, { status: 409 });
        snapshots.add(b.name);
        snapshotImages.set(b.name, b.imageName);
        return Response.json({
          id: `snap-${b.name}`,
          name: b.name,
          imageName: b.imageName,
          state: "pending",
        });
      }
      const m = /^\/api\/sandbox(?:\/([^/]+))?$/.exec(url.pathname);
      if (m) {
        const id = m[1];
        if (!id && req.method === "GET") {
          const labels = url.searchParams.get("labels");
          const want = labels ? (JSON.parse(labels) as Record<string, string>) : {};
          const states = url.searchParams.getAll("states");
          let all = [...sandboxes.values()].filter(
            (s) =>
              Object.entries(want).every(([k, v]) => s.labels[k] === v) &&
              (states.length === 0 ||
                states.includes(
                  s.state === "creating" && Date.now() >= s.readyAt ? "started" : s.state,
                )),
          );
          const lag = opts.listLagMs ?? 0;
          if (opts.listBroken) {
            const stale = labels ? [] : [...ghosts.values()].map((g) => view(g, origin));
            return Response.json({ items: stale, nextCursor: null });
          }
          if (hugeList) {
            // An endless body with no content-length: the client must stop at its own cap.
            const filler = new TextEncoder().encode(`"${"x".repeat(65_534)}",`);
            const stream = new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new TextEncoder().encode('{"items":['));
              },
              pull(c) {
                if (stats.hugePulled >= 2000) return c.close();
                stats.hugePulled += 1;
                c.enqueue(filler);
              },
              cancel() {
                stats.hugeCancelled = true;
              },
            });
            return new Response(stream, { headers: { "content-type": "application/json" } });
          }
          if (lag > 0) {
            // Listings are eventually consistent: young sandboxes are not listed yet and
            // deleted ones linger as if still running.
            all = all.filter((s) => Date.now() - (bornAt.get(s.id) ?? 0) >= lag);
            for (const [gid, t] of diedAt) {
              if (Date.now() - t < lag && ghosts.has(gid)) all.push(ghosts.get(gid)!);
            }
          }
          all = all.map((s) => view(s, origin)) as never;
          const start = Number(url.searchParams.get("cursor") ?? "0");
          const size = opts.pageSize ?? 200;
          const items = all.slice(start, start + size);
          return Response.json({
            items,
            nextCursor: start + size < all.length ? String(start + size) : null,
          });
        }
        if (!id && req.method === "POST") {
          if (failNext.createReply && failNext.createReply.times > 0) {
            failNext.createReply.times -= 1;
            return Response.json(
              { message: failNext.createReply.message },
              { status: failNext.createReply.status },
            );
          }
          if (failNext.createStatus) {
            const st = failNext.createStatus;
            failNext.createStatus = undefined;
            return Response.json({ message: "boom" }, { status: st });
          }
          const b = body as {
            name: string;
            labels: Record<string, string>;
            networkBlockAll?: boolean;
            networkAllowList?: string;
            domainAllowList?: string;
          };
          const sid = `sbx-${(seq += 1)}-${crypto.randomUUID().slice(0, 8)}`;
          bornAt.set(sid, Date.now());
          const sb: MockSandbox = {
            id: sid,
            name: b.name ?? sid,
            state: "creating",
            labels: b.labels ?? {},
            createdAt: new Date().toISOString(),
            toolboxProxyUrl: `${origin}/toolbox`,
            networkBlockAll: Boolean(b.networkBlockAll),
            // An account that does not apply a list (a lower tier) leaves these out of the reply.
            networkAllowList: opts.ignoreNetworkLists ? undefined : b.networkAllowList,
            domainAllowList: opts.ignoreNetworkLists ? undefined : b.domainAllowList,
            dir: mkdtempSync(join(tmpdir(), "tt-mock-sbx-")),
            readyAt: Date.now() + (opts.startDelayMs ?? 0),
          };
          sandboxes.set(sid, sb);
          return Response.json(view(sb, origin));
        }
        const sb = id ? sandboxes.get(id) : undefined;
        if (!sb) return Response.json({ message: "not found" }, { status: 404 });
        if (req.method === "GET") return Response.json(view(sb, origin));
        if (req.method === "DELETE") {
          const finish = () => {
            if (opts.listLagMs || opts.listBroken) {
              diedAt.set(sb.id, Date.now());
              ghosts.set(sb.id, { ...sb, state: "started" });
            }
            sandboxes.delete(sb.id);
            rmSync(sb.dir, { recursive: true, force: true });
          };
          if (opts.deleteDelayMs) {
            // Real deletion is asynchronous: the sandbox lingers while it is torn down.
            sb.state = "destroying";
            sb.desired = "destroyed";
            setTimeout(finish, opts.deleteDelayMs);
          } else finish();
          return Response.json({ ...view(sb, origin), state: "destroying" });
        }
      }
      const t = /^\/toolbox\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (t) {
        const sb = sandboxes.get(t[1]!);
        if (!sb) return Response.json({ message: "not found" }, { status: 404 });
        const path = t[2]!;
        if (path === "/process/execute") {
          const b = body as { command: string; timeout?: number };
          const proc = Bun.spawn(["sh", "-c", b.command], {
            cwd: sb.dir,
            env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: sb.dir, LANG: "C" },
            stdout: "pipe",
            stderr: "pipe",
            stdin: "ignore",
            timeout: (b.timeout ?? 10) * 1000,
          });
          const [out, err, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          if (proc.signalCode) return Response.json({ message: "timeout" }, { status: 408 });
          return Response.json({ exitCode: code, result: out + err });
        }
        if (path === "/files/upload-v2" && req.method === "POST") {
          const form = await req.formData();
          const file = form.get("file") as File;
          const target = url.searchParams.get("path")!;
          mkdirSync(dirname(target), { recursive: true });
          await Bun.write(target, file);
          return Response.json({ name: target.split("/").pop(), path: target, type: "file" });
        }
        if (path === "/files/download" && url.searchParams.get("path") === "/tmp/__huge") {
          const chunk = new Uint8Array(64 * 1024);
          const stream = new ReadableStream<Uint8Array>({
            pull(c) {
              if (stats.hugePulled >= 2000) return c.close();
              stats.hugePulled += 1;
              c.enqueue(chunk);
            },
            cancel() {
              stats.hugeCancelled = true;
            },
          });
          return new Response(stream); // no content-length
        }
        if (path === "/files/download") {
          const f = Bun.file(url.searchParams.get("path")!);
          if (!(await f.exists()))
            return Response.json({ message: "no such file" }, { status: 404 });
          return new Response(f);
        }
      }
      return Response.json({ message: "unknown route" }, { status: 404 });
    },
  });

  const view = (s: MockSandbox, origin: string) => ({
    id: s.id,
    name: s.name,
    snapshot: s.snapshot,
    desiredState: s.desired ?? "started",
    state: Date.now() >= s.readyAt && s.state === "creating" ? (s.state = "started") : s.state,
    labels: s.labels,
    createdAt: s.createdAt,
    toolboxProxyUrl: `${origin}/toolbox`,
    networkBlockAll: s.networkBlockAll,
    organizationId: "org-mock",
    ...(s.networkAllowList ? { networkAllowList: s.networkAllowList } : {}),
    ...(s.domainAllowList ? { domainAllowList: s.domainAllowList } : {}),
  });

  return {
    url: `http://127.0.0.1:${server.port}/api`,
    sandboxes,
    requests,
    failNext,
    usage,
    snapshots,
    snapshotImages,
    stats,
    setHugeList(v: boolean) {
      hugeList = v;
    },
    /** Adds a sandbox owned by someone else (no longshore-dev label). */
    addForeign(
      name: string,
      labels: Record<string, string>,
      state = "started",
      snapshot?: string,
    ): string {
      const id = `foreign-${(seq += 1)}`;
      sandboxes.set(id, {
        id,
        name,
        state,
        labels,
        createdAt: new Date().toISOString(),
        toolboxProxyUrl: `http://127.0.0.1:${server.port}/toolbox`,
        networkBlockAll: false,
        dir: mkdtempSync(join(tmpdir(), "tt-mock-foreign-")),
        readyAt: 0,
        snapshot,
      });
      return id;
    },
    stop: async () => {
      if (hadAllow === undefined) delete process.env.TURNTABLE_NET_ALLOW_HOSTS;
      else process.env.TURNTABLE_NET_ALLOW_HOSTS = hadAllow;
      for (const s of sandboxes.values()) rmSync(s.dir, { recursive: true, force: true });
      await server.stop(true);
    },
  };
}
