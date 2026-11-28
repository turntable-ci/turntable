// The claim path's quota figure (#815): the sandbox-span query is index-served on a hosted-sized
// table and fast, and the per-org usage cache survives from one claim transaction to the next.
import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  cachedUsage,
  createAttempt,
  type Db,
  NO_QUOTAS,
  sandboxSeconds,
  spanRowsQuery,
} from "../src/db";
import * as s from "../src/db/schema";
import { seedWorld, type Tenant } from "./ops-helpers";
import { onPostgres } from "./pg-mode";

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const NOW = Date.UTC(2026, 10, 28);

let db: Db;
let a: Tenant;
beforeEach(async () => {
  ({ db, a } = await seedWorld());
});

describe("sandbox-span query at hosted size", () => {
  // 60k attempts over 30 days (2k a day); 24 h window.
  const TOTAL = 60_000;
  const W = { from: NOW - DAY, to: NOW, now: NOW };

  async function fill(): Promise<void> {
    const att = (await createAttempt(db, a.scope, { jobId: a.jobId, provider: "test" }))!;
    const [tpl] = await db.orm.select().from(s.jobAttempts).where(eq(s.jobAttempts.id, att.id));
    const gap = (30 * DAY) / TOTAL;
    for (let i = 0; i < TOTAL; i += 1000) {
      const rows = Array.from({ length: Math.min(1000, TOTAL - i) }, (_, k) => {
        const created = Math.floor(NOW - (i + k) * gap);
        return {
          ...tpl!,
          id: `big${(i + k).toString().padStart(8, "0")}`,
          attempt: 1000 + i + k,
          sandboxCreatedAt: created,
          sandboxDestroyedAt: created + 5 * MIN,
          finishedAt: created + 5 * MIN,
          state: "success" as const,
          sandboxTtlSeconds: null,
        };
      });
      await db.orm.insert(s.jobAttempts).values(rows);
    }
    await db.run(async (h) => {
      const o = h.orm as unknown as {
        execute?(q: unknown): Promise<unknown>;
        run?(q: unknown): unknown;
      };
      if (onPostgres) await o.execute!(sql`analyze job_attempts`);
      else await o.run!(sql`analyze`);
    });
  }

  test("the plan ranges over the sandbox index with both bounds", async () => {
    await fill();
    const q = spanRowsQuery(db.orm, { orgId: a.orgId }, W);
    let text: string;
    if (onPostgres) {
      const pg = db.orm as unknown as { execute(q: unknown): Promise<unknown> };
      const res = (await pg.execute(sql`explain ${q.getSQL()}`)) as unknown as
        Record<string, string>[] | { rows: Record<string, string>[] };
      text = (Array.isArray(res) ? res : res.rows)
        .map((r) => Object.values(r).join(" "))
        .join("\n");
    } else {
      const rows = (await (db.orm as unknown as { all(q: unknown): unknown }).all(
        sql`explain query plan ${q.getSQL()}`,
      )) as { detail: string }[];
      text = rows.map((r) => r.detail).join("\n");
    }
    expect(text).toContain("job_attempts_sandbox_idx");
    expect(text).not.toMatch(/SCAN job_attempts|Seq Scan/);
  }, 120_000);

  test("one figure reads in under 50 ms and counts the right minutes", async () => {
    await fill();
    await sandboxSeconds(db, { orgId: a.orgId }, W); // warm the statement
    const t0 = performance.now();
    const out = await sandboxSeconds(db, { orgId: a.orgId }, W);
    const ms = performance.now() - t0;
    // 2000 attempts a day, 5 minutes each, created inside the last 24 h or ending inside it.
    expect(out.seconds / 60).toBeGreaterThan(9_000);
    expect(out.seconds / 60).toBeLessThan(10_100);
    expect(ms).toBeLessThan(50);
  }, 120_000);
});

describe("the usage cache is shared across claim transactions", () => {
  test("a second transaction reads the cached figure; past the TTL it re-measures", async () => {
    const read = (now: number) =>
      db.transaction((tx) => cachedUsage(tx, a.orgId, now, 5_000, NO_QUOTAS, db));
    const first = await read(NOW);
    expect(first.sandboxMinutesLastDay).toBe(0);
    const att = (await createAttempt(db, a.scope, { jobId: a.jobId, provider: "test" }))!;
    await db.orm
      .update(s.jobAttempts)
      .set({
        state: "success",
        sandboxCreatedAt: NOW - 40 * MIN,
        sandboxDestroyedAt: NOW - 10 * MIN,
        finishedAt: NOW - 10 * MIN,
      })
      .where(eq(s.jobAttempts.id, att.id));
    expect((await read(NOW + 1_000)).sandboxMinutesLastDay).toBe(0); // cache hit
    expect((await read(NOW + 6_000)).sandboxMinutesLastDay).toBe(30); // expired
  });
});
