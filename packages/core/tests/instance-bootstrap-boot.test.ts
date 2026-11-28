// Booting `turntable serve` with TURNTABLE_INSTANCE_BOOTSTRAP_TOKEN_SHA256 (#330). Starts server
// processes, so it is SQLite only. Captures stdout and stderr: no hash or token may appear.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateInstanceToken, hashToken } from "../src/ops/tokens";

const MAIN = join(import.meta.dir, "../src/main.ts");
const tmp = mkdtempSync(join(tmpdir(), "tt-ibootstrap-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

async function boot(
  dir: string,
  env: Record<string, string> = {},
): Promise<{ code: number | null; out: string; listening: boolean }> {
  mkdirSync(join(dir, "data"), { recursive: true });
  const p = Bun.spawn([process.execPath, MAIN, "serve", "--port", "0", "--data-dir", "data"], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? dir,
      TURNTABLE_ALLOW_ROOT: "1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  const reads = [p.stdout, p.stderr].map(async (s) => {
    for await (const chunk of s) {
      out += new TextDecoder().decode(chunk);
      if (out.includes("listening on")) p.kill();
    }
  });
  const timer = setTimeout(() => p.kill(), 20_000);
  const code = await p.exited;
  clearTimeout(timer);
  await Promise.all(reads);
  return { code, out, listening: out.includes("listening on") };
}

const ENV = "TURNTABLE_INSTANCE_BOOTSTRAP_TOKEN_SHA256";

describe("boot with an instance bootstrap hash", () => {
  test("an empty directory boots without the variable", async () => {
    const r = await boot(join(tmp, `d${n++}`));
    expect(r.listening).toBe(true);
    expect(r.out).not.toContain("instance bootstrap");
  }, 30_000);

  test("registers once, then says it was ignored exactly once; nothing secret is logged", async () => {
    const secret = generateInstanceToken();
    const hash = hashToken(secret);
    const dir = join(tmp, `d${n++}`);
    const first = await boot(dir, { [ENV]: hash });
    expect(first.listening).toBe(true);
    expect(first.out).toContain("instance bootstrap: registered an instance token");
    const second = await boot(dir, { [ENV]: hash });
    expect(second.listening).toBe(true);
    expect(
      second.out.split("instance bootstrap hash ignored: an instance token exists").length,
    ).toBe(2);
    for (const r of [first, second]) {
      expect(r.out).not.toContain(hash);
      expect(r.out).not.toContain(secret);
    }
  }, 60_000);

  test("the legacy LONGSHORE_ name works through the legacy-env mapping", async () => {
    const hash = hashToken(generateInstanceToken());
    const r = await boot(join(tmp, `d${n++}`), {
      LONGSHORE_INSTANCE_BOOTSTRAP_TOKEN_SHA256: hash,
    });
    expect(r.out).toContain("instance bootstrap: registered an instance token");
    expect(r.out).not.toContain(hash);
  }, 30_000);

  test("a malformed hash stops the boot with a clear message that omits the value", async () => {
    const bad = generateInstanceToken(); // a token pasted by mistake
    const r = await boot(join(tmp, `d${n++}`), { [ENV]: bad });
    expect(r.listening).toBe(false);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`${ENV} must be 64 hex characters`);
    expect(r.out).not.toContain(bad);
  }, 30_000);
});
