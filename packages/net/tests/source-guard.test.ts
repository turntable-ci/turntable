// Source guard (issue #49): nothing outside the one outbound client may make a network request.
// Control-plane code must go through @turntable/net so every request gets address validation,
// pinned resolution, redirect rules and caps. A new caller that reaches for fetch fails here.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../../..");

/** Test files that call fetch, and only against servers they start themselves on loopback. */
const ALLOWED_TESTS = new Set<string>([
  "packages/core/tests/github-serve.test.ts", // the real server, on 127.0.0.1
  "packages/core/tests/release-prereqs.test.ts", // the real server, on 127.0.0.1
  "packages/core/tests/github-app.test.ts", // the manifest loopback page
  "packages/core/tests/github-hosted-manifest.test.ts", // the hosted manifest routes, on 127.0.0.1
  "packages/core/tests/server-pages.test.ts", // the CLI manifest loopback page, on 127.0.0.1
  "packages/core/tests/db-backup.test.ts", // fetches only its own Bun.serve on 127.0.0.1
  "packages/core/tests/cache.test.ts", // the cache service under test, on 127.0.0.1
  "packages/core/tests/mcp.test.ts", // the MCP transport, on 127.0.0.1
  "packages/core/tests/realtime.test.ts", // the realtime server, on 127.0.0.1
  "packages/core/tests/transport.test.ts", // the real server, on 127.0.0.1
  "packages/core/tests/tenant-isolation.test.ts", // the realtime WebSocket probe, on 127.0.0.1
  "packages/core/tests/token-realtime.test.ts", // the realtime server, on 127.0.0.1
  "packages/provider-daytona/tests/provider.test.ts", // a mock Daytona, on 127.0.0.1
  "packages/proxy/tests/proxy.test.ts", // the proxy under test, dialled on 127.0.0.1
  "packages/provider-daytona/tests/proxy-path.test.ts", // a local TLS endpoint and relay, on 127.0.0.1
  "packages/core/tests/proxy-wiring.test.ts", // the same proxy, dialled on 127.0.0.1
  "packages/core/tests/job-token-proxy.test.ts", // the same proxy, dialled on 127.0.0.1
  "packages/core/tests/release-compat.test.ts", // the release proxy, dialled on 127.0.0.1
  "packages/core/tests/proxy-e2e.test.ts", // the same proxy, dialled on 127.0.0.1 (CI only)
  "packages/core/tests/job-oidc.test.ts", // the same proxy, dialled on 127.0.0.1
  "packages/core/tests/vault-jwt-e2e.test.ts", // a Vault dev server in a container, on 127.0.0.1
  "packages/core/tests/artifact-service.test.ts", // the control server under test, on 127.0.0.1
  "packages/core/tests/artifact-egress-none.test.ts", // the proxy under test, dialled on 127.0.0.1
  "packages/core/tests/version-header.test.ts", // the server under test, on 127.0.0.1
  "packages/core/tests/release-lane-supervisor.test.ts", // the release proxy under test, dialled on 127.0.0.1
  "packages/core/tests/attempt-adopt-credentials.test.ts", // the adopted proxy under test, dialled on 127.0.0.1
  "packages/core/tests/attempt-adopt-hardening.test.ts", // the adopted proxy under test, raw CONNECT dial on 127.0.0.1
]);

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "data", "drizzle"]);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP_DIRS.has(e.name)) return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx|mts|js|mjs)$/.test(e.name) ? [p] : [];
  });
}

/** Source with comments removed, so prose about fetch is not a finding. */
function stripComments(src: string): string {
  return src.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const PATTERNS: [RegExp, string][] = [
  // a direct call of the global (a method named fetch, as in Bun.serve({ async fetch(req) {}}), is not)
  [/(^|[^\w$.#])fetch\s*\((?!.*\)\s*(\{|:\s*Promise|=>\s*\{))/m, "calls the global fetch"],
  [/(\?\?|\|\||=)\s*fetch\b(?!\s*[:(?])/, "takes the global fetch as a value"],
  [/:\s*fetch\s*[,}]/, "passes the global fetch as a value"],
  [/\b(globalThis|window|self)\.fetch\b|\bBun\.fetch\b/, "uses fetch off a global"],
  [/from\s+["'](node:)?(http|https|http2)["']/, "imports an HTTP client module"],
  [/from\s+["'](undici|axios|got|node-fetch|ky|superagent)["']/, "imports an HTTP client library"],
  [
    /\b(net|tls)\.(connect|createConnection)\s*\(|\bBun\.connect\s*\(|\bXMLHttpRequest\b|new\s+WebSocket\s*\(/,
    "opens a raw connection",
  ],
];

test("only the outbound client reaches the network", () => {
  const violations: string[] = [];
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file);
    if (rel.startsWith("packages/net/src/")) continue; // the client itself
    if (rel.startsWith("packages/ui/")) continue; // browser code: it runs in the user's browser
    if (rel === "packages/net/tests/source-guard.test.ts") continue; // names the patterns
    if (ALLOWED_TESTS.has(rel)) continue;
    const src = stripComments(readFileSync(file, "utf8"));
    for (const [re, why] of PATTERNS) if (re.test(src)) violations.push(`${rel}: ${why}`);
  }
  expect(violations).toEqual([]);
});

test("the allowlist only names test files that exist and still need it", () => {
  for (const rel of ALLOWED_TESTS) {
    const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
    expect(PATTERNS.some(([re]) => re.test(src))).toBe(true);
  }
});

test("the guard catches the shapes it exists for", () => {
  const hit = (code: string): boolean => PATTERNS.some(([re]) => re.test(stripComments(code)));
  for (const bad of [
    'await fetch("https://x")',
    "const res = await fetch(url, { method: 'POST' });",
    "const f = o.fetch ?? fetch;",
    "return (opts.fetch ?? fetch)(url);",
    "this.doFetch = o.fetch || fetch;",
    "foo({ fetch: fetch })",
    "globalThis.fetch(u)",
    'import http from "node:http";',
    'import { request } from "node:https";',
    'import axios from "axios";',
    "net.connect(80, host)",
    "new WebSocket(url)",
  ]) {
    expect(hit(bad)).toBe(true);
  }
  for (const ok of [
    "async fetch(req, srv) {",
    "  async fetch(req: Request): Promise<Response> {",
    "fetch?: SafeFetch;",
    "type X = typeof fetch;",
    "// await fetch(url)",
    "/* fetch(url) */",
    'run("git", ["fetch", "-q"])',
    "const r = await safeFetch(url);",
    "this.#fetch = o.fetch ?? safeFetch;",
    "await client.fetch(url)",
  ]) {
    expect(hit(ok)).toBe(false);
  }
});
