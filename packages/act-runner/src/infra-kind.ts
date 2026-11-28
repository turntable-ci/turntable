/**
 * Why an attempt ended `infra_error`, as a name from a small closed set. The kind is carried next
 * to the reason (whose text is unchanged) so the scheduler can decide whether one retry is worth
 * it. This table is the only place that says which kinds are transient, and whether each one
 * happens before any job step runs (`beforeSteps`). A kind that can happen mid-run could follow
 * steps with side effects (a deploy, a publish), so it is retried only for pull request jobs.
 */
export const INFRA_KINDS = {
  /** The sandbox's Docker daemon never came up (`docker info` failed). */
  docker_daemon_unavailable: {
    transient: true,
    beforeSteps: true,
    label: "the sandbox's Docker daemon was unavailable",
  },
  /**
   * A job's service container never reported healthy within act's 5 minute limit (#796): the
   * steps did not start. Usually the service's own config (env, --health-cmd), so never retried.
   */
  service_unhealthy: {
    transient: false,
    beforeSteps: true,
    label: "a service container did not become healthy",
  },
  /** The provider could not create the sandbox. */
  sandbox_create_failed: {
    transient: true,
    beforeSteps: true,
    label: "the sandbox could not be created",
  },
  /** The sandbox or the act process in it vanished before a result, possibly mid-run. */
  sandbox_lost: { transient: true, beforeSteps: false, label: "the sandbox was lost" },
  /** Reserved for a rate-limited image pull (#513): nothing produces it yet. It is the preflight. */
  image_pull_rate_limited: {
    transient: true,
    beforeSteps: true,
    label: "an image pull was rate limited",
  },
  /**
   * The forge refused the checkout's installation token (401, 403, or 404 to a request with a
   * token): the App installation cannot read the repository. Deterministic, so never retried.
   */
  checkout_auth_failed: {
    transient: false,
    beforeSteps: true,
    label: "the checkout was refused by GitHub",
  },
  /**
   * The control plane could not fetch the sources (full history or submodules, #698): a network
   * error before any sandbox exists. Requeued while the network is degraded, else retried once.
   */
  checkout_fetch_failed: {
    transient: true,
    beforeSteps: true,
    label: "the checkout could not be fetched",
  },
  /**
   * GitHub rate limited the control plane's action lookups past the job's wait budget (#621).
   * Nothing ran, so it is safe for every trust class; the retry waits for the reset first.
   */
  github_rate_limited: {
    transient: true,
    beforeSteps: true,
    label: "GitHub rate limited the action lookups",
  },
  /**
   * An error that matches no known class (an unclassified exception from the provider or the
   * runner, #670). Retried once, like `sandbox_lost`: it can happen mid-run, so only a pull
   * request job retries it. The instance administrator reads its sanitized text.
   */
  unknown: {
    transient: true,
    beforeSteps: false,
    label: "an unclassified infrastructure error",
  },
  /**
   * The strict tree scan refused the checkout's tarball (a malformed or over-limit archive). It is
   * deterministic for that sha, so never retried; the reason names the rule that refused it.
   */
  tree_scan: {
    transient: false,
    beforeSteps: true,
    label: "the checkout's tree scan refused the repository",
  },
  /**
   * The checkout ran over a size budget (pack, unpacked data, tarball or memory). Deterministic for
   * that sha and those budgets, so never retried; the reason and the job log name the limit, its
   * value and the setting that raises it.
   */
  fetch_limit: {
    transient: false,
    beforeSteps: true,
    label: "the checkout ran over a size limit",
  },
  /** Everything else: a deterministic or unknown cause. Never retried. */
  other: {
    transient: false,
    beforeSteps: false,
    label: "an infrastructure error",
  },
} as const satisfies Record<string, { transient: boolean; beforeSteps: boolean; label: string }>;

export type InfraKind = keyof typeof INFRA_KINDS;

export function isInfraKind(v: unknown): v is InfraKind {
  return typeof v === "string" && Object.hasOwn(INFRA_KINDS, v);
}

/**
 * True when a failure that may have followed job steps is worth one retry for this trust class:
 * only a pull request job (`trusted_pr`, `untrusted_pr`). `protected` and `release` jobs may have
 * deployed or published already. An unknown or unrecorded class counts as not a pull request.
 * The drain-cut requeue (#565) applies this same rule.
 */
export function retryableAfterSteps(trustClass: string | null | undefined): boolean {
  return trustClass === "trusted_pr" || trustClass === "untrusted_pr";
}

/**
 * True for a kind worth one retry on a fresh sandbox. A kind that can happen mid-run is retried
 * only for a pull request job (`trusted_pr`, `untrusted_pr`); `protected` and `release` jobs may
 * have deployed or published before the sandbox died, so they end `infra_error`. An unknown class
 * counts as not a pull request.
 */
export function isRetryableInfra(
  kind: InfraKind | null | undefined,
  trustClass: string | null | undefined,
): boolean {
  if (kind == null || !INFRA_KINDS[kind].transient) return false;
  return INFRA_KINDS[kind].beforeSteps || retryableAfterSteps(trustClass);
}
