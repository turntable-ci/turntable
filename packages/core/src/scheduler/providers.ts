import { readFileSync } from "node:fs";
import {
  DaytonaProvider,
  HARD_MAX_LIVE,
  type OwnerCiPreflight,
  parseFleetName,
} from "@turntable/provider-daytona";
import { DockerProvider } from "@turntable/provider-docker";
import type { Provider } from "@turntable/provider-sdk";
import {
  BUILTIN_CEILINGS,
  checkProviderInfo,
  parsePluginPins,
  ProviderTrustError,
  verifyExternalPlugin,
  type PluginPin,
} from "./provider-trust";

/** Providers `serve --provider` knows. */
export const PROVIDER_NAMES = ["docker", "daytona"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export function isProviderName(name: string): name is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(name);
}

/**
 * Reads a provider config file: a JSON object of provider options. Secrets do not go in it:
 * a provider that needs an API key reads it from a file named here (never inline).
 */
export function parseProviderConfig(text: string, source: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `cannot read provider config ${source}: ${err instanceof Error ? err.message : "error"}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`provider config ${source} must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

export function loadProviderConfig(path: string | undefined): Record<string, unknown> {
  if (path === undefined) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read provider config ${path}: ${err instanceof Error ? err.message : "error"}`,
    );
  }
  return parseProviderConfig(text, path);
}

const DOCKER_KEYS = new Set(["docker", "maxFileBytes", "runtime"]);

/**
 * Builds the provider named on the command line. It codes against the provider-sdk `Provider`
 * interface only, so the worker never knows which one it has.
 */
export function createProvider(
  name: string,
  config: Record<string, unknown> = {},
  opts: {
    hosted?: boolean;
    pins?: readonly PluginPin[];
    /** Limits read at each sandbox create (#661); the Daytona provider uses them. */
    limits?: () => { maxLive?: number | undefined; cpuLimit?: number | undefined };
  } = {},
): Provider {
  if (!isProviderName(name)) {
    // Not built in: gated by hosted mode and a digest pin, and no external loader exists yet.
    const path = verifyExternalPlugin(name, {
      hosted: opts.hosted === true,
      pins: opts.pins ?? parsePluginPins(process.env.TURNTABLE_PROVIDER_PLUGINS),
    });
    throw new ProviderTrustError(
      `plugin ${name} (${path}) matches its pinned digest, but this build has no external provider loader; use one of: ${PROVIDER_NAMES.join(", ")}`,
    );
  }
  const provider = build(name, config, opts.limits);
  // The declaration is checked at registration, before the scheduler relies on it.
  checkProviderInfo(name, provider.info, BUILTIN_CEILINGS[name]);
  return provider;
}

function build(
  name: ProviderName,
  config: Record<string, unknown>,
  limits?: () => { maxLive?: number | undefined; cpuLimit?: number | undefined },
): Provider {
  switch (name) {
    case "docker": {
      const unknown = Object.keys(config).filter((k) => !DOCKER_KEYS.has(k));
      if (unknown.length > 0) {
        throw new Error(
          `unknown docker provider option(s): ${unknown.join(", ")} (known: ${[...DOCKER_KEYS].join(", ")})`,
        );
      }
      return new DockerProvider({
        ...(typeof config.docker === "string" ? { docker: config.docker } : {}),
        ...(typeof config.maxFileBytes === "number" ? { maxFileBytes: config.maxFileBytes } : {}),
        // `runsc` (gVisor) makes the provider declare the gvisor isolation class.
        ...(typeof config.runtime === "string" ? { hardening: { runtime: config.runtime } } : {}),
      });
    }
    case "daytona":
      return createDaytona(config, limits);
  }
}

const DAYTONA_KEYS = new Set([
  "baseUrl",
  "apiKeyFile",
  "apiKeyEnv",
  "maxLive",
  "snapshot",
  "target",
  "ttlSeconds",
  "capacityWaitSeconds",
  "createTimeoutSeconds",
  "ownerCiPreflight",
  "quotaMode",
  "fleet",
  "ownerCiLabels",
  "ownerCiLabelWaitAt",
  "allowDomainListConfinement",
]);

function str(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v === "")
    throw new Error(`daytona provider option ${key} must be a non-empty string`);
  return v;
}

function int(
  config: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const v = config[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`daytona provider option ${key} must be an integer from ${min} to ${max}`);
  }
  return v;
}

/**
 * `ownerCiPreflight` in the config: `true` (or absent) is the defaults; an object sets the org CPU
 * check's `cpuLimit`, `region` and `sandboxClass`; `false` turns that org check off. The label
 * count of the account owner's CI sandboxes is part of the provider and is never configurable.
 */
/**
 * `ownerCiLabels` in the config: `{ key, values }`, how the account owner's CI sandboxes are
 * recognised (label `key` set to one of `values`). Absent means no label check.
 */
function ownerCiLabelsOf(v: unknown): { key: string; values: string[] } | undefined {
  if (v === undefined) return undefined;
  const o = v as { key?: unknown; values?: unknown };
  if (v === null || typeof v !== "object" || Array.isArray(v))
    throw new Error("daytona provider option ownerCiLabels must be { key, values }");
  const unknown = Object.keys(o).filter((k) => k !== "key" && k !== "values");
  if (unknown.length > 0) throw new Error(`unknown ownerCiLabels option(s): ${unknown.join(", ")}`);
  if (typeof o.key !== "string" || !/^[A-Za-z0-9._/-]{1,63}$/.test(o.key))
    throw new Error("ownerCiLabels.key must be a short label name");
  if (
    !Array.isArray(o.values) ||
    o.values.length === 0 ||
    o.values.length > 50 ||
    !o.values.every((x) => typeof x === "string" && /^[A-Za-z0-9._/-]{1,63}$/.test(x))
  )
    throw new Error("ownerCiLabels.values must be 1 to 50 short label values");
  return { key: o.key, values: o.values as string[] };
}

function ownerCiPreflightOf(v: unknown): OwnerCiPreflight | false | undefined {
  if (v === undefined || v === true) return undefined;
  if (v === false) return false;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(
      "daytona provider option ownerCiPreflight must be true, false or { cpuLimit, diskLimitGiB, memLimitGiB, region, sandboxClass }",
    );
  }
  const o = v as Record<string, unknown>;
  const unknown = Object.keys(o).filter(
    (k) => !["cpuLimit", "region", "sandboxClass", "diskLimitGiB", "memLimitGiB"].includes(k),
  );
  if (unknown.length > 0) {
    throw new Error(`unknown ownerCiPreflight option(s): ${unknown.join(", ")}`);
  }
  const out: OwnerCiPreflight = {};
  if (o.cpuLimit !== undefined) {
    if (
      typeof o.cpuLimit !== "number" ||
      !Number.isInteger(o.cpuLimit) ||
      o.cpuLimit < 1 ||
      o.cpuLimit > 10_000
    ) {
      throw new Error("ownerCiPreflight.cpuLimit must be an integer from 1 to 10000");
    }
    out.cpuLimit = o.cpuLimit;
  }
  for (const k of ["diskLimitGiB", "memLimitGiB"] as const) {
    const x = o[k];
    if (x === undefined) continue;
    if (typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > 1_000_000) {
      throw new Error(`ownerCiPreflight.${k} must be an integer from 1 to 1000000`);
    }
    out[k] = x;
  }
  for (const k of ["region", "sandboxClass"] as const) {
    const x = o[k];
    if (x === undefined) continue;
    if (typeof x !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(x)) {
      throw new Error(`ownerCiPreflight.${k} must be a short lower-case name`);
    }
    out[k] = x;
  }
  return out;
}

/**
 * Daytona, for a shared account. The key is never in the config: `apiKeyFile` names a file that
 * holds it (or `apiKeyEnv` an environment variable; default `DAYTONA_API_KEY`). The label and name
 * prefix come from `fleet` (default `longshore-dev`), the 30 minute backstops, the owner-CI preflight and the ceiling of 10 live
 * sandboxes (the default is 2) are fixed in the provider and cannot be configured away.
 */
function createDaytona(
  config: Record<string, unknown>,
  limits?: () => { maxLive?: number | undefined; cpuLimit?: number | undefined },
): Provider {
  const unknown = Object.keys(config).filter((k) => !DAYTONA_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `unknown daytona provider option(s): ${unknown.join(", ")} (known: ${[...DAYTONA_KEYS].join(", ")})`,
    );
  }
  const preflight = ownerCiPreflightOf(config.ownerCiPreflight);
  const quotaMode = config.quotaMode;
  if (quotaMode !== undefined && quotaMode !== "org-usage" && quotaMode !== "own-fleet") {
    throw new Error('daytona provider option quotaMode must be "org-usage" or "own-fleet"');
  }
  const labels = ownerCiLabelsOf(config.ownerCiLabels);
  const labelWaitAt = int(config, "ownerCiLabelWaitAt", 1, 1000);
  if (labelWaitAt !== undefined && labels === undefined)
    throw new Error("daytona provider option ownerCiLabelWaitAt needs ownerCiLabels");
  const domainOk = config.allowDomainListConfinement;
  if (domainOk !== undefined && typeof domainOk !== "boolean") {
    throw new Error("daytona provider option allowDomainListConfinement must be true or false");
  }
  if (config.apiKeyFile !== undefined && config.apiKeyEnv !== undefined) {
    throw new Error("set only one of apiKeyFile and apiKeyEnv for the daytona provider");
  }
  const keyFile = str(config, "apiKeyFile");
  const keyEnv = str(config, "apiKeyEnv") ?? "DAYTONA_API_KEY";
  const baseUrl = str(config, "baseUrl");
  const snapshot = str(config, "snapshot");
  const target = str(config, "target");
  const fleet = str(config, "fleet");
  if (fleet !== undefined) parseFleetName(fleet);
  const maxLive = int(config, "maxLive", 1, HARD_MAX_LIVE);
  const ttl = int(config, "ttlSeconds", 60, 1800);
  const wait = int(config, "capacityWaitSeconds", 1, 3600);
  const createTimeout = int(config, "createTimeoutSeconds", 10, 1800);
  return new DaytonaProvider({
    apiKey: keyFile !== undefined ? { file: keyFile } : { env: keyEnv },
    ...(baseUrl ? { baseUrl } : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(target ? { target } : {}),
    ...(fleet ? { fleet } : {}),
    ...(maxLive !== undefined ? { maxLive } : {}),
    ...(wait !== undefined ? { capacityWaitMs: wait * 1000 } : {}),
    ...(createTimeout !== undefined ? { createTimeoutMs: createTimeout * 1000 } : {}),
    // The scheduler asks for job timeout plus slack, usually past 30 minutes: clamp instead of
    // refusing so jobs still run; the sandbox is reaped at the cap either way.
    // Off unless the operator says so: a domain list rests on Daytona's filter reading the TLS
    // server name, which the strict address allow list does not.
    ...(domainOk === true ? { allowDomainListConfinement: true } : {}),
    ...(preflight !== undefined ? { ownerCiPreflight: preflight } : {}),
    ...(quotaMode ? { quotaMode } : {}),
    ...(labels ? { ownerCiLabels: labels } : {}),
    ...(labelWaitAt !== undefined ? { ownerCiLabelWaitAt: labelWaitAt } : {}),
    ...(limits ? { limits } : {}),
    clampTtl: true,
    ...(ttl !== undefined ? { maxTtlSeconds: ttl } : {}),
  });
}
