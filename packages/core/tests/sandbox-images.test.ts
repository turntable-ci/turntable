// register_sandbox_image (#809): the instance operator registers a digest-pinned image with the
// provider (here the fake provider), Turntable records its name and digest, and a project can be
// pointed at it and sees it in get_project_settings.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parsePinnedImage } from "@turntable/provider-sdk";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import { systemOrgId } from "../src/audit/failures";
import { type Db, getProjectSandboxSettings, listAudit } from "../src/db";
import { deleteProjectCascade } from "../src/db/repos/project-delete";
import {
  getSandboxImage,
  listSandboxImages,
  putSandboxImage,
} from "../src/db/repos/sandbox-images";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { DEFAULT_IMAGE_NAME } from "../src/ops/definitions/sandbox-images";
import { GITHUB_DEFAULT_LABELS, parseSandboxSizes, sizeFor } from "../src/scheduler/sandbox-size";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

// Built at runtime: no digest-looking literal in the source.
const digest = (c: string): string => `sha256:${c.repeat(64)}`;
const D1 = digest("a");
const D2 = digest("b");
const OURS = "ghcr.io/turntable-ci/turntable-ubuntu-24.04";

let db: Db;
let a: Tenant;
let world: FakeWorld;
let env: DispatchEnv;
let secret: string;

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  world = new FakeWorld();
  const provider = world.provider();
  env = {
    registry,
    db,
    allowInstance: true,
    imageRegistrar: () => ({
      provider: provider.info.name,
      register: (req) => provider.registerImage!(req),
    }),
  };
  secret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
});
afterEach(() => world.dispose());

/** The output of a successful dispatch, else undefined. */
const out = (r: Awaited<ReturnType<typeof dispatch>>): Record<string, unknown> | undefined =>
  r.ok ? (r.output as Record<string, unknown>) : undefined;

const asInstance = (input: Record<string, unknown>, e: DispatchEnv = env) =>
  dispatch(e, { kind: "bearer", token: secret }, "register_sandbox_image", input);

describe("parsePinnedImage", () => {
  test("accepts repository@digest, drops a tag next to it, refuses anything not pinned", () => {
    expect(parsePinnedImage(`${OURS}@${D1}`)).toEqual({ repository: OURS, digest: D1 });
    expect(parsePinnedImage(`${OURS}:24.04@${D1}`)).toEqual({ repository: OURS, digest: D1 });
    expect(parsePinnedImage(`localhost:5000/x/y@${D1}`)?.repository).toBe("localhost:5000/x/y");
    for (const bad of [
      OURS,
      `${OURS}:latest`,
      `${OURS}@sha256:abc`,
      `${OURS}@sha512:${"a".repeat(128)}`,
      `${OURS.toUpperCase()}@${D1}`,
      `${OURS}@${D1} `,
      `${OURS}@${D1}\n`,
      `-rf@${D1}`,
    ])
      expect(parsePinnedImage(bad), bad).toBeUndefined();
  });
});

describe("register_sandbox_image", () => {
  test("registers with the provider by digest and records name, digest and source", async () => {
    const r = await asInstance({ name: DEFAULT_IMAGE_NAME, image: `${OURS}:24.04@${D1}` });
    expect(out(r)).toEqual({
      name: DEFAULT_IMAGE_NAME,
      image: `${OURS}@${D1}`,
      digest: D1,
      source: "turntable",
      state: "ready",
      project: null,
    });
    // The provider was handed the digest ref, never the tag.
    expect(world.images.get(DEFAULT_IMAGE_NAME)).toEqual({ image: `${OURS}@${D1}`, digest: D1 });
    const [rec] = await listSandboxImages(db);
    expect(rec).toMatchObject({ name: DEFAULT_IMAGE_NAME, digest: D1, provider: "fake" });
  });

  test("an image outside Turntable's registry is recorded as operator-registered", async () => {
    const r = await asInstance({ name: "team-img", image: `registry.example/team/ci@${D1}` });
    expect(out(r)?.source).toBe("operator");
  });

  test("a tag-only ref is refused and the provider is never called", async () => {
    for (const image of [OURS, `${OURS}:24.04`, `${OURS}:latest`]) {
      const r = await asInstance({ name: "x", image });
      expect(r.ok, image).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    }
    expect(world.images.size).toBe(0);
    expect(await listSandboxImages(db)).toEqual([]);
  });

  test("a bad snapshot name is refused", async () => {
    const r = await asInstance({ name: "-bad", image: `${OURS}@${D1}` });
    expect(!r.ok && r.error.code).toBe("invalid_input");
  });

  test("same name and digest again is idempotent; another digest under the name is a conflict", async () => {
    expect((await asInstance({ name: "img", image: `${OURS}@${D1}` })).ok).toBe(true);
    expect((await asInstance({ name: "img", image: `${OURS}@${D1}` })).ok).toBe(true);
    const r = await asInstance({ name: "img", image: `${OURS}@${D2}` });
    expect(!r.ok && r.error.code).toBe("conflict");
    expect(world.images.get("img")?.digest).toBe(D1);
  });

  test("the provider's refusal is invalid_input; its outage is unavailable; nothing recorded", async () => {
    world.images.set("taken", { image: `${OURS}@${D2}`, digest: D2 });
    const r = await asInstance({ name: "taken", image: `${OURS}@${D1}` });
    expect(!r.ok && r.error.code).toBe("invalid_input");
    world.failNext("registerImage");
    const r2 = await asInstance({ name: "img", image: `${OURS}@${D1}` });
    expect(!r2.ok && r2.error.code).toBe("unavailable");
    expect(await listSandboxImages(db)).toEqual([]);
  });

  test("without a provider that registers images it is unavailable", async () => {
    const r = await asInstance(
      { name: "img", image: `${OURS}@${D1}` },
      { ...env, imageRegistrar: () => undefined },
    );
    expect(!r.ok && r.error.code).toBe("unavailable");
  });

  test("naming a project points it at the snapshot, shown in get_project_settings, audited", async () => {
    const r = await asInstance({
      name: DEFAULT_IMAGE_NAME,
      image: `${OURS}@${D1}`,
      target_org: "org-a",
      target_project: "app",
    });
    expect(out(r)?.project).toBe(a.scope.projectId);
    expect((await getProjectSandboxSettings(db, a.scope)).sandboxSnapshot).toBe(DEFAULT_IMAGE_NAME);
    const reader = await mintToken(db, a.scope, "reader");
    const got = await dispatch(
      { registry, db },
      { kind: "bearer", token: reader.secret },
      "get_project_settings",
      {},
    );
    expect(out(got)).toMatchObject({
      sandbox_snapshot: DEFAULT_IMAGE_NAME,
      sandbox_image: { name: DEFAULT_IMAGE_NAME, image: `${OURS}@${D1}`, digest: D1 },
    });
    const audit = await listAudit(db, a.scope);
    expect(audit.some((x) => x.op === "register_sandbox_image")).toBe(true);
  });

  test("get_project_settings refreshes a recorded state that is not ready", async () => {
    await asInstance({
      name: "img",
      image: `${OURS}@${D1}`,
      target_org: "org-a",
      target_project: "app",
    });
    await putSandboxImage(db, { ...(await getSandboxImage(db, "img"))!, state: "pending" });
    const provider = world.provider();
    let state: "pending" | "ready" | "unavailable" = "unavailable";
    const stale: DispatchEnv = {
      registry,
      db,
      imageRegistrar: () => ({
        provider: provider.info.name,
        register: async (req) => ({ ...(await provider.registerImage!(req)), state }),
      }),
    };
    const reader = await mintToken(db, a.scope, "reader");
    const read = async () =>
      (
        out(
          await dispatch(
            stale,
            { kind: "bearer", token: reader.secret },
            "get_project_settings",
            {},
          ),
        )?.sandbox_image as { state: string }
      ).state;
    expect(await read()).toBe("unavailable");
    expect((await getSandboxImage(db, "img"))?.state).toBe("unavailable");
    state = "ready";
    expect(await read()).toBe("ready");
    expect((await getSandboxImage(db, "img"))?.state).toBe("ready");
  });

  test("an unknown target project creates no snapshot; naming only one of the pair is refused", async () => {
    const r = await asInstance({
      name: "img",
      image: `${OURS}@${D1}`,
      target_org: "org-a",
      target_project: "nope",
    });
    expect(!r.ok && r.error.code).toBe("not_found");
    const r2 = await asInstance({ name: "img", image: `${OURS}@${D1}`, target_org: "org-a" });
    expect(!r2.ok && r2.error.code).toBe("invalid_input");
    expect(world.images.size).toBe(0);
  });

  test("a project deleted while the provider call runs gets not_found; the record is kept and the instance audit says so", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = world.provider();
    const gated: DispatchEnv = {
      ...env,
      imageRegistrar: () => ({
        provider: provider.info.name,
        register: async (req) => {
          await gate;
          return provider.registerImage!(req);
        },
      }),
    };
    const pending = asInstance(
      { name: "gone", image: `${OURS}@${D1}`, target_org: "org-a", target_project: "app" },
      gated,
    );
    await new Promise((r) => setTimeout(r, 20));
    await deleteProjectCascade(db, { orgId: a.scope.orgId }, a.scope.projectId!);
    release();
    const r = await pending;
    expect(!r.ok && r.error.code).toBe("not_found");
    expect((await listSandboxImages(db)).map((x) => x.name)).toContain("gone");
    const audit = await listAudit(db, a.scope);
    expect(audit.some((x) => x.op === "register_sandbox_image")).toBe(false);
    if (!r.ok) expect(r.error.details).toBeUndefined();
    const sys = await listAudit(db, { orgId: await systemOrgId(db) });
    const row = sys.find(
      (x) => x.op === "register_sandbox_image" && x.outcome === "error:not_found",
    );
    expect(JSON.parse(String(row?.input))).toMatchObject({ recorded: true, state: "ready" });
  });

  test("a project snapshot not registered through Turntable shows no sandbox_image", async () => {
    const set = await dispatch(env, { kind: "bearer", token: secret }, "set_project_settings", {
      target_org: "org-a",
      target_project: "app",
      sandbox_snapshot: "hand-made",
    });
    expect(out(set)?.sandbox_image).toBeNull();
  });

  test("no org token of any role reaches it", async () => {
    for (const role of ["reader", "operator", "release_operator"] as const) {
      const t = await mintToken(db, { orgId: a.orgId }, role);
      const r = await dispatch(env, { kind: "bearer", token: t.secret }, "register_sandbox_image", {
        name: "img",
        image: `${OURS}@${D1}`,
      });
      expect(!r.ok && r.error.code, role).toBe("forbidden");
    }
    expect(world.images.size).toBe(0);
    expect(registry.get("register_sandbox_image")?.mcp).toBe(false);
  });
});

describe("ubuntu-latest and ubuntu-24.04 map to the default image", () => {
  test("the documented size config sends GitHub's default labels to the registered snapshot", () => {
    const cfg = parseSandboxSizes(
      JSON.stringify({
        classes: {
          standard: {
            cpus: 4,
            memoryMb: 16384,
            providers: { daytona: { snapshot: DEFAULT_IMAGE_NAME } },
          },
        },
        default: "standard",
      }),
      "test",
    );
    for (const label of ["ubuntu-latest", "ubuntu-24.04"]) {
      expect(GITHUB_DEFAULT_LABELS).toContain(label);
      expect(sizeFor(cfg, [label]).providers?.daytona?.snapshot, label).toBe(DEFAULT_IMAGE_NAME);
    }
  });
});

describe("the provider call holds no write transaction", () => {
  test("another transaction finishes while the registrar is still pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = world.provider();
    const slow: DispatchEnv = {
      ...env,
      imageRegistrar: () => ({
        provider: provider.info.name,
        register: async (req) => {
          await gate;
          return provider.registerImage!(req);
        },
      }),
    };
    const pending = asInstance({ name: "slow", image: `${OURS}@${D1}` }, slow);
    await new Promise((r) => setTimeout(r, 20));
    await db.transaction(async () => {});
    release();
    expect((await pending).ok).toBe(true);
  });
});
