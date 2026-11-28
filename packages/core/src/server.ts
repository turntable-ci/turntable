import type { AppAuth } from "./github/app-auth";
import type { ArtifactService } from "./artifacts/service";
import type { CacheService } from "./cache/service";
import type { Db } from "./db";
import type { BackupConfig } from "./db/backup";
import type { SettingsRuntime } from "./settings/resolve";
import { registry } from "./ops";
import type { ArtifactBlobs, ImageRegistrar } from "./ops/define";
import { buildOpenApi } from "./ops/openapi";
import { createMcpHttp } from "./mcp/http";
import {
  decideTransport,
  redirectResponse,
  rejectResponse,
  transportOptionsFromEnv,
  withHsts,
  withVersion,
  type TransportOptions,
} from "./transport";
import { createRestApi } from "./ops/rest";
import type { RelyingParty } from "./approvals/webauthn";
import type { LaneConfigClient } from "./release/channel-client";
import type { LaneAvailability } from "./release/supervisor";
import type { GithubFacts, GithubUserLookup } from "./github/api";
import type { ClaimHandler, InstallationClaims } from "./github/claim";
import type { AuthHandler } from "./auth/github-login";
import type { UserGithub } from "./auth/user-tokens";
import type { WebSessions } from "./auth/web-sessions";
import type { HostedManifestHandler } from "./github/hosted-manifest";
import { processDrain } from "./scheduler/drain";
import { createDeployGate } from "./deploy-gate";
import type { TrustedProxies } from "./github/trusted-proxies";
import type { DoctorReport } from "./doctor/types";
import type { ForwardedObserver } from "./doctor/observe";
import type { SecretStore } from "./secrets/store";
import type { SecretVault } from "./secrets/vault";
import { createRealtime, type WsData } from "./realtime/server";
import { createEventStream } from "./realtime/sse";
import type { WebhookService } from "./webhooks/service";
import { pageCsp, renderPage, servePageAsset } from "./pages/server-pages";
import { serveUi } from "./ui-assets";
import { BUILD_SHA, BUILD_TIME, VERSION } from "./version";
import type { RunDispatcher } from "./poll/dispatch";
import type {
  ContainerJobs,
  DefaultBranchRunner,
  RepoReaderFactory,
} from "./poll/onboarding-forge";

const PLACEHOLDER_HTML = renderPage({
  title: "Turntable",
  body: `<p>Pre-alpha. The web UI is not built yet.</p>
<p class="tt-muted">From source: run <code>bun run --cwd packages/ui build</code> and restart <code>serve</code> (or set <code>TURNTABLE_UI_DIR</code> to a built bundle).</p>`,
});

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": pageCsp(),
} as const;

/** Handler for `/api/v1/*`; resolves to undefined for any other path. */
export type ApiHandler = (req: Request, peer?: string) => Promise<Response | undefined>;

const OAUTH_PATHS = ["/.well-known", "/register", "/authorize", "/token", "/oauth"] as const;
const underPath = (path: string, base: string): boolean =>
  path === base || path.startsWith(`${base}/`);

/**
 * Paths no page answers: OAuth discovery and endpoints (this server has no OAuth), and any
 * `/api` or `/mcp` path nothing else matched. A client parses these as JSON, so never the app.
 */
function jsonNotFound(path: string): Response | undefined {
  const oauth = OAUTH_PATHS.some((b) => underPath(path, b));
  if (!oauth && !underPath(path, "/api") && !underPath(path, "/mcp")) return undefined;
  const message = oauth
    ? "this server does not implement OAuth; send a bearer token in the Authorization header"
    : "no such path";
  return new Response(JSON.stringify({ error: { code: "not_found", message } }), {
    status: 404,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const OPENAPI = JSON.stringify(buildOpenApi(registry, VERSION));

export async function handleRequest(
  req: Request,
  api?: ApiHandler,
  peer?: string,
): Promise<Response> {
  const apiResponse = await api?.(req, peer);
  if (apiResponse) return apiResponse;
  const url = new URL(req.url);
  const unrouted = jsonNotFound(url.pathname);
  if (unrouted) return unrouted;
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: SECURITY_HEADERS });
  }
  if (url.pathname === "/healthz") {
    // Still 200 while draining, so the platform keeps the old instance until its attempts finish.
    const body = processDrain.draining
      ? // Only the flag: /healthz is unauthenticated, so a running count would publish tenant
        // activity. The count is in the instance administrator's instance_drain_status.
        { ok: true, version: VERSION, build_sha: BUILD_SHA, built_at: BUILD_TIME, draining: true }
      : { ok: true, version: VERSION, build_sha: BUILD_SHA, built_at: BUILD_TIME };
    return Response.json(body, { headers: SECURITY_HEADERS });
  }
  if (url.pathname === "/openapi.json") {
    return new Response(OPENAPI, {
      headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" },
    });
  }
  const asset = servePageAsset(req);
  if (asset) return asset;
  const ui = serveUi(url, req.method, SECURITY_HEADERS);
  if (ui) return ui;
  if (url.pathname === "/") {
    return new Response(PLACEHOLDER_HTML, {
      headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("not found", { status: 404, headers: SECURITY_HEADERS });
}

export type ServeOptions = {
  /** Plain-http redirect and HSTS. Default: no proxy trusted, HSTS on over https. */
  transport?: TransportOptions;
  port: number;
  host: string;
  db: Db;
  /** Origins besides the page's own that may open a realtime socket. */
  allowedOrigins?: readonly string[];
  /** GitHub webhook endpoint, when a master key is configured. */
  webhooks?: { handle(req: Request, peer?: string): Promise<Response | undefined> };
  /** Per-org OIDC issuer endpoints, when a master key and a public URL are configured. */
  oidc?: { handle(req: Request): Promise<Response | undefined> };
  /** The secrets vault, when a master key is configured. */
  vault?: SecretVault;
  /** Installation claims (hosted): the start op and the setup callback. */
  claims?: { starter: InstallationClaims; handler: ClaimHandler };
  /**
   * Sign in with GitHub and web sessions (#430), when a master key and an https public URL are
   * set. Without it no session cookie is a credential and every `/auth/*` path falls through.
   */
  webAuth?: { sessions: WebSessions; handler: AuthHandler; userGithub?: UserGithub };
  /** GitHub API facts, for `resync_installation`. */
  githubFacts?: GithubFacts;
  /** Starts `workflow_dispatch` runs (the poller), for `run_dispatch`. */
  runDispatcher?: RunDispatcher;
  repoReader?: RepoReaderFactory;
  /** The preview's answer for a `services:` or `container:` job (#796). */
  containerJobs?: ContainerJobs;
  defaultBranchRunner?: DefaultBranchRunner;
  /** Resolves a GitHub login to its numeric id, for invites. */
  githubUsers?: GithubUserLookup;
  /** Creating the GitHub App from this instance (hosted, no shell): github/hosted-manifest.ts. */
  appManifest?: HostedManifestHandler;
  /** Proxies whose forwarded address the deploy gate's rate limit believes. */
  trustedProxies?: TrustedProxies;
  /** Egress modes the sandbox provider can enforce, for `set_project_egress`. */
  providerEgress?: (() => readonly string[] | undefined) | undefined;
  /** The provider's image registration, for `register_sandbox_image`. */
  imageRegistrar?: (() => ImageRegistrar | undefined) | undefined;
  /** The instance's per-org concurrency cap, the ceiling `set_quotas` clamps to. */
  instanceOrgCap?: number | undefined;
  /** `org-slug/project-slug` pairs the poll config names statically, for `list_projects`. */
  staticPollProjects?: readonly string[] | undefined;
  /** What `db_backup` needs: the data dir and database file, or the Postgres marker. */
  backup?: BackupConfig;
  /** The settings registry with its environment and turntable.toml layers (settings/boot.ts). */
  settings?: SettingsRuntime;
  /** WebAuthn relying party for human approvals. Absent: only offline ed25519 approvals work. */
  webauthn?: RelyingParty;
  /** The release lane's config channel, when configured (the instance's `release_*` ops). */
  releaseConfig?: LaneConfigClient;
  /** The supervised release lane, when this process runs it: `request_release` fails while it is down. */
  releaseLane?: { availability(): LaneAvailability };
  /** The artifact store's reads (the artifact download ops); absent when artifacts are off. */
  artifactBlobs?: ArtifactBlobs;
  /** The operator org (TURNTABLE_BOOTSTRAP_ORG, default `local`): its owners configure the release lane. */
  operatorOrgSlug?: string;
  /** The control-plane cache for jobs (`/_cache/...`), when a cache URL is configured. */
  cache?: CacheService;
  /** The artifact service for jobs (the twirp API and `/_artifacts/...`), when a URL is configured. */
  artifacts?: ArtifactService;
  /** Outbound webhook management ops, when a master key is configured. */
  outboundWebhooks?: WebhookService;
  /** Trust x-forwarded-proto from a proxy you control (for value-bearing requests). */
  trustForwardedProto?: boolean;
  /** The secret store, for `instance_audit_verify`'s public keys. */
  auditStore?: SecretStore | undefined;
  /** The App credential minter, for the instance App-secret ops. */
  appAuth?: AppAuth | undefined;
  /** The readiness checks, served by the `doctor` operation. */
  doctor?: () => Promise<DoctorReport>;
  /** Counts the forwarded headers requests carry, for doctor to compare with the settings. */
  forwarded?: ForwardedObserver;
};

export function startServer(options: ServeOptions) {
  const env = {
    registry,
    db: options.db,
    vault: options.vault,
    claims: options.claims?.starter,
    sessions: options.webAuth?.sessions,
    userGithub: options.webAuth?.userGithub,
    githubFacts: options.githubFacts,
    githubUsers: options.githubUsers,
    runDispatcher: options.runDispatcher,
    repoReader: options.repoReader,
    containerJobs: options.containerJobs,
    defaultBranchRunner: options.defaultBranchRunner,
    webhooks: options.outboundWebhooks,
    webauthn: options.webauthn,
    releaseConfig: options.releaseConfig,
    releaseLane: options.releaseLane,
    artifactBlobs: options.artifactBlobs,
    operatorOrgSlug: options.operatorOrgSlug,
    providerEgress: options.providerEgress,
    imageRegistrar: options.imageRegistrar,
    instanceOrgCap: options.instanceOrgCap,
    staticPollProjects: options.staticPollProjects,
    doctor: options.doctor,
    auditStore: options.auditStore,
    appAuth: options.appAuth,
    backup: options.backup,
    settings: options.settings,
  };
  const api = createRestApi(env, {
    trustForwardedProto:
      options.trustForwardedProto ?? options.transport?.trustForwardedProto === true,
  });
  const deployGate = createDeployGate({
    db: options.db,
    ...(options.trustedProxies ? { trustedProxies: options.trustedProxies } : {}),
  });
  const mcp = createMcpHttp(env);
  const realtime = createRealtime({
    env,
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
  });
  const sse = createEventStream({
    env,
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
  });
  const transport = options.transport ?? transportOptionsFromEnv({});
  const server = Bun.serve<WsData>({
    port: options.port,
    hostname: options.host,
    async fetch(req, srv) {
      options.forwarded?.record(req);
      const t = decideTransport(req, transport);
      if (t.action === "redirect") return withVersion(redirectResponse(t.location));
      if (t.action === "reject") return withVersion(rejectResponse());
      const res = await route(req, srv);
      if (res === undefined) return res;
      const versioned = withVersion(res);
      return t.secure ? withHsts(versioned, transport) : versioned;
    },
    error(err) {
      console.error("unhandled request error", err);
      return withVersion(new Response("internal server error", { status: 500 }));
    },
    websocket: realtime.websocket,
  });
  async function route(req: Request, srv: Bun.Server<WsData>): Promise<Response | undefined> {
    const gate = await deployGate.handle(req, srv.requestIP(req)?.address);
    if (gate) return gate;
    const hook = await options.webhooks?.handle(req, srv.requestIP(req)?.address);
    if (hook) return hook;
    const manifest = await options.appManifest?.handle(req, srv.requestIP(req)?.address);
    if (manifest) return manifest;
    const claimed = await options.claims?.handler.handle(req);
    if (claimed) return claimed;
    const signedIn = await options.webAuth?.handler.handle(req);
    if (signedIn) return signedIn;
    const idp = await options.oidc?.handle(req);
    if (idp) return idp;
    const cached = await options.cache?.handle(req);
    if (cached) return cached;
    const artifact = await options.artifacts?.handle(req);
    if (artifact) return artifact;
    const upgraded = await realtime.handle(req, srv);
    if (upgraded === "upgraded") return undefined;
    if (upgraded) return upgraded;
    const stream = await sse.handle(req, srv);
    if (stream) return stream;
    const mcpResponse = await mcp(req);
    if (mcpResponse) return mcpResponse;
    return handleRequest(req, api, srv.requestIP(req)?.address);
  }
  const stop = server.stop.bind(server);
  server.stop = (force?: boolean) => {
    realtime.stop();
    return stop(force);
  };
  return server;
}
