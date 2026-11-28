import "./legacy-env-boot";
import { egressProbeConfigFromEnv, startEgressProbe } from "./egress-probe";
import { startLoopLag } from "./loop-lag";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { allowHostsFromEnv } from "@turntable/net";
import type { Provider } from "@turntable/provider-sdk";
import { checkoutConfigFromEnv } from "./run/checkout-child";
import { addNotice, type Db, ensureInstance, getAttempt, openDatabase } from "./db";
import {
  githubFacts,
  type GithubFacts,
  githubUserLookup,
  type GithubUserLookup,
} from "./github/api";
import { adoptPolledBindings } from "./github/installations";
import { CheckReporter } from "./checks/reporter";
import { githubCheckRunsApi } from "./checks/client";
import { AppAuth } from "./github/app-auth";
import { registerCredentialRevoker } from "./incident";
import { createForgeToken } from "./pins/forge-token";
import { createHostedManifestHandler, type HostedManifestHandler } from "./github/hosted-manifest";
import { parseTrustedProxies } from "./github/trusted-proxies";
import { createWebhookHandler, type WebhookHandler } from "./github/webhook";
import {
  createClaimHandler,
  githubUserVerifier,
  InstallationClaims,
  type ClaimHandler,
} from "./github/claim";
import { type AuthHandler, createAuthHandler, githubIdentityVerifier } from "./auth/github-login";
import { githubUserApi, type UserGithub, UserTokens } from "./auth/user-tokens";
import { WebSessions } from "./auth/web-sessions";
import { AuditAnchor } from "./audit/anchor";
import { backupBeforeMigrate, backupKeepFromEnv } from "./db/backup";
import { ambientSettings, setAmbientSettings } from "./settings/ambient";
import { loadSettingsRuntime } from "./settings/boot";
import { LiveLimits } from "./scheduler/live-limits";
import { dockerRefusal, setOperatorSizes } from "./scheduler/sandbox-size";
import { DIALECT } from "./db/dialect";
import { SYSTEM_ORG_SLUG } from "./audit/failures";
import { startCheckpointer } from "./audit/checkpoint";
import { createAnchorExporter } from "./audit/anchor-export";
import { takeAuditWebhookSecret } from "./audit/webhook-secret";
import { jsonlSink, startExporter, webhookSink, type AuditSink } from "./audit/export";
import { bootstrapToken } from "./ops/bootstrap";
import {
  anchorKeyMessage,
  auditStateDir,
  MasterKeyConfigError,
  takeMasterKeys,
  type MasterKeys,
} from "./secrets/master-key";
import { rewrapMasterKey } from "./secrets/rewrap";
import { RETIRE_FILE_ENV, retireMasterKeyFile } from "./secrets/retire-key-file";
import { autoInitMasterKey, autoInitRequested } from "./secrets/autoinit";
import { appendAudit } from "./db/repos";
import { backfillApprovalDefaultStrict } from "./db/repos/approval-default";
import {
  egressProbe as networkProbe,
  networkProbeConfig,
  type ProbeCheck,
  processNetwork,
} from "./network";
import { systemOrgId } from "./audit/failures";
import { SecretStore } from "./secrets/store";
import { relyingPartyFromEnv } from "./approvals/config";
import { createOidcHandler, type OidcHandler } from "./oidc/http";
import { NotificationEngine } from "./notifications/rules";
import { defaultSettleMs, WebhookService } from "./webhooks/service";
import { OidcIssuer, parseAllowClasses } from "./oidc/issuer";
import { JobOidc } from "./oidc/job-delivery";
import { artifactTargetOf, githubTargetOf, SecretsProxy, withSecretsProxy } from "./proxy";
import { attemptSeeds, type AttemptSeeds } from "./scheduler/adopt-credentials";
import { JobTokens, publicRepoCheck } from "./github/job-token";
import { ArtifactGrants } from "./artifacts/grants";
import { jobArtifactProvider } from "./artifacts/job";
import { createArtifactService, type ArtifactService } from "./artifacts/service";
import { FsArtifactStore } from "./artifacts/store";
import { CacheGrants } from "./cache/grants";
import { jobCacheProvider } from "./cache/job";
import { createCacheService, type CacheService } from "./cache/service";
import { FsCacheStore } from "./cache/store";
import { SecretVault } from "./secrets/vault";
import { logStoreConfigFromEnv, openLogStore } from "./logstore/config";
import { createDropReporter } from "./logstore/outage";
import { setLogStore } from "./logstore/registry";
import { bootstrapExpiryDays, bootstrapInstanceToken } from "./ops/instance-bootstrap";
import { generateInstanceToken, generateToken, hashToken } from "./ops/tokens";
import { DispatchError, Poller, type RunDispatcher } from "./poll";
import type {
  ContainerJobs,
  DefaultBranchRunner,
  RepoReaderFactory,
} from "./poll/onboarding-forge";
import {
  resolvePollConfig,
  resolveProviderConfig,
  resolveSandboxSizes,
  serveDefaults,
} from "./serve-config";
import {
  createActRunner,
  createProvider,
  gitRepoSource,
  CHECKOUT_PERMISSIONS,
  adoptRecordedSandboxes,
  reconcileExpired,
  sweepUndestroyedSandboxes,
  type AttemptRunner,
  Scheduler,
  withEgressPolicy,
  withIsolationPolicy,
} from "./scheduler";
import { createTokenFromCli, listTokensFromCli, revokeTokenFromCli } from "./ops/token-cli";
import { dropForCommand } from "./command-privileges";
import { enforceRootPolicy } from "./privileges";
import { mainRuntime, releaseLaneConfigured, resolveRoles, takeReleaseKeys } from "./roles";
import {
  type ChannelClient,
  createChannelClient,
  laneConfigClientFromEnv,
  withReleaseChannel,
} from "./release/channel-client";
import {
  DEFAULT_DRAIN_TIMEOUT_SECONDS,
  drainTimeoutSecondsSetting,
  settingsRegistry,
} from "./settings/definitions";
import { withoutRefusals } from "./settings/define";
import { resolveSetting } from "./settings/resolve";
import { cachedDoctor } from "./doctor/cache";
import { runDoctor } from "./doctor/checks";
import { countHumanWithAnyKeyPolicy, countHumanWithoutApprover } from "./ops/setting-guard";
import { ForwardedObserver } from "./doctor/observe";
import { readerOf, realInputs } from "./doctor/real";
import { serveRelease } from "./release/serve";
import {
  LANE_CHILD_ENV,
  LaneSupervisor,
  type PreparedLane,
  laneSupervised,
  prepareSupervisedLane,
} from "./release/supervisor";
import { staticPollKey } from "./ops/project-setup";
import type { ImageRegistrar } from "./ops/define";
import { startServer } from "./server";
import { enableDevUi, hasUi } from "./ui-assets";
import { transportOptionsFromEnv } from "./transport";
import { VERSION, assertValidVersion } from "./version";

const USAGE = `turntable ${VERSION}

Usage:
  turntable serve [--roles web,worker,poller|all|release] [--port 8080] [--host 127.0.0.1] [--data-dir ./data]
                  [--database-url postgres://...]
                  [--allowed-origin <origin>]
                  [--public-url <base url>]
                  [--worker [--provider docker|daytona] [--provider-config <file>] [--global-cap 4]
                   [--org-cap 2] [--lease-seconds 30] [--image <ref>] [--hosted]
                   [--isolation-override <reason>]]
                  [--poll <config.json>] [--config <turntable.toml>]
  turntable oidc status|rotate|export --org <slug> (see turntable oidc)
  turntable secret set|rotate|delete|list --org <slug> --name <NAME> (--value-file <path> | --value-stdin)
  turntable audit init-key|adopt|verify|checkpoint|export-key|export (see turntable audit)
  turntable policy show | set [--org local] [--project local] [--require-sha-pins true|false]
                              [--allow-owners a,b | --clear-allowlist] [--data-dir ./data]
  turntable keys init [--file <path>] [--data-dir ./data]
  turntable github-app create --url <public base url> [--org <github org>] [--name Turntable]
                              [--turntable-org local] [--master-key-file <path>]
  turntable github-app rotate-webhook-secret | status [--master-key-file <path>] [--data-dir ./data]
  turntable token create --instance --name <name> [--expires-days 30] [--data-dir ./data]
                         (an instance-administrator token: REST only, for quotas; list and revoke take --instance too)
  turntable token create --org <slug> [--project <slug>] --role <reader|operator|release_operator>
                         [--kind <agent|person>] --name <name> [--expires-days 90] [--data-dir ./data]
  turntable token generate [--instance]
  turntable token rotate <id> --instance [--name <name>] [--expires-days 30] [--data-dir ./data]
  turntable token list --org <slug> [--project <slug>] [--data-dir ./data]
  turntable token revoke <id> [--data-dir ./data]
  turntable run <workflow-path> -j <job> [--repo <dir>] [--image <ref>] [--data-dir ./data] [--event push] [--egress none|open]
  turntable policy set approve-run-min-role <operator|release_operator> [--org local]
  turntable policy set --egress <none|open|allowlist> [--org local] [--project <slug>]
  turntable policy set --checks-mode <off|shadow|live> [--org local] [--project <slug>]
  turntable mcp [--token-file <path>] [--data-dir ./data]
  turntable approvals keygen|bootstrap|sign|approve-release|policy|list|revoke ...   (human approvals; see docs/security.mdx)
  turntable incident freeze|unfreeze|status --org <slug> [--project <slug>] [--reason <text>]
  turntable db backup [--keep <n>] [--data-dir ./data]  (SQLite backup into <data-dir>/backups; not for Postgres)
  turntable quotas show|set --org <slug> [--max-concurrent <n|none> ...] [--data-dir ./data]
  turntable artifacts list|check --url <https://host> --org <slug> --project <slug> [--run <id>] [--token-file <path>]
  turntable quotas get --url <https://host> --org <slug> [--token-file <path>]  (remote read)
  turntable usage --url <https://host> [--days <n>] [--by-project] [--token-file <path>]  (sandbox minutes per day, remote read)
  turntable channel --url <https://host> --org <slug> [--token-file <path>] [--project a,b]
                    [--branch main] [--types run.finished,approval.required] [--state-file <path>]
  turntable fetch-source <owner/name> <sha> [--file <path>]   check that a commit can be fetched, as a worker does
  turntable parity --run <id> --repo <owner/name> --app-id <n> [--json]   compare a run with another CI's checks
  turntable doctor [--data-dir ./data] [--json] [--strict]   read-only readiness check before going live
  turntable verify <artifact> --provenance <file> --pubkey <file> [--name <subject>]
  turntable version

Environment:
  PORT  default for --port (Railway and similar hosts set it)
  TURNTABLE_BOOTSTRAP_TOKEN_SHA256  sha256 of a token from "turntable token generate"; on boot, an
                    org with no tokens gets one operator token with this hash
  TURNTABLE_INSTANCE_BOOTSTRAP_TOKEN_SHA256  sha256 of a token from "turntable token generate --instance"; on boot, an
                    instance with no active (unexpired, unrevoked) instance token gets one (30 days at most). Rotate it, then remove the variable
  TURNTABLE_INSTANCE_BOOTSTRAP_EXPIRY_DAYS  lifetime of that token, 1 to 30 (default 30)
  TURNTABLE_BOOTSTRAP_ORG  org for the bootstrap token (default local)
  TURNTABLE_MASTER_KEY_AUTOINIT  set to 1 (or serve --init-master-key) to create TURNTABLE_MASTER_KEY_FILE on first boot when it is
                    absent (a host with no shell); never overwrites an existing file
  TURNTABLE_MASTER_KEY_FILE  32-byte master key file for the encrypted secret store (turntable keys init);
                    required for the GitHub App and its webhook endpoint (or TURNTABLE_MASTER_KEY, not both)
  TURNTABLE_MASTER_KEY  the master key itself, 32 bytes as base64 or hex, so it stays off the data volume; read once at
                    boot and removed from the environment. TURNTABLE_MASTER_KEY_PREVIOUS (or _FILE) re-wraps every sealed row
                    under the new key at that boot, in one transaction; remove it afterwards
  TURNTABLE_MASTER_KEY_RETIRE_FILE  path of the old key file in the data dir; after the re-wrap is verified, with
                    TURNTABLE_MASTER_KEY in use and the file equal to the previous key, it is deleted once; remove it afterwards
  TURNTABLE_AUDIT_EXPORT_DIR  rotate audit entries and checkpoints to JSONL files here
  TURNTABLE_AUDIT_WEBHOOK_URL  POST audit batches here (HMAC with TURNTABLE_AUDIT_WEBHOOK_SECRET_FILE)
  TURNTABLE_OIDC_BASE_URL  base of the per-org OIDC issuers (default <public url>/oidc); an org's issuer
                    is <base>/<org slug>. Needs TURNTABLE_MASTER_KEY_FILE
  TURNTABLE_OIDC_ALLOW_CLASSES  trust classes that may get an OIDC token (default protected,release;
                    untrusted_pr is refused unless you list it, which you should not)
  TURNTABLE_TRUST_FORWARDED_PROTO  set to 1 behind a TLS-terminating proxy you control: plain-http requests it
                    forwards get a 301 to https (GET and HEAD; 400 otherwise), and secret values
                    sent over x-forwarded-proto: https are accepted
  TURNTABLE_DATABASE_URL  Postgres connection URL (default for --database-url); every subcommand that opens
                    the database uses it. Without it the database is SQLite in the data dir
  TURNTABLE_BACKUP_BEFORE_MIGRATE  set to 1 to back up the SQLite database (under <data-dir>/backups) at boot,
                    when migrations are pending and before they run; a failed backup stops the boot
  TURNTABLE_BACKUP_KEEP  how many backups to keep (default 10), for "db backup" and the db_backup operation
  TURNTABLE_CONFIG  path of a turntable.toml of settings (default for --config); the environment beats the file
  TURNTABLE_HSTS_MAX_AGE  Strict-Transport-Security max-age in seconds for https responses (default 31536000;
                    0 or off disables); TURNTABLE_HSTS_INCLUDE_SUBDOMAINS=0 drops includeSubDomains
  TURNTABLE_DROP_PRIVILEGES  <uid>:<gid>; when started as root, chown the data dir to it and drop to it
                    before opening anything (the image sets 65532:65532)
  TURNTABLE_ALLOW_ROOT  set to 1 to keep running as root (otherwise a root server is refused)
  TURNTABLE_RELEASE_*  belong to "serve --roles release" alone (its own master key file, data dir, forge
                    token, artifact dir): the release lane runs as its own process and no other role reads them
  TURNTABLE_TOKEN_FILE  token file for "turntable mcp" (mode 0600; never pass a token on the command line)
  TURNTABLE_WEBAUTHN_RP_ID, TURNTABLE_WEBAUTHN_ORIGINS  WebAuthn relying party for human approvals (default: the public URL)
  TURNTABLE_CACHE_URL  base URL jobs reach the control-plane cache at (enables it; see docs/cache.mdx)
  TURNTABLE_ARTIFACTS_URL  base URL jobs reach the control plane at for upload/download-artifact (enables it; see docs/compatibility.mdx)
  TURNTABLE_ARTIFACT_MAX_GIB, TURNTABLE_ARTIFACT_RETENTION_DAYS  largest artifact (default 2) and how long blobs are kept (default 90)
  TURNTABLE_CACHE_QUOTA_GIB, TURNTABLE_CACHE_MAX_ENTRY_GIB  per-org cache quota (default 10) and largest entry (default 2)
  TURNTABLE_PUBLIC_URL  default for --public-url: the server's public base URL, linked from check runs
  TURNTABLE_TRUSTED_PROXIES  comma-separated addresses and CIDR ranges of the proxies in front of the server;
                    the webhook failure limiter keys on the client the forwarded chain reports through them
  TURNTABLE_GITHUB_APP_SETUP_TOKEN_SHA256  sha256 of a setup token (turntable token generate): enables creating the
                    GitHub App from this instance at /api/v1/instance/github-app/manifest; needs TURNTABLE_PUBLIC_URL
  TURNTABLE_CLAIM_INSTALLATIONS  set to 1 on a hosted instance: an org claims its own App installation
                    (start_installation_claim, then GitHub redirects to /api/v1/github/setup)
  TURNTABLE_WORKER, TURNTABLE_PROVIDER, TURNTABLE_PROVIDER_CONFIG, TURNTABLE_POLL, TURNTABLE_IMAGE,
  TURNTABLE_GLOBAL_CAP, TURNTABLE_ORG_CAP, TURNTABLE_LEASE_SECONDS, TURNTABLE_ISOLATION_OVERRIDE, TURNTABLE_DATA_DIR
                    the environment equivalent of each serve flag (a flag wins)
  TURNTABLE_POLL_JSON, TURNTABLE_PROVIDER_CONFIG_JSON  the poll and provider configs as JSON, for hosts with no files
  TURNTABLE_HOST  default for --host (the container image sets 0.0.0.0)
  TURNTABLE_ALLOWED_ORIGINS  comma-separated extra origins allowed to open the realtime WebSocket
`;

/** Starts the worker and the poller when asked for. Returns a stop function. */
async function startBackground(
  db: Db,
  v: {
    worker?: boolean | undefined;
    "global-cap"?: string | undefined;
    "org-cap"?: string | undefined;
    "lease-seconds"?: string | undefined;
    image?: string | undefined;
    poll?: string | undefined;
    provider?: string | undefined;
    "provider-config"?: string | undefined;
    hosted?: boolean | undefined;
    "isolation-override"?: string | undefined;
  },
  observer?: CheckReporter,
  extras: {
    auth?: AppAuth;
    vault?: SecretVault;
    cache?: CacheService;
    artifacts?: ArtifactService;
    jobOidc?: JobOidc;
    /**
     * Per-attempt seeds from the master key (#787): proxy and artifact credentials are derived
     * from them, so the next controller can take over a running attempt that holds them.
     */
    seeds?: AttemptSeeds;
    /** The supervised lane's channel client (no channel files: its keys are made at boot). */
    laneChannel?: ChannelClient;
  } = {},
): Promise<{
  stop(): Promise<void>;
  nudge(repo: string): boolean;
  dispatch: RunDispatcher | undefined;
  repoReader: RepoReaderFactory | undefined;
  runDefaultBranch: DefaultBranchRunner | undefined;
  containerJobs: ContainerJobs | undefined;
  /** Egress modes the worker's provider can enforce; undefined without a worker role. */
  providerEgress(): readonly string[] | undefined;
  /** The worker's provider's image registration; undefined without one. */
  imageRegistrar(): ImageRegistrar | undefined;
}> {
  const log = (m: string) => console.log(`[turntable] ${m}`);
  // Loaded first: the worker uses the poll token to resolve actions for the repos it watches.
  const pollConfig = resolvePollConfig(v.poll);
  // Egress health (#698): a probe every 15 s of the forge API and, with a remote provider, its API.
  const probeChecks: ProbeCheck[] = [];
  const netCfg = networkProbeConfig(
    process.env,
    v.provider ?? "docker",
    pollConfig?.apiBaseUrl ?? "https://api.github.com",
  );
  processNetwork.configure({
    ...(netCfg.enabled
      ? {
          probe: networkProbe({
            targets: [{ label: "forge", url: netCfg.forgeUrl }],
            checks: () => probeChecks,
          }),
        }
      : {}),
    maxDegradedMs: netCfg.maxDegradedMs,
    onGiveUp: () =>
      log(
        `network still degraded after ${Math.round(netCfg.maxDegradedMs / 60_000)} min: claims resume anyway; check the probe's targets (doctor egress)`,
      ),
    onChange: (state, snap) => {
      log(
        `network ${state}${state === "degraded" ? ": no new attempt starts until it recovers" : ""}`,
      );
      void (async () => {
        await appendAudit(
          db,
          { orgId: await systemOrgId(db) },
          {
            principalKind: "system",
            principalId: "network-probe",
            op: "network.state_change",
            effect: "write",
            outcome: "ok",
            input: { state, since: snap.since, failures: snap.consecutive_failures },
          },
        );
      })().catch((err) => log(`network state change not audited: ${String(err)}`));
    },
  });
  let scheduler: Scheduler | undefined;
  let liveLimits: LiveLimits | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let poller: Poller | undefined;
  let workerProvider: Provider | undefined;
  // The size map read at startup, the same snapshot the scheduler routes with (#796).
  let startupSizes: ReturnType<typeof resolveSandboxSizes>;
  let secretsProxy: SecretsProxy | undefined;

  if (v.worker) {
    const providerName = v.provider ?? "docker";
    // One live-limits reader for the claim loop and the provider's create-time hook (#661).
    liveLimits = new LiveLimits(db);
    const limits = liveLimits;
    const provider = createProvider(providerName, resolveProviderConfig(v["provider-config"]), {
      hosted: v.hosted === true || process.env.TURNTABLE_HOSTED === "1",
      // Read at each create: the last value the claim loop read, never a restart's.
      limits: () => {
        const d = limits.last()?.daytona;
        return { maxLive: d?.maxLive, cpuLimit: d?.cpuLimit };
      },
    });
    workerProvider = provider;
    if (providerName === "daytona") {
      probeChecks.push({ label: "provider", run: () => provider.healthcheck() });
    }
    if (netCfg.enabled) processNetwork.start();
    // Fail at startup, with the provider named, instead of at the first job.
    try {
      await provider.healthcheck();
    } catch (err) {
      throw new Error(
        `provider ${providerName} is not usable: ${err instanceof Error ? err.message : "error"}`,
        { cause: err },
      );
    }
    // One provider per server for now; the name stored on an attempt is the provider it was made for.
    const providers = () => provider;
    const override = v["isolation-override"]?.trim();
    if (v["isolation-override"] !== undefined && !override) {
      throw new Error(
        "--isolation-override needs a reason (it is audited and shown on affected runs)",
      );
    }
    if (override) log(`isolation override ON: ${override}`);
    const leaseMs = Number(v["lease-seconds"]) * 1000;
    // The secrets proxy (#15): opt in, and only with a vault. A job whose project has proxy rules
    // runs with no route but the proxy; see docs/secrets-proxy.mdx.
    if (process.env.TURNTABLE_SECRETS_PROXY === "1") {
      if (!extras.vault) {
        throw new Error("TURNTABLE_SECRETS_PROXY=1 needs the vault (a master key)");
      }
      const port = process.env.TURNTABLE_PROXY_PORT?.trim();
      secretsProxy = await SecretsProxy.start({
        db,
        vault: extras.vault,
        ...(extras.seeds ? { seeds: extras.seeds } : {}),
        ...(port ? { port: Number(port) } : {}),
        ...(process.env.TURNTABLE_PROXY_BIND?.trim()
          ? { bindHost: process.env.TURNTABLE_PROXY_BIND.trim() }
          : {}),
        ...(process.env.TURNTABLE_PROXY_ADVERTISE_HOST?.trim()
          ? { advertiseHost: process.env.TURNTABLE_PROXY_ADVERTISE_HOST.trim() }
          : {}),
        // A public TLS listener, for sandboxes in another provider's network (Daytona).
        ...(process.env.TURNTABLE_PROXY_TLS_CERT_FILE?.trim() ||
        process.env.TURNTABLE_PROXY_TLS_KEY_FILE?.trim()
          ? { tls: readProxyTls() }
          : {}),
        ...(process.env.TURNTABLE_PROXY_ADVERTISE_PORT?.trim()
          ? { advertisePort: Number(process.env.TURNTABLE_PROXY_ADVERTISE_PORT.trim()) }
          : {}),
        ...(process.env.TURNTABLE_PROXY_ADVERTISE_ADDRESSES?.trim()
          ? {
              advertiseAddresses: process.env.TURNTABLE_PROXY_ADVERTISE_ADDRESSES.split(",")
                .map((a) => a.trim())
                .filter(Boolean),
            }
          : {}),
        log,
      });
      log(`secrets proxy listening on port ${secretsProxy.port}`);
    }
    // A GitHub token per job (see github/job-token), when the App is configured.
    const jobTokens =
      extras.auth && process.env.TURNTABLE_JOB_TOKENS !== "off"
        ? new JobTokens(extras.auth, { isPublic: publicRepoCheck({ auth: extras.auth }) })
        : undefined;
    // Compat publishing: a release-class job may ask the release lane for a release-proxy
    // credential. This process holds only the request key, never a publish credential.
    const channelKey = process.env.TURNTABLE_PUBLISH_CHANNEL_KEY_FILE?.trim();
    const publishChannel = extras.laneChannel
      ? extras.laneChannel
      : channelKey
        ? createChannelClient({
            key: readFileSync(channelKey, "utf8").trim(),
            target: process.env.TURNTABLE_PUBLISH_CHANNEL_URL?.trim()
              ? {
                  url: process.env.TURNTABLE_PUBLISH_CHANNEL_URL.trim(),
                  tls: {
                    cert: readFileSync(
                      requiredEnv("TURNTABLE_PUBLISH_CHANNEL_TLS_CERT_FILE"),
                      "utf8",
                    ),
                    key: readFileSync(
                      requiredEnv("TURNTABLE_PUBLISH_CHANNEL_TLS_KEY_FILE"),
                      "utf8",
                    ),
                    ca: readFileSync(requiredEnv("TURNTABLE_PUBLISH_CHANNEL_TLS_CA_FILE"), "utf8"),
                  },
                }
              : { unix: requiredEnv("TURNTABLE_PUBLISH_CHANNEL_SOCKET") },
          })
        : undefined;
    // The operator's map from runs-on labels to a sandbox size (none: providers' default size).
    const sandboxSizes = resolveSandboxSizes();
    startupSizes = sandboxSizes;
    if (sandboxSizes)
      console.log(
        `sandbox sizes: ${Object.keys(sandboxSizes.classes).length} class(es), ${Object.keys(sandboxSizes.labels).length} label(s)`,
      );
    const released = (r: AttemptRunner): AttemptRunner =>
      publishChannel ? withReleaseChannel(r, { client: publishChannel }) : r;
    const proxied = (r: AttemptRunner): AttemptRunner =>
      secretsProxy
        ? withSecretsProxy(r, {
            proxy: secretsProxy,
            ...(jobTokens ? { github: githubTargetOf(db) } : {}),
            ...(extras.jobOidc ? { oidc: (c, k) => extras.jobOidc!.proxyTarget(c, k) } : {}),
            ...(extras.artifacts
              ? { artifacts: () => artifactTargetOf(extras.artifacts!.resultsUrl) }
              : {}),
          })
        : r;
    scheduler = new Scheduler({
      db,
      providers,
      // Jobs never start on a provider weaker than their trust class allows (see isolation.ts).
      runner: withIsolationPolicy(
        // Egress is none by default and refused where it cannot be enforced; each `none`
        // sandbox is probed for a real way out before the job starts.
        proxied(
          released(
            withEgressPolicy(
              createActRunner({
                db,
                source: gitRepoSource({
                  allowHosts: allowHostsFromEnv(),
                  config: checkoutConfigFromEnv(),
                  ...(extras.auth
                    ? {
                        installationToken: async (installationId: string, repo: string) =>
                          (
                            await extras.auth!.mint(installationId, {
                              repositories: [repo],
                              permissions: CHECKOUT_PERMISSIONS,
                            })
                          ).token,
                      }
                    : {}),
                }),
                // Actions are resolved and verified with the run's own GitHub credential: the poll
                // token, else an App token read-only for that repo, else TURNTABLE_GITHUB_TOKEN.
                forgeToken: createForgeToken({
                  db,
                  poll: pollConfig,
                  auth: extras.auth,
                  envToken: process.env.TURNTABLE_GITHUB_TOKEN?.trim() || undefined,
                  log: (m) => console.warn(`[turntable] ${m}`),
                }),
                canary: true,
                ...(jobTokens ? { jobTokens } : {}),
                ...(extras.jobOidc ? { jobOidc: extras.jobOidc } : {}),
                ...(extras.cache ? { cache: jobCacheProvider(db, extras.cache) } : {}),
                ...(extras.artifacts
                  ? {
                      artifacts: jobArtifactProvider(
                        extras.artifacts,
                        extras.seeds ? { seeds: extras.seeds } : {},
                      ),
                    }
                  : {}),
                ...(v.image ? { image: v.image } : {}),
                ...(sandboxSizes ? { sizes: sandboxSizes } : {}),
              }),
              // A job behind the proxy holds secrets: it never runs with open egress.
              { secretBearing: (ctx) => ctx.proxy?.vaultRules === true },
            ),
          ),
        ),
        {
          db,
          hosted: v.hosted === true || process.env.TURNTABLE_HOSTED === "1",
          ...(override ? { override: { reason: override } } : {}),
        },
      ),
      leaseMs,
      ...(observer ? { observer } : {}),
      // The caps are the `scheduler_global_cap` and `scheduler_org_cap` settings, read at each claim.
      ...(liveLimits ? { limits: liveLimits } : {}),
      log,
    });
    const sched = scheduler;
    const reconcile = async () => {
      // A provider that cannot trust its listings (Daytona) counts its own fleet by recorded id:
      // tell it which sandboxes the database says are still ours before anything else.
      await adoptRecordedSandboxes(db, providers);
      const done = await reconcileExpired(db, providers, {
        log,
        owner: sched.owner,
        leaseMs,
        // Re-attach to execs a dead worker left behind: the real result is recovered by replay.
        adopt: (claim, resume) => sched.adopt(claim, resume),
      });
      const swept = await sweepUndestroyedSandboxes(db, providers, { log });
      if (swept.destroyed + swept.failed > 0) {
        log(
          `sandbox sweep: ${swept.destroyed} destroyed, ${swept.failed} failed (retried next time)`,
        );
      }
      return done;
    };
    // Boot reconcile before claiming: abandoned attempts are re-attached or resolved first.
    const report = await reconcile();
    if (report.resolved.length + report.adopted.length > 0) {
      log(
        `reconciled: ${report.adopted.length} re-attached, ${report.resolved.length} marked infra_error`,
      );
    }
    scheduler.start();
    reconcileTimer = setInterval(
      () => {
        void reconcile().catch((e) => log(`reconcile failed: ${String(e)}`));
      },
      Math.max(leaseMs, 10_000),
    );
    log("worker started");
  }

  // Interim egress diagnostics (#693, #698): off unless TURNTABLE_EGRESS_PROBE_SECONDS is set.
  const egressProbe = egressProbeConfigFromEnv();
  if (egressProbe) {
    startEgressProbe(egressProbe, log);
    // The same switch starts the event-loop stall monitor (#693): stalls over 1 s, with fds.
    startLoopLag(log);
    log(`egress probe on: ${egressProbe.hosts.join(", ")} every ${egressProbe.periodSeconds} s`);
  }

  if (pollConfig) {
    if (v.worker && pollConfig.provider !== (v.provider ?? "docker")) {
      throw new Error(
        `poll config provider "${pollConfig.provider}" does not match --provider ${v.provider ?? "docker"}`,
      );
    }
    poller = new Poller({
      db,
      config: pollConfig,
      ...(extras.auth ? { auth: extras.auth } : {}),
      // Repos bound by an installation are ingested once their project has ingest settings.
      bindings: true,
      log,
      onQueued: () => scheduler?.nudge(),
      // A newer cancel-in-progress run took over running attempts: stop their workers now and
      // destroy their sandboxes (the worker's own cleanup is the same; this is the backstop).
      onSuperseded: (running) => {
        scheduler?.abort(running.map((r) => r.attemptId));
        for (const r of running) {
          if (r.sandboxId && workerProvider) {
            void workerProvider
              .destroy(r.sandboxId)
              .catch((e) => log(`could not destroy sandbox: ${String(e)}`));
          }
        }
      },
    });
    poller.start();
    log(`polling per ${v.poll}`);
  }

  return {
    nudge: (repo) => poller?.nudge(repo) ?? false,
    dispatch: poller ? (scope, repo, req) => poller!.dispatch(scope, repo, req) : undefined,
    repoReader: poller ? (inst, repo) => poller!.repoReader(inst, repo) : undefined,
    // The preview's answer for a `services:` or `container:` job (#796): the same refusal rule
    // the scheduler applies, for a trusted run on this worker's provider and size map.
    containerJobs: workerProvider
      ? (need) => {
          const reason = dockerRefusal(startupSizes, need, {
            untrusted: false,
            provider: workerProvider!.info,
          });
          return reason === undefined ? { runnable: true } : { runnable: false, reason };
        }
      : undefined,
    runDefaultBranch: poller ? (scope, repo) => poller!.runDefaultBranch(scope, repo) : undefined,
    providerEgress: () => workerProvider?.info.network.egressPolicy,
    imageRegistrar: () => {
      const p = workerProvider;
      return p?.registerImage
        ? { provider: p.info.name, register: (req) => p.registerImage!(req) }
        : undefined;
    },
    async stop() {
      poller?.stop();
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (scheduler) {
        // Drain (#446): start nothing new, wait for running attempts up to `drain_timeout_seconds`
        // (the server stays up and /healthz says `draining`), then leave the rest. Their leases
        // expire and the next boot's reconcile re-attaches to them, or retries each job once as an
        // infra error. Never abort them here, which would record a user cancel that never happened.
        const seconds = (
          await resolveSetting(ambientSettings(), db, drainTimeoutSecondsSetting.key).catch(() => ({
            value: DEFAULT_DRAIN_TIMEOUT_SECONDS,
          }))
        ).value as number;
        log(`draining: waiting up to ${seconds}s for ${scheduler.activeCount} running attempt(s)`);
        // Attempts whose act already runs in a live sandbox are handed to the next boot at once
        // (#761), which re-attaches to them: the wait covers only the phases that cannot be.
        const { remaining, handedOff } = await scheduler.drainAndWait(seconds * 1000, "shutdown", {
          handoff: true,
        });
        if (handedOff) log(`handed off ${handedOff} running attempt(s) to the next boot`);
        if (remaining > 0) log(`drain timeout: ${remaining} attempt(s) left for the next boot`);
      }
      await secretsProxy?.stop();
    },
  };
}

/** The proxy's TLS certificate and key, from their files: both or neither. */
function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function readProxyTls(): { key: string; cert: string } {
  const certFile = process.env.TURNTABLE_PROXY_TLS_CERT_FILE?.trim();
  const keyFile = process.env.TURNTABLE_PROXY_TLS_KEY_FILE?.trim();
  if (!certFile || !keyFile) {
    throw new Error(
      "TURNTABLE_PROXY_TLS_CERT_FILE and TURNTABLE_PROXY_TLS_KEY_FILE must be set together",
    );
  }
  if (!process.env.TURNTABLE_PROXY_ADVERTISE_HOST?.trim()) {
    throw new Error("a TLS proxy listener needs TURNTABLE_PROXY_ADVERTISE_HOST (its public name)");
  }
  return { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8") };
}

async function serve(args: string[]): Promise<void> {
  assertValidVersion();
  // Every option has an environment variable (serve-config.ts), so a platform with no shell
  // configures the whole server from variables. A flag wins over its variable.
  const d = serveDefaults(process.env);
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string", default: d.port },
      host: { type: "string", default: d.host },
      "data-dir": { type: "string", default: d.dataDir },
      // Read before anything else loads (db/dialect.ts); declared so strict parsing accepts it.
      "database-url": { type: "string" },
      "allowed-origin": { type: "string", multiple: true },
      "public-url": { type: "string" },
      "init-master-key": { type: "boolean", default: false },
      roles: { type: "string" },
      worker: { type: "boolean", default: d.worker },
      "global-cap": { type: "string", default: d.globalCap },
      "org-cap": { type: "string", default: d.orgCap },
      "lease-seconds": { type: "string", default: d.leaseSeconds },
      image: { type: "string", ...(d.image ? { default: d.image } : {}) },
      poll: { type: "string", ...(d.poll ? { default: d.poll } : {}) },
      provider: { type: "string", default: d.provider },
      "provider-config": {
        type: "string",
        ...(d.providerConfig ? { default: d.providerConfig } : {}),
      },
      hosted: { type: "boolean", default: d.hosted },
      "isolation-override": {
        type: "string",
        ...(d.isolationOverride ? { default: d.isolationOverride } : {}),
      },
      config: { type: "string", ...(d.config ? { default: d.config } : {}) },
    },
    strict: true,
  });
  // The settings layers above the database: the environment and turntable.toml (#321). An unknown
  // key, a bad value or an unreadable file stops the boot here, before anything is opened. No file
  // is fine.
  // The operator's size classes first: the org and project label maps may name only those.
  setOperatorSizes(resolveSandboxSizes());
  // `--global-cap` and `--org-cap` on the command line lock their settings like the variables do.
  // The overrides layer over the live environment through a view, so the environment is never copied.
  const cliOverrides: Record<string, string | undefined> = {};
  for (const [flag, name] of [
    ["global-cap", "TURNTABLE_GLOBAL_CAP"],
    ["org-cap", "TURNTABLE_ORG_CAP"],
  ] as const) {
    if (process.argv.some((a) => a === `--${flag}` || a.startsWith(`--${flag}=`))) {
      cliOverrides[name] = values[flag];
    }
  }
  const settingsEnv = new Proxy(process.env, {
    get: (target, key) =>
      typeof key === "string" && key in cliOverrides ? cliOverrides[key] : target[key as string],
  });
  const roles = resolveRoles(values.roles, { worker: values.worker, poll: values.poll });
  // The release lane applies the approval policy and nothing that depends on the server's size
  // classes: it must boot on any config the server boots on, so it skips those refusals.
  const settings = loadSettingsRuntime({
    config: values.config,
    env: settingsEnv,
    ...(roles.has("release") ? { registry: withoutRefusals(settingsRegistry) } : {}),
  });
  // The approval engine and the release lane read the approval policy from the same runtime.
  setAmbientSettings(settings);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port: ${values.port}`);
  }
  if (roles.has("release")) {
    // The release lane is its own process with its own keys: nothing below runs for it. It drops
    // (or refuses) like every other process that opens a data dir, before any file is touched. It
    // does not chown: its own directories belong to whoever provisions the lane.
    enforceRootPolicy(resolve(values["data-dir"]), process.env, undefined, { chown: false });
    // The lane has its own key file; the main process's key is not its to hold.
    delete process.env.TURNTABLE_MASTER_KEY;
    delete process.env.TURNTABLE_MASTER_KEY_PREVIOUS;
    const lane = await serveRelease(values);
    // A supervised lane ends with its parent, however the parent ended.
    if (process.env[LANE_CHILD_ENV] === "1") {
      delete process.env[LANE_CHILD_ENV];
      const parent = process.ppid;
      setInterval(() => {
        if (process.ppid !== parent) {
          lane.stop();
          process.exit(0);
        }
      }, 1000).unref();
    }
    const stopLane = () => {
      lane.stop();
      process.exit(0);
    };
    process.on("SIGINT", stopLane);
    process.on("SIGTERM", stopLane);
    return;
  }
  // A process that is not the release lane holds nothing of it: those variables do nothing here.
  const runtime = mainRuntime(roles, process.env);
  // The lane as this process's supervised child (off by default): its variables are taken after
  // the privilege drop below, and go to the child alone.
  const laneChild = laneSupervised(process.env);
  // The lane's keys, if given, are used once for the boot re-wrap and removed: not for a child to inherit.
  const releaseLaneElsewhere = laneChild || releaseLaneConfigured(process.env);
  // A supervised lane re-wraps its own keys in the child; this process never parses them.
  const releaseKeys = laneChild ? undefined : takeReleaseKeys(process.env);
  if (runtime.ignoredReleaseEnv.length > 0 && !laneChild) {
    console.warn(
      `warning: ${runtime.ignoredReleaseEnv.join(", ")} belong to the release lane and are ignored here; run it as its own process (serve --roles release)`,
    );
  }
  const dataDir = resolve(values["data-dir"]);
  // Before anything is opened: as root, own the data dir and drop to an unprivileged user.
  const privilege = enforceRootPolicy(dataDir);
  if (privilege === "dropped")
    console.log(`dropped privileges to ${process.env.TURNTABLE_DROP_PRIVILEGES}`);
  if (privilege === "root_allowed")
    console.warn("warning: running as root (TURNTABLE_ALLOW_ROOT=1)");
  // Before anything else is read or loaded: every release variable leaves process.env here and is
  // handed to the child alone (supervisor.ts). Made after the drop so the socket directory is ours.
  let preparedLane: PreparedLane | undefined;
  if (laneChild) {
    preparedLane = prepareSupervisedLane({
      env: process.env,
      postgres: DIALECT === "pg",
      config: values.config ? resolve(values.config) : undefined,
    });
    console.log(
      "[turntable] release lane: supervised child process (no release variable stays here)",
    );
  }
  // A platform with no shell cannot run `keys init`: when asked to, create the key file once, here,
  // before anything reads it. Never overwrites; without the opt-in an absent file stays an error.
  let masterKeyCreated: string | undefined;
  const keyPath = process.env.TURNTABLE_MASTER_KEY_FILE?.trim();
  if (keyPath && process.env.TURNTABLE_MASTER_KEY?.trim()) {
    delete process.env.TURNTABLE_MASTER_KEY;
    delete process.env.TURNTABLE_MASTER_KEY_PREVIOUS;
    throw new MasterKeyConfigError(
      "TURNTABLE_MASTER_KEY and TURNTABLE_MASTER_KEY_FILE are both set: use one. Remove the file setting once the key is in the variable.",
    );
  }
  if (keyPath && autoInitRequested(process.env, values["init-master-key"])) {
    if (
      autoInitMasterKey(resolve(keyPath), dataDir, (m) => console.log(`[turntable] ${m}`)) ===
      "created"
    ) {
      masterKeyCreated = resolve(keyPath);
    }
  } else if (!keyPath && autoInitRequested(process.env, values["init-master-key"])) {
    throw new Error(
      process.env.TURNTABLE_MASTER_KEY?.trim()
        ? "--init-master-key (TURNTABLE_MASTER_KEY_AUTOINIT) creates a key file and is not used with TURNTABLE_MASTER_KEY: remove it"
        : "--init-master-key (TURNTABLE_MASTER_KEY_AUTOINIT) needs TURNTABLE_MASTER_KEY_FILE",
    );
  }
  // The key is read once, here, and TURNTABLE_MASTER_KEY is deleted from the environment before
  // any provider, plugin or child process starts. Both a variable and a file is refused.
  const masterKeys: MasterKeys | undefined = takeMasterKeys(process.env);
  // Likewise the audit webhook secret, which signs both the audit export and the anchor export.
  const auditWebhookSecret = takeAuditWebhookSecret(process.env);
  // Before the database is opened (and so migrated) by this binary. SQLite only: on Postgres the
  // operator takes the backup with pg_dump.
  if (
    DIALECT === "sqlite" &&
    ["1", "true"].includes(process.env.TURNTABLE_BACKUP_BEFORE_MIGRATE ?? "")
  ) {
    await backupBeforeMigrate({
      dbPath: join(dataDir, "turntable.db"),
      dataDir,
      version: VERSION,
      keep: backupKeepFromEnv(process.env, settings),
      log: (m) => console.log(`[turntable] ${m}`),
    });
  }
  const db = openDatabase(join(dataDir, "turntable.db"));
  const dropReport = createDropReporter(db, {
    onError: (err) => console.error("[turntable] could not record a dropped log chunk:", err),
  });
  await ensureInstance(db);
  // The log store (#717): `db` keeps job logs in this database; `clickhouse` sends them to a
  // ClickHouse service through a bounded queue that never blocks the event loop. A bad setting
  // or an unreachable store at boot stops the boot, so a typo does not silently fall back.
  const logStore = await openLogStore(logStoreConfigFromEnv(), (k, o, n) =>
    dropReport.report(k, o, n),
  );
  setLogStore(logStore);
  // Before anything serves: orgs that already had two owners or admins keep the strict approval
  // default after one leaves (#663). Idempotent.
  await backfillApprovalDefaultStrict(db);
  // A rotation: the previous key is given, so every sealed row moves to the new key before anything
  // reads one. All or nothing; a failure stops the boot.
  if (masterKeys && (masterKeys.previous || releaseKeys?.previous)) {
    await rewrapMasterKey({
      db,
      next: masterKeys.key,
      previous: masterKeys.previous,
      release: releaseKeys,
      releaseElsewhere: !releaseKeys && releaseLaneElsewhere,
      anchorDir: auditStateDir(masterKeys, dataDir),
      auditOrgId: await systemOrgId(db),
      log: (m) => console.log(`[turntable] ${m}`),
    });
    console.warn(
      "[turntable] a previous master key is set: once the re-wrap is done and a new backup is taken, remove it",
    );
  }
  // One-shot: delete the old key file from the volume once everything above holds. A refusal only
  // logs; it never stops the boot.
  const retirePath = process.env[RETIRE_FILE_ENV]?.trim();
  if (masterKeys && retirePath) {
    await retireMasterKeyFile({
      db,
      path: retirePath,
      dataDir,
      keys: masterKeys,
      anchorDir: auditStateDir(masterKeys, dataDir),
      auditOrgId: await systemOrgId(db),
      log: (m) => console.log(`[turntable] ${m}`),
    });
  } else if (retirePath) {
    console.log(`[turntable] ${RETIRE_FILE_ENV}: refused, no master key is set`);
  }
  // A key changed without its previous one: say so now, with the fix, not as a bare AnchorCorrupt
  // from the checkpointer later. Not fatal: the checkpointer alerts on every pass either way.
  if (masterKeys && !masterKeys.previous) {
    for (const orgId of new AuditAnchor(
      auditStateDir(masterKeys, dataDir),
      masterKeys.key,
    ).unreadable()) {
      console.error(`[turntable] ${anchorKeyMessage(orgId)}`);
    }
  }
  if (masterKeyCreated) {
    await appendAudit(
      db,
      { orgId: await systemOrgId(db) },
      {
        principalKind: "system",
        principalId: "first-boot",
        op: "master_key_created",
        effect: "write",
        outcome: "ok",
        input: { file: basename(masterKeyCreated) },
      },
    );
  }

  // The child opens the same database, so it starts after this process has migrated it.
  // No respawn: a lane that is gone stops the other roles and exits non-zero (set below), so the
  // platform restarts the container and this process never keeps the lane's variables or root.
  // The stop path is wired at the end of boot, so a loss before then (a spawn that throws, a child
  // that exits while the server is still booting) is kept and replayed the moment it is wired.
  let laneLost: ((why: string) => void) | undefined;
  let earlyLaneLoss: string | undefined;
  const laneSupervisor = preparedLane
    ? new LaneSupervisor({
        prepared: preparedLane,
        onLaneLost: (why) => {
          if (laneLost) laneLost(why);
          else earlyLaneLoss = why;
        },
        startupTimeoutMs: laneStartupMs(process.env),
        args: ["serve", "--roles", "release", "--data-dir", dataDir],
      })
    : undefined;
  laneSupervisor?.start();

  // First-boot access without a shell: see ops/bootstrap.ts.
  const bootstrapHash = process.env.TURNTABLE_BOOTSTRAP_TOKEN_SHA256?.trim();
  if (bootstrapHash) {
    const r = await bootstrapToken(db, {
      sha256: bootstrapHash,
      org: process.env.TURNTABLE_BOOTSTRAP_ORG,
    });
    console.log(
      r.status === "created"
        ? `bootstrap: created an operator token for org ${r.org} (expires ${iso(r.expiresAt)})`
        : `bootstrap: org ${r.org} already has tokens, nothing created`,
    );
  }

  // First-boot instance-administrator access: see ops/instance-bootstrap.ts. Never logs the hash.
  const instanceBootstrapHash = process.env.TURNTABLE_INSTANCE_BOOTSTRAP_TOKEN_SHA256?.trim();
  if (instanceBootstrapHash) {
    const r = await bootstrapInstanceToken(db, {
      sha256: instanceBootstrapHash,
      expiresInDays: bootstrapExpiryDays(process.env.TURNTABLE_INSTANCE_BOOTSTRAP_EXPIRY_DAYS),
    });
    console.log(
      r.status === "created"
        ? `instance bootstrap: registered an instance token (expires ${iso(r.expiresAt)}). Rotate it, then remove TURNTABLE_INSTANCE_BOOTSTRAP_TOKEN_SHA256.`
        : r.reason === "an instance token exists"
          ? "instance bootstrap hash ignored: an instance token exists"
          : "instance bootstrap hash refused: that hash was already registered once. Generate a new token and set its hash instead.",
    );
  }

  // The control-plane cache for jobs (#38). Off unless a URL the sandboxes can reach is given.
  let cache: CacheService | undefined;
  const cacheUrl = process.env.TURNTABLE_CACHE_URL?.trim();
  if (cacheUrl) {
    const gib = (name: string, dflt: number): number => {
      const n = Number(process.env[name] ?? dflt);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid ${name}`);
      return Math.floor(n * 1024 ** 3);
    };
    cache = createCacheService({
      db,
      // With a master key the blobs are encrypted at rest, per org (cache/blob-crypto.ts).
      store: new FsCacheStore(join(dataDir, "cache"), { masterKey: masterKeys?.key }),
      grants: new CacheGrants(),
      orgQuotaBytes: gib("TURNTABLE_CACHE_QUOTA_GIB", 10),
      maxEntryBytes: gib("TURNTABLE_CACHE_MAX_ENTRY_GIB", 2),
      baseUrl: cacheUrl,
      // Shown next to the job's own log as a system line (out of band: output cannot forge it).
      onNotice: (g, m) => {
        console.log(`[turntable] ${m} (attempt ${g.attemptId})`);
        void addNotice(
          db,
          { orgId: g.own.orgId, projectId: g.own.projectId },
          { attemptId: g.attemptId, source: "cache", text: m },
        ).catch(() => {});
      },
      // A grant works only while its attempt is running, whatever else the token says.
      isActive: async (g) =>
        (await getAttempt(db, { orgId: g.own.orgId, projectId: g.own.projectId }, g.attemptId))
          ?.state === "running",
    });
    const sweep = setInterval(() => void cache?.sweep().catch(() => {}), 5 * 60_000);
    sweep.unref();
    console.log(`[turntable] job cache on, sandboxes reach it at ${cacheUrl}`);
  }

  // The artifact store for jobs: what upload-artifact and download-artifact talk to, and what the
  // release lane signs from. Off unless a URL the sandboxes can reach is given.
  let artifacts: ArtifactService | undefined;
  let artifactStore: FsArtifactStore | undefined;
  const artifactsUrl = process.env.TURNTABLE_ARTIFACTS_URL?.trim();
  if (artifactsUrl) {
    const num = (name: string, dflt: number): number => {
      const n = Number(process.env[name] ?? dflt);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid ${name}`);
      return n;
    };
    artifactStore = new FsArtifactStore(join(dataDir, "artifacts"));
    artifacts = createArtifactService({
      db,
      store: artifactStore,
      grants: new ArtifactGrants(),
      maxArtifactBytes: Math.floor(num("TURNTABLE_ARTIFACT_MAX_GIB", 2) * 1024 ** 3),
      retentionMs: Math.floor(num("TURNTABLE_ARTIFACT_RETENTION_DAYS", 90) * 86_400_000),
      baseUrl: artifactsUrl,
      onNotice: (g, m) => {
        console.log(`[turntable] ${m} (attempt ${g.attemptId})`);
        void addNotice(db, g.scope, { attemptId: g.attemptId, source: "artifacts", text: m }).catch(
          () => {},
        );
      },
      // A grant works only while its attempt is running, whatever else the token says.
      isActive: async (g) => (await getAttempt(db, g.scope, g.attemptId))?.state === "running",
    });
    const sweep = setInterval(() => void artifacts?.sweep().catch(() => {}), 5 * 60_000);
    sweep.unref();
    console.log(`[turntable] job artifacts on, sandboxes reach them at ${artifactsUrl}`);
  }

  const allowedOrigins = [
    ...(values["allowed-origin"] ?? []),
    ...(process.env.TURNTABLE_ALLOWED_ORIGINS?.split(",") ?? []),
  ]
    .map((o) => o.trim())
    .filter((o) => o !== "");
  // GitHub webhooks (/api/v1/webhooks/github) need the secret store, so they need a master key.
  let webhooks: WebhookHandler | undefined;
  let claims: { starter: InstallationClaims; handler: ClaimHandler } | undefined;
  let appFacts: GithubFacts | undefined;
  let appUsers: GithubUserLookup | undefined;
  // Creating the GitHub App from this instance, for a host with no shell (github/hosted-manifest.ts).
  let appManifest: HostedManifestHandler | undefined;
  // Sign in with GitHub and web sessions (auth/github-login.ts); needs the store and a public URL.
  let webAuth: { sessions: WebSessions; handler: AuthHandler; userGithub?: UserGithub } | undefined;
  // Set once the poller exists: a push or pull request webhook wakes it for that repo.
  let wake: ((repo: string) => void) | undefined;
  // Set once the poller exists: `run_dispatch` starts workflow_dispatch runs through it.
  let dispatchRun: RunDispatcher | undefined;
  // Set with it: the onboarding preview's repo reader and the default-branch run.
  let repoReader: RepoReaderFactory | undefined;
  let runDefaultBranch: DefaultBranchRunner | undefined;
  let containerJobs: ContainerJobs | undefined;
  // Hosted multi-tenant installs: an org claims its own installation (github/claim.ts).
  const claimMode = process.env.TURNTABLE_CLAIM_INSTALLATIONS === "1";
  let checks: CheckReporter | undefined;
  const auditStops: (() => void)[] = [];
  let appAuth: AppAuth | undefined;
  let vault: SecretVault | undefined;
  let auditStore: SecretStore | undefined;
  let oidc: OidcHandler | undefined;
  let jobOidc: JobOidc | undefined;
  // The notification rule engine (#611): reads the event feed, writes per-person rows. Needs no
  // key, so it runs with or without a master key, in the process that serves the API.
  if (roles.has("web")) {
    auditStops.push(
      new NotificationEngine({
        db,
        settings,
        settleMs: defaultSettleMs(),
        log: (m) => console.warn(`[turntable] ${m}`),
      }).start(),
    );
  }
  let outboundWebhooks: WebhookService | undefined;
  if (masterKeys) {
    const masterKey = masterKeys.key;
    const store = new SecretStore(db, masterKey);
    auditStore = store;
    vault = new SecretVault({ db, masterKey });
    outboundWebhooks = new WebhookService({
      db,
      masterKey,
      log: (m) => console.warn(`[turntable] ${m}`),
    });
    // Delivery runs in the process that serves the API: one loop per web process, and rows are
    // claimed with a lease, so two processes never send the same delivery at once.
    if (roles.has("web")) auditStops.push(outboundWebhooks.start());
    // Per-org OIDC issuer: needs a public https base, which is what an issuer URL is.
    const publicUrl = (values["public-url"] ?? process.env.TURNTABLE_PUBLIC_URL)?.trim();
    const oidcBase =
      process.env.TURNTABLE_OIDC_BASE_URL?.trim() ||
      (publicUrl ? `${publicUrl.replace(/\/+$/, "")}/oidc` : undefined);
    if (oidcBase) {
      const u = new URL(oidcBase);
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (u.protocol !== "https:" && !local) {
        throw new Error(
          "the OIDC issuer base URL must be https (TURNTABLE_PUBLIC_URL or TURNTABLE_OIDC_BASE_URL)",
        );
      }
      const issuer = new OidcIssuer({
        db,
        masterKey,
        baseUrl: oidcBase,
        allowClasses: parseAllowClasses(process.env.TURNTABLE_OIDC_ALLOW_CLASSES),
      });
      oidc = createOidcHandler({ db, issuer, masterKey });
      // Jobs that ask for an ID token get GitHub's variables, behind the secrets proxy.
      jobOidc = new JobOidc({ db, issuer, masterKey });
    }
    const auth = new AppAuth({ db, store });
    // Check runs: a per-project setting (off by default); the reporter does nothing for a project
    // that has not turned it on.
    checks = new CheckReporter({
      db,
      auth,
      api: githubCheckRunsApi(),
      publicUrl: values["public-url"] ?? process.env.TURNTABLE_PUBLIC_URL?.trim(),
      settings,
      log: (m) => console.log(`[turntable] checks: ${m}`),
    });
    appAuth = auth;
    // An incident freeze drops the cached installation tokens. GitHub tokens still live until
    // they expire (within an hour); this stops the server handing them out again.
    registerCredentialRevoker({
      name: "github-installation-tokens",
      revoke: () => auth.dropCached(),
    });
    const ghFacts = githubFacts(auth);
    appFacts = ghFacts;
    appUsers = githubUserLookup(auth);
    webhooks = createWebhookHandler({
      db,
      store,
      facts: ghFacts,
      trustedProxies: parseTrustedProxies(process.env.TURNTABLE_TRUSTED_PROXIES),
      ...(claimMode ? { claimMode: true } : {}),
      onRepoEvent: (repo) => wake?.(repo),
    });
    if (claimMode) {
      const starter = new InstallationClaims({
        db,
        store,
        publicUrl: values["public-url"] ?? process.env.TURNTABLE_PUBLIC_URL?.trim(),
      });
      claims = {
        starter,
        handler: createClaimHandler({
          claims: starter,
          facts: ghFacts,
          user: githubUserVerifier({ db, store }),
          log: (m) => console.warn(`[turntable] ${m}`),
        }),
      };
    }
    const signInUrl = (values["public-url"] ?? process.env.TURNTABLE_PUBLIC_URL)?.trim();
    if (signInUrl) {
      let u: URL | undefined;
      try {
        u = new URL(signInUrl);
      } catch {
        u = undefined;
      }
      const local = u?.hostname === "localhost" || u?.hostname === "127.0.0.1";
      if (!u || (u.protocol !== "https:" && !local)) {
        console.warn(
          "web sign-in is off: TURNTABLE_PUBLIC_URL must be an https URL (the session cookie is Secure)",
        );
      } else {
        const sessions = new WebSessions({ db, publicUrl: signInUrl, settings });
        // The user's GitHub token is sealed per session (auth/user-tokens.ts); a timer sweeps the
        // tokens of sessions that ended without a sign-out.
        const userTokens = new UserTokens({ db, store, sessions });
        const sweep = setInterval(() => void userTokens.sweep().catch(() => {}), 3_600_000);
        sweep.unref();
        webAuth = {
          sessions,
          userGithub: githubUserApi({ db, tokens: userTokens }),
          handler: createAuthHandler({
            db,
            store,
            sessions,
            userTokens,
            settings,
            identity: githubIdentityVerifier({ db, store }),
            log: (m) => console.warn(`[turntable] ${m}`),
          }),
        };
      }
    }
    const setupHash = process.env.TURNTABLE_GITHUB_APP_SETUP_TOKEN_SHA256?.trim();
    if (setupHash) {
      const publicBase = (values["public-url"] ?? process.env.TURNTABLE_PUBLIC_URL)?.trim();
      if (!publicBase) {
        console.warn(
          "TURNTABLE_GITHUB_APP_SETUP_TOKEN_SHA256 is set but there is no public URL (TURNTABLE_PUBLIC_URL): the GitHub App cannot be created from this instance",
        );
      } else {
        appManifest = createHostedManifestHandler({
          db,
          store,
          publicUrl: publicBase,
          setupTokenSha256: setupHash,
          ...(claimMode ? { claimFlow: true } : {}),
          // The App owns every installation of it: only the bootstrap or system org may.
          ownerOrgSlugs: [process.env.TURNTABLE_BOOTSTRAP_ORG?.trim() || "local", SYSTEM_ORG_SLUG],
          trustedProxies: parseTrustedProxies(process.env.TURNTABLE_TRUSTED_PROXIES),
          onReplaced: () => auth.dropCached(),
          log: (m) => console.log(`[turntable] ${m}`),
        });
      }
    }
    if (process.env.TURNTABLE_TRUST_FORWARDED_FOR !== undefined) {
      console.warn(
        "warning: TURNTABLE_TRUST_FORWARDED_FOR is no longer read; name your proxies in TURNTABLE_TRUSTED_PROXIES",
      );
    }
    void webhooks.retryUnfinished().catch(() => {});
    // Signed audit checkpoints need the store's key; export sinks are opt in. Each checkpoint
    // also sends the org's anchor to the off-instance sink, when `audit_anchor_sink_url` is set.
    const anchors = createAnchorExporter({ db, settings, secret: auditWebhookSecret });
    auditStops.push(
      anchors.start(),
      startCheckpointer(db, store, new AuditAnchor(auditStateDir(masterKeys, dataDir), masterKey), {
        onCheckpoint: (orgId, cp) => anchors.onCheckpoint(orgId, cp),
      }),
    );
  }
  const sinks: AuditSink[] = [];
  const exportDir = process.env.TURNTABLE_AUDIT_EXPORT_DIR?.trim();
  if (exportDir) sinks.push(jsonlSink(resolve(exportDir)));
  const exportUrl = process.env.TURNTABLE_AUDIT_WEBHOOK_URL?.trim();
  if (exportUrl) {
    sinks.push(webhookSink(exportUrl, auditWebhookSecret ? { secret: auditWebhookSecret } : {}));
  }
  if (sinks.length > 0) auditStops.push(startExporter(db, sinks));
  // The release lane's config channel (#541), when this process is set up for it.
  const releaseConfig = preparedLane?.config ?? laneConfigClientFromEnv(process.env);
  const webauthn = relyingPartyFromEnv(
    values["public-url"] ?? process.env.TURNTABLE_PUBLIC_URL?.trim(),
  );
  // Running from source with a built UI bundle on disk: serve it (never in the compiled binary).
  if (roles.has("web")) {
    const dev = enableDevUi();
    if (dev) console.log(`serving the web UI from ${dev.dir} (dev mode, ${dev.source})`);
    else if (process.env.TURNTABLE_UI_DIR?.trim() && !hasUi())
      console.warn(
        "TURNTABLE_UI_DIR is not used: it needs a run from source (the compiled binary serves only its embedded UI) and a directory with an index.html",
      );
  }
  // The readiness checks behind the `doctor` operation, with what this server has seen of
  // forwarded headers. Read-only: the handle it is given can only run queries.
  const forwarded = new ForwardedObserver();
  const hostedMode = values.hosted === true || process.env.TURNTABLE_HOSTED === "1";
  const doctorRun = cachedDoctor(async () => {
    const { inputs, close } = realInputs({
      env: process.env,
      dataDir,
      hosted: hostedMode,
      provider: values.provider,
      providerConfig: values["provider-config"],
      observed: forwarded.snapshot(),
      db: readerOf(db),
      masterKeys,
      ...(laneSupervisor ? { releaseLane: () => laneSupervisor.status() } : {}),
      humanApprovalGaps: () => countHumanWithoutApprover(settings, db),
      humanAnyKeyPolicy: () => countHumanWithAnyKeyPolicy(settings, db),
    });
    try {
      return await runDoctor(inputs);
    } finally {
      close();
    }
  });
  const server = roles.has("web")
    ? startServer({
        port,
        host: values.host,
        db,
        trustedProxies: parseTrustedProxies(process.env.TURNTABLE_TRUSTED_PROXIES),
        allowedOrigins,
        ...(webhooks ? { webhooks } : {}),
        ...(vault ? { vault } : {}),
        ...(webauthn ? { webauthn } : {}),
        ...(releaseConfig ? { releaseConfig } : {}),
        ...(laneSupervisor ? { releaseLane: laneSupervisor } : {}),
        ...(artifactStore ? { artifactBlobs: artifactStore } : {}),
        operatorOrgSlug: process.env.TURNTABLE_BOOTSTRAP_ORG?.trim() || "local",
        providerEgress: () => background.providerEgress(),
        imageRegistrar: () => background.imageRegistrar(),
        ...(oidc ? { oidc } : {}),
        ...(outboundWebhooks ? { outboundWebhooks } : {}),
        ...(claims ? { claims } : {}),
        ...(webAuth ? { webAuth } : {}),
        ...(appFacts ? { githubFacts: appFacts } : {}),
        ...(appUsers ? { githubUsers: appUsers } : {}),
        runDispatcher: (scope, repo, req) =>
          dispatchRun
            ? dispatchRun(scope, repo, req)
            : Promise.reject(
                new DispatchError(
                  "unavailable",
                  "this process does not run the poller role, which starts dispatched runs",
                ),
              ),
        containerJobs: (need) => containerJobs?.(need),
        repoReader: (inst, repo) =>
          repoReader
            ? repoReader(inst, repo)
            : Promise.reject(
                new DispatchError("unavailable", "this process does not run the poller role"),
              ),
        defaultBranchRunner: (scope, repo) =>
          runDefaultBranch
            ? runDefaultBranch(scope, repo)
            : Promise.reject(
                new DispatchError(
                  "unavailable",
                  "this process does not run the poller role, which starts runs",
                ),
              ),
        ...(appManifest ? { appManifest } : {}),
        ...(cache ? { cache } : {}),
        ...(artifacts ? { artifacts } : {}),
        backup:
          DIALECT === "pg"
            ? { dialect: "pg" }
            : {
                dialect: "sqlite",
                dataDir,
                dbPath: join(dataDir, "turntable.db"),
                keep: backupKeepFromEnv(process.env, settings),
              },
        settings,
        staticPollProjects: (roles.has("poller")
          ? (resolvePollConfig(values.poll)?.repos ?? [])
          : []
        ).map((r) => staticPollKey(r.org, r.project)),
        trustForwardedProto: process.env.TURNTABLE_TRUST_FORWARDED_PROTO === "1",
        transport: transportOptionsFromEnv(process.env),
        // The `doctor` op is owner-member only (in-process) and `instance_doctor` is a `tti_` token's:
        // no org token reaches either, so a hosted instance serves it too.
        doctor: doctorRun,
        auditStore,
        ...(appAuth ? { appAuth } : {}),
        forwarded,
      })
    : undefined;
  if (server)
    console.log(`turntable ${VERSION} listening on http://${server.hostname}:${server.port}`);
  // Installations synced before polled repos were adopted: adopt now, after listening, so a slow
  // or failing GitHub never holds up startup or healthz.
  if (appFacts) {
    const facts = appFacts;
    void adoptPolledBindings(db, facts, (m) => console.log(`[turntable] ${m}`)).catch((err) =>
      console.warn(`[turntable] adopt sweep failed: ${err instanceof Error ? err.message : err}`),
    );
  }

  const background = await startBackground(
    db,
    {
      ...values,
      worker: roles.has("worker"),
      poll: roles.has("poller") ? values.poll : undefined,
    },
    checks,
    {
      ...(appAuth ? { auth: appAuth } : {}),
      ...(vault ? { vault } : {}),
      ...(cache ? { cache } : {}),
      ...(artifacts ? { artifacts } : {}),
      ...(jobOidc ? { jobOidc } : {}),
      ...(masterKeys ? { seeds: attemptSeeds(masterKeys.key) } : {}),
      ...(preparedLane ? { laneChannel: preparedLane.channel } : {}),
    },
  );

  wake = (repo) => void background.nudge(repo);
  dispatchRun = background.dispatch;
  repoReader = background.repoReader;
  runDefaultBranch = background.runDefaultBranch;
  containerJobs = background.containerJobs;

  let stopping = false;
  let exitCode = 0;
  const stop = () => {
    // A second signal does not wait for the drain.
    if (stopping) process.exit(1);
    stopping = true;
    for (const s of auditStops) s();
    void background
      .stop()
      .then(() => server?.stop())
      // Queued log chunks get a few seconds to reach the store; what is left is lost.
      .then(() => logStore && Promise.race([logStore.flush(), Bun.sleep(5000)]).catch(() => {}))
      // Last: running release jobs may still be using the lane's proxy while the scheduler drains.
      .then(() => laneSupervisor?.stop())
      .finally(() => {
        db.close();
        process.exit(exitCode);
      });
  };
  laneLost = () => {
    if (stopping) return;
    exitCode = 1;
    stop();
  };
  if (earlyLaneLoss !== undefined) laneLost(earlyLaneLoss);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/** TURNTABLE_LANE_STARTUP_TIMEOUT_SECONDS: how long the supervised lane has to become healthy (default 60). */
function laneStartupMs(env: Record<string, string | undefined>): number {
  const raw = env.TURNTABLE_LANE_STARTUP_TIMEOUT_SECONDS?.trim();
  if (!raw) return 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("TURNTABLE_LANE_STARTUP_TIMEOUT_SECONDS must be a positive number of seconds");
  }
  return Math.round(n * 1000);
}

const iso = (ms: number | null): string => (ms === null ? "-" : new Date(ms).toISOString());

async function token(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const options = {
    org: { type: "string" },
    project: { type: "string" },
    role: { type: "string" },
    kind: { type: "string" },
    name: { type: "string" },
    "expires-days": { type: "string" },
    instance: { type: "boolean", default: false },
    "data-dir": { type: "string", default: "./data" },
  } as const;
  const { values, positionals } = parseArgs({
    args: rest,
    options,
    allowPositionals: sub === "revoke" || sub === "rotate",
    strict: true,
  });
  const open = () => openDatabase(join(resolve(values["data-dir"]), "turntable.db"));
  if (sub === "generate") {
    // No database: the token goes to stdout, its hash to stderr. Keep the token; set only the
    // hash (TURNTABLE_BOOTSTRAP_TOKEN_SHA256) on the server.
    const secret = values.instance ? generateInstanceToken() : generateToken();
    const variable = values.instance
      ? "TURNTABLE_INSTANCE_BOOTSTRAP_TOKEN_SHA256"
      : "TURNTABLE_BOOTSTRAP_TOKEN_SHA256";
    console.error(
      `sha256: ${hashToken(secret)}\nSet ${variable} to that hash on the server and keep the token below; it is not stored anywhere else.`,
    );
    console.log(secret);
    return;
  }
  if (values.instance) {
    // An instance-administrator token (tti_): not tied to an org, minted only here.
    if (values.org || values.project || values.role || values.kind) {
      throw new Error(
        "--instance takes no --org, --project, --role or --kind: it holds no org grant",
      );
    }
    const {
      createInstanceTokenFromCli,
      listInstanceTokensFromCli,
      revokeInstanceTokenFromCli,
      rotateInstanceTokenFromCli,
    } = await import("./ops/instance-token-cli");
    const db = open();
    try {
      if (sub === "create") {
        if (!values.name) throw new Error("--name is required");
        const created = await createInstanceTokenFromCli(db, {
          name: values.name,
          expiresInDays:
            values["expires-days"] === undefined ? undefined : Number(values["expires-days"]),
        });
        console.error(
          `created instance token ${created.id}, expires ${iso(created.expiresAt)}. It is shown once. It can call the instance operations over REST and nothing else.`,
        );
        console.log(created.secret);
      } else if (sub === "list") {
        console.log(["ID", "NAME", "STATUS", "LAST USED", "EXPIRES"].join("\t"));
        for (const r of await listInstanceTokensFromCli(db)) {
          console.log([r.id, r.name, r.status, iso(r.lastUsedAt), iso(r.expiresAt)].join("\t"));
        }
      } else if (sub === "revoke") {
        const [id] = positionals;
        if (!id)
          throw new Error("usage: turntable token revoke <id> --instance [--data-dir ./data]");
        const done = await revokeInstanceTokenFromCli(db, id);
        console.error(`revoked instance token ${done.id} (${done.name})`);
      } else if (sub === "rotate") {
        const [id] = positionals;
        if (!id)
          throw new Error(
            "usage: turntable token rotate <id> --instance [--name <name>] [--data-dir ./data]",
          );
        const r = await rotateInstanceTokenFromCli(db, {
          oldId: id,
          name: values.name,
          expiresInDays:
            values["expires-days"] === undefined ? undefined : Number(values["expires-days"]),
        });
        console.error(
          `created instance token ${r.id}, expires ${iso(r.expiresAt)}, and revoked ${r.revokedId}. The new token is shown once. Remove TURNTABLE_INSTANCE_BOOTSTRAP_TOKEN_SHA256 if it is set.`,
        );
        console.log(r.secret);
      } else {
        throw new Error("--instance works with create, list, revoke and rotate");
      }
    } finally {
      db.close();
    }
    return;
  }
  if (sub === "create") {
    if (!values.org || !values.role || !values.name) {
      throw new Error("--org, --role and --name are required");
    }
    const db = open();
    try {
      const created = await createTokenFromCli(db, {
        org: values.org,
        project: values.project,
        role: values.role,
        kind: values.kind,
        name: values.name,
        expiresInDays:
          values["expires-days"] === undefined ? undefined : Number(values["expires-days"]),
      });
      // Details to stderr, the secret alone to stdout, so `TOKEN=$(turntable token create ...)` works.
      console.error(
        `created ${created.kind} ${created.role} token ${created.id} for ${created.org}${created.project ? `/${created.project}` : ""}, expires ${iso(created.expiresAt)}. It is shown once.`,
      );
      console.log(created.secret);
    } finally {
      db.close();
    }
  } else if (sub === "list") {
    if (!values.org) throw new Error("--org is required");
    const db = open();
    try {
      const rows = await listTokensFromCli(db, { org: values.org, project: values.project });
      console.log(
        ["ID", "NAME", "ROLE", "KIND", "PROJECT", "STATUS", "LAST USED", "EXPIRES"].join("\t"),
      );
      for (const r of rows) {
        console.log(
          [
            r.id,
            r.name,
            r.role,
            r.kind,
            r.project ?? "(org)",
            r.status,
            iso(r.lastUsedAt),
            iso(r.expiresAt),
          ].join("\t"),
        );
      }
    } finally {
      db.close();
    }
  } else if (sub === "revoke") {
    const [id] = positionals;
    if (!id) throw new Error("usage: turntable token revoke <id> [--data-dir ./data]");
    const db = open();
    try {
      const done = await revokeTokenFromCli(db, id);
      console.error(`revoked token ${done.id} (${done.name})`);
    } finally {
      db.close();
    }
  } else {
    throw new Error("usage: turntable token <generate|create|list|revoke> ...");
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  // Before any subcommand opens the data directory: as root, drop (or refuse) like `serve` does.
  dropForCommand(command, rest);
  switch (command) {
    case "serve":
      return await serve(rest);
    case "token":
      return await token(rest);
    case "keys": {
      const { keysCommand } = await import("./github/cli");
      return await keysCommand(rest);
    }
    case "github-app": {
      const { githubAppCommand } = await import("./github/cli");
      return await githubAppCommand(rest);
    }
    case "run": {
      const { runCommand } = await import("./run/cli");
      process.exit(await runCommand(rest));
    }
    case "release": {
      const { releaseCommand } = await import("./release/cli");
      process.exit(await releaseCommand(rest));
    }
    case "oidc": {
      const { oidcCommand } = await import("./oidc/cli");
      process.exit(await oidcCommand(rest));
    }
    case "secret": {
      const { secretCommand } = await import("./secrets/cli");
      process.exit(await secretCommand(rest));
    }
    case "audit": {
      const { auditCommand } = await import("./audit/cli");
      process.exit(await auditCommand(rest));
    }
    case "policy": {
      const { policyCommand } = await import("./ops/policy-command");
      return await policyCommand(rest);
    }
    case "mcp": {
      const { mcpCommand } = await import("./mcp/cli");
      return await mcpCommand(rest);
    }
    case "approvals": {
      const { approvalsCommand } = await import("./approvals/cli");
      process.exit(await approvalsCommand(rest));
    }
    case "incident": {
      const { incidentCommand } = await import("./incident/cli");
      process.exit(await incidentCommand(rest));
    }
    case "db": {
      const { dbCommand } = await import("./db/cli");
      process.exit(await dbCommand(rest));
    }
    case "quotas": {
      const { quotasCommand } = await import("./quotas/cli");
      process.exit(await quotasCommand(rest));
    }
    case "usage": {
      const { usageCommand } = await import("./usage/cli");
      process.exit(await usageCommand(rest));
    }
    case "doctor": {
      const { doctorCommand } = await import("./doctor/cli");
      process.exit(await doctorCommand(rest));
    }
    case "artifacts": {
      const { artifactsCommand } = await import("./artifacts/cli");
      process.exit(await artifactsCommand(rest));
    }
    case "channel": {
      const { channelCommand } = await import("./channel/cli");
      return await channelCommand(rest);
    }
    case "fetch-source": {
      const { fetchSourceCommand } = await import("./run/fetch-source-cli");
      process.exit(await fetchSourceCommand(rest));
    }
    case "parity": {
      const { parityCommand } = await import("./parity/cli");
      process.exit(await parityCommand(rest));
    }
    case "verify": {
      const { verifyCommand } = await import("./verify/cli");
      process.exit(await verifyCommand(rest));
    }
    case "version":
    case "--version":
      console.log(VERSION);
      return;
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return;
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
