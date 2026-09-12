import { describe, expect, it } from 'vitest';
import {
  auditSupabaseQueries,
  collectConflictTargets,
  conflictTargetVerdict,
  readSchema,
} from '../scripts/audit-supabase-queries.mjs';
import { checkConflictTargets, parseIndexDefinition } from '../scripts/check-conflict-targets.mjs';

// Postgres resolves `ON CONFLICT (a, b)` by INDEX INFERENCE. A candidate index
// must cover exactly those columns, must not be an expression index, and must
// not be partial — a partial index is inferable only when the statement repeats
// the index predicate, which PostgREST has no syntax to emit.
//
// When nothing matches, the statement fails at PLANNING time with 42P10. That
// is the whole reason this class of bug survives: it does not wait for a second
// row, or for a conflict, or for production data. It fails on the first insert
// into an empty table, identically, forever — and every piece of it reads
// correctly on its own. The migration that creates a partial unique index is
// good SQL; the upsert that names those two columns is good TypeScript. Only
// the pair is wrong, and nothing had ever looked at the pair.
//
// Five live upserts were in this state when these tests were written
// (calendar_events, marketing_automation_runs, family_inbox_messages,
// library_items, subscriptions), plus one statement in SEED_ALL.sql.

const index = (name: string, keys: string[], extra: Partial<{ partial: boolean; expression: boolean }> = {}) => ({
  name, table: 't', keys, partial: false, expression: false, ...extra,
});

describe('conflictTargetVerdict', () => {
  it('accepts a plain unique index over exactly those columns', () => {
    expect(conflictTargetVerdict('family_id,feed_url', [index('uq', ['family_id', 'feed_url'])]).ok).toBe(true);
  });

  it('does not care about the order the columns are written in', () => {
    expect(conflictTargetVerdict('feed_url,family_id', [index('uq', ['family_id', 'feed_url'])]).ok).toBe(true);
  });

  it('rejects a PARTIAL index over the right columns', () => {
    const verdict = conflictTargetVerdict('feed_id,external_uid', [
      index('uniq_calendar_events_feed_uid', ['feed_id', 'external_uid'], { partial: true }),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('PARTIAL');
  });

  it('rejects an EXPRESSION index even when the expression mentions the column', () => {
    const verdict = conflictTargetVerdict('family_id,feed_id,guid', [
      index('uq_library_item_guid', ['family_id', "coalesce(feed_id::text, 'manual')", 'guid'], { expression: true }),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('expression index');
  });

  it('rejects a target with no unique index at all, and says what is there', () => {
    const verdict = conflictTargetVerdict('family_id', [index('subscriptions_pkey', ['id'])]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('subscriptions_pkey');
  });

  it('rejects a superset and a subset alike — inference is exact, not "covers"', () => {
    expect(conflictTargetVerdict('family_id,as_of_date', [index('uq', ['family_id', 'as_of_date', 'kind'])]).ok).toBe(false);
    expect(conflictTargetVerdict('family_id,as_of_date,kind', [index('uq', ['family_id', 'as_of_date'])]).ok).toBe(false);
  });
});

describe('parseIndexDefinition', () => {
  it('reads a plain index', () => {
    const parsed = parseIndexDefinition('t', 'uq', 'CREATE UNIQUE INDEX uq ON public.t USING btree (a, b)', 'total');
    expect(parsed).toMatchObject({ keys: ['a', 'b'], partial: false, expression: false });
  });

  it('treats NULLS NOT DISTINCT as inferable — it is not a predicate', () => {
    // This one matters: an earlier reader looked for a closing paren followed by
    // WHERE or end-of-string, so the trailing clause made it mis-parse the key
    // list and call a perfectly good index partial.
    const parsed = parseIndexDefinition(
      'dashboard_layouts', 'uq_dashboard_layout_upsert',
      'CREATE UNIQUE INDEX uq_dashboard_layout_upsert ON public.dashboard_layouts USING btree (family_id, user_id, device_context) NULLS NOT DISTINCT',
      'total',
    );
    expect(parsed).toMatchObject({ keys: ['family_id', 'user_id', 'device_context'], partial: false, expression: false });
    expect(conflictTargetVerdict('family_id,user_id,device_context', [parsed!]).ok).toBe(true);
  });

  it('keeps an expression with its own comma as ONE key', () => {
    const parsed = parseIndexDefinition(
      'library_items', 'uq_library_item_guid',
      "CREATE UNIQUE INDEX uq_library_item_guid ON public.library_items USING btree (family_id, COALESCE((feed_id)::text, 'manual'::text), guid)",
      'total',
    );
    expect(parsed!.keys).toHaveLength(3);
    expect(parsed!.expression).toBe(true);
  });

  it('marks a WHERE clause as partial', () => {
    const parsed = parseIndexDefinition(
      'calendar_events', 'uniq_calendar_events_feed_uid',
      'CREATE UNIQUE INDEX uniq_calendar_events_feed_uid ON public.calendar_events USING btree (feed_id, external_uid) WHERE ((feed_id IS NOT NULL) AND (external_uid IS NOT NULL))',
      'partial',
    );
    expect(parsed!.partial).toBe(true);
  });
});

describe('the call sites this check is meant to cover', () => {
  const sites = collectConflictTargets();

  // The reason this assertion exists, spelled out: the collector's first draft
  // matched `.from('t'` without the closing paren, so the chain walk it handed
  // off to stopped immediately and it found ZERO application call sites. The
  // audit then reported no findings — against a tree with five live defects in
  // it. A check that finds nothing is indistinguishable from a clean bill of
  // health unless something insists it must find things.
  it('finds application upserts, not only the ones in SEED_ALL.sql', () => {
    const appSites = sites.filter((site) => !site.file.startsWith('supabase/'));
    expect(appSites.length).toBeGreaterThan(80);
  });

  it.each([
    ['app/(app)/dashboard/library/actions.ts', 'library_items'],
    ['lib/server/calendar-feeds.ts', 'calendar_events'],
    ['lib/marketing/automation-events.ts', 'marketing_automation_runs'],
    ['lib/contact-center/server.ts', 'family_inbox_messages'],
  ])('still sees the upsert in %s', (file, table) => {
    expect(sites.some((site) => site.file === file && site.table === table)).toBe(true);
  });

  it('reads the ON CONFLICT statements in SEED_ALL.sql, whose errors the bootstrap swallows', () => {
    expect(sites.some((site) => site.file === 'supabase/SEED_ALL.sql')).toBe(true);
  });
});

describe('the repository itself', () => {
  it('has no ON CONFLICT target the migrations cannot satisfy', () => {
    const findings = auditSupabaseQueries().findings.filter((f) => f.kind === 'uninferable-conflict-target');
    expect(findings.map((f) => `${f.file}:${f.line} ${f.detail}`)).toEqual([]);
  });

  it('agrees with itself: the catalog checker clears the same tree, given the same index facts', () => {
    // The two readers differ only in where the index facts come from. Feeding
    // the file-derived facts through the catalog checker proves the shared
    // verdict is what both rely on, without needing a database here — CI runs
    // the real thing against a replayed schema, which is the authority.
    const schema = readSchema();
    expect(checkConflictTargets(schema.uniqueIndexes)).toEqual([]);
  });
});
