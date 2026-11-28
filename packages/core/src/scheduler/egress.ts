import type { Provider } from "@turntable/provider-sdk";
import type { AttemptContext, AttemptOutcome, AttemptRunner } from "./types";

/**
 * Egress for a run's sandboxes. Deny by default for every trust class: a run gets `none` unless
 * its recorded plan names another policy (set from the project's configuration when the run is
 * created), or the runner was explicitly built with `open` (the local `turntable run` opt-in).
 * `allowlist` is understood so a provider that cannot enforce it is refused rather than silently
 * given more network. Anything else, including a missing, malformed or unknown value, is `none`.
 */
export type Egress = "none" | "open" | "allowlist";

export function egressForRun(
  runPlan: string | null | undefined,
  explicit?: "none" | "open",
): Egress {
  if (explicit === "open") return "open";
  if (!runPlan) return "none";
  try {
    const plan = JSON.parse(runPlan) as { egress?: unknown; trust?: unknown } | null;
    if (plan === null || typeof plan !== "object") return "none";
    // Untrusted code never gets open egress, whatever a config said (mining, exfiltration).
    if (plan.trust === "untrusted_pr" || plan.trust === "untrusted") {
      return plan.egress === "allowlist" ? "allowlist" : "none";
    }
    return plan.egress === "open" || plan.egress === "allowlist" ? plan.egress : "none";
  } catch {
    return "none";
  }
}

export type EgressDecision = { ok: true } | { ok: false; reason: string };

/**
 * Whether a job may run with this egress on this provider:
 * - the provider must be able to enforce the policy it is asked for (`none` included: a provider
 *   that cannot cut the network would only pretend);
 * - a secret-bearing job never runs on `open`.
 */
export function egressDecision(o: {
  egress: Egress;
  secretBearing: boolean;
  provider: Pick<Provider["info"], "name" | "network">;
}): EgressDecision {
  const { egress, secretBearing, provider } = o;
  if (secretBearing && egress === "open") {
    return { ok: false, reason: "egress: a job with secrets cannot run with open egress" };
  }
  if (!provider.network.egressPolicy.includes(egress)) {
    return {
      ok: false,
      reason: `egress: provider ${provider.name} cannot enforce egress ${egress}`,
    };
  }
  return { ok: true };
}

export type EgressPolicyOptions = {
  /** Whether a job holds secrets. Nothing carries secrets yet, so the default is false. */
  secretBearing?: (ctx: AttemptContext) => boolean;
  /** An explicit local `open`, as for `createActRunner`'s `egress` option. */
  explicit?: "none" | "open";
};

/**
 * Wraps a runner so a job never starts where its egress policy cannot be enforced. A refused
 * resume (#789) is not returned from here: the attempt inherited a sandbox and an exec from the
 * last controller, so it goes to the runner as `refuseResume`, which stops the exec, releases the
 * sandbox and ends the attempt with the reason, without running anything. A refusal an outer
 * wrapper already made is kept as it is.
 */
export function withEgressPolicy(
  runner: AttemptRunner,
  o: EgressPolicyOptions = {},
): AttemptRunner {
  return async (ctx: AttemptContext): Promise<AttemptOutcome> => {
    const d = egressDecision({
      egress: egressForRun(ctx.run.plan, o.explicit),
      secretBearing: o.secretBearing?.(ctx) ?? false,
      provider: ctx.provider.info,
    });
    if (!d.ok) {
      if (ctx.resume) return runner({ ...ctx, refuseResume: ctx.refuseResume ?? d.reason });
      return { state: "infra_error", reason: d.reason };
    }
    return runner(ctx);
  };
}
