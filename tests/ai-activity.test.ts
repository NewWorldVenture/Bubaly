// §33's second half: the rows are readable, and the reading is correct.
//
// Fifteen surfaces now write to `ai_requests`. Until `lib/ai/activity.ts` no
// application code read them back except `loadRunDetail`, which needs a run —
// so every feature-kind row was write-only, and the gap row's actual complaint
// ("nobody can answer them") was still open with the ledger full.
//
// The page that renders this cannot be tested: the runner is `environment:
// 'node'` and a server component does not render here. So the filtering, the
// counting and the paging live in a module, and this is where they are pinned.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AI_ACTIVITY_PAGE_SIZE, AI_FAILURE_STATES, AI_IN_FLIGHT_STATES, AI_REQUEST_STATES,
  listAiActivity, normalizeStatusFilter, recentAiFeatures, summarizeAiActivity,
} from '@/lib/ai/activity';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type Call = { method: string; args: unknown[] };

/**
 * Records the query as it is built and resolves to a canned result. The point
 * of the assertions below is WHICH query was sent — a page that filters in
 * JavaScript over a capped fetch looks identical from the outside until the
 * table is bigger than the cap.
 */
function stubDb(result: { data?: unknown; count?: number; error?: unknown } = {}) {
  const calls: Call[] = [];
  const chain: Record<string, unknown> = {};
  const record = (method: string) => (...args: unknown[]) => { calls.push({ method, args }); return chain; };
  for (const m of ['select', 'order', 'range', 'eq', 'or', 'in', 'gte', 'not', 'limit']) chain[m] = record(m);
  chain.then = (onF: (v: unknown) => unknown) =>
    Promise.resolve({ data: result.data ?? [], count: result.count ?? 0, error: result.error ?? null }).then(onF);
  const db = { from: (table: string) => { calls.push({ method: 'from', args: [table] }); return chain; } };
  return { db: db as unknown as SupabaseClient<Database>, calls };
}

const argsOf = (calls: Call[], method: string) => calls.filter((c) => c.method === method).map((c) => c.args);

describe('normalizeStatusFilter', () => {
  it('accepts a real request status', () => {
    expect(normalizeStatusFilter('failed')).toEqual({ status: 'failed', ignored: null });
    expect(normalizeStatusFilter('partially_completed')).toEqual({ status: 'partially_completed', ignored: null });
  });

  it('treats an unknown status as ignored rather than passing it to the query', () => {
    // Not an injection — PostgREST parameterises it. The damage is duller: the
    // filter matches nothing and the console shows an empty table that reads as
    // "Bubaly did nothing" instead of "that is not a status".
    expect(normalizeStatusFilter('deleted')).toEqual({ status: null, ignored: 'deleted' });
    expect(normalizeStatusFilter("failed' or '1'='1")).toEqual({ status: null, ignored: "failed' or '1'='1" });
  });

  it('rejects `paused`, which is a RUN state and never a request state', () => {
    // The bug this pins: validating against RUN_STATES (AiRunLifecycleState[])
    // would accept `paused` and hand it to a query that can never match, and
    // the type predicate claiming AiRunState would be a lie.
    expect(AI_REQUEST_STATES).not.toContain('paused');
    expect(normalizeStatusFilter('paused')).toEqual({ status: null, ignored: 'paused' });
    // ...while still covering every status a row can actually hold.
    for (const s of ['queued', 'executing', 'completed', 'partially_completed', 'failed', 'cancelled', 'blocked'] as const) {
      expect(AI_REQUEST_STATES, `${s} must be filterable`).toContain(s);
    }
  });

  it('treats blank and whitespace as no filter at all', () => {
    expect(normalizeStatusFilter(undefined).status).toBeNull();
    expect(normalizeStatusFilter('   ')).toEqual({ status: null, ignored: null });
  });
});

describe('listAiActivity', () => {
  it('asks PostgreSQL to filter, order, count and page — not JavaScript', () => {
    // A capped fetch filtered in memory answers "show me every failure" wrongly
    // and silently: it shows the failures inside the last N rows and calls that
    // all of them. On a table that grows by a row per AI call, that is the
    // default outcome, not an edge case.
    const { db, calls } = stubDb({ count: 130 });
    return listAiActivity(db, { status: 'failed', page: 3 }).then((res) => {
      expect(res.ok).toBe(true);
      expect(calls[0]).toEqual({ method: 'from', args: ['ai_requests'] });
      expect(argsOf(calls, 'select')[0][1]).toEqual({ count: 'exact' });
      expect(argsOf(calls, 'order')[0]).toEqual(['created_at', { ascending: false }]);
      expect(argsOf(calls, 'eq')).toContainEqual(['status', 'failed']);
      // Page 3 of 25 is rows 50–74 inclusive; `range` is inclusive at both ends.
      expect(argsOf(calls, 'range')[0]).toEqual([50, 74]);
    });
  });

  it('never sends an unknown status to the database, and says which it dropped', async () => {
    const { db, calls } = stubDb({ count: 0 });
    const res = await listAiActivity(db, { status: 'nonsense' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ignoredStatus).toBe('nonsense');
    expect(argsOf(calls, 'eq').some(([col]) => col === 'status')).toBe(false);
  });

  it('escapes ILIKE wildcards so a literal % is searched for, not matched with', async () => {
    const { db, calls } = stubDb();
    await listAiActivity(db, { q: '50%_off' });
    const [filter] = argsOf(calls, 'or')[0] as [string];
    expect(filter).toContain('50\\%\\_off');
    // Both columns, and NOT request_text: the search box is for diagnosing a
    // surface, not for trawling what families typed.
    expect(filter).toContain('feature.ilike');
    expect(filter).toContain('error.ilike');
    expect(filter).not.toContain('request_text');
  });

  it('cannot have its or-filter split apart by a comma or a bracket in the search box', async () => {
    // `,` `(` `)` are STRUCTURAL inside PostgREST's `or=(...)`. A term carrying
    // one would break `feature.ilike.%a,b%,error.ilike.%a,b%` into pieces that
    // are rejected or, worse, read as different conditions. Every other `.or()`
    // in this repo interpolates a UUID or a timestamp; this is the only one
    // taking a person's text, so it is the only one that can be split.
    const { db, calls } = stubDb();
    await listAiActivity(db, { q: 'timeout (503), retry' });
    const [filter] = argsOf(calls, 'or')[0] as [string];
    // Exactly two conditions, still — one comma, the one that separates them.
    expect(filter.split(',')).toHaveLength(2);
    expect(filter).not.toContain('(');
    expect(filter).not.toContain(')');
    expect(filter).toMatch(/^feature\.ilike\.%[^,()]*%,error\.ilike\.%[^,()]*%$/);
  });

  it('keeps the dots, because feature names are full of them', async () => {
    // A dot inside the value half of `column.operator.value` is not structural,
    // and `wallet.coach` is a thing someone will reasonably type.
    const { db, calls } = stubDb();
    await listAiActivity(db, { q: 'wallet.coach' });
    const [filter] = argsOf(calls, 'or')[0] as [string];
    expect(filter).toContain('feature.ilike.%wallet.coach%');
  });

  it('treats a term that was nothing but structure as no search at all', async () => {
    const { db, calls } = stubDb();
    await listAiActivity(db, { q: '  (),  ' });
    expect(argsOf(calls, 'or')).toEqual([]);
  });

  it('derives the page count from the server count, not from the rows it got back', async () => {
    // The last page holds fewer rows than the page size; deriving pageCount
    // from `rows.length` would say "1 page" on every page.
    const { db } = stubDb({ data: [{ id: 'a' }], count: 130 });
    const res = await listAiActivity(db, { page: 6 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.total).toBe(130);
    expect(res.data.pageCount).toBe(Math.ceil(130 / AI_ACTIVITY_PAGE_SIZE));
    expect(res.data.rows).toHaveLength(1);
  });

  it('clamps a nonsense page to the first one instead of asking for a negative range', async () => {
    for (const page of [0, -4, Number.NaN]) {
      const { db, calls } = stubDb();
      await listAiActivity(db, { page });
      expect(argsOf(calls, 'range')[0], `page=${page}`).toEqual([0, AI_ACTIVITY_PAGE_SIZE - 1]);
    }
  });

  it('reports a read failure instead of rendering an empty ledger as calm', async () => {
    // An empty table and a broken query look the same to a reader, and one of
    // them means "Bubaly is fine".
    const { db } = stubDb({ error: { message: 'boom' } });
    const res = await listAiActivity(db, {});
    expect(res.ok).toBe(false);
  });

  it('scopes to one family when support is answering one ticket', async () => {
    const { db, calls } = stubDb();
    await listAiActivity(db, { familyId: 'fam-7' });
    expect(argsOf(calls, 'eq')).toContainEqual(['family_id', 'fam-7']);
  });
});

describe('summarizeAiActivity', () => {
  it('counts without shipping rows, and counts partial as a failure', async () => {
    const { db, calls } = stubDb({ count: 4 });
    const summary = await summarizeAiActivity(db, '2026-09-05T00:00:00.000Z');
    expect(summary).toEqual({ failed: 4, inFlight: 4, total: 4 });
    // head: true — the number without the payload.
    for (const [, opts] of argsOf(calls, 'select')) expect(opts).toEqual({ count: 'exact', head: true });
    expect(argsOf(calls, 'gte')[0]).toEqual(['created_at', '2026-09-05T00:00:00.000Z']);
    // A half-answer is the thing families write in about, so it counts as failed.
    expect(AI_FAILURE_STATES).toContain('partially_completed');
    expect(AI_FAILURE_STATES).toContain('failed');
    expect(AI_IN_FLIGHT_STATES).toContain('executing');
    // ...and the two sets must not overlap, or the strip double-counts.
    expect(AI_FAILURE_STATES.filter((s) => AI_IN_FLIGHT_STATES.includes(s))).toEqual([]);
  });

  it('survives a failed count rather than taking the page down with it', async () => {
    const { db } = stubDb({ error: { message: 'nope' } });
    await expect(summarizeAiActivity(db, '2026-09-05T00:00:00.000Z')).resolves.toEqual({ failed: 0, inFlight: 0, total: 0 });
  });
});

describe('recentAiFeatures', () => {
  it('de-duplicates and sorts what it found', async () => {
    const { db, calls } = stubDb({ data: [
      { feature: 'meals.plan' }, { feature: 'assistant.turn' }, { feature: 'meals.plan' }, { feature: null },
    ] });
    await expect(recentAiFeatures(db)).resolves.toEqual(['assistant.turn', 'meals.plan']);
    expect(argsOf(calls, 'not')[0]).toEqual(['feature', 'is', null]);
    expect(argsOf(calls, 'limit')[0]).toEqual([500]);
  });

  it('returns nothing rather than throwing when the read fails', async () => {
    const { db } = stubDb({ error: { message: 'nope' } });
    await expect(recentAiFeatures(db)).resolves.toEqual([]);
  });
});

describe('the console the ledger is for', () => {
  const page = readFileSync('app/(app)/admin/ai-activity/page.tsx', 'utf8');

  it('lives under the admin layout, which is what gates it', () => {
    // The page itself runs no auth check, and must not need one: every route
    // under app/(app)/admin is behind a layout that redirects a non-super-admin
    // BEFORE any child renders. If that ever stops being true, this page starts
    // serving every family's AI history to anyone signed in.
    const layout = readFileSync('app/(app)/admin/layout.tsx', 'utf8');
    expect(layout).toContain('isSuperAdmin()');
    expect(layout).toContain("redirect('/dashboard')");
    // ...and the page is genuinely inside it.
    expect(existsSync('app/(app)/admin/ai-activity/page.tsx')).toBe(true);
  });

  it('reads through the tested module rather than querying inline', () => {
    // The reason the filtering above can be tested at all: a server component
    // cannot be rendered by this runner, so a page holding its own query is a
    // page whose query is never exercised.
    expect(page).toContain("from '@/lib/ai/activity'");
    expect(page).not.toContain("from('ai_requests')");
  });

  it('is reachable — an admin console page nobody can navigate to is not a view', () => {
    const nav = readFileSync('lib/constants/navigation.ts', 'utf8');
    expect(nav).toContain("href: '/admin/ai-activity'");
  });

  it('shows a broken read as broken, not as an empty ledger', () => {
    // "No AI requests" and "the query failed" render identically unless the page
    // branches, and one of them means Bubaly is fine.
    expect(page).toContain('if (!result.ok) return <AIActivityReadError');
  });

  it('distinguishes "no tokens reported" from zero tokens', () => {
    // The streaming assistant reports no usage at all; a 0 there reads as a free
    // turn rather than as a missing number.
    expect(page).toContain('row.prompt_tokens == null && row.completion_tokens == null');
  });
});
