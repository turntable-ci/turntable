import { createPrivateKey, X509Certificate } from "node:crypto";
import { type CreateStats, processCreateStats } from "../scheduler/create-stats";
import { isAbsolute, join, relative, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { ingestStatus, POLL_RESERVE } from "../poll/status";
import { type NetworkHealth, processNetwork } from "../network";
import { processDrain } from "../scheduler/drain";
import {
  providerDaytonaCpuLimitSetting,
  providerDaytonaMaxLiveSetting,
  schedulerGlobalCapSetting,
  schedulerOrgCapSetting,
} from "../settings/definitions";
import { envValue } from "../settings/resolve";
import { open, secretAad } from "../secrets/crypto";
import { RELEASE_KEY_ENV, RELEASE_KEY_PREVIOUS_ENV } from "../roles";
import { anchorKeyMessage } from "../secrets/master-key";
import { SECRET_APP_ID, SECRET_PRIVATE_KEY, SECRET_WEBHOOK } from "../github/app-auth";
import {
  checkoutConfigFromEnv,
  DEFAULT_CHECKOUT_CONFIG,
  limitsFor,
  unpackedBudget,
} from "../run/checkout-child";
import { FULL_HISTORY_FACTOR } from "../run/git-fetch";
import { type DoctorCheck, type DoctorInputs, report, type DoctorReport } from "./types";

/** `openError` value for a data directory with no database file yet. */
export const MISSING_DATABASE = "missing";
const DAY = 86_400_000;
const CERT_WARN_DAYS = 14;

const pass = (id: string, area: string, summary: string): DoctorCheck => ({
  id,
  area,
  status: "pass",
  summary,
});
const warn = (id: string, area: string, summary: string, fix: string): DoctorCheck => ({
  id,
  area,
  status: "warn",
  summary,
  fix,
});
const fail = (
  id: string,
  area: string,
  summary: string,
  fix: string,
  detail?: string,
): DoctorCheck => ({
  id,
  area,
  status: "fail",
  summary,
  ...(detail ? { detail } : {}),
  fix,
});

const set = (v: string | undefined): string | undefined => (v?.trim() ? v.trim() : undefined);

/** The process and the data directory: root is dropped, and the directory is ours to write. */
export function checkPrivileges(i: DoctorInputs): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  if (i.proc.uid === 0 && set(i.env.TURNTABLE_DROP_PRIVILEGES)) {
    out.push(
      warn(
        "privileges",
        "process",
        `this check runs as root; the server drops to ${set(i.env.TURNTABLE_DROP_PRIVILEGES)} at start`,
        "Run doctor as that user (or through the API of the running server) for the true picture.",
      ),
    );
  } else if (i.proc.uid === 0) {
    out.push(
      fail(
        "privileges",
        "process",
        "running as root: privileges were not dropped",
        "Set TURNTABLE_DROP_PRIVILEGES=<uid>:<gid> (the image sets 65532:65532 and drops after taking ownership of the data directory), or start the process as a non-root user.",
      ),
    );
  } else {
    out.push(pass("privileges", "process", `running as uid ${i.proc.uid}, not root`));
  }
  const dir = i.fs.stat(i.dataDir);
  if (!dir) {
    out.push(
      warn(
        "data_dir",
        "process",
        "the data directory does not exist yet",
        "It is created at first start. Mount a persistent volume there first, or the data will not survive a restart.",
      ),
    );
  } else if (!dir.isDirectory) {
    out.push(
      fail(
        "data_dir",
        "process",
        "the data path is not a directory",
        "Point --data-dir at a directory.",
      ),
    );
  } else if (!i.fs.writable(i.dataDir)) {
    out.push(
      fail(
        "data_dir",
        "process",
        `the data directory is owned by uid ${dir.uid} and this process (uid ${i.proc.uid}) cannot write to it`,
        `Make it writable by this user, for example: chown -R ${i.proc.uid}:${i.proc.gid} <data dir>. In the image, start as root with TURNTABLE_DROP_PRIVILEGES set and it does this itself.`,
      ),
    );
  } else if ((dir.mode & 0o002) !== 0) {
    out.push(
      warn(
        "data_dir",
        "process",
        "the data directory is writable by everyone",
        "Remove world write: chmod o-w <data dir>. It holds the database and may hold keys.",
      ),
    );
  } else if (dir.uid !== i.proc.uid) {
    out.push(
      warn(
        "data_dir",
        "process",
        `the data directory is owned by uid ${dir.uid}, not this process (uid ${i.proc.uid}), but is writable`,
        `Own it as the service user: chown -R ${i.proc.uid}:${i.proc.gid} <data dir>.`,
      ),
    );
  } else {
    out.push(
      pass(
        "data_dir",
        "process",
        "the data directory exists and is owned and writable by this user",
      ),
    );
  }
  return out;
}

/** True when `path` is `dir` or inside it. */
const inside = (dir: string, path: string): boolean => {
  const rel = relative(resolve(dir), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const KEY_ON_VOLUME_FIX =
  "Move the key off the volume: set it as TURNTABLE_MASTER_KEY (or mount the file from a separate secrets store), re-wrap with TURNTABLE_MASTER_KEY_PREVIOUS, then delete the file. See the key rotation runbook in docs/hosted.mdx.";

/** The release key file must not sit in a directory that is backed up: the lane's own, or the main one. */
export function checkReleaseKey(i: DoctorInputs): DoctorCheck[] {
  const k = i.releaseKey;
  if (!k) return [];
  const where = [
    inside(i.dataDir, k.file) ? "the data directory" : undefined,
    k.dataDir && inside(k.dataDir, k.file) ? "the release data directory" : undefined,
  ].filter((x): x is string => x !== undefined);
  if (where.length === 0) {
    return [
      pass("release_key", "keys", "the release master key file is outside the data directories"),
    ];
  }
  return [
    warn(
      "release_key",
      "keys",
      `the release master key file is inside ${where.join(" and ")}: every volume backup holds the signing keys' wrapper next to what it unseals`,
      `Set ${RELEASE_KEY_ENV} instead (re-wrap with ${RELEASE_KEY_PREVIOUS_ENV}), then delete the file. See docs/hosted.mdx.`,
    ),
  ];
}

export function checkAuditAnchors(i: DoctorInputs): DoctorCheck {
  const bad = i.unreadableAnchors?.() ?? [];
  if (bad.length === 0) {
    return pass(
      "audit_anchor",
      "keys",
      "the audit anchor state opens under the current master key",
    );
  }
  return fail(
    "audit_anchor",
    "keys",
    `audit anchor for org ${bad.join(", ")} is sealed under another master key (most likely the previous one)`,
    anchorKeyMessage(bad[0]!),
  );
}

/** The sealed anchor state is only worth something off the volume that holds the database it anchors. */
export function checkAuditStateDir(i: DoctorInputs): DoctorCheck[] {
  const dir = i.auditStateDir;
  if (!dir) return [];
  if (inside(i.dataDir, dir)) {
    return [
      warn(
        "audit_state_dir",
        "keys",
        "the audit anchor state is inside the data directory: whoever can restore or edit the volume restores matching anchors with it",
        "Set TURNTABLE_AUDIT_STATE_DIR to a separate mount or secrets volume, and set audit_anchor_sink_url to export anchors off this instance. See docs/security.mdx (audit integrity).",
      ),
    ];
  }
  return [pass("audit_state_dir", "keys", "the audit anchor state is outside the data directory")];
}

export function checkMasterKey(i: DoctorInputs): DoctorCheck {
  const path = set(i.env.TURNTABLE_MASTER_KEY_FILE);
  const area = "keys";
  if (i.masterKeyEnv) {
    if (path) {
      return fail(
        "master_key",
        area,
        "TURNTABLE_MASTER_KEY and TURNTABLE_MASTER_KEY_FILE are both set",
        "Use one. Remove TURNTABLE_MASTER_KEY_FILE once the key is in the variable.",
      );
    }
    // A key file left in the data directory is the thing the variable was meant to get rid of:
    // every volume backup would still carry it. Any 32-byte `*.key` file counts.
    const stray = (i.fs.list?.(i.dataDir) ?? []).filter((n) => {
      if (!n.endsWith(".key")) return false;
      const f = i.fs.stat(join(i.dataDir, n));
      return f !== undefined && !f.isDirectory && f.size === 32;
    });
    if (stray.length > 0) {
      return warn(
        "master_key",
        area,
        `the master key comes from TURNTABLE_MASTER_KEY, but the data directory still holds a key file (${stray.join(", ")}): volume backups carry it`,
        "Once a backup taken after the re-wrap exists, delete the file from the volume, then rotate the GitHub App private key, the webhook secret and the vault secrets so the copies in older backups are dead.",
      );
    }
    return pass(
      "master_key",
      area,
      "the master key comes from TURNTABLE_MASTER_KEY, off the data volume",
    );
  }
  if (!path) {
    const what =
      "without a master key there is no vault, secrets store, GitHub App, OIDC issuer or signed audit checkpoints";
    const fix =
      "Set TURNTABLE_MASTER_KEY (`openssl rand -base64 32`), or create a file with `turntable keys init` and set TURNTABLE_MASTER_KEY_FILE.";
    return i.hosted
      ? fail("master_key", area, `no master key is configured: ${what}`, fix)
      : warn("master_key", area, `no master key is configured: ${what}`, fix);
  }
  const f = i.fs.stat(path);
  if (!f) {
    return fail(
      "master_key",
      area,
      "the master key file named by TURNTABLE_MASTER_KEY_FILE does not exist",
      "Create it with `turntable keys init --file <path>`, or restore it from backup. Without it sealed values cannot be read.",
    );
  }
  if (f.size !== 32) {
    return fail(
      "master_key",
      area,
      `the master key file is ${f.size} bytes, not 32`,
      "Restore the original key from backup. Do not edit it: a wrong key cannot open existing records.",
    );
  }
  if ((f.mode & 0o077) !== 0) {
    return warn(
      "master_key",
      area,
      `the master key file is readable by group or others (mode ${f.mode.toString(8)})`,
      "chmod 600 the file, and keep it out of the data directory's backups unless they are encrypted.",
    );
  }
  if (inside(i.dataDir, path)) {
    return warn(
      "master_key",
      area,
      "the master key file is inside the data directory: every volume backup holds the key next to what it unseals",
      KEY_ON_VOLUME_FIX,
    );
  }
  return pass(
    "master_key",
    area,
    "the master key file exists, is 32 bytes and is private to its owner",
  );
}

export async function checkDatabase(i: DoctorInputs): Promise<DoctorCheck[]> {
  const area = "database";
  if (!i.db && i.openError === MISSING_DATABASE) {
    return [
      warn(
        "database",
        area,
        "the database does not exist yet",
        "It is created at first start: run `turntable serve` once, from the data directory you mean to use.",
      ),
    ];
  }
  if (!i.db) {
    return [
      fail(
        "database",
        area,
        "the database cannot be opened",
        "Check the data directory and that no other process holds a lock on turntable.db.",
        i.openError?.slice(0, 160),
      ),
    ];
  }
  const out: DoctorCheck[] = [];
  try {
    await i.db.all(sql`SELECT 1 AS ok`);
    out.push(pass("database", area, "the database answers"));
  } catch (e) {
    return [
      fail(
        "database",
        area,
        "the database does not answer",
        "Check the file's permissions and free disk space.",
        String(e).slice(0, 160),
      ),
    ];
  }
  let applied: string[];
  try {
    applied = (await i.db.all(sql`SELECT tag FROM __turntable_migrations`)).map((r) =>
      String(r.tag),
    );
  } catch {
    out.push(
      warn(
        "migrations",
        area,
        "the database has no migration record yet",
        "It is created at first start: run `turntable serve` once.",
      ),
    );
    return out;
  }
  const expected = new Set(i.expectedMigrations);
  const pending = i.expectedMigrations.filter((t) => !applied.includes(t));
  const unknown = applied.filter((t) => !expected.has(t));
  if (unknown.length > 0) {
    out.push(
      fail(
        "migrations",
        area,
        `the database has ${unknown.length} migration(s) this binary does not know: it was written by a newer version`,
        "Do not run this binary against it. Use the newer version, or restore a backup taken before the upgrade.",
      ),
    );
  } else if (pending.length > 0) {
    out.push(
      warn(
        "migrations",
        area,
        `${pending.length} migration(s) are pending and will run when the server starts`,
        "Back up the data directory first: migrations only go forward.",
      ),
    );
  } else {
    out.push(pass("migrations", area, `all ${applied.length} migrations are applied`));
  }
  return out;
}

/** The GitHub App's credentials: the app is registered, and its key and webhook secret open. */
export async function checkGithubApp(i: DoctorInputs): Promise<DoctorCheck> {
  const area = "github";
  const none = (): DoctorCheck =>
    i.hosted
      ? fail(
          "github_app",
          area,
          "no GitHub App is configured",
          "Run `turntable github-app create --url <public url>`, or set up the App for hosted use.",
        )
      : warn(
          "github_app",
          area,
          "no GitHub App is configured: only polling and local runs are possible",
          "Run `turntable github-app create --url <public url>` to receive webhooks and report checks.",
        );
  if (!i.db)
    return fail(
      "github_app",
      area,
      "not checked: the database is not open",
      "Fix the database first.",
    );
  const db = i.db;
  let app: { org_id: string } | undefined;
  try {
    app = (await i.db.all(sql`SELECT org_id FROM github_apps ORDER BY created_at LIMIT 1`))[0] as
      { org_id: string } | undefined;
  } catch {
    return none();
  }
  if (!app) return none();
  const key = i.masterKey();
  if (!key)
    return fail(
      "github_app",
      area,
      "the App exists but the master key is not available to check its credentials",
      "Set TURNTABLE_MASTER_KEY_FILE to the key the App was created with.",
    );
  const opens = async (name: string): Promise<"ok" | "missing" | "unreadable"> => {
    const row = (
      await db.all(
        sql`SELECT ciphertext FROM secrets WHERE org_id = ${app!.org_id} AND name = ${name}`,
      )
    )[0];
    if (!row) return "missing";
    try {
      return open(key, String(row.ciphertext), secretAad(app!.org_id, name), "system", app!.org_id)
        .length > 0
        ? "ok"
        : "missing";
    } catch {
      return "unreadable";
    }
  };
  const state = {
    "app id": await opens(SECRET_APP_ID),
    "private key": await opens(SECRET_PRIVATE_KEY),
    "webhook secret": await opens(SECRET_WEBHOOK),
  };
  const bad = Object.entries(state).filter(([, v]) => v !== "ok");
  if (bad.length === 0)
    return pass(
      "github_app",
      area,
      "the GitHub App is configured; its id, private key and webhook secret are present and open",
    );
  return fail(
    "github_app",
    area,
    `GitHub App credentials not usable: ${bad.map(([n, v]) => `${n} ${v}`).join(", ")}`,
    bad.some(([, v]) => v === "unreadable")
      ? "A record does not open under this master key: use the key the App was created with, or restore from backup."
      : "Re-create the App with `turntable github-app create`, or rotate the webhook secret with `turntable github-app rotate-webhook-secret`.",
  );
}

/** The public TLS listener's certificate for the secrets proxy: valid now, not about to expire, for the right name. */
export function checkProxyTls(i: DoctorInputs): DoctorCheck {
  const area = "proxy";
  const certPath = set(i.env.TURNTABLE_PROXY_TLS_CERT_FILE);
  const keyPath = set(i.env.TURNTABLE_PROXY_TLS_KEY_FILE);
  if (!certPath && !keyPath)
    return pass("proxy_tls", area, "no public TLS listener is configured for the secrets proxy");
  if (!certPath || !keyPath)
    return fail(
      "proxy_tls",
      area,
      "only one of the proxy's TLS certificate and key is set",
      "Set both TURNTABLE_PROXY_TLS_CERT_FILE and TURNTABLE_PROXY_TLS_KEY_FILE.",
    );
  const certPem = i.fs.read(certPath, 64 * 1024);
  const keyPem = i.fs.read(keyPath, 64 * 1024);
  if (!certPem || !keyPem)
    return fail(
      "proxy_tls",
      area,
      "the proxy's TLS certificate or key file cannot be read",
      "Check the paths and that the service user can read both files.",
    );
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    return fail(
      "proxy_tls",
      area,
      "the proxy's TLS certificate is not a valid PEM certificate",
      "Provide the certificate in PEM form.",
    );
  }
  try {
    if (!cert.checkPrivateKey(createPrivateKey(keyPem)))
      return fail(
        "proxy_tls",
        area,
        "the proxy's TLS key does not belong to its certificate",
        "Use the key that matches the certificate.",
      );
  } catch {
    return fail(
      "proxy_tls",
      area,
      "the proxy's TLS key is not a valid PEM private key",
      "Provide the key in PEM form, unencrypted.",
    );
  }
  const now = i.now();
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  if (now < from)
    return fail(
      "proxy_tls",
      area,
      "the proxy's TLS certificate is not valid yet",
      "Check the certificate's dates and this machine's clock.",
    );
  if (now > to)
    return fail(
      "proxy_tls",
      area,
      `the proxy's TLS certificate expired ${Math.ceil((now - to) / DAY)} day(s) ago`,
      "Renew it and restart the server.",
    );
  const host = set(i.env.TURNTABLE_PROXY_ADVERTISE_HOST);
  if (host && !cert.checkHost(host))
    return warn(
      "proxy_tls",
      area,
      `the proxy's TLS certificate does not name its advertised host ${host}`,
      "Issue a certificate for that host name, or fix TURNTABLE_PROXY_ADVERTISE_HOST.",
    );
  const left = Math.floor((to - now) / DAY);
  return left < CERT_WARN_DAYS
    ? warn(
        "proxy_tls",
        area,
        `the proxy's TLS certificate expires in ${left} day(s)`,
        "Renew it and restart the server.",
      )
    : pass("proxy_tls", area, `the proxy's TLS certificate is valid for ${left} more days`);
}

/** Forwarded headers the server saw, against what it was told to trust. */
export function checkForwarded(i: DoctorInputs): DoctorCheck {
  const area = "network";
  const trustProto = i.env.TURNTABLE_TRUST_FORWARDED_PROTO === "1";
  const trustedProxies = set(i.env.TURNTABLE_TRUSTED_PROXIES) !== undefined;
  if (!i.observed) {
    return pass(
      "forwarded_headers",
      area,
      `forwarded-header trust is ${trustProto ? "on" : "off"} for protocol and ${trustedProxies ? "set" : "unset"} for client addresses (the live server compares this with what it sees: run doctor through the API to include that)`,
    );
  }
  const o = i.observed;
  if (o.requests === 0)
    return pass(
      "forwarded_headers",
      area,
      "no requests have been seen yet, so the settings could not be compared with real traffic",
    );
  const problems: string[] = [];
  if (o.withForwardedProto > 0 && !trustProto)
    problems.push(
      `${o.withForwardedProto} request(s) carried X-Forwarded-Proto but TURNTABLE_TRUST_FORWARDED_PROTO is not set, so http is not redirected to https and value-bearing requests behind the proxy are refused`,
    );
  if (o.withForwardedFor > 0 && !trustedProxies)
    problems.push(
      `${o.withForwardedFor} request(s) carried X-Forwarded-For but TURNTABLE_TRUSTED_PROXIES is empty, so rate limits key on the proxy's address, not the client's`,
    );
  if (trustProto && o.withForwardedProto === 0)
    problems.push(
      "TURNTABLE_TRUST_FORWARDED_PROTO is set but no request carried X-Forwarded-Proto: is the proxy in front of this server?",
    );
  if (trustedProxies && o.withForwardedFor === 0)
    problems.push("TURNTABLE_TRUSTED_PROXIES is set but no request carried X-Forwarded-For");
  return problems.length === 0
    ? pass(
        "forwarded_headers",
        area,
        `forwarded-header settings match the ${o.requests} request(s) seen`,
      )
    : warn(
        "forwarded_headers",
        area,
        problems.join("; "),
        "Set TURNTABLE_TRUST_FORWARDED_PROTO=1 and name your proxies in TURNTABLE_TRUSTED_PROXIES when a proxy you control is in front; clear them when none is.",
      );
}

/** Plain http is redirected to https, here or by the proxy in front. */
export function checkHttpsRedirect(i: DoctorInputs): DoctorCheck {
  const area = "network";
  const trustProto = i.env.TURNTABLE_TRUST_FORWARDED_PROTO === "1";
  const hsts = i.env.TURNTABLE_HSTS_MAX_AGE?.trim().toLowerCase();
  if (hsts === "off" || hsts === "0")
    return warn(
      "https_redirect",
      area,
      "HSTS is turned off",
      "Unset TURNTABLE_HSTS_MAX_AGE (the default is one year) unless something in front sends it.",
    );
  if (trustProto)
    return pass(
      "https_redirect",
      area,
      "behind a trusted proxy, http requests get a 301 to https and https responses carry HSTS",
    );
  return i.hosted
    ? fail(
        "https_redirect",
        area,
        "plain http is not redirected here: no trusted proxy is configured",
        "Set TURNTABLE_TRUST_FORWARDED_PROTO=1 behind a proxy you control, and turn on the proxy's Always Use HTTPS as well.",
      )
    : warn(
        "https_redirect",
        area,
        "plain http is not redirected by this server (no trusted proxy is configured)",
        "On a public site set TURNTABLE_TRUST_FORWARDED_PROTO=1 behind your proxy and enable its Always Use HTTPS. Loopback development needs neither.",
      );
}

export async function checkChannel(i: DoctorInputs): Promise<DoctorCheck> {
  const area = "release";
  if (i.releaseLane)
    return pass(
      "release_channel",
      area,
      "the release lane is this process's supervised child: its channel is made at boot and checked by release_lane_process",
    );
  const configured = set(i.env.TURNTABLE_PUBLISH_CHANNEL_KEY_FILE);
  if (!configured || !i.channel)
    return pass(
      "release_channel",
      area,
      "no release channel is configured, so compat publishing is off",
    );
  const keyFile = i.fs.stat(configured);
  if (!keyFile)
    return fail(
      "release_channel",
      area,
      "the release channel key file does not exist",
      "Create it, with the same content as the key file the release lane uses for its channel.",
    );
  if ((keyFile.mode & 0o077) !== 0)
    return warn(
      "release_channel",
      area,
      "the release channel key file is readable by group or others",
      "chmod 600 it.",
    );
  const r = await i.channel();
  return r.ok
    ? pass(
        "release_channel",
        area,
        "the release lane answers over the channel and accepts this process's request key",
      )
    : fail(
        "release_channel",
        area,
        `the release lane channel is not usable: ${r.reason}`,
        "Check that the lane is running with the channel enabled, the socket or address matches, and both sides hold the same key.",
        r.detail,
      );
}

/**
 * A release approval challenge reads the lane's configuration version over the config channel, so
 * with no way to it every release approval is refused. This process knows a lane is expected only
 * through its own config channel client settings (`configChannel` is set when they are present);
 * it reads no release lane variable. With none, no lane is configured here and the check passes.
 */
export async function checkConfigChannel(i: DoctorInputs): Promise<DoctorCheck> {
  const area = "release";
  if (i.releaseLane)
    return pass(
      "release_config_channel",
      area,
      "the release lane is this process's supervised child: its config channel is made at boot and checked by release_lane_process",
    );
  if (!i.configChannel)
    return pass(
      "release_config_channel",
      area,
      "no release lane configured here, so there is no config channel to reach",
    );
  const r = await i.configChannel();
  return r.ok
    ? pass("release_config_channel", area, "the release lane's config channel answers")
    : fail(
        "release_config_channel",
        area,
        "release lane config channel unreachable: release approvals will be refused",
        `Check that the lane is running, the channel address and TLS files here match it, and that the config key file here holds the same key as the lane's (${r.reason}).`,
        "detail" in r ? r.detail : undefined,
      );
}

/** The supervised release lane: running and answering, or restarting. Only the running server knows. */
export function checkReleaseLane(i: DoctorInputs): DoctorCheck {
  const area = "release";
  const id = "release_lane_process";
  if (!i.releaseLane) return pass(id, area, "the release lane is not supervised by this process");
  const s = i.releaseLane();
  const exit = s.lastExit
    ? ` Last exit: code ${s.lastExit.code ?? "none"}, signal ${s.lastExit.signal ?? "none"}.`
    : "";
  if (s.state === "ready")
    return pass(id, area, `the release lane child is running and answers on its channel`);
  return fail(
    id,
    area,
    `the release lane child is ${s.state}: release requests are refused with release_lane_unavailable.${exit}`,
    "Read the lane's own log lines (`[turntable release]`) for why it exited; a bad key, data dir or token is the usual cause. The lane is not restarted by this process: when it is lost the server exits non-zero and the platform restarts the container.",
  );
}

/**
 * The checkout unpacked budget (shallow and full history) is clamped to the child's memory ceiling
 * minus the pack budget and a fixed overhead. Doctor reads the environment (the instance values
 * that `TURNTABLE_CHECKOUT_*` set, when it sets the unpacked budget); a per-project override is clamped the same way at run time.
 */
export function checkCheckoutBudgets(i: DoctorInputs): DoctorCheck {
  const id = "checkout_budgets";
  const area = "limits";
  let cfg;
  try {
    cfg = checkoutConfigFromEnv(i.env);
  } catch {
    return pass(id, area, "checkout budgets are not checked: an environment value is invalid");
  }
  // Only a budget the operator set is reported: the full-history default (4 x 512 MiB) is above
  // the default ceiling on purpose and is clamped quietly (see docs/configuration.mdx).
  if (cfg.limits.maxInflatedBytes === undefined)
    return pass(
      id,
      area,
      "checkout unpacked budgets are the defaults, clamped to the memory ceiling",
    );
  const mem = cfg.memoryMb ?? DEFAULT_CHECKOUT_CONFIG.memoryMb;
  const clamped: string[] = [];
  for (const full of [false, true]) {
    const asked = limitsFor(cfg.limits, full);
    const got = limitsFor(cfg.limits, full, mem);
    if (got.maxInflatedBytes < asked.maxInflatedBytes) {
      const m = unpackedBudget(asked.maxInflatedBytes, asked.maxPackBytes, mem);
      clamped.push(
        `${full ? "full-history" : "shallow"} unpacked ${Math.round(asked.maxInflatedBytes / 1048576)} MiB is clamped to ${Math.round(m.maxBytes / 1048576)} MiB by the ${mem} MiB memory ceiling`,
      );
    }
  }
  if (clamped.length === 0)
    return pass(id, area, "checkout unpacked budgets fit the checkout memory ceiling");
  return warn(
    id,
    area,
    `checkout unpacked budget is above what the memory ceiling allows (${clamped.join("; ")})`,
    `Raise TURNTABLE_CHECKOUT_MAX_MEMORY_MIB (the ceiling, minus the pack budget and 256 MiB, is the most that can be unpacked; full history is ${FULL_HISTORY_FACTOR} times the shallow budgets) or lower the unpacked budget.`,
  );
}

export async function checkQuotas(i: DoctorInputs): Promise<DoctorCheck> {
  const area = "limits";
  if (!i.db)
    return fail("quotas", area, "not checked: the database is not open", "Fix the database first.");
  if (!(await i.db.hasTable("org_quotas")))
    return pass("quotas", area, "this build has no per-org quotas");
  const n = Number((await i.db.all(sql`SELECT count(*) AS n FROM org_quotas`))[0]?.n ?? 0);
  if (n > 0) return pass("quotas", area, `${n} org(s) have quotas set`);
  return i.hosted
    ? warn(
        "quotas",
        area,
        "no quotas are set: every org can use unlimited sandbox time, log and artifact storage",
        "Set limits with the `set_quotas` operation before opening the instance to other people.",
      )
    : pass("quotas", area, "no quotas are set: every org is unlimited (fine for one operator)");
}

/** How many attempts of the last week stored a log with bytes missing. Warn, never fail. */
export async function checkIncompleteLogs(i: DoctorInputs): Promise<DoctorCheck> {
  const area = "logs";
  if (!i.db)
    return fail(
      "incomplete_logs",
      area,
      "not checked: the database is not open",
      "Fix the database first.",
    );
  if (!(await i.db.hasTable("log_cuts")))
    return pass("incomplete_logs", area, "this build records no log cuts");
  const since = Date.now() - 7 * 86_400_000;
  const rows = await i.db.all(
    sql`SELECT count(DISTINCT c.attempt_id) AS n FROM log_cuts c JOIN job_attempts a ON a.id = c.attempt_id WHERE a.started_at >= ${since}`,
  );
  const n = Number(rows[0]?.n ?? 0);
  if (n === 0)
    return pass("incomplete_logs", area, "no job log of the last 7 days is missing output");
  return warn(
    "incomplete_logs",
    area,
    `${n} job attempt(s) of the last 7 days stored a log with output missing`,
    "Each has a `[turntable] ... could not be retrieved` line and `log_incomplete` on get_run. The sandbox keeps the first 1 MiB and last 64 MiB of output and drops the middle if the controller could not read it in time (a slow provider). Check the provider's health and the server log for log-poll retries.",
  );
}

export async function checkHumanApprovalApprovers(i: DoctorInputs): Promise<DoctorCheck> {
  const area = "approvals";
  const id = "human_approval_approvers";
  if (!i.humanApprovalGaps)
    return pass(id, area, "not checked here: the running server's doctor checks it");
  const n = await i.humanApprovalGaps();
  return n > 0
    ? warn(
        id,
        area,
        "a project requires human approval but its org has no active approver whose key satisfies the key policy: its held runs cannot be approved",
        "Enrol an approver (`turntable approvals bootstrap`), relax the org key policy, or set untrusted_run_approval to no_agents.",
      )
    : pass(id, area, "every project on human approval has an approver that counts");
}

export async function checkApproverReenrol(i: DoctorInputs): Promise<DoctorCheck> {
  const area = "approvals";
  const id = "approver_github_ids";
  if (!i.db) return pass(id, area, "not checked: the database is not open");
  if (!(await i.db.hasTable("approvers"))) return pass(id, area, "this build has no approver keys");
  const n = Number(
    (
      await i.db.all(
        sql`SELECT count(*) AS n FROM approvers WHERE revoked_at IS NULL AND github_user_id IS NULL`,
      )
    )[0]?.n ?? 0,
  );
  return n > 0
    ? warn(
        id,
        area,
        `${n} approver keys need re-enrolling for passkey step-up`,
        "A key enrolled without a numeric GitHub account id can never step up a web session: re-enrol it (revoke it, then enrol the person again). `instance_org_summary` shows the count per org.",
      )
    : pass(id, area, "every active approver key carries a GitHub account id");
}

export async function checkHumanApprovalKeyPolicy(i: DoctorInputs): Promise<DoctorCheck> {
  const area = "approvals";
  const id = "human_approval_key_policy";
  if (!i.humanAnyKeyPolicy)
    return pass(id, area, "not checked here: the running server's doctor checks it");
  const n = await i.humanAnyKeyPolicy();
  return n > 0
    ? warn(
        id,
        area,
        "a project requires human approval but its org key policy is any: a key file on a machine where agents run lets an agent sign an approval",
        "Set the org key policy to hardware, or set untrusted_run_approval to no_agents.",
      )
    : pass(id, area, "every project on human approval has the hardware key policy");
}

/** The failures in a row at which a repo's polling is reported as unhealthy. */
export const POLL_FAILURE_WARN = 3;
/** The intervals without a successful poll at which a repo is reported as stalled. */
export const POLL_STALE_INTERVALS = 3;

/**
 * Poll health from the in-process poller snapshot: fixed sentences, no repo names or error text.
 * A process with no poller (or none polling yet) passes: there is nothing to be unhealthy.
 */
export function checkPollHealth(now: number = Date.now()): DoctorCheck {
  const area = "ingest";
  const repos = [...ingestStatus.repos.values()];
  // Silent stalls (a dead loop, a skipped binding) never raise a failure count: look at success age.
  const stalled = repos.filter((r) => {
    const since = r.lastSuccessAt ?? ingestStatus.startedAt;
    return (
      since !== null &&
      ingestStatus.running &&
      now - since > POLL_STALE_INTERVALS * r.intervalSeconds * 1000
    );
  }).length;
  const failing = repos.filter((r) => r.consecutiveFailures >= POLL_FAILURE_WARN).length;
  const anonymousLow = repos.some(
    (r) =>
      r.authMode === "anonymous" &&
      r.rateLimit?.remaining !== undefined &&
      r.rateLimit.remaining <= POLL_RESERVE,
  );
  if (failing > 0 || anonymousLow || stalled > 0) {
    return warn(
      "poll_health",
      area,
      [
        failing > 0 ? "some repos have failed to poll several times in a row" : "",
        stalled > 0 ? "some repos have not polled successfully within 3 intervals" : "",
        anonymousLow ? "the anonymous GitHub budget is nearly spent" : "",
      ]
        .filter(Boolean)
        .join("; "),
      "Run `instance_ingest_status` for each repo's error class and budget; set a poll token or install the GitHub App to raise the budget.",
    );
  }
  return pass("poll_health", area, "no repo is failing to poll and the poll budget has room");
}

/**
 * The egress probe's verdict (#698): degraded holds back every new attempt and defers check posts.
 * The summary is a fixed sentence plus times this process wrote; no probe text reaches it.
 */
export function checkEgress(net: NetworkHealth = processNetwork): DoctorCheck {
  const snap = net.snapshot();
  const n = snap.windows.length;
  const last = snap.windows.at(-1);
  const recent =
    n === 0
      ? ""
      : `; ${n} degraded window${n === 1 ? "" : "s"} since boot, the last from ${new Date(last?.start ?? 0).toISOString()}${last?.end ? ` to ${new Date(last.end).toISOString()}` : " (still open)"}`;
  if (snap.gave_up) {
    return fail(
      "egress",
      "network",
      `outbound network probe has failed past its maximum degraded time: claims resumed anyway${recent}`,
      "Check the host's outbound connectivity and DNS, and the probe's targets (the forge API base and the provider). Set TURNTABLE_NETWORK_PROBE=off to turn the probe off, or raise TURNTABLE_NETWORK_MAX_DEGRADED_SECONDS.",
    );
  }
  if (snap.state === "degraded") {
    return warn(
      "egress",
      "network",
      `outbound network is degraded: no new attempt is claimed and check posts wait${recent}`,
      "Check the host's outbound connectivity and DNS. The state clears after two successful probes (15 s apart).",
    );
  }
  if (snap.state === "unknown") {
    return pass("egress", "network", `outbound network not probed by this process${recent}`);
  }
  return pass("egress", "network", `outbound network is healthy${recent}`);
}

/**
 * The recent sandbox create-timeout rate per provider (#814), from this process's last hour. A
 * rate of a quarter or more over at least four creates is a warning. Fixed words and counts only.
 */
export function checkCreateTimeouts(stats: CreateStats = processCreateStats): DoctorCheck {
  const rows = stats.snapshot();
  if (rows.length === 0) {
    return pass(
      "create_timeouts",
      "provider",
      "no sandbox create in this process in the last hour",
    );
  }
  const text = rows
    .map(
      (r) =>
        `${r.provider} ${r.timeouts}/${r.creates} (${Math.round((100 * r.timeouts) / r.creates)}%)`,
    )
    .join(", ");
  const bad = rows.some((r) => r.creates >= 4 && r.timeouts / r.creates >= 0.25);
  if (bad) {
    return warn(
      "create_timeouts",
      "provider",
      `sandbox create timeouts in the last hour: ${text}`,
      "The provider is slow to create sandboxes. Timed-out jobs are requeued, not failed. Raise createTimeoutSeconds in the provider config if creates are only slow.",
    );
  }
  return pass("create_timeouts", "provider", `sandbox create timeouts in the last hour: ${text}`);
}

/** A drain holds back every new attempt: say so, with a fixed sentence (#446). */
export function checkDraining(): DoctorCheck {
  const area = "scheduler";
  if (processDrain.draining) {
    return warn(
      "draining",
      area,
      "the scheduler is draining: no new attempt starts until the drain ends",
      "Finish the deploy, or call `instance_drain` with on=false to resume. A restart ends the drain.",
    );
  }
  return pass("draining", area, "the scheduler is claiming work normally");
}

/**
 * A sandbox limit that an environment variable sets is locked: the web UI shows it read-only and
 * `instance_set_setting` refuses it (#661). Say which variable, so an operator knows why.
 */
export function checkLimitLocks(i: DoctorInputs): DoctorCheck {
  const area = "limits";
  const locked: string[] = [];
  for (const def of [
    schedulerGlobalCapSetting,
    schedulerOrgCapSetting,
    providerDaytonaMaxLiveSetting,
    providerDaytonaCpuLimitSetting,
  ]) {
    try {
      const e = envValue(def, i.env);
      if (e) locked.push(`${def.key} is locked by ${e.name}`);
    } catch {
      // A bad value stops the server at boot with its own message.
    }
  }
  if (locked.length === 0) {
    return pass("limit_locks", area, "no sandbox limit is locked by an environment variable");
  }
  return warn(
    "limit_locks",
    area,
    locked.join("; "),
    "The web UI shows a locked limit read-only and `instance_set_setting` refuses it. Unset the variable (and restart once) to change the limit live.",
  );
}

/** Every check, in a fixed order. A check that throws is reported as a fail, never as a crash. */
export async function runDoctor(i: DoctorInputs): Promise<DoctorReport> {
  const safe = async (
    id: string,
    area: string,
    fn: () => DoctorCheck[] | Promise<DoctorCheck[]> | DoctorCheck | Promise<DoctorCheck>,
  ): Promise<DoctorCheck[]> => {
    try {
      const r = await fn();
      return Array.isArray(r) ? r : [r];
    } catch (e) {
      return [
        fail(
          id,
          area,
          "the check itself failed",
          "This is a bug in doctor: report it.",
          String(e).slice(0, 120),
        ),
      ];
    }
  };
  const all = [
    ...(await safe("privileges", "process", () => checkPrivileges(i))),
    ...(await safe("master_key", "keys", () => checkMasterKey(i))),
    ...(await safe("release_key", "keys", () => checkReleaseKey(i))),
    ...(await safe("audit_anchor", "keys", () => checkAuditAnchors(i))),
    ...(await safe("audit_state_dir", "keys", () => checkAuditStateDir(i))),
    ...(await safe("database", "database", () => checkDatabase(i))),
    ...(await safe("github_app", "github", () => checkGithubApp(i))),
    ...(await safe("provider", "provider", () => i.providerChecks())),
    ...(await safe("proxy_tls", "proxy", () => checkProxyTls(i))),
    ...(await safe("forwarded_headers", "network", () => checkForwarded(i))),
    ...(await safe("https_redirect", "network", () => checkHttpsRedirect(i))),
    ...(await safe("release_channel", "release", () => checkChannel(i))),
    ...(await safe("release_config_channel", "release", () => checkConfigChannel(i))),
    ...(await safe("release_lane_process", "release", () => checkReleaseLane(i))),
    ...(await safe("quotas", "limits", () => checkQuotas(i))),
    ...(await safe("checkout_budgets", "limits", () => checkCheckoutBudgets(i))),
    ...(await safe("limit_locks", "limits", () => checkLimitLocks(i))),
    ...(await safe("incomplete_logs", "logs", () => checkIncompleteLogs(i))),
    ...(await safe("poll_health", "ingest", () => checkPollHealth())),
    ...(await safe("draining", "scheduler", () => checkDraining())),
    ...(await safe("egress", "network", () => checkEgress())),
    ...(await safe("create_timeouts", "provider", () => checkCreateTimeouts())),
    ...(await safe("human_approval_approvers", "approvals", () => checkHumanApprovalApprovers(i))),
    ...(await safe("approver_github_ids", "approvals", () => checkApproverReenrol(i))),
    ...(await safe("human_approval_key_policy", "approvals", () => checkHumanApprovalKeyPolicy(i))),
  ];
  return report(all);
}
