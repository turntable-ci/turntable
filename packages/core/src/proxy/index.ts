// The secrets proxy, wired into job execution (#15). One proxy per worker. For each attempt the
// worker registers the project's injection rules (from `proxy_rules`, each host re-checked
// against the vault secret's destinations) and revokes them when the attempt ends, however it
// ends. Values come from the vault per request, through its one policy path, and are added to the
// attempt's redaction set as they are used. Nothing here puts a secret in a sandbox.
import type net from "node:net";
import {
  AttemptRegistry,
  compileRule,
  type AttemptCredential,
  type AuditEvent,
  type AuditSink,
  type Inject,
  type ResolvedSecret,
  type Rule,
  type SecretScope,
  type SecretSource,
  startProxy,
  type RunningProxy,
} from "@turntable/proxy";
import { plannedArtifactUpload, plannedIdToken } from "@turntable/act-runner";
import { dockerBridgeGateway } from "@turntable/provider-docker";
import type { ProxyEndpoint } from "@turntable/provider-sdk";
import { SecretRegistry } from "@turntable/redact";
import type { SafeFetch } from "@turntable/net";
import type { Db } from "../db";
import {
  appendAudit,
  listPassthroughHosts,
  listRepos,
  type PassthroughEntry,
  listProxyRules,
  type ProxyRuleRow,
  type Scope,
} from "../db/repos";
import { parseTrust } from "../db/repos/approve";
import type { SecretVault } from "../secrets/vault";
import { credentialsFor, type TrustClass } from "../trust";
import type { AttemptContext, AttemptOutcome, AttemptRunner } from "../scheduler/types";
import {
  type AdoptProxySpec,
  type AttemptSeeds,
  invalidSpec,
  parseAdoptSpec,
  sameCheck,
  seedCheck,
  specHash,
} from "../scheduler/adopt-credentials";

/** What a runner needs to put a job behind the proxy. */
export interface ProxyAccess {
  /** The proxy as the provider's host reaches it (the provider gives the sandbox its own route). */
  listen: ProxyEndpoint;
  credential: AttemptCredential;
  /**
   * The attempt has vault rules, so it must run behind the proxy. Without them the proxy is only
   * there to hold a GitHub token, and a job that gets none runs as if it were not here.
   */
  vaultRules: boolean;
  /** The attempt's rules include the upload-only route to the artifact service. */
  artifactUpload?: boolean;
  /**
   * How another controller re-registers this same credential (#787), stored with the attempt.
   * Absent when the proxy has no seed source (no master key): the attempt is then not adoptable.
   */
  adopt?: AdoptProxySpec;
  /**
   * Hands the proxy this attempt's GitHub installation token, minted once the job is planned. The
   * proxy attaches it to requests to the run's own repository; the job never holds it.
   */
  setGithubToken(token: string | undefined): void;
  /**
   * Hands the proxy a way to mint this attempt's OIDC credential (see oidc/job-delivery). The
   * proxy calls it per request, attaches the result to requests for the org's mint URL and keeps
   * nothing; the job holds a placeholder.
   */
  setOidcMinter(mint: (() => string) | undefined): void;
}

/** The rule `secret` that means "this attempt's OIDC mint credential" (not a vault secret). */
export const OIDC_CREDENTIAL_SECRET = "@oidc-credential";

/** Where an org's OIDC issuer mints tokens. */
export interface OidcTarget {
  host: string;
  port: number;
  pathPrefix: string;
}

export { plannedIdToken };

/** The one rule that lets a job ask its own org's issuer for a token. Nothing else on that host. */
export function oidcRules(t: OidcTarget): Rule[] {
  return [
    {
      id: "oidc-mint",
      host: t.host,
      port: t.port,
      methods: ["GET", "POST"],
      pathPrefix: t.pathPrefix,
      pathExact: true,
      inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
      secret: OIDC_CREDENTIAL_SECRET,
    },
  ];
}

/** Where the control plane's artifact service is, as a sandbox reaches it. */
export interface ArtifactTarget {
  host: string;
  port: number;
}

/**
 * The route a sandbox with no network of its own has to the artifact service: the two twirp calls
 * and the blob PUT of an upload, and nothing else on that host (no list, no signed download URL,
 * no GET). Nothing is injected: the job holds an upload-only artifact credential (artifacts/grants,
 * mode `upload`), and the service refuses it everything but this.
 */
export function artifactRules(t: ArtifactTarget): Rule[] {
  const twirp = (id: string, method: string): Rule => ({
    id,
    host: t.host,
    port: t.port,
    methods: ["POST"],
    pathPrefix: `${ARTIFACT_TWIRP}${method}`,
    pathExact: true,
    inject: { type: "none" },
  });
  return [
    twirp("artifact-create", "CreateArtifact"),
    twirp("artifact-finalize", "FinalizeArtifact"),
    {
      id: "artifact-blob-put",
      host: t.host,
      port: t.port,
      methods: ["PUT"],
      pathPrefix: "/_artifacts",
      pathShape: "/_artifacts/*/upload/*",
      inject: { type: "none" },
    },
  ];
}

/** The twirp path the artifact service answers on (kept equal to artifacts/service.ts by a test). */
const ARTIFACT_TWIRP = "/twirp/github.actions.results.api.v1.ArtifactService/";

/** The target of an artifact service whose public URL is `baseUrl`: https only, as the proxy is. */
export function artifactTargetOf(baseUrl: string): ArtifactTarget | undefined {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:") return undefined;
    return { host: u.hostname.toLowerCase(), port: u.port === "" ? 443 : Number(u.port) };
  } catch {
    return undefined;
  }
}

/** The rule `secret` that means "this attempt's GitHub token" (not a vault secret). */
export const GITHUB_TOKEN_SECRET = "@github-token";

/** A GitHub repository the run belongs to, with the installation its token comes from. */
export interface GithubTarget {
  owner: string;
  repo: string;
  installationId: string;
}

const SAFE_GH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * The rules that let a job use its own GitHub token without holding it: the API for this one
 * repository (and GraphQL), and git over HTTPS for this one repository. Nothing else on GitHub.
 */
export function githubRules(t: GithubTarget): Rule[] {
  if (!SAFE_GH.test(t.owner) || !SAFE_GH.test(t.repo)) return [];
  const api = (id: string, pathPrefix: string, methods: string[]): Rule => ({
    id,
    host: "api.github.com",
    methods,
    pathPrefix,
    inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
    secret: GITHUB_TOKEN_SECRET,
    forwardHeaders: ["x-github-api-version"],
  });
  const git = (id: string, pathPrefix: string): Rule => ({
    id,
    host: "github.com",
    methods: ["GET", "POST"],
    pathPrefix,
    inject: { type: "basic", username: "x-access-token" },
    secret: GITHUB_TOKEN_SECRET,
    forwardHeaders: ["git-protocol"],
  });
  const base = `/${t.owner}/${t.repo}`;
  return [
    api("github-api-repo", `/repos/${t.owner}/${t.repo}`, [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ]),
    api("github-api-graphql", "/graphql", ["POST"]),
    git("github-git", base),
    git("github-git-dotgit", `${base}.git`),
  ];
}

export interface SecretsProxyOptions {
  db: Db;
  vault: SecretVault;
  /**
   * Interface to bind. Default: the Docker bridge's gateway on Linux (what containers reach as
   * the host, and no other interface), else loopback (Docker Desktop routes the host name there).
   * `0.0.0.0` or `::` is an explicit opt-in and logs a warning.
   */
  bindHost?: string;
  /** Test seam: how the bridge gateway is found. */
  bridgeGateway?: () => Promise<string | undefined>;
  /** Default: a free port. */
  port?: number;
  /** How the provider's host names this machine. Default `host.docker.internal`. */
  advertiseHost?: string;
  /**
   * Serve over TLS on a public name (for sandboxes in another provider's network, such as
   * Daytona). The certificate is for `advertiseHost`.
   */
  tls?: { key: string; cert: string };
  /** The port sandboxes are told to use, when it differs from the one bound (a platform that forwards). */
  advertisePort?: number;
  /** The endpoint's stable IPv4 addresses, for a provider that filters by address. */
  advertiseAddresses?: readonly string[];
  /** Limits on the listener (see the proxy's limits). */
  limits?: Parameters<typeof startProxy>[0]["limits"];
  /** Test seams: where requests and passthrough tunnels really go. */
  upstream?: SafeFetch;
  tunnel?: (host: string, port: number) => Promise<net.Socket>;
  now?: () => number;
  log?: (message: string) => void;
  /**
   * Per-attempt seeds from the master key (#787). With them each attempt's credential and CA are
   * derived instead of random, so a controller that adopts the attempt can register them again.
   * Without them every proxied attempt stays bound to the process that registered it.
   */
  seeds?: AttemptSeeds;
}

interface Live {
  scope: Required<Scope>;
  redact: SecretRegistry;
  /** False while this controller's lease on the attempt may have lapsed (#789): inject nothing. */
  leaseValid?: (() => boolean) | undefined;
  githubToken?: string | undefined;
  oidcMint?: (() => string) | undefined;
}

const toRule = (r: ProxyRuleRow): Rule => ({
  id: r.name,
  host: r.host,
  port: r.port,
  methods: JSON.parse(r.methods) as string[],
  pathPrefix: r.pathPrefix,
  inject:
    r.injectType === "basic"
      ? { type: "basic", username: r.injectUsername ?? "" }
      : ({
          type: "header",
          name: r.injectHeader ?? "",
          ...(r.injectFormat === null ? {} : { format: r.injectFormat }),
        } satisfies Inject),
  secret: r.secret,
});

/** The address to bind when none was asked for: the narrowest one a container can reach. */
export async function defaultBindHost(
  gateway: () => Promise<string | undefined> = () => dockerBridgeGateway(),
): Promise<string> {
  return (await gateway()) ?? "127.0.0.1";
}

const WILDCARD = new Set(["0.0.0.0", "::", "[::]"]);

export class SecretsProxy {
  readonly #o: SecretsProxyOptions;
  readonly #registry: AttemptRegistry;
  readonly #live = new Map<string, Live>();
  #running: RunningProxy | undefined;

  private constructor(o: SecretsProxyOptions) {
    this.#o = o;
    this.#registry = new AttemptRegistry(o.now ? { now: o.now } : {});
  }

  static async start(o: SecretsProxyOptions): Promise<SecretsProxy> {
    const p = new SecretsProxy(o);
    const bind = o.bindHost ?? (await defaultBindHost(o.bridgeGateway));
    if (WILDCARD.has(bind)) {
      o.log?.(
        `WARNING: the secrets proxy is bound to ${bind}, every interface of this machine. Each connection still needs a per-attempt credential, but prefer the Docker bridge address.`,
      );
    }
    const source: SecretSource = { resolve: (scope, rule) => p.#resolve(scope, rule) };
    const audit: AuditSink = { record: (e) => p.#audit(e) };
    p.#running = await startProxy({
      registry: p.#registry,
      source,
      audit,
      host: bind,
      port: o.port ?? 0,
      ...(o.tls ? { tls: o.tls } : {}),
      ...(o.limits ? { limits: o.limits } : {}),
      ...(o.upstream ? { upstream: o.upstream } : {}),
      ...(o.tunnel ? { tunnel: o.tunnel } : {}),
      ...(o.now ? { now: o.now } : {}),
    });
    return p;
  }

  /** The address the proxy actually bound. */
  get host(): string {
    return this.#running?.host ?? "127.0.0.1";
  }

  get port(): number {
    return this.#running?.port ?? 0;
  }

  async stop(): Promise<void> {
    await this.#running?.close();
  }

  async #resolve(scope: SecretScope, rule: Rule): Promise<ResolvedSecret> {
    const live = this.#live.get(scope.attemptId);
    if (!live || !rule.secret) return { ok: false, reason: "no_attempt" };
    // Past this controller's lease, by its own clock, another controller may hold the attempt and
    // its own credentials (#789): nothing of this one's is used until a heartbeat renews the lease.
    if (live.leaseValid && !live.leaseValid()) return { ok: false, reason: "lease_lapsed" };
    if (rule.secret === GITHUB_TOKEN_SECRET) {
      // This attempt's own token, never a vault secret. Only the rules githubRules builds name it.
      if (!live.githubToken) return { ok: false, reason: "no_github_token" };
      live.redact.register(live.githubToken);
      return { ok: true, value: live.githubToken };
    }
    if (rule.secret === OIDC_CREDENTIAL_SECRET) {
      // This attempt's own mint credential, never a vault secret. Only oidcRules names it.
      if (!live.oidcMint) return { ok: false, reason: "no_oidc_credential" };
      // Minted now, for this request, and short-lived. Registered with the redactor all the same.
      const credential = live.oidcMint();
      live.redact.register(credential);
      return { ok: true, value: credential };
    }
    // Through the vault's one policy path, per request: class, scope, destination, rotation,
    // freeze and audit all apply. Nothing is read ahead of time.
    const r = await this.#o.vault.use({
      orgId: scope.orgId,
      projectId: scope.projectId,
      runId: scope.runId,
      jobId: scope.jobId,
      attemptId: scope.attemptId,
      name: rule.secret,
      destination: scope.host,
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    // The log redactor learns the value before it can be echoed anywhere.
    live.redact.register(r.value);
    return { ok: true, value: r.value };
  }

  async #audit(e: AuditEvent): Promise<void> {
    const live = this.#live.get(e.attemptId);
    // An event with no attempt behind it (a bad credential) has no org to attribute it to.
    if (!live) {
      this.#o.log?.(`proxy: ${e.kind} ${e.reason ?? ""} for an unknown attempt`);
      return;
    }
    await appendAudit(this.#o.db, live.scope, {
      principalKind: "attempt",
      principalId: e.attemptId,
      op: `proxy_${e.kind}`,
      effect: "use",
      outcome: e.reason ?? "ok",
      input: {
        host: e.host ?? null,
        port: e.port ?? null,
        method: e.method ?? null,
        rule: e.ruleId ?? null,
        ...(e.detail ? { detail: e.detail } : {}),
      },
    });
  }

  /**
   * The rules this attempt may have: the project's, each one only while the vault secret it names
   * still lists the rule's host. Never from a workflow.
   */
  async rulesFor(scope: Required<Scope>): Promise<Rule[]> {
    return (await this.vaultPolicy(scope)).rules;
  }

  /**
   * The project's rules (as `rulesFor`) and the stored rows they were built from: the policy
   * inputs an adopted attempt's registration is compared on (#789), not the built rules.
   */
  async vaultPolicy(scope: Required<Scope>): Promise<{ rules: Rule[]; inputs: ProxyRuleRow[] }> {
    const out: Rule[] = [];
    const inputs: ProxyRuleRow[] = [];
    for (const row of await listProxyRules(this.#o.db, scope)) {
      if (!(await this.#o.vault.canDeliver(scope.orgId, scope.projectId, row.secret, row.host))) {
        this.#o.log?.(
          `proxy rule ${row.name} skipped: its host is not a destination of the secret`,
        );
        continue;
      }
      const rule = toRule(row);
      try {
        compileRule(rule);
      } catch {
        this.#o.log?.(`proxy rule ${row.name} skipped: it does not compile`);
        continue;
      }
      out.push(rule);
      inputs.push(row);
    }
    return { rules: out, inputs };
  }

  /** The hosts the project allows plain tunnels to. */
  passthroughFor(scope: Required<Scope>): Promise<PassthroughEntry[]> {
    return listPassthroughHosts(this.#o.db, scope);
  }

  /** The endpoint sandboxes are told to use, as `host:port` (compared on adoption). */
  get endpoint(): string {
    return `${this.#o.advertiseHost ?? "host.docker.internal"}:${this.#o.advertisePort ?? this.port}`;
  }

  /**
   * Registers a fresh attempt. `policy` (from `proxyPolicyHash`) is what an adoption is compared
   * on; without it, the hash of the built rules (as before #789).
   */
  register(
    ctx: AttemptContext,
    rules: readonly Rule[],
    o: {
      passthroughHosts: readonly PassthroughEntry[];
      ttlMs: number;
      vaultRules?: boolean;
      artifactUpload?: boolean;
      policy?: string;
    },
  ): { access: ProxyAccess; redact: SecretRegistry } {
    const seed = this.#o.seeds?.("proxy", { orgId: ctx.scope.orgId, attemptId: ctx.attempt.id });
    const issuedAt = (this.#o.now ?? Date.now)();
    return this.#register(ctx, rules, {
      ...o,
      ...(seed
        ? {
            derive: { seed, issuedAt },
            // Adoptable only on a pinned port: a free port differs in the next process, which
            // would refuse every adoption, so the attempt stays not adoptable (drain waits).
            ...(this.#o.port || this.#o.advertisePort
              ? {
                  adopt: {
                    issuedAt,
                    ttlMs: o.ttlMs,
                    rules: o.policy ?? rulesHash(rules, o.passthroughHosts),
                    endpoint: this.endpoint,
                    check: seedCheck(seed),
                  },
                }
              : {}),
          }
        : {}),
    });
  }

  /**
   * Registers, for an attempt this controller adopted (#787), the credential the old controller
   * registered: the same seed, time and rules give the same password and CA, so the sandbox's
   * proxy URL and trusted CA still work. Refused (with why) when anything differs: no seed source,
   * another master key, another policy or another endpoint. Nothing then runs with a credential
   * that is not the one it had.
   *
   * The policy is compared on its inputs (`policy`, from `proxyPolicyHash`), not on the rules this
   * build makes of them (#789): a deploy that changes how rules are built, or the Rule type, does
   * not refuse the attempts it takes over; only a changed project policy (or a bumped
   * PROXY_POLICY_VERSION) does. A spec recorded before that holds the hash of the built rules, and
   * is accepted while this build makes the same rules.
   */
  adopt(
    ctx: AttemptContext,
    spec: AdoptProxySpec,
    rules: readonly Rule[],
    o: {
      passthroughHosts: readonly PassthroughEntry[];
      vaultRules?: boolean;
      artifactUpload?: boolean;
      policy?: string;
    },
  ): { ok: true; access: ProxyAccess; redact: SecretRegistry } | { ok: false; why: string } {
    const seed = this.#o.seeds?.("proxy", { orgId: ctx.scope.orgId, attemptId: ctx.attempt.id });
    if (!seed) return { ok: false, why: "this controller derives no proxy credentials" };
    if (!sameCheck(seed, spec.check)) return { ok: false, why: "the master key changed" };
    if (spec.endpoint !== this.endpoint) return { ok: false, why: "the proxy endpoint changed" };
    const samePolicy =
      (o.policy !== undefined && spec.rules === o.policy) ||
      spec.rules === rulesHash(rules, o.passthroughHosts);
    if (!samePolicy) return { ok: false, why: "the attempt's proxy rules changed" };
    if (spec.issuedAt + spec.ttlMs <= (this.#o.now ?? Date.now)()) {
      return { ok: false, why: "the credential has expired" };
    }
    try {
      return {
        ok: true,
        ...this.#register(ctx, rules, {
          ...o,
          ttlMs: spec.ttlMs,
          derive: { seed, issuedAt: spec.issuedAt },
          adopt: spec,
        }),
      };
    } catch (e) {
      return { ok: false, why: e instanceof Error ? e.message : String(e) };
    }
  }

  #register(
    ctx: AttemptContext,
    rules: readonly Rule[],
    o: {
      passthroughHosts: readonly PassthroughEntry[];
      ttlMs: number;
      vaultRules?: boolean;
      artifactUpload?: boolean;
      derive?: { seed: Buffer; issuedAt: number };
      adopt?: AdoptProxySpec;
    },
  ): { access: ProxyAccess; redact: SecretRegistry } {
    const credential = this.#registry.register(
      {
        attemptId: ctx.attempt.id,
        orgId: ctx.scope.orgId,
        projectId: ctx.scope.projectId,
        runId: ctx.run.id,
        jobId: ctx.job.id,
        rules,
        passthroughHosts: o.passthroughHosts,
        ttlMs: o.ttlMs,
      },
      o.derive,
    );
    const redact = new SecretRegistry();
    this.#live.set(ctx.attempt.id, {
      scope: ctx.scope,
      redact,
      ...(ctx.leaseValid ? { leaseValid: ctx.leaseValid } : {}),
    });
    const live = this.#live.get(ctx.attempt.id);
    return {
      access: {
        listen: {
          host: this.#o.advertiseHost ?? "host.docker.internal",
          port: this.#o.advertisePort ?? this.port,
          // The name the certificate is for, when this is a public TLS listener.
          ...(this.#o.tls ? { tlsName: this.#o.advertiseHost ?? "host.docker.internal" } : {}),
          ...(this.#o.advertiseAddresses ? { addresses: this.#o.advertiseAddresses } : {}),
        },
        credential,
        vaultRules: o.vaultRules ?? true,
        artifactUpload: o.artifactUpload ?? false,
        ...(o.adopt ? { adopt: o.adopt } : {}),
        setGithubToken: (token) => {
          if (live) live.githubToken = token;
        },
        setOidcMinter: (mint) => {
          if (live) live.oidcMint = mint;
        },
      },
      redact,
    };
  }

  /** Ends the attempt's credential and closes its tunnels. Idempotent. */
  release(attemptId: string): void {
    this.#registry.revoke(attemptId);
    this.#registry.sweep();
    this.#live.delete(attemptId);
  }

  /** Attempts with a live registration (for tests and status). */
  get active(): number {
    return this.#live.size;
  }
}

/**
 * The hash of the built rules: what a spec recorded before #789 holds. Accepted on adoption only
 * while this build makes the same rules from the same inputs.
 */
function rulesHash(rules: readonly Rule[], passthrough: readonly PassthroughEntry[]): string {
  return specHash({ rules, passthrough });
}

/**
 * The version of how rules are built from the policy inputs (#789). Bump it only when a change to
 * the rule builders, or to the proxy's matching, must not be applied to an attempt that is already
 * running: the next controller then refuses to adopt the attempts registered before (they end as a
 * lost controller). A change that is fine for a running job (most are: the credential and CA do
 * not depend on the rules) leaves it, and adopted attempts get this build's rules.
 */
export const PROXY_POLICY_VERSION = 1;

/** What an attempt's proxy rules are built from: the project's policy, not the builder's output. */
export interface ProxyPolicyInputs {
  /** The project's rule rows that were kept (their secret still lists the host). */
  vault: readonly ProxyRuleRow[];
  passthrough: readonly PassthroughEntry[];
  github: GithubTarget | undefined;
  oidc: OidcTarget | undefined;
  artifact: ArtifactTarget | undefined;
}

/**
 * The hash an adopted attempt's policy must match (#789). Each input is named field by field, so a
 * column added to a table or a field added to a target changes nothing until it is listed here
 * (and listing one is a policy change: bump PROXY_POLICY_VERSION with it). No secret value is in
 * any input: a rule names its secret, it never holds it.
 */
export function proxyPolicyHash(p: ProxyPolicyInputs): string {
  const v = PROXY_POLICY_VERSION;
  return `policy${v}:${specHash({
    v,
    vault: p.vault.map((r) => [
      r.name,
      r.secret,
      r.host,
      r.port,
      r.methods,
      r.pathPrefix,
      r.injectType,
      r.injectHeader ?? null,
      r.injectFormat ?? null,
      r.injectUsername ?? null,
    ]),
    passthrough: p.passthrough.map((e) => [e.host, [...e.ports]]),
    github: p.github ? [p.github.owner, p.github.repo, p.github.installationId] : null,
    oidc: p.oidc ? [p.oidc.host, p.oidc.port, p.oidc.pathPrefix] : null,
    artifact: p.artifact ? [p.artifact.host, p.artifact.port] : null,
  })}`;
}

export interface SecretsProxyRunnerOptions {
  proxy: SecretsProxy;
  /** How long an attempt's credential lives. Default: the longest job plus a margin. */
  ttlMs?: number;
  /**
   * Where a run's GitHub token would come from: its bound repository and installation. Absent or
   * returning nothing: no GitHub rules.
   */
  github?: (ctx: AttemptContext) => Promise<GithubTarget | undefined>;
  /**
   * The artifact service, for a job whose plan has an `actions/upload-artifact` step: the proxy
   * then lets it reach the upload endpoints (and only those). Absent or returning nothing: no
   * artifact rule, so a job with no network of its own cannot upload.
   */
  artifacts?: (ctx: AttemptContext) => ArtifactTarget | undefined;
  /**
   * The org's OIDC mint endpoint, for a class that may mint. Absent or returning nothing: no
   * OIDC rule, so a job cannot reach the issuer through the proxy.
   */
  oidc?: (ctx: AttemptContext, klass: TrustClass) => Promise<OidcTarget | undefined>;
}

/**
 * Wraps a runner: registers the attempt's rules before it starts and revokes them after, in a
 * finally and at once when the attempt is aborted (cancel, timeout, lease loss).
 * - Vault rules (the project's `proxy_rules`) only for a class that may hold secrets; never for
 *   `untrusted_pr`.
 * - GitHub rules (the job's own token, for its own repository) for every class when the run is
 *   bound to an installation. For `untrusted_pr` they are the ONLY rules.
 * - No rules at all: no proxy, egress unchanged.
 * - A re-attached attempt (#787) registers again the credential the old controller registered,
 *   from the spec stored with it, or is refused (infra_error), fail closed: it never runs behind
 *   a proxy that does not know it, nor with other rules. An older attempt with no spec keeps the
 *   old rule: refused when it would have had vault rules.
 */
export function withSecretsProxy(
  runner: AttemptRunner,
  o: SecretsProxyRunnerOptions,
): AttemptRunner {
  return async (ctx): Promise<AttemptOutcome> => {
    const klass = parseTrust(ctx.run)?.class as TrustClass | undefined;
    if (klass === undefined) return runner(ctx);
    const mayHoldSecrets = klass !== "untrusted_pr" && credentialsFor(klass).secrets;
    const vault = mayHoldSecrets ? await o.proxy.vaultPolicy(ctx.scope) : undefined;
    const vaultRules = vault?.rules ?? [];
    const target = o.github ? await o.github(ctx) : undefined;
    const ghRules = target ? githubRules(target) : [];
    // The rule exists only for a job whose plan asked for an ID token, not for every job of a
    // class that may mint.
    const oidcTarget =
      o.oidc && plannedIdToken(ctx.job.planned) ? await o.oidc(ctx, klass) : undefined;
    // Likewise only for a job that has an upload-artifact step.
    const artifactTarget =
      o.artifacts && plannedArtifactUpload(ctx.job.planned) ? o.artifacts(ctx) : undefined;
    const rules = [
      ...vaultRules,
      ...ghRules,
      ...(oidcTarget ? oidcRules(oidcTarget) : []),
      ...(artifactTarget ? artifactRules(artifactTarget) : []),
    ];
    const passthroughHosts = mayHoldSecrets ? await o.proxy.passthroughFor(ctx.scope) : [];
    // What an adoption is compared on: the inputs, so a deploy that only changes how rules are
    // built does not refuse the attempts it takes over (#789).
    const policy = proxyPolicyHash({
      vault: vault?.inputs ?? [],
      passthrough: passthroughHosts,
      github: ghRules.length > 0 ? target : undefined,
      oidc: oidcTarget,
      artifact: artifactTarget,
    });
    const parsed = ctx.resume ? parseAdoptSpec(ctx.attempt.adoptSpec) : undefined;
    if (invalidSpec(parsed)) {
      return runner({
        ...ctx,
        refuseResume: `re-attached attempt has an unusable adoption record (${parsed.invalid}); not resumed`,
      });
    }
    const spec = parsed;
    if (ctx.resume && spec) {
      // The job never went behind the proxy (no rule it needed was used): nothing to restore.
      if (!spec.proxy) return runner(ctx);
      const r = o.proxy.adopt(ctx, spec.proxy, rules, {
        passthroughHosts,
        vaultRules: vaultRules.length > 0,
        artifactUpload: artifactTarget !== undefined,
        policy,
      });
      if (!r.ok) {
        // The runner releases the inherited sandbox and ends the attempt: returning here would
        // leave its exec running without its credential.
        return runner({
          ...ctx,
          refuseResume: `re-attached attempt lost its secrets-proxy credential (${r.why}); not resumed`,
        });
      }
      return guarded(ctx, r.access, r.redact);
    }
    if (rules.length === 0) return runner(ctx);
    if (ctx.resume) {
      // Vault rules: the credential died with the old process, so the job cannot be resumed. With
      // GitHub rules only, the job may or may not have had a token; it carries on without the
      // proxy (a token it held is unusable: its credential is gone), which can only fail closed.
      if (vaultRules.length === 0) return runner(ctx);
      return runner({
        ...ctx,
        refuseResume: "re-attached attempt lost its secrets-proxy credential; not resumed",
      });
    }
    const { access, redact } = o.proxy.register(ctx, rules, {
      // Hosts with no rule are tunnelled only if the project listed them, and only for a class
      // that may hold secrets. No list, rule hosts only.
      passthroughHosts,
      ttlMs: o.ttlMs ?? 5 * 3600 * 1000,
      vaultRules: vaultRules.length > 0,
      artifactUpload: artifactTarget !== undefined,
      policy,
    });
    return guarded(ctx, access, redact);
  };
  /** Runs with the registration, and revokes it however the attempt ends (or is handed off). */
  async function guarded(
    ctx: AttemptContext,
    access: ProxyAccess,
    redact: SecretRegistry,
  ): Promise<AttemptOutcome> {
    const revoke = (): void => o.proxy.release(ctx.attempt.id);
    ctx.signal.addEventListener("abort", revoke, { once: true });
    try {
      return await runner({ ...ctx, proxy: access, redact });
    } finally {
      ctx.signal.removeEventListener("abort", revoke);
      revoke();
    }
  }
}

/**
 * The run's GitHub repository and installation, from the project's binding: what a job token is
 * minted for. Nothing for a local run, a project with no binding, or a binding with no installation.
 */
export function githubTargetOf(
  db: Db,
): (ctx: Pick<AttemptContext, "run" | "scope">) => Promise<GithubTarget | undefined> {
  return async ({ run, scope }) => {
    if (run.local) return undefined;
    const bound = (await listRepos(db, scope))[0];
    if (!bound || bound.forge !== "github" || !bound.installationId) return undefined;
    return { owner: bound.owner, repo: bound.repo, installationId: bound.installationId };
  };
}
