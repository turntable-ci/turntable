// Every test file must be named in a test group file (scripts/test-groups/<group>.txt) or in some
// package.json script, or CI never runs it. `bun run test` runs only the `test:*` scripts, each an
// explicit file list, so a test file added without a list entry passes review and goes green while
// testing nothing. This guard fails the build for it.
// A file that must not run in CI goes in ALLOWED below, with the reason.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GATED, readGroup, testScripts, parseGroupCall } from "./test-groups";

const root = join(import.meta.dir, "..");

/** Test files that are on purpose in no script, with why. Keep this list short. */
export const ALLOWED: Record<string, string> = {
  "packages/provider-daytona/tests/conformance.test.ts":
    "live-gated: needs a real Daytona account (TT_DAYTONA_CONFORMANCE=1), run by packages/provider-daytona/scripts/live-check.ts",
};

const TEST_FILE = /\.test\.ts$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEST_FILE.test(name)) out.push(full);
  }
  return out;
}

/** Test files of the repo, root-relative with forward slashes: each package's tests/, and scripts/. */
export function testFiles(repo: string = root): string[] {
  const dirs = [join(repo, "scripts")];
  for (const p of readdirSync(join(repo, "packages"))) {
    const t = join(repo, "packages", p, "tests");
    if (existsSync(t)) dirs.push(t);
  }
  return dirs
    .filter(existsSync)
    .flatMap((d) => walk(d))
    .map((f) => f.slice(repo.length + 1))
    .toSorted();
}

/** Every path-like word in every script of the root and package package.json files, plus every line of the test group files of the root `test:*` scripts, root-relative. */
export function scriptPaths(repo: string = root): Set<string> {
  const out = new Set<string>();
  const add = (pkgFile: string, base: string): void => {
    if (!existsSync(pkgFile)) return;
    const scripts = (
      JSON.parse(readFileSync(pkgFile, "utf8")) as { scripts?: Record<string, string> }
    ).scripts;
    for (const cmd of Object.values(scripts ?? {}))
      for (const w of cmd.split(/\s+/)) {
        const word = w.replace(/^["']|["']$/g, "").replace(/^\.\//, "");
        if (TEST_FILE.test(word)) out.add(base === "" ? word : `${base}/${word}`);
      }
  };
  add(join(repo, "package.json"), "");
  for (const cmd of Object.values(testScripts(repo))) {
    const call = parseGroupCall(cmd);
    if (call) for (const f of readGroup(call.group, repo)) if (TEST_FILE.test(f)) out.add(f);
  }
  for (const p of readdirSync(join(repo, "packages")))
    add(join(repo, "packages", p, "package.json"), `packages/${p}`);
  return out;
}

/** The test files no script names and the allowlist does not excuse, plus stale allowlist entries. */
export function problems(
  files: readonly string[],
  named: ReadonlySet<string>,
  allowed: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = [];
  for (const f of files)
    if (!named.has(f) && !(f in allowed))
      out.push(`${f} is in no test group file or package.json script, so CI never runs it`);
  for (const [f, why] of Object.entries(allowed)) {
    if (!files.includes(f)) out.push(`allowlist entry ${f} is not a test file (stale)`);
    else if (named.has(f))
      out.push(`allowlist entry ${f} is in a script now: remove it from the list`);
    if (why.trim() === "") out.push(`allowlist entry ${f} has no reason`);
  }
  return out;
}

describe("every test file runs in CI", () => {
  test("each packages/*/tests and scripts test file is in a package.json script, or allowed with a reason", () => {
    expect(problems(testFiles(), scriptPaths(), ALLOWED)).toEqual([]);
  });

  test("the guard finds the files (not an empty pass)", () => {
    const files = testFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("scripts/test-wiring.test.ts");
    expect(scriptPaths().has("scripts/test-wiring.test.ts")).toBe(true);
  });
});

describe("the check itself", () => {
  const files = ["packages/a/tests/x.test.ts", "packages/a/tests/y.test.ts"];
  test("a test file in no script is reported; a listed one is not", () => {
    expect(problems(files, new Set(["packages/a/tests/x.test.ts"]), {})).toEqual([
      "packages/a/tests/y.test.ts is in no test group file or package.json script, so CI never runs it",
    ]);
  });
  test("a longer path that merely contains a name does not count as naming it", () => {
    const named = new Set(["packages/a/tests/xx.test.ts", "packages/a/tests/y.test.ts"]);
    expect(problems(files, named, {})).toHaveLength(1);
  });
  test("the allowlist excuses a file, but a stale, redundant or reasonless entry is itself a problem", () => {
    const named = new Set(["packages/a/tests/x.test.ts"]);
    expect(problems(files, named, { "packages/a/tests/y.test.ts": "live-gated" })).toEqual([]);
    expect(
      problems(files, new Set(files), { "packages/a/tests/gone.test.ts": "x" }).join("\n"),
    ).toContain("stale");
    expect(problems(files, new Set(files), { "packages/a/tests/y.test.ts": "x" })[0]).toContain(
      "remove it",
    );
    expect(problems(files, named, { "packages/a/tests/y.test.ts": " " }).join("\n")).toContain(
      "no reason",
    );
  });
});

// A suite that sets a TT_*_E2E flag needs Docker or a live service. Left in the `bun run test`
// aggregate, it also runs in `check` wherever that job runs, including a hosted sandbox with no
// Docker daemon, where it fails as infra_error (#412). Gated, it must have a CI step of its own,
// or it never runs anywhere.
describe("gated suites (#412)", () => {
  const scripts = testScripts(root);
  const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
  /** Suites run another way than `bun run <name>` in ci.yml, with how. */
  const RUN_ELSEWHERE: Record<string, string> = {
    "test:pg-only": "the postgres jobs run it through `bun run pg:test`",
  };

  test("every suite that sets a TT_*_E2E flag is gated out of the aggregate", () => {
    const e2e = Object.entries(scripts)
      .filter(([, cmd]) =>
        (parseGroupCall(cmd)?.env ?? []).some((e) => /^TT_[A-Z0-9_]*E2E=1$/.test(e)),
      )
      .map(([k]) => k);
    expect(e2e.length).toBeGreaterThan(0);
    expect(e2e.filter((k) => !GATED.has(k))).toEqual([]);
  });

  test("every gated suite exists and has its own CI step", () => {
    const missing = [...GATED].filter((k) => !(k in scripts));
    expect(missing).toEqual([]);
    const noStep = [...GATED].filter((k) => {
      if (k in RUN_ELSEWHERE) return false;
      const step = new RegExp(`^\\s+(?:- )?run: bun run ${k.replace(/[-:]/g, "\\$&")}\\s*$`, "m");
      return !step.test(ci);
    });
    expect(noStep).toEqual([]);
    expect(ci).toMatch(/^\s+run: bun run pg:test\s*$/m);
  });
});
