// The GitHub token a job gets as GITHUB_TOKEN: an installation token minted for this one job, for
// this one repository, with the permissions its workflow declared, capped by the run's trust
// class and by what the App's installation was granted, and revoked when the job ends. It is
// never cached or shared with another job, and never returned by any operation.
import {
  DEFAULT_PERMISSIONS,
  declaredPermissions,
  isMappablePermission,
  type PermissionLevel,
} from "@turntable/act-runner";
import { type SafeFetch, safeFetch } from "@turntable/net";
import { parse } from "yaml";
import type { TrustClass } from "../trust";

export type Permissions = Record<string, PermissionLevel>;

export interface CappedPermissions {
  permissions: Permissions;
  /** What was lowered or dropped, and why, for the job's log. */
  notes: string[];
}

/**
 * What the token may carry:
 * - `untrusted_pr`: contents read, whatever the workflow asked for;
 * - `trusted_pr`: what was asked for, but never write;
 * - `protected` and `release`: what was asked for;
 * then never more than the installation was granted (`granted`, when known). `metadata: read` is
 * always present, since GitHub grants it with every installation token. There is no id-token
 * here: Turntable's own OIDC issuer is the way to ask for one.
 */
export function capPermissions(
  declared: Readonly<Record<string, PermissionLevel>>,
  klass: TrustClass,
  granted?: Readonly<Record<string, string>>,
): CappedPermissions {
  const notes: string[] = [];
  // Only names an installation token can carry; id_token and the like never get through.
  let want: Permissions = Object.fromEntries(
    Object.entries(declared).filter(([k]) => isMappablePermission(k)),
  );
  if (klass === "untrusted_pr") {
    const extra = Object.keys(want).filter((k) => k !== "contents" || want[k] !== "read");
    if (extra.length > 0) {
      notes.push(`an untrusted pull request gets contents read only (not ${extra.join(", ")})`);
    }
    want = { contents: "read" };
  } else if (klass === "trusted_pr") {
    for (const [k, v] of Object.entries(want)) {
      if (v === "write") {
        want[k] = "read";
        notes.push(`${k}: write lowered to read for a pull request`);
      }
    }
  }
  if (granted) {
    for (const [k, v] of Object.entries(want)) {
      const have = granted[k];
      if (have === undefined) {
        delete want[k];
        notes.push(`${k}: the App installation was not granted it; dropped`);
      } else if (v === "write" && have === "read") {
        want[k] = "read";
        notes.push(`${k}: the App installation has read only; lowered to read`);
      }
    }
  }
  return { permissions: { metadata: "read", ...want }, notes };
}

/** The pieces of AppAuth this needs (so tests can supply a fake GitHub). */
export interface TokenAuthority {
  mintFresh(
    installationId: string,
    scope: {
      repositories?: readonly string[];
      permissions?: Readonly<Record<string, "read" | "write">>;
    },
  ): Promise<{ token: string; expiresAt: number }>;
  installationPermissions(installationId: string): Promise<Readonly<Record<string, string>>>;
  revoke(token: string): Promise<boolean>;
}

export interface IssuedJobToken {
  token: string;
  expiresAt: number;
  permissions: Permissions;
  notes: string[];
  /** What the job needed a token for beyond the tree Turntable delivers, for a refusal's message. */
  needs: string[];
  /** Shadow: declared permissions were lowered to read. */
  lowered?: boolean;
  /** Revokes it at GitHub. Idempotent, never throws. */
  revoke(): Promise<void>;
}

export interface IssueRequest {
  installationId: string;
  /** The repository's owner, for the visibility check. */
  owner: string;
  /** The repository name, without the owner. */
  repo: string;
  klass: TrustClass;
  workflowYaml: string;
  jobId: string;
  /**
   * The project's checks_mode is not `live` (GitHub Actions is still the system of record): the
   * token is capped to `contents: read` and `metadata: read` for every class, so a side-by-side
   * run can never repeat a write. Read by the caller at issue time from the effective setting.
   */
  readOnly?: boolean;
}

/** The notice a side-by-side run gets when its declared permissions were lowered. */
export const SHADOW_LOWERED_NOTICE = "shadow: GITHUB_TOKEN write permissions lowered to read";

/** Why no token was minted, for the job's log. */
export interface NoToken {
  none: string;
  /** Shadow: declared permissions were lowered to read before it was decided no token is needed. */
  lowered?: boolean;
}

export interface JobTokensOptions {
  /**
   * Whether a repository is public. A job on a public repo whose token would carry nothing beyond
   * contents read and metadata read gets none: its source is delivered by the controller, and a
   * token would only make it a secret-bearing job. Unknown means private.
   */
  isPublic?:
    ((owner: string, repo: string, installationId: string) => Promise<boolean>) | undefined;
}

/** True when the permissions are nothing beyond `contents: read` and `metadata: read`. */
export const isReadOnlyContents = (p: Readonly<Record<string, string>>): boolean =>
  Object.entries(p).every(([k, v]) => v === "read" && (k === "contents" || k === "metadata"));

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What a job's checkout steps need that the delivered tree cannot give: another repository (a
 * `repository:` input that is not this one, or an expression, which cannot be known) or
 * submodules. Both keep the job on the token rule, since they would fetch with a credential.
 */
export function checkoutNeeds(workflowYaml: string, jobId: string, self: string): string[] {
  let doc: unknown;
  try {
    doc = parse(workflowYaml, { merge: true });
  } catch {
    return [];
  }
  const jobs = isObj(doc) && isObj(doc.jobs) ? doc.jobs : {};
  const job = jobs[jobId];
  const steps = isObj(job) && Array.isArray(job.steps) ? job.steps : [];
  const needs = new Set<string>();
  for (const st of steps) {
    if (!isObj(st) || typeof st.uses !== "string" || !st.uses.startsWith("actions/checkout@")) {
      continue;
    }
    const w = isObj(st.with) ? st.with : {};
    const repository = typeof w.repository === "string" ? w.repository.trim() : "";
    if (repository !== "" && repository.toLowerCase() !== self.toLowerCase()) {
      needs.add(`a checkout of another repository (${repository})`);
    }
    const sub = String(w.submodules ?? "false").toLowerCase();
    if (sub === "true" || sub === "recursive") needs.add("a checkout with submodules");
  }
  return [...needs];
}

export class JobTokens {
  readonly #auth: TokenAuthority;
  readonly #isPublic:
    ((owner: string, repo: string, installationId: string) => Promise<boolean>) | undefined;

  constructor(auth: TokenAuthority, o: JobTokensOptions = {}) {
    this.#auth = auth;
    this.#isPublic = o.isPublic;
  }

  /**
   * Mints the job's token, or says why not. A token is minted only when the capped permissions
   * need one: any write scope, or a scope beyond contents read (contents read alone needs none: the
   * controller delivers the tree, public or private).
   */
  async issue(r: IssueRequest): Promise<IssuedJobToken | NoToken> {
    const declared = declaredPermissions(r.workflowYaml, r.jobId);
    let granted: Readonly<Record<string, string>> | undefined;
    try {
      granted = await this.#auth.installationPermissions(r.installationId);
    } catch {
      // Unknown grant: the token request itself is the check; GitHub refuses a wider one.
      granted = undefined;
    }
    const capped = capPermissions(
      declared.declared ? declared.permissions : DEFAULT_PERMISSIONS,
      r.klass,
      granted,
    );
    let lowered = false;
    if (r.readOnly === true) {
      const asked = declared.declared ? declared.permissions : DEFAULT_PERMISSIONS;
      lowered = !isReadOnlyContents(
        Object.fromEntries(Object.entries(asked).filter(([k]) => isMappablePermission(k))),
      );
      capped.permissions = { contents: "read", metadata: "read" };
    }
    const needs = [
      ...Object.entries(capped.permissions)
        .filter(([, v]) => v === "write")
        .map(([k]) => `${k}: write`),
      ...checkoutNeeds(r.workflowYaml, r.jobId, `${r.owner}/${r.repo}`),
    ];
    if (isReadOnlyContents(capped.permissions) && needs.length === 0) {
      let pub = false;
      try {
        pub = (await this.#isPublic?.(r.owner, r.repo, r.installationId)) ?? false;
      } catch {
        pub = false;
      }
      if (pub) {
        return {
          none: `no token: ${r.owner}/${r.repo} is public and the job needs nothing beyond contents read, which the controller already delivers`,
          ...(lowered ? { lowered } : {}),
        };
      }
      if (r.readOnly === true && lowered) {
        // Private, and the job declared more than contents read (it likely calls the API): a
        // read-only token, never a write one.
        return this.#mint(r, capped, declared.notes, needs, lowered);
      }
      // A private repository's tree is fetched by the control plane and delivered to the job (the
      // in-job checkout is a stub), so contents read alone needs no token in the job either.
      return {
        ...(lowered ? { lowered } : {}),
        none: "the private repository's tree was delivered by Turntable; a step that calls the GitHub API needs a write permission declared, which needs restricted egress or the secrets proxy",
      };
    }
    return this.#mint(r, capped, declared.notes, needs, lowered);
  }

  /**
   * A new token for an attempt another controller took over (#787), with the permissions the
   * first one was minted with and never wider: the job's workflow was read and capped then. With
   * `readOnly` (the project is no longer live) it gets exactly what a fresh read-only token gets,
   * `contents: read` and `metadata: read`, never every stored scope at read (#789). The job never
   * held the first token (the proxy attached it), so nothing it has changes.
   */
  async reissue(r: {
    installationId: string;
    repo: string;
    permissions: Readonly<Record<string, string>>;
    readOnly?: boolean;
  }): Promise<IssuedJobToken> {
    const stored: Record<string, "read" | "write"> = {};
    for (const [k, v] of Object.entries(r.permissions)) {
      if (v !== "read" && v !== "write") throw new Error(`unexpected permission ${k}: ${v}`);
      stored[k] = v;
    }
    // The same cap `issue` applies to a project that is not live: these two scopes and no other.
    const permissions: Record<string, "read" | "write"> =
      r.readOnly === true ? { contents: "read", metadata: "read" } : stored;
    const minted = await this.#auth.mintFresh(r.installationId, {
      repositories: [r.repo],
      permissions,
    });
    let revoked = false;
    return {
      token: minted.token,
      expiresAt: minted.expiresAt,
      permissions,
      notes: [],
      needs: [],
      revoke: async () => {
        if (revoked) return;
        revoked = true;
        await this.#auth.revoke(minted.token);
      },
    };
  }

  async #mint(
    r: IssueRequest,
    capped: CappedPermissions,
    declaredNotes: string[],
    needs: string[],
    lowered: boolean,
  ): Promise<IssuedJobToken> {
    const minted = await this.#auth.mintFresh(r.installationId, {
      repositories: [r.repo],
      permissions: capped.permissions as Record<string, "read" | "write">,
    });
    let revoked = false;
    return {
      token: minted.token,
      expiresAt: minted.expiresAt,
      permissions: capped.permissions,
      notes: [...declaredNotes, ...capped.notes],
      needs,
      ...(lowered ? { lowered } : {}),
      revoke: async () => {
        if (revoked) return;
        revoked = true;
        await this.#auth.revoke(minted.token);
      },
    };
  }
}

/** What the visibility check needs from the App: a cached read-only token, and the API base. */
export interface VisibilityAuth {
  mint(
    installationId: string,
    scope: {
      repositories?: readonly string[];
      permissions?: Readonly<Record<string, "read" | "write">>;
    },
  ): Promise<{ token: string }>;
  readonly apiBase: string;
}

/**
 * Public or private, asked of GitHub as the App: an installation token read-only for that one
 * repository (the same cached one the action pin checks use), then `GET /repos/{owner}/{repo}`.
 * Authenticated, so it does not spend GitHub's 60-per-hour anonymous limit. Only `private: false`
 * is public; anything else (a failed mint, an error, a rate limit) is "not public", and only a
 * clear answer is remembered, for ten minutes.
 */
export function publicRepoCheck(o: {
  auth: VisibilityAuth;
  fetch?: SafeFetch;
  now?: () => number;
  ttlMs?: number;
}): (owner: string, repo: string, installationId: string) => Promise<boolean> {
  const cache = new Map<string, { at: number; pub: boolean }>();
  const now = o.now ?? Date.now;
  const ttl = o.ttlMs ?? 10 * 60_000;
  const plain = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
  return async (owner, repo, installationId) => {
    if (!plain.test(owner) || !plain.test(repo)) return false;
    const key = `${installationId}/${owner}/${repo}`.toLowerCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.pub;
    try {
      const { token } = await o.auth.mint(installationId, {
        repositories: [repo],
        permissions: { contents: "read" },
      });
      const res = await (o.fetch ?? safeFetch)(`${o.auth.apiBase}/repos/${owner}/${repo}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "turntable",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status !== 200) return false;
      const pub = ((await res.json()) as { private?: boolean }).private === false;
      cache.set(key, { at: now(), pub });
      return pub;
    } catch {
      return false;
    }
  };
}
