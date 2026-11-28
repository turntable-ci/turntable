// DaytonaProvider.registerImage (#809): a snapshot from a digest-pinned image, against the mock API.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { SpecError } from "@turntable/provider-sdk";
import { DaytonaProvider } from "../src/index";
import { MOCK_KEY, startMock } from "../src/testing/mock-daytona";

let mock: ReturnType<typeof startMock>;
beforeEach(() => {
  mock = startMock();
});
afterEach(async () => {
  await mock.stop();
});

const make = () => new DaytonaProvider({ apiKey: () => MOCK_KEY, baseUrl: mock.url, pollMs: 5 });
const digest = (c: string): string => `sha256:${c.repeat(64)}`;
const REPO = "ghcr.io/turntable-ci/turntable-ubuntu-24.04";

test("creates the snapshot from the digest ref with the class resources, pending until built", async () => {
  const r = await make().registerImage({
    name: "turntable-ubuntu-24.04",
    image: `${REPO}@${digest("a")}`,
    resources: { cpus: 4, memoryMb: 8192, diskGb: 10 },
  });
  expect(r).toEqual({ name: "turntable-ubuntu-24.04", digest: digest("a"), state: "pending" });
  const post = mock.requests.find((q) => q.method === "POST" && q.path === "/api/snapshots");
  expect(post?.body).toEqual({
    name: "turntable-ubuntu-24.04",
    imageName: `${REPO}@${digest("a")}`,
    cpu: 4,
    memory: 8,
    disk: 10,
  });
});

test("a taken name is accepted only with the same digest", async () => {
  const p = make();
  await p.registerImage({ name: "img", image: `${REPO}@${digest("a")}` });
  expect(await p.registerImage({ name: "img", image: `${REPO}@${digest("a")}` })).toMatchObject({
    state: "ready",
  });
  await expect(
    p.registerImage({ name: "img", image: `${REPO}@${digest("b")}` }),
  ).rejects.toBeInstanceOf(SpecError);
});

test("an image not pinned by digest is refused before any request", async () => {
  const p = make();
  for (const image of [REPO, `${REPO}:latest`, `${REPO}@sha256:abc`])
    await expect(p.registerImage({ name: "img", image })).rejects.toBeInstanceOf(SpecError);
  expect(mock.requests.filter((q) => q.path === "/api/snapshots")).toEqual([]);
});
