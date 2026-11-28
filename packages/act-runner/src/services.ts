// A job's `services:` as act runs them in container mode (#796). Two things act does not do:
//  - bind a service's published port to loopback: act publishes `5432:5432` on every interface of
//    the sandbox. Every port is rewritten to `127.0.0.1:<host>:<container>`, so a service is
//    reachable from the job's steps (the job container shares the sandbox's network) and from
//    nothing else.
//  - fill `job.services.<id>.ports`: act's job context carries no ports. The host ports are fixed
//    here, so each reference is replaced by its literal value before act reads the workflow.
// Pure: a job mapping in, a job mapping out. Throws PlanError naming the service and the port.
import { PlanError } from "./plan";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Service id to its port map: container port (`"5432"`) to host port (`"5432"`). */
export type ServicePorts = Record<string, Record<string, string>>;

// [ip:][host:]container[/proto]. Ranges and IPv6 addresses are refused.
const PORT_SPEC = /^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(?:(\d{1,5}):)?(\d{1,5})(?:\/(tcp|udp|sctp))?$/i;
/** Where a port without a host port goes when its container port is already taken. */
const FIRST_FREE = 49152;

// Long flags act's pflag parser takes without a value; any other long flag consumes the next token.
const BOOL_LONG = new Set([
  "init",
  "privileged",
  "read-only",
  "tty",
  "interactive",
  "no-healthcheck",
  "rm",
  "oom-kill-disable",
]);
// Short bool shorthands that can sit before p/P in a cluster such as `-tp` or `-iP`.
const BOOL_SHORT = new Set(["i", "t", "d"]);

/** Splits like shellquote: whitespace separates, quotes group, a backslash escapes. */
function shellSplit(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i] as string;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < input.length) {
        // shellquote: inside double quotes a backslash escapes only $ ` " \ and newline, else it stays
        const next = input[i + 1] as string;
        if (next === "$" || next === "`" || next === '"' || next === "\\") {
          cur += next;
          i++;
        } else if (next === "\n") i++;
        else cur += c;
      } else cur += c;
    } else if (c === "\\" && i + 1 < input.length) {
      const next = input[++i] as string;
      if (next !== "\n") {
        cur += next;
        has = true;
      } // a backslash-newline is dropped, as shellquote does
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === " " || c === "\n" || c === "\t") {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** True when a service's options carry a docker publish flag (-p, -P, --publish, --publish-all). */
export function publishesPort(options: string): boolean {
  const tokens = shellSplit(options);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t === "--") break;
    if (t.startsWith("--")) {
      const name = t.slice(2).split("=")[0] as string;
      if (name === "publish" || name === "publish-all") return true;
      if (!t.includes("=") && !BOOL_LONG.has(name)) i++; // the value is the next token
    } else if (t.startsWith("-") && t.length > 1) {
      for (const ch of t.slice(1)) {
        if (ch === "p" || ch === "P") return true;
        if (!BOOL_SHORT.has(ch)) {
          if (t.slice(1).length === 1) i++; // a lone value flag such as -e or -v takes the next token
          break;
        }
      }
    }
  }
  return false;
}

const validPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;

/**
 * Rewrites every service port to bind loopback with a fixed host port, and returns the port map
 * per service. A port with no host port (`5432`) gets its container port when free, else the
 * next free port from 49152, so the map is known before act starts. A port that is not a literal
 * after interpolation, a range, an IPv6 address or a host port used twice is a PlanError.
 */
export function bindServicePorts(
  services: Obj,
  resolve: (s: string) => string = (s) => s,
): { services: Obj; ports: ServicePorts } {
  const used = new Set<string>();
  const ports: ServicePorts = {};
  const out: Obj = {};
  type Parsed = { id: string; container: number; host?: number; proto?: string };
  const parsed: Parsed[] = [];
  for (const [id, spec] of Object.entries(services)) {
    // act merges -p/--publish/-P from options into the port bindings, past the loopback rewrite.
    if (isObj(spec) && typeof spec.options === "string" && publishesPort(spec.options)) {
      throw new PlanError(
        "services",
        `service "${id}" options publish a port (-p, --publish or -P): use ports: instead`,
      );
    }
    if (!isObj(spec) || spec.ports === undefined) continue;
    if (!Array.isArray(spec.ports)) {
      throw new PlanError("services", `service "${id}" ports must be a list`);
    }
    for (const p of spec.ports) {
      const text = resolve(typeof p === "number" ? String(p) : typeof p === "string" ? p : "");
      const m = PORT_SPEC.exec(text.trim());
      const container = m ? Number(m[3]) : NaN;
      const host = m?.[2] !== undefined ? Number(m[2]) : undefined;
      if (!m || !validPort(container) || (host !== undefined && !validPort(host))) {
        throw new PlanError(
          "services",
          `service "${id}" port "${text.slice(0, 40)}" is not a literal [host:]container port`,
        );
      }
      if (host !== undefined) {
        const key = `${m[4]?.toLowerCase() ?? "tcp"}:${host}`;
        if (used.has(key)) {
          throw new PlanError("services", `service "${id}" host port ${host} is used twice`);
        }
        used.add(key);
      }
      parsed.push({
        id,
        container,
        ...(host !== undefined ? { host } : {}),
        ...(m[4] ? { proto: m[4].toLowerCase() } : {}),
      });
    }
  }
  // Ports without a host port are placed after every explicit one is known.
  let next = FIRST_FREE;
  for (const p of parsed) {
    if (p.host !== undefined) continue;
    const proto = p.proto ?? "tcp";
    if (!used.has(`${proto}:${p.container}`)) p.host = p.container;
    else {
      while (used.has(`${proto}:${next}`)) next++;
      if (next > 65535) throw new PlanError("services", "no free host port for a service");
      p.host = next;
    }
    used.add(`${p.proto ?? "tcp"}:${p.host}`);
  }
  for (const [id, spec] of Object.entries(services)) {
    if (!isObj(spec) || spec.ports === undefined) {
      out[id] = spec;
      continue;
    }
    const mine = parsed.filter((p) => p.id === id);
    ports[id] = Object.fromEntries(mine.map((p) => [String(p.container), String(p.host)]));
    out[id] = {
      ...spec,
      ports: mine.map(
        (p) =>
          `127.0.0.1:${p.host}:${p.container}${p.proto && p.proto !== "tcp" ? `/${p.proto}` : ""}`,
      ),
    };
  }
  for (const id of Object.keys(services)) ports[id] ??= {};
  return { services: out, ports };
}

const quote = (s: string): string => `'${s.replaceAll("'", "''")}'`;

// job.services.<id>.ports, then an optional ['5432'] / ["5432"] / [5432] / .5432 index.
const REF =
  /\bjob\.services\.([A-Za-z_][A-Za-z0-9_-]*)\.ports(?:\[\s*(?:'(\d{1,5})'|"(\d{1,5})"|(\d{1,5}))\s*\]|\.(\d{1,5})\b)?(?![\w.[])/gi;

/** Replaces each `job.services.<id>.ports` reference in one expression with its literal value. */
export function substituteServiceRefs(expr: string, ports: ServicePorts): string {
  const byLower = new Map(Object.entries(ports).map(([k, v]) => [k.toLowerCase(), v]));
  return expr.replace(
    REF,
    (whole, id: string, a?: string, b?: string, c?: string, d?: string): string => {
      const map = byLower.get(id.toLowerCase());
      if (!map) return whole;
      const key = a ?? b ?? c ?? d;
      if (key === undefined) return `fromJSON(${quote(JSON.stringify(map))})`;
      return quote(map[key] ?? "");
    },
  );
}

// Keys whose string value is an expression even without `${{ }}`.
const BARE_EXPR_KEYS = new Set(["if"]);

function substituteIn(v: unknown, ports: ServicePorts, key?: string): unknown {
  if (typeof v === "string") {
    if (key !== undefined && BARE_EXPR_KEYS.has(key) && !v.includes("${{")) {
      return substituteServiceRefs(v, ports);
    }
    return v.replace(/\$\{\{([\s\S]*?)\}\}/g, (_m, inner: string) => {
      return `\${{${substituteServiceRefs(inner, ports)}}}`;
    });
  }
  if (Array.isArray(v)) return v.map((x) => substituteIn(x, ports));
  if (isObj(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substituteIn(x, ports, k)]));
  }
  return v;
}

/**
 * The job with its services bound to loopback and its `job.services.<id>.ports` references
 * replaced. A job without `services:` is returned unchanged. The services block itself is not
 * searched for references (a service cannot read another's ports on GitHub either).
 */
export function prepareServices(job: Obj, resolve?: (s: string) => string): Obj {
  if (!isObj(job.services)) return job;
  const { services, ports } = bindServicePorts(job.services, resolve);
  const rest: Obj = {};
  for (const [k, v] of Object.entries(job)) {
    if (k !== "services") rest[k] = substituteIn(v, ports, k);
  }
  return { ...rest, services };
}
