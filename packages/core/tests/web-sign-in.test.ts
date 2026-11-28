// Sign in with GitHub, sessions, invites and the first-user bootstrap (#430). A fake GitHub stands
// behind the code exchange; everything else (state, cookies, rows, dispatch, REST) is the real
// thing, on SQLite and on Postgres.
import { afterAll, describe, expect, test } from "bun:test";
import { systemOrgId } from "../src/audit/failures";
import {
  CALLBACK_PATH,
  createAuthHandler,
  type GithubIdentity,
  LOGIN_PATH,
  loginCookieName,
  LOGOUT_PATH,
  SESSION_INFO_PATH,
} from "../src/auth/github-login";
import {
  csrfToken,
  LOGIN_COOKIE,
  SESSION_COOKIE,
  sessionHash,
  WebSessions,
} from "../src/auth/web-sessions";
import {
  createOrg,
  createJob,
  createProject,
  createRun,
  type Db,
  listAudit,
  listEvents,
  listMembershipsOfUser,
  openDatabase,
  schema,
} from "../src/db";
import { testDb } from "../src/db/dialect";
import { openPostgres } from "../src/db/pg";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { SESSION_WRITE_OPS } from "../src/ops/dispatch";
import { LANE_CONFIG_READ_OPS, LANE_CONFIG_WRITE_OPS } from "../src/ops/step-up";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { createRestApi } from "../src/ops/rest";
import { buildManifest } from "../src/github/manifest";
import { setup } from "./github-helpers";
import { mintToken } from "./ops-helpers";

const ORIGIN = "https://ci.example.test";
// Real time: the instance token and API tokens are minted with expiries counted from the clock.
const T0 = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const pgTarget = (): Parameters<typeof openPostgres>[0] => {
  const t = testDb();
  return t && t !== "pglite"
    ? { url: t, schema: `lstest_signin_${process.pid}` }
    : { pglite: true };
};

const opened: Db[] = [];
const dialects: [string, () => Db][] = [
  ["sqlite", () => openDatabase(":memory:")],
  ["postgres", () => openPostgres(pgTarget(), { fresh: true })],
];
afterAll(() => {
  for (const db of opened) db.close();
});

const cookieOf = (res: Response, name: string, prefix = false): string | undefined =>
  res.headers.getSetCookie().find((c) => c.startsWith(prefix ? name : `${name}=`));
const valueOf = (setCookie: string): string =>
  setCookie.split(";")[0]!.slice(setCookie.indexOf("=") + 1);

describe.each(dialects)("web sign-in (%s)", (_name, open) => {
  async function harness() {
    const s = await setup("42", open);
    opened.push(s.db);
    const tenant = await createOrg(s.db, { slug: "tenant", name: "Tenant" });
    const other = await createOrg(s.db, { slug: "other", name: "Other" });
    let now = T0;
    const sessions = new WebSessions({ db: s.db, publicUrl: ORIGIN, now: () => now });
    // The fake GitHub: a code maps to a user. An unknown code is refused like GitHub refuses it.
    const users = new Map<string, GithubIdentity>();
    const redirects: string[] = [];
    const handler = createAuthHandler({
      db: s.db,
      store: s.store,
      sessions,
      identity: {
        async verify(code, redirectUri) {
          redirects.push(redirectUri);
          const u = users.get(code);
          if (!u) throw new Error("bad code");
          return u;
        },
      },
    });
    // The fake GitHub user lookup: login to numeric id, as GitHub's `GET /users/{login}` says.
    const logins = new Map<string, string>([
      ["alice", "1001"],
      ["bob", "2002"],
      ["late", "5005"],
    ]);
    const lookup = { fail: false };
    const githubUsers = {
      async idOfLogin(login: string): Promise<string | undefined> {
        if (lookup.fail) throw new Error("GitHub is down");
        const l = login.toLowerCase();
        if (l === "ghost") return undefined;
        return logins.get(l) ?? `gen-${l}`;
      },
    };
    const env: DispatchEnv = {
      registry,
      db: s.db,
      githubUsers,
      sessions,
      allowInstance: true,
      now: () => now,
    };
    const tti = (await createInstanceTokenFromCli(s.db, { name: "ops" })).secret;
    const bind = (input: Record<string, unknown>) =>
      dispatch(env, { kind: "bearer", token: tti }, "instance_bind_github_login", {
        target_org: "tenant",
        github_login: "alice",
        role: "admin",
        reason: "first admin of the org",
        ...input,
      });
    const start = async () => {
      const go = (await handler.handle(new Request(`${ORIGIN}${LOGIN_PATH}`)))!;
      const location = new URL(go.headers.get("location")!);
      return {
        go,
        location,
        state: location.searchParams.get("state")!,
        cookie: valueOf(cookieOf(go, `${LOGIN_COOKIE}_`, true)!),
        cookieName: cookieOf(go, `${LOGIN_COOKIE}_`, true)!.split("=")[0]!,
      };
    };
    // A state that does not parse has no nonce: its cookie name then matches nothing.
    const nonceOfState = (state: string): string => {
      try {
        const n = JSON.parse(Buffer.from(state.split(".")[1] ?? "", "base64url").toString()).n;
        return typeof n === "string" ? n : "none";
      } catch {
        return "none";
      }
    };
    /** The callback as a browser holding `cookies` (a raw Cookie header) makes it. */
    const callbackWith = async (state: string, code: string, cookies: string) =>
      (await handler.handle(
        new Request(`${ORIGIN}${CALLBACK_PATH}?${new URLSearchParams({ state, code })}`, {
          headers: cookies ? { cookie: cookies } : {},
        }),
      ))!;
    // The browser holds this sign-in's own cookie, named from the state's nonce.
    const callback = async (state: string, code: string, cookie?: string) =>
      callbackWith(state, code, cookie ? `${loginCookieName(nonceOfState(state))}=${cookie}` : "");
    /** A whole sign-in for a code. `session` is the cookie value when it succeeded. */
    const signIn = async (code: string) => {
      const st = await start();
      const res = await callback(st.state, code, st.cookie);
      const set = cookieOf(res, SESSION_COOKIE);
      return { res, session: set ? valueOf(set) : undefined, setCookie: set };
    };
    const as = (cookie: string, op: string, input: Record<string, unknown> = {}) =>
      dispatch(env, { kind: "session", cookie }, op, input);
    const logout = (init: { cookie?: string; origin?: string | null; csrf?: string }) =>
      handler.handle(
        new Request(`${ORIGIN}${LOGOUT_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...(init.cookie ? { cookie: `${SESSION_COOKIE}=${init.cookie}` } : {}),
            ...(init.origin === null ? {} : { origin: init.origin ?? ORIGIN }),
          },
          body: new URLSearchParams({ csrf: init.csrf ?? "" }),
        }),
      );
    return {
      ...s,
      tenant,
      other,
      now: () => now,
      advance: (ms: number) => (now += ms),
      sessions,
      handler,
      users,
      logins,
      lookup,
      redirects,
      env,
      tti,
      bind,
      start,
      callbackWith,
      callback,
      signIn,
      as,
      logout,
    };
  }

  /** Alice (GitHub id 1001) is invited as admin of `tenant` and signs in. */
  async function aliceAdmin() {
    const h = await harness();
    h.users.set("code-alice", { id: "1001", login: "alice" });
    expect((await h.bind({})).ok).toBe(true);
    const r = await h.signIn("code-alice");
    expect(r.res.status).toBe(303);
    return { h, cookie: r.session! };
  }

  describe("return target", () => {
    const GOOD = "/onboarding?step=repos&org=tenant";
    const via = async (h: Awaited<ReturnType<typeof harness>>, next: string) => {
      const go = (await h.handler.handle(
        new Request(`${ORIGIN}${LOGIN_PATH}?${new URLSearchParams({ next })}`),
      ))!;
      const state = new URL(go.headers.get("location")!).searchParams.get("state")!;
      const cookie = valueOf(cookieOf(go, `${LOGIN_COOKIE}_`, true)!);
      return h.callback(state, "code-alice", cookie);
    };

    test("a wizard step round-trips through the sign-in", async () => {
      const h = await harness();
      h.users.set("code-alice", { id: "1001", login: "alice" });
      expect((await h.bind({ role: "owner" })).ok).toBe(true);
      const done = await via(h, GOOD);
      expect(done.status).toBe(303);
      expect(done.headers.get("location")).toBe(GOOD);
      expect(cookieOf(done, SESSION_COOKIE)).toBeDefined();
    });

    test("a hostile or off-list target is dropped: the sign-in lands on /", async () => {
      for (const bad of [
        "//evil.example",
        "https://evil.example",
        "/\\evil.example",
        "/\\/evil.example",
        "/onboarding\\..\\x",
        "/runs",
        "/onboarding?step=repos&org=tenant&x=1",
        "/onboarding?step=nope",
        "/onboarding?org=../x",
        "/onboarding?step=repos#frag",
        "/onboarding?step=repos&step=run",
        "javascript:alert(1)",
        "/onboarding\nx",
      ]) {
        const h = await harness();
        h.users.set("code-alice", { id: "1001", login: "alice" });
        expect((await h.bind({ role: "owner" })).ok).toBe(true);
        const done = await via(h, bad);
        expect([bad, done.status, done.headers.get("location")]).toEqual([bad, 303, "/"]);
      }
    });
  });

  test("login round trip: authorize redirect, callback, session cookie, membership from the DB", async () => {
    const h = await harness();
    h.users.set("code-alice", { id: "1001", login: "Alice" });
    expect((await h.bind({ github_login: "ALICE", role: "owner" })).ok).toBe(true);
    const st = await h.start();
    expect(st.go.status).toBe(303);
    expect(st.location.origin + st.location.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(st.location.searchParams.get("client_id")).toBe("Iv1.abc");
    expect(st.location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}${CALLBACK_PATH}`);
    const loginCookie = cookieOf(st.go, `${LOGIN_COOKIE}_`, true)!;
    expect(loginCookie.startsWith("__Host-")).toBe(true);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
      expect(loginCookie).toContain(attr);
    }
    const done = await h.callback(st.state, "code-alice", st.cookie);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/");
    // the code was exchanged with the same redirect_uri the authorize step used
    expect(h.redirects).toEqual([`${ORIGIN}${CALLBACK_PATH}`]);
    const set = cookieOf(done, SESSION_COOKIE)!;
    expect(set.startsWith("__Host-")).toBe(true);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=604800"]) {
      expect(set).toContain(attr);
    }
    expect(set).not.toContain("Domain");
    // the login cookie is cleared
    expect(cookieOf(done, `${LOGIN_COOKIE}_`, true)).toContain("Max-Age=0");
    const id = valueOf(set);
    // the database holds only a hash of the session id
    const rows = await h.db.run((x) => x.orm.select().from(schema.webSessions));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(sessionHash(id));
    expect(rows[0]!.id).not.toBe(id);
    // the identity is the numeric id, and the login only what GitHub said last
    const idents = await h.db.run((x) => x.orm.select().from(schema.githubIdentities));
    expect(idents).toMatchObject([{ githubUserId: "1001", login: "Alice" }]);
    const me = await h.as(id, "whoami");
    expect(me.ok && me.output).toMatchObject({ kind: "session", role: "owner", org: "tenant" });
    // /auth/session and the page show who is signed in
    const info = await h.handler.handle(
      new Request(`${ORIGIN}${SESSION_INFO_PATH}`, {
        headers: { cookie: `${SESSION_COOKIE}=${id}` },
      }),
    );
    expect(await info!.json()).toMatchObject({
      signed_in: true,
      github_login: "Alice",
      orgs: [{ slug: "tenant", role: "owner" }],
    });
  });

  test("/auth/session hands the signed-in page its CSRF token, same-origin only and uncached", async () => {
    const { h, cookie } = await aliceAdmin();
    const get = (init: { cookie?: string; origin?: string } = {}) =>
      h.handler.handle(
        new Request(`${ORIGIN}${SESSION_INFO_PATH}`, {
          headers: {
            ...(init.cookie ? { cookie: `${SESSION_COOKIE}=${init.cookie}` } : {}),
            ...(init.origin ? { origin: init.origin } : {}),
          },
        }),
      );
    const res = (await get({ cookie, origin: "https://evil.example" }))!;
    const body = (await res.json()) as { csrf?: string };
    expect(body.csrf).toBe(csrfToken(cookie));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
    // the token passes the sign-out check; another value does not
    expect((await h.logout({ cookie, csrf: "wrong" }))!.status).toBe(403);
    expect((await h.logout({ cookie, csrf: body.csrf ?? "" }))!.status).toBe(303);
    // signed out: no token
    const anon = (await get())!;
    expect(await anon.json()).toEqual({ signed_in: false });
    expect([...anon.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
  });

  test("a state with no cookie, a wrong cookie or a bad signature is refused and spends nothing", async () => {
    const h = await harness();
    h.users.set("code-alice", { id: "1001", login: "alice" });
    await h.bind({});
    const a = await h.start();
    const b = await h.start();
    expect((await h.callback(a.state, "code-alice")).status).toBe(403); // no cookie
    expect((await h.callback(a.state, "code-alice", b.cookie)).status).toBe(403); // another browser's
    const [v, body] = a.state.split(".");
    expect((await h.callback(`${v}.${body}.AAAA`, "code-alice", a.cookie)).status).toBe(403);
    expect((await h.callback("garbage", "code-alice", a.cookie)).status).toBe(403);
    expect((await h.callback("", "code-alice", a.cookie)).status).toBe(403);
    // none of that spent the nonce: the genuine callback still works
    const ok = await h.callback(a.state, "code-alice", a.cookie);
    expect(ok.status).toBe(303);
    expect(cookieOf(ok, SESSION_COOKIE)).toBeDefined();
  });

  test("a replayed state is refused, and an expired one", async () => {
    const h = await harness();
    h.users.set("code-alice", { id: "1001", login: "alice" });
    await h.bind({});
    const a = await h.start();
    expect((await h.callback(a.state, "code-alice", a.cookie)).status).toBe(303);
    const replay = await h.callback(a.state, "code-alice", a.cookie);
    expect(replay.status).toBe(403);
    expect(cookieOf(replay, SESSION_COOKIE)).toBeUndefined();
    const b = await h.start();
    h.advance(11 * 60_000);
    const late = await h.callback(b.state, "code-alice", b.cookie);
    expect(late.status).toBe(403);
    expect(cookieOf(late, SESSION_COOKIE)).toBeUndefined();
  });

  test("a code GitHub refuses signs nobody in, and the nonce is spent", async () => {
    const h = await harness();
    const a = await h.start();
    const res = await h.callback(a.state, "no-such-code", a.cookie);
    expect(res.status).toBe(403);
    expect(cookieOf(res, SESSION_COOKIE)).toBeUndefined();
    h.users.set("code-alice", { id: "1001", login: "alice" });
    await h.bind({});
    expect((await h.callback(a.state, "code-alice", a.cookie)).status).toBe(403); // state already used
  });

  test("no auto-join: a stranger gets no session, no user row and no membership", async () => {
    const h = await harness();
    // Mallory is, say, an owner of the GitHub org and of the repos. GitHub says nothing here.
    h.users.set("code-mallory", { id: "3003", login: "mallory" });
    const r = await h.signIn("code-mallory");
    expect(r.res.status).toBe(403);
    expect(r.session).toBeUndefined();
    expect(await h.db.run((x) => x.orm.select().from(schema.githubIdentities))).toHaveLength(0);
    expect(await h.db.run((x) => x.orm.select().from(schema.webSessions))).toHaveLength(0);
    expect(await h.db.run((x) => x.orm.select().from(schema.orgMembers))).toHaveLength(0);
  });

  test("roles come from the DB: an invite for one org grants nothing in another", async () => {
    const h = await harness();
    h.users.set("code-alice", { id: "1001", login: "alice" });
    await h.bind({ role: "admin" });
    await h.bind({ target_org: "other", role: "viewer" });
    const { session } = await h.signIn("code-alice");
    const sid = session!;
    // two orgs: one must be named
    const unnamed = await h.as(sid, "whoami");
    expect(!unnamed.ok && unnamed.error.code).toBe("invalid_input");
    const t = await h.as(sid, "whoami", { org: "tenant" });
    expect(t.ok && t.output).toMatchObject({ role: "admin" });
    const o = await h.as(sid, "whoami", { org: "other" });
    expect(o.ok && o.output).toMatchObject({ role: "viewer" });
    // a viewer cannot invite; the same call as an admin of the other org works
    const denied = await h.as(sid, "invite_member", {
      org: "other",
      github_login: "bob",
      role: "viewer",
    });
    expect(!denied.ok && denied.error.code).toBe("forbidden");
    // an org the person does not belong to looks like one that does not exist
    const third = await createOrg(h.db, { slug: "third", name: "Third" });
    const none = await h.as(sid, "whoami", { org: third.slug });
    expect(!none.ok && none.error.code).toBe("not_found");
    const ghost = await h.as(sid, "whoami", { org: "no-such-org" });
    expect(!ghost.ok && ghost.error.code).toBe("not_found");
  });

  test("invite_member: the invitee's first sign-in binds the numeric id, consumes the invite and emits the event", async () => {
    const { h, cookie } = await aliceAdmin();
    const inv = await h.as(cookie, "invite_member", {
      github_login: "Bob",
      role: "member",
    });
    expect(inv.ok).toBe(true);
    expect(inv.ok && inv.output).toMatchObject({ github_login: "bob", role: "member" });
    h.users.set("code-bob", { id: "2002", login: "BOB" });
    const r = await h.signIn("code-bob");
    expect(r.res.status).toBe(303);
    const bob = await h.as(r.session!, "whoami");
    expect(bob.ok && bob.output).toMatchObject({ role: "member", org: "tenant" });
    // the invite is spent: a second account with the same login (a recycled one) gets nothing
    h.users.set("code-bob2", { id: "9009", login: "bob" });
    expect((await h.signIn("code-bob2")).res.status).toBe(403);
    const invites = await h.db.run((x) => x.orm.select().from(schema.memberInvites));
    expect(invites.find((i) => i.githubLogin === "bob")?.usedByUserId).toBeTruthy();
    const feed = await listEvents(
      h.db,
      { orgId: h.tenant.id },
      { after: 0, limit: 50, types: ["org.member_invited", "org.member_joined"] },
    );
    expect(feed.map((e) => e.type)).toEqual([
      "org.member_invited", // alice, by the instance
      "org.member_joined", // alice
      "org.member_invited", // bob, by alice
      "org.member_joined", // bob
    ]);
    expect(JSON.parse(feed[3]!.payload)).toMatchObject({
      github_user_id: "2002",
      github_login: "BOB",
      role: "member",
    });
    const joined = (await listAudit(h.db, { orgId: h.tenant.id })).filter(
      (a) => a.op === "member_joined",
    );
    expect(joined).toHaveLength(2);
  });

  test("an invite expires after 7 days, and a newer invite replaces an older one", async () => {
    const h = await harness();
    h.users.set("code-alice", { id: "1001", login: "alice" });
    await h.bind({ role: "viewer" });
    await h.bind({ role: "owner" }); // replaces the viewer invite
    h.advance(6 * DAY);
    const { session } = await h.signIn("code-alice");
    const me = await h.as(session!, "whoami");
    expect(me.ok && me.output).toMatchObject({ role: "owner" });
    const live = (await h.db.run((x) => x.orm.select().from(schema.memberInvites))).filter(
      (i) => i.usedAt === null && i.revokedAt === null,
    );
    expect(live).toHaveLength(0);

    h.users.set("code-late", { id: "5005", login: "late" });
    await h.bind({ github_login: "late" });
    h.advance(8 * DAY);
    expect((await h.signIn("code-late")).res.status).toBe(403);
  });

  test("who may invite, and up to what role", async () => {
    const { h, cookie } = await aliceAdmin();
    const scope = { orgId: h.tenant.id };
    // an admin may not invite above their own role
    const up = await h.as(cookie, "invite_member", { github_login: "x1", role: "owner" });
    expect(!up.ok && up.error.code).toBe("forbidden");
    // a person's release_operator token: viewer or member only
    const person = await mintToken(h.db, scope, "release_operator", { kind: "person" });
    const asToken = (token: string, input: Record<string, unknown>) =>
      dispatch(h.env, { kind: "bearer", token }, "invite_member", input);
    expect((await asToken(person.secret, { github_login: "x2", role: "member" })).ok).toBe(true);
    const adminViaToken = await asToken(person.secret, { github_login: "x3", role: "admin" });
    expect(!adminViaToken.ok && adminViaToken.error.code).toBe("forbidden");
    // an agent token, even release_operator, never; and a reader is below the role
    const agent = await mintToken(h.db, scope, "release_operator");
    const refused = await asToken(agent.secret, { github_login: "x4", role: "viewer" });
    expect(!refused.ok && refused.error.code).toBe("forbidden");
    const reader = await mintToken(h.db, scope, "reader", { kind: "person" });
    const low = await asToken(reader.secret, { github_login: "x5", role: "viewer" });
    expect(!low.ok && low.error.code).toBe("forbidden");
    // not over MCP
    expect(registry.mcpOps().map((o) => o.name)).not.toContain("invite_member");
    // an existing member cannot be invited again
    const dup = await h.as(cookie, "invite_member", { github_login: "ALICE", role: "viewer" });
    expect(!dup.ok && dup.error.code).toBe("conflict");
  });

  test("a session may invite only viewer or member, whatever its role", async () => {
    const { h, cookie } = await aliceAdmin();
    for (const role of ["admin", "owner"]) {
      const r = await h.as(cookie, "invite_member", { github_login: `s-${role}`, role });
      expect(r.ok, role).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("forbidden");
        expect(r.error.message).toContain("passkey step-up");
      }
    }
    expect((await h.as(cookie, "invite_member", { github_login: "s-v", role: "viewer" })).ok).toBe(
      true,
    );
    expect((await h.as(cookie, "invite_member", { github_login: "s-m", role: "member" })).ok).toBe(
      true,
    );
    // the instance operator still roots an admin or owner
    expect((await h.bind({ github_login: "s-owner", role: "owner" })).ok).toBe(true);
  });

  test("an invite binds the numeric id: a recycled login is refused, a renamed account is not", async () => {
    const h = await harness();
    expect((await h.bind({ github_login: "alice" })).ok).toBe(true); // resolves to 1001
    const invite = (await h.db.run((x) => x.orm.select().from(schema.memberInvites)))[0]!;
    expect(invite.githubUserId).toBe("1001");
    // someone else now holds the login "alice"
    h.users.set("code-other", { id: "7777", login: "alice" });
    const stolen = await h.signIn("code-other");
    expect(stolen.res.status).toBe(403);
    expect(stolen.session).toBeUndefined();
    expect(await h.db.run((x) => x.orm.select().from(schema.orgMembers))).toHaveLength(0);
    // the invited account, renamed, signs in
    h.users.set("code-renamed", { id: "1001", login: "alice-renamed" });
    const ok = await h.signIn("code-renamed");
    expect(ok.res.status).toBe(303);
    const me = await h.as(ok.session!, "whoami");
    expect(me.ok && me.output).toMatchObject({ role: "admin", org: "tenant" });
    const idents = await h.db.run((x) => x.orm.select().from(schema.githubIdentities));
    expect(idents).toMatchObject([{ githubUserId: "1001", login: "alice-renamed" }]);
  });

  test("an invite is refused when the login cannot be resolved", async () => {
    const h = await harness();
    h.lookup.fail = true;
    const down = await h.bind({});
    expect(!down.ok && down.error.code).toBe("unavailable");
    h.lookup.fail = false;
    const none = await h.bind({ github_login: "ghost" });
    expect(!none.ok && none.error.code).toBe("not_found");
    // no GitHub App wired: fail closed too
    const bare = await dispatch(
      { ...h.env, githubUsers: undefined },
      { kind: "bearer", token: h.tti },
      "instance_bind_github_login",
      {
        target_org: "tenant",
        github_login: "alice",
        role: "admin",
        reason: "x",
      },
    );
    expect(!bare.ok && bare.error.code).toBe("unavailable");
    expect(await h.db.run((x) => x.orm.select().from(schema.memberInvites))).toHaveLength(0);
  });

  test("a web session never passes a check meant for the in-process caller", async () => {
    const h = await harness();
    h.users.set("code-alice", { id: "1001", login: "alice" });
    await h.bind({ role: "owner" });
    const cookie = (await h.signIn("code-alice")).session!;
    // doctor is the instance operator's: the host CLI's owner principal, never a signed-in owner
    const viaSession = await h.as(cookie, "doctor", { org: "tenant" });
    expect(!viaSession.ok && viaSession.error.code).toBe("forbidden");
    const cli = await dispatch(
      h.env,
      {
        kind: "principal",
        principal: { kind: "member", id: "cli", orgId: h.tenant.id, role: "owner" },
      },
      "doctor",
      { org: "tenant" },
    );
    expect(cli.ok || cli.error.code !== "forbidden").toBe(true);
    // the member-only checks (webhooks, OIDC audiences, token revoke by an admin) refuse a session too
    for (const op of [
      "create_webhook",
      "set_oidc_audiences",
      "revoke_api_token",
      "create_api_token",
    ]) {
      const r = await h.as(cookie, op, { org: "tenant" });
      expect(r.ok, op).toBe(false);
    }
  });

  test("a refused session is audited as a session, not as a token", async () => {
    const h = await harness();
    const r = await h.as("x".repeat(40), "whoami", { org: "tenant" });
    expect(!r.ok && r.error.code).toBe("unauthenticated");
    const rows = await listAudit(h.db, { orgId: await systemOrgId(h.db) });
    expect(rows.filter((a) => a.op === "whoami").map((a) => a.principalKind)).toEqual(["session"]);
  });

  test("replacing invites checks and revokes exactly the same rows: those of one account", async () => {
    const { h, cookie } = await aliceAdmin();
    const live = async (id: string) =>
      (await h.db.run((x) => x.orm.select().from(schema.memberInvites))).filter(
        (i) => i.githubUserId === id && i.usedAt === null && i.revokedAt === null,
      );
    // the same login, two accounts over time (a rename or recycle): ids c1 then c2
    h.logins.set("carol", "c1");
    expect((await h.bind({ github_login: "carol", role: "owner" })).ok).toBe(true);
    h.logins.set("carol", "c2");
    expect(
      (await h.as(cookie, "invite_member", { github_login: "carol", role: "viewer" })).ok,
    ).toBe(true);
    // re-inviting c2 never touched c1's owner invite
    expect(await live("c1")).toMatchObject([{ role: "owner" }]);
    expect(await live("c2")).toMatchObject([{ role: "viewer" }]);
    // a higher invite for c2 in the matched set refuses the whole call, and nothing is revoked
    expect((await h.bind({ github_login: "carol", role: "admin" })).ok).toBe(true);
    const refused = await h.as(cookie, "invite_member", { github_login: "carol", role: "member" });
    expect(!refused.ok && refused.error.code).toBe("conflict");
    expect(await live("c2")).toMatchObject([{ role: "admin" }]);
    expect(await live("c1")).toMatchObject([{ role: "owner" }]);
    // the same session replacing its own lower invite for c2 works and leaves c1 alone
    h.logins.set("dora", "d1");
    expect((await h.as(cookie, "invite_member", { github_login: "dora", role: "viewer" })).ok).toBe(
      true,
    );
    expect((await h.as(cookie, "invite_member", { github_login: "dora", role: "member" })).ok).toBe(
      true,
    );
    expect(await live("d1")).toMatchObject([{ role: "member" }]);
  });

  test("an invite never cancels a more privileged one", async () => {
    const { h, cookie } = await aliceAdmin();
    expect((await h.bind({ github_login: "carol", role: "owner" })).ok).toBe(true);
    // a session (cap member) and a person's token both fail to replace the operator's owner invite
    const viaSession = await h.as(cookie, "invite_member", {
      github_login: "carol",
      role: "viewer",
    });
    expect(!viaSession.ok && viaSession.error.code).toBe("conflict");
    const person = await mintToken(h.db, { orgId: h.tenant.id }, "release_operator", {
      kind: "person",
    });
    const viaToken = await dispatch(
      h.env,
      { kind: "bearer", token: person.secret },
      "invite_member",
      {
        github_login: "carol",
        role: "viewer",
      },
    );
    expect(!viaToken.ok && viaToken.error.code).toBe("conflict");
    const live = (await h.db.run((x) => x.orm.select().from(schema.memberInvites))).filter(
      (i) => i.githubLogin === "carol" && i.usedAt === null && i.revokedAt === null,
    );
    expect(live).toMatchObject([{ role: "owner" }]);
    // carol still joins as the owner the operator named
    h.users.set("code-carol", { id: "gen-carol", login: "carol" });
    const me = await h.as((await h.signIn("code-carol")).session!, "whoami");
    expect(me.ok && me.output).toMatchObject({ role: "owner" });
    // a lower invite of the caller's own making may still be replaced by the same caller
    expect((await h.as(cookie, "invite_member", { github_login: "dave", role: "viewer" })).ok).toBe(
      true,
    );
    expect((await h.as(cookie, "invite_member", { github_login: "dave", role: "member" })).ok).toBe(
      true,
    );
  });

  test("instance_bind_github_login: audited in both chains, with an org event; bad targets refused", async () => {
    const h = await harness();
    const r = await h.bind({ role: "owner" });
    expect(r.ok).toBe(true);
    const mine = (rows: Awaited<ReturnType<typeof listAudit>>) =>
      rows.filter((a) => a.op === "instance_bind_github_login");
    const sys = mine(await listAudit(h.db, { orgId: await systemOrgId(h.db) }));
    expect(sys).toHaveLength(1);
    expect(sys[0]).toMatchObject({ principalKind: "instance", outcome: "ok" });
    const own = mine(await listAudit(h.db, { orgId: h.tenant.id }));
    expect(own).toHaveLength(1);
    expect(JSON.parse(own[0]!.input)).toMatchObject({
      target_org: "tenant",
      github_login: "alice",
      role: "owner",
      reason: "first admin of the org",
    });
    const feed = await listEvents(
      h.db,
      { orgId: h.tenant.id },
      { after: 0, limit: 10, types: ["org.member_invited"] },
    );
    expect(feed).toHaveLength(1);
    expect(JSON.parse(feed[0]!.payload)).toMatchObject({
      github_login: "alice",
      role: "owner",
      via: "instance",
    });
    const missing = await h.bind({ target_org: "no-such-org" });
    expect(!missing.ok && missing.error.code).toBe("not_found");
    const sysOrg = await h.bind({ target_org: "_system" });
    expect(!sysOrg.ok && sysOrg.error.code).toBe("not_found");
    expect((await h.bind({ github_login: "bad login!" })).ok).toBe(false);
    expect((await h.bind({ reason: "" })).ok).toBe(false);
    // an org token, of any role, and a session never reach it
    const tok = await mintToken(h.db, { orgId: h.tenant.id }, "release_operator", {
      kind: "person",
    });
    const viaToken = await dispatch(
      h.env,
      { kind: "bearer", token: tok.secret },
      "instance_bind_github_login",
      {
        target_org: "tenant",
        github_login: "eve",
        role: "owner",
        reason: "x",
      },
    );
    expect(!viaToken.ok && viaToken.error.code).toBe("forbidden");
    expect(registry.mcpOps().map((o) => o.name)).not.toContain("instance_bind_github_login");
  });

  test("session lifetime: idle timeout, absolute lifetime", async () => {
    const h = await harness();
    h.users.set("code-alice", { id: "1001", login: "alice" });
    await h.bind({});
    const idle = (await h.signIn("code-alice")).session!;
    h.advance(11 * HOUR);
    expect(await h.sessions.resolve(idle)).toBeDefined(); // used: the idle clock restarts
    h.advance(11 * HOUR);
    expect(await h.sessions.resolve(idle)).toBeDefined();
    h.advance(13 * HOUR); // unused for longer than 12 h
    expect(await h.sessions.resolve(idle)).toBeUndefined();
    const dead = await h.as(idle, "whoami");
    expect(!dead.ok && dead.error.code).toBe("unauthenticated");

    const busy = (await h.signIn("code-alice")).session!;
    for (let i = 0; i < 27; i += 1) {
      h.advance(6 * HOUR);
      expect(await h.sessions.resolve(busy)).toBeDefined(); // 162 h in, never idle
    }
    h.advance(7 * HOUR); // 169 h: past the 7 day absolute limit however active it was
    expect(await h.sessions.resolve(busy)).toBeUndefined();
  });

  test("sign-out revokes the session; it needs the origin and the CSRF token", async () => {
    const { h, cookie } = await aliceAdmin();
    expect((await h.as(cookie, "whoami")).ok).toBe(true);
    expect((await h.logout({ cookie, origin: "https://evil.example" }))!.status).toBe(403);
    expect((await h.logout({ cookie, origin: null, csrf: csrfToken(cookie) }))!.status).toBe(403);
    expect((await h.logout({ cookie, csrf: "wrong" }))!.status).toBe(403);
    expect((await h.as(cookie, "whoami")).ok).toBe(true); // all refused: still signed in
    const out = (await h.logout({ cookie, csrf: csrfToken(cookie) }))!;
    expect(out.status).toBe(303);
    expect(cookieOf(out, SESSION_COOKIE)).toContain("Max-Age=0");
    const after = await h.as(cookie, "whoami");
    expect(!after.ok && after.error.code).toBe("unauthenticated");
    const row = await h.db.run((x) => x.orm.select().from(schema.webSessions));
    expect(row[0]!.revokedAt).not.toBeNull();
  });

  test("a session may read and invite, and every other write is refused for the step-up it lacks", async () => {
    const { h, cookie } = await aliceAdmin();
    expect((await h.as(cookie, "list_runs", { org: "tenant" })).ok).toBe(true);
    const writes = registry
      .tokenOps()
      .filter(
        (o) =>
          o.auth.type === "token" &&
          o.effect !== "read" &&
          !SESSION_WRITE_OPS.has(o.name) &&
          !LANE_CONFIG_WRITE_OPS.has(o.name),
      );
    const names = writes.map((o) => o.name);
    // the step-up actions of #430 are among them
    for (const n of ["create_api_token", "approve_run", "request_enrolment"]) {
      expect(names).toContain(n);
    }
    for (const op of writes) {
      const r = await h.as(cookie, op.name, { org: "tenant" });
      expect(r.ok, op.name).toBe(false);
      if (!r.ok) {
        expect(r.error.code, op.name).toBe("forbidden");
        expect(r.error.message, op.name).toContain("step-up");
      }
    }
    // the release lane config ops (#541) take a session of an operator org owner plus a step-up;
    // this session is not one, so each is refused for its own reason, before any step-up check
    expect(LANE_CONFIG_WRITE_OPS.size).toBeGreaterThan(0);
    for (const op of [...LANE_CONFIG_WRITE_OPS, ...LANE_CONFIG_READ_OPS]) {
      const r = await h.as(cookie, op, { org: "tenant" });
      expect(r.ok, op).toBe(false);
      if (!r.ok) {
        expect(r.error.code, op).toBe("forbidden");
        expect(r.error.details, op).toEqual({ reason: "lane_operator_owner_only" });
      }
    }
    // nothing was minted
    const tokens = await h.as(cookie, "list_api_tokens", { org: "tenant" });
    expect(tokens.ok && JSON.stringify(tokens.output)).not.toContain("b-minted");
    // instance ops are not for a session either
    const inst = await h.as(cookie, "instance_whoami");
    expect(inst.ok).toBe(false);
    expect([...SESSION_WRITE_OPS]).toEqual([
      "invite_member", // a viewer or member invite needs no step-up (admin and owner invites do)
      "session_step_up_challenge", // the challenge is how a session obtains a step-up at all
      "first_approver_challenge", // an owner session under 10 minutes from GitHub sign-in (#587)
      "enrol_first_approver", // the same gate, enforced again in one transaction
      "onboarding_create_org",
      "start_installation_claim",
      "bind_installation",
      "add_project", // owner or admin adds a repo as a project; the op's own `admin` role gates it
      "remove_project", // owner or admin unbinds; delete_history also needs owner and a step-up
      "onboard_repos", // owner or admin onboarding of repos; the op's own `admin` role gates it
      "run_default_branch", // owner or admin starts a default-branch run; same `admin` gate
      "run_dispatch", // owner or admin starts a workflow_dispatch run; the op's release_operator role gates it (#617)
      "set_setting", // each setting's own role; loosening a trust setting also needs a step-up
      "set_approval_policy", // an owner session; loosening also needs a step-up (and a quorum)
      "tighten_project_egress", // an owner session tightens only; widening is the instance op (#799)
      "change_project_pr_policy", // an owner or admin session; only an owner widens (#807)
      "notifications_ack", // a person's own notification rows (#611)
      "set_notification_prefs", // a person's own preferences (#611)

      "cancel", // operator role, as for a token; no step-up
      "rerun", // same
    ]);
  });

  test("onboard_repos and run_default_branch are open to a session but still refuse a member role", async () => {
    const { h, cookie } = await aliceAdmin();
    await createProject(h.db, { orgId: h.tenant.id }, { slug: "web", name: "web" });
    h.logins.set("carol", "1002"); // the invite binds the id GitHub reports for the login
    expect(
      (await h.as(cookie, "invite_member", { github_login: "carol", role: "member" })).ok,
    ).toBe(true);
    h.users.set("code-carol", { id: "1002", login: "carol" });
    const signed = await h.signIn("code-carol");
    expect(signed.res.status).toBe(303);
    const session = signed.session;
    for (const op of ["onboard_repos", "run_default_branch"]) {
      expect(SESSION_WRITE_OPS.has(op)).toBe(true);
      const input =
        op === "run_default_branch" ? { org: "tenant", project: "web" } : { org: "tenant" };
      const r = await h.as(session!, op, input);
      expect(r.ok, op).toBe(false);
      if (!r.ok) expect(r.error.code, op).toBe("forbidden");
    }
  });

  test("cancel and rerun work for an admin session, with an audit entry; a viewer session is refused by role (#600)", async () => {
    const { h, cookie } = await aliceAdmin();
    const project = await createProject(h.db, { orgId: h.tenant.id }, { slug: "web", name: "web" });
    const scope = { orgId: h.tenant.id, projectId: project.id };
    const mk = async (event: string) => {
      const run = await createRun(h.db, scope, {
        workflowPath: ".github/workflows/ci.yml",
        event,
        ref: "refs/heads/main",
        repo: "acme/web",
      });
      await createJob(h.db, scope, { runId: run.id, jobKey: "j", name: "j" });
      return run;
    };
    const run = await mk("push");
    const done = await h.as(cookie, "cancel", {
      org: "tenant",
      run_id: run.id,
      reason: "from the web",
    });
    expect(done.ok && done.output).toMatchObject({ state: "cancelled", cancelled_jobs: 1 });
    const audit = (await listAudit(h.db, { orgId: h.tenant.id })).filter((a) => a.op === "cancel");
    expect(audit.some((a) => a.outcome === "ok")).toBe(true);
    // rerun is open to the session too: the role gate passes, and the op itself answers (here a
    // conflict, since a job that never ran has nothing to rerun), never forbidden
    const re = await h.as(cookie, "rerun", {
      org: "tenant",
      run_id: run.id,
      reason: "try again",
    });
    expect(re.ok ? "ok" : re.error.code).not.toBe("forbidden");
    // a viewer session may do neither
    expect((await h.bind({ github_login: "bob", role: "viewer" })).ok).toBe(true);
    h.users.set("code-bob", { id: "2002", login: "bob" });
    const viewer = (await h.signIn("code-bob")).session!;
    const other = await mk("push");
    for (const [op, input] of [
      ["cancel", { run_id: other.id }],
      ["rerun", { run_id: other.id, reason: "no" }],
    ] as const) {
      const r = await h.as(viewer, op, { org: "tenant", ...input });
      expect(r.ok, op).toBe(false);
      if (!r.ok) expect(r.error.code, op).toBe("forbidden");
    }
  });

  test("REST: a cookie needs the exact public Origin on a state-changing request; a bearer is unaffected", async () => {
    const { h, cookie } = await aliceAdmin();
    const api = createRestApi(h.env);
    const post = (headers: Record<string, string>, login: string) =>
      api(
        new Request(`${ORIGIN}/api/v1/members/invites`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ org: "tenant", github_login: login, role: "viewer" }),
        }),
      );
    const c = { cookie: `${SESSION_COOKIE}=${cookie}` };
    expect((await post({ ...c, origin: "https://evil.example" }, "v1"))!.status).toBe(403);
    expect((await post({ ...c, origin: "null" }, "v1"))!.status).toBe(403);
    expect((await post(c, "v1"))!.status).toBe(403); // no Origin at all
    expect((await post({ ...c, origin: `${ORIGIN}.evil.example` }, "v1"))!.status).toBe(403);
    expect((await post({ ...c, origin: ORIGIN }, "v1"))!.status).toBe(200);
    // a GET needs no Origin
    const who = await api(new Request(`${ORIGIN}/api/v1/whoami?org=tenant`, { headers: c }));
    expect(who!.status).toBe(200);
    expect(await who!.json()).toMatchObject({ kind: "session", role: "admin" });
    // a bearer token behaves exactly as before: no cookie, no origin check
    const tok = await mintToken(h.db, { orgId: h.tenant.id }, "release_operator", {
      kind: "person",
    });
    const bearer = { authorization: `Bearer ${tok.secret}`, origin: "https://evil.example" };
    expect((await post(bearer, "v2"))!.status).toBe(200);
    const tokWho = await api(
      new Request(`${ORIGIN}/api/v1/whoami`, {
        headers: { authorization: `Bearer ${tok.secret}` },
      }),
    );
    expect(await tokWho!.json()).toMatchObject({ kind: "token", role: "release_operator" });
    // a bad bearer is not rescued by a good cookie
    const bad = await api(
      new Request(`${ORIGIN}/api/v1/whoami?org=tenant`, {
        headers: { ...c, authorization: "Bearer tt_nope" },
      }),
    );
    expect(bad!.status).toBe(401);
    // and with sign-in not configured the cookie is not a credential at all
    const off = createRestApi({ ...h.env, sessions: undefined });
    const none = await off(new Request(`${ORIGIN}/api/v1/whoami?org=tenant`, { headers: c }));
    expect(none!.status).toBe(401);
    // a revoked or garbage cookie is a 401
    const junk = await api(
      new Request(`${ORIGIN}/api/v1/whoami`, { headers: { cookie: `${SESSION_COOKIE}=junk` } }),
    );
    expect(junk!.status).toBe(401);
  });

  test("sign-in is unavailable without a GitHub App, and other paths and methods are not claimed", async () => {
    const db = open();
    opened.push(db);
    const { SecretStore } = await import("../src/secrets/store");
    const { randomBytes } = await import("node:crypto");
    const sessions = new WebSessions({ db, publicUrl: ORIGIN });
    const handler = createAuthHandler({
      db,
      store: new SecretStore(db, randomBytes(32)),
      sessions,
      identity: { verify: async () => ({ id: "1", login: "x" }) },
    });
    const go = await handler.handle(new Request(`${ORIGIN}${LOGIN_PATH}`));
    expect(go!.status).toBe(503);
    expect(go!.headers.getSetCookie()).toEqual([]);
    // unrelated paths fall through to the rest of the server
    expect(await handler.handle(new Request(`${ORIGIN}/healthz`))).toBeUndefined();
    expect(await handler.handle(new Request(`${ORIGIN}/auth/other`))).toBeUndefined();
    // wrong methods
    const bad = await handler.handle(new Request(`${ORIGIN}${LOGOUT_PATH}`));
    expect(bad!.status).toBe(405);
  });

  test("two logins started in one browser both complete, each with its own cookie", async () => {
    const h = await harness();
    h.users.set("code-alice", { id: "1001", login: "alice" });
    await h.bind({});
    const older = await h.start();
    const newer = await h.start();
    expect(older.cookieName).not.toBe(newer.cookieName);
    const jar = `${older.cookieName}=${older.cookie}; ${newer.cookieName}=${newer.cookie}`;
    const first = await h.callbackWith(older.state, "code-alice", jar);
    expect(first.status).toBe(303);
    // the finished sign-in clears only its own cookie
    expect(cookieOf(first, `${older.cookieName}=`, true)).toContain("Max-Age=0");
    expect(cookieOf(first, `${newer.cookieName}=`, true)).toBeUndefined();
    const second = await h.callbackWith(newer.state, "code-alice", jar);
    expect(second.status).toBe(303);
    expect(await h.db.run((x) => x.orm.select().from(schema.webSessions))).toHaveLength(2);
  });

  test("a callback with only another sign-in's cookie is refused", async () => {
    const h = await harness();
    h.users.set("code-alice", { id: "1001", login: "alice" });
    await h.bind({});
    const a = await h.start();
    const b = await h.start();
    const res = await h.callbackWith(a.state, "code-alice", `${b.cookieName}=${b.cookie}`);
    expect(res.status).toBe(403);
    // the cookie under a's name but b's value is not a's cookie either
    const forged = await h.callbackWith(a.state, "code-alice", `${a.cookieName}=${b.cookie}`);
    expect(forged.status).toBe(403);
    expect(
      (await h.callbackWith(a.state, "code-alice", `${a.cookieName}=${a.cookie}`)).status,
    ).toBe(303);
  });

  test("a browser holding many login cookies has the earliest expired when it starts another", async () => {
    const h = await harness();
    const held: { cookieName: string; cookie: string }[] = [];
    for (let i = 0; i < 6; i++) held.push(await h.start());
    const jar = held.map((c) => `${c.cookieName}=${c.cookie}`).join("; ");
    const go = (await h.handler.handle(
      new Request(`${ORIGIN}${LOGIN_PATH}`, { headers: { cookie: jar } }),
    ))!;
    const cleared = go.headers.getSetCookie().filter((c) => c.includes("Max-Age=0"));
    // 6 held, room for MAX_FLOW_COOKIES - 1 = 3 besides the new one: the 3 earliest go
    expect(cleared.map((c) => c.split("=")[0])).toEqual(held.slice(0, 3).map((c) => c.cookieName));
  });

  test("the sign-in state key is shared by a second handler over the same store", async () => {
    const h = await harness();
    h.users.set("code-alice", { id: "1001", login: "alice" });
    await h.bind({});
    const [x, y] = await Promise.all([h.start(), h.start()]);
    const second = createAuthHandler({
      db: h.db,
      store: h.store,
      sessions: h.sessions,
      identity: { verify: async () => ({ id: "1001", login: "alice" }) },
    });
    const res = await second.handle(
      new Request(
        `${ORIGIN}${CALLBACK_PATH}?${new URLSearchParams({ state: y.state, code: "c" })}`,
        {
          headers: { cookie: `${y.cookieName}=${y.cookie}` },
        },
      ),
    );
    expect(res!.status).toBe(303);
    expect(x.state).not.toBe(y.state);
  });

  test("two sign-ins of one invite make one member and one user", async () => {
    const h = await harness();
    h.users.set("code-alice", { id: "1001", login: "alice" });
    await h.bind({});
    // two browsers (separate cookie jars) start at the same moment
    const [a, b] = await Promise.all([h.start(), h.start()]);
    const first = await h.callback(a.state, "code-alice", a.cookie);
    const second = await h.callback(b.state, "code-alice", b.cookie);
    expect([first.status, second.status]).toEqual([303, 303]);
    const members = await listMembershipsOfUser(
      h.db,
      (await h.db.run((x) => x.orm.select().from(schema.githubIdentities)))[0]!.userId,
    );
    expect(members).toHaveLength(1);
    // the second sign-in is an existing member signing in: same user, a second session
    const idents = await h.db.run((x) => x.orm.select().from(schema.githubIdentities));
    expect(idents).toHaveLength(1);
    expect(await h.db.run((x) => x.orm.select().from(schema.webSessions))).toHaveLength(2);
  });
});

test("the claim-mode App manifest registers the sign-in callback URL", () => {
  const m = buildManifest({
    name: "Turntable",
    url: ORIGIN,
    redirectUrl: "http://x/cb",
    claimFlow: true,
  });
  expect(m.callback_urls).toEqual([`${ORIGIN}/api/v1/github/setup`, `${ORIGIN}${CALLBACK_PATH}`]);
});
