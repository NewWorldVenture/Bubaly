// compareQuotes is pure: the same rows in, the same ranking out, with the
// reason for every rank and every tie explained — and the AI tool that wraps it
// is read-only, family-scoped, and ranks the same rows the projects module
// shows.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { compareQuotes, type ComparableQuote } from '@/lib/services/providers/compare';
import { getTool } from '@/lib/ai/tools/registry';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const TODAY = '2026-09-05';

function quote(over: Partial<ComparableQuote> & { id: string; contractor_name: string; amount_cents: number }): ComparableQuote {
  return { includes_materials: false, lead_time_days: null, valid_until: null, status: 'received', notes: null, ...over };
}

describe('compareQuotes ranks what the family recorded and says why', () => {
  const bell = quote({ id: 'q-bell', contractor_name: 'Bell Plumbing', amount_cents: 120_000, includes_materials: true, lead_time_days: 3, notes: '2-year warranty on labour' });
  const acme = quote({ id: 'q-acme', contractor_name: 'Acme Pipes', amount_cents: 150_000, includes_materials: false, lead_time_days: 10 });
  const zed = quote({ id: 'q-zed', contractor_name: 'Zed & Sons', amount_cents: 110_000, includes_materials: false, lead_time_days: null });

  it('puts the strongest quote first and attaches a reason for every factor', () => {
    const c = compareQuotes([acme, zed, bell], { today: TODAY });
    expect(c.ranked.map((r) => r.quote.id)).toEqual(['q-bell', 'q-zed', 'q-acme']);
    expect(c.ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    const first = c.ranked[0];
    expect(first.reasons.map((r) => r.code)).toEqual(['above_lowest', 'shortest_lead_time', 'includes_materials', 'has_notes']);
    expect(first.reasons.find((r) => r.code === 'above_lowest')?.params).toEqual({ pct: 9 });
    expect(c.lowest?.id).toBe('q-zed');
    const zedRank = c.ranked[1];
    expect(zedRank.reasons.map((r) => r.code)).toEqual(['lowest_price', 'no_lead_time', 'labour_only', 'no_notes']);
    expect(c.summary).toBe('Bell Plumbing ranks first of 3: can start soonest — 3-day lead time, materials included, scope or warranty notes on file.');
  });

  it('excludes what cannot be ranked yet, each with its reason', () => {
    const waiting = quote({ id: 'q-wait', contractor_name: 'Waiting Co', amount_cents: 0, status: 'requested' });
    const declined = quote({ id: 'q-no', contractor_name: 'No Thanks', amount_cents: 90_000, status: 'declined' });
    const expired = quote({ id: 'q-old', contractor_name: 'Old Quote', amount_cents: 80_000, valid_until: '2026-08-01' });
    const flagged = quote({ id: 'q-flag', contractor_name: 'Flagged', amount_cents: 70_000, status: 'expired' });
    const zero = quote({ id: 'q-zero', contractor_name: 'Zero', amount_cents: 0 });
    const c = compareQuotes([bell, waiting, declined, expired, flagged, zero], { today: TODAY });
    expect(c.ranked.map((r) => r.quote.id)).toEqual(['q-bell']);
    expect(Object.fromEntries(c.excluded.map((e) => [e.quote.id, e.reason.code]))).toEqual({
      'q-wait': 'still_waiting', 'q-no': 'declined', 'q-old': 'expired', 'q-flag': 'expired', 'q-zero': 'no_amount',
    });
    expect(c.excluded.find((e) => e.quote.id === 'q-old')?.reason.params).toEqual({ date: '2026-08-01' });
    // The cheaper-but-expired quote does not set the "lowest" bar.
    expect(c.lowest?.id).toBe('q-bell');
    expect(c.ranked[0].reasons.map((r) => r.code)).toContain('lowest_price');
  });

  it('flags an accepted quote and one that expires within the week', () => {
    const soon = quote({ id: 'q-soon', contractor_name: 'Soon', amount_cents: 100_000, valid_until: '2026-09-10', status: 'accepted' });
    const c = compareQuotes([soon], { today: new Date('2026-09-05T12:00:00Z') });
    const codes = c.ranked[0].reasons.map((r) => r.code);
    expect(codes).toContain('accepted');
    expect(codes).toContain('expires_soon');
    expect(c.summary).toBe('Soon is the only live quote (lowest price).');
  });

  it('explains a tie instead of breaking it silently', () => {
    // A: cheapest, no lead time, notes → 50 + 0 + 0 + 10 = 60.
    // B: twice the price, the only lead time on file, notes → 25 + 25 + 0 + 10 = 60.
    const a = quote({ id: 'q-a', contractor_name: 'Alpha', amount_cents: 100_000, notes: 'warranty' });
    const b = quote({ id: 'q-b', contractor_name: 'Beta', amount_cents: 200_000, lead_time_days: 2, notes: 'warranty' });
    const c = compareQuotes([b, a], { today: TODAY });
    expect(c.ranked.map((r) => r.score)).toEqual([60, 60]);
    expect(c.ranked.map((r) => r.quote.id)).toEqual(['q-a', 'q-b']);
    expect(c.ranked[0].tiedWith).toEqual(['q-b']);
    expect(c.ranked[1].tiedWith).toEqual(['q-a']);
    expect(c.ties).toHaveLength(1);
    expect(c.ties[0].code).toBe('tie_broken_by_price');
    expect(c.ties[0].params).toEqual({ name: 'Beta' });
    expect(c.ranked[0].reasons.at(-1)?.code).toBe('tie_broken_by_price');
    expect(c.summary).toMatch(/with a tie explained\.$/);

    // Identical on every count: alphabetical, and it says so.
    const twin = quote({ id: 'q-twin', contractor_name: 'Alpha Twin', amount_cents: 100_000, notes: 'warranty' });
    const d = compareQuotes([twin, a], { today: TODAY });
    expect(d.ranked.map((r) => r.quote.id)).toEqual(['q-a', 'q-twin']);
    expect(d.ties[0].code).toBe('tie_broken_by_name');

    // Same points and price, different lead time.
    const l1 = quote({ id: 'q-l1', contractor_name: 'Lead One', amount_cents: 100_000, lead_time_days: 1, includes_materials: true });
    const l2 = quote({ id: 'q-l2', contractor_name: 'Lead Two', amount_cents: 100_000, lead_time_days: 1, includes_materials: true });
    const e = compareQuotes([l2, l1], { today: TODAY });
    expect(e.ties[0].code).toBe('tie_broken_by_name');
    expect(e.ranked.map((r) => r.quote.id)).toEqual(['q-l1', 'q-l2']);
  });

  it('is pure: no mutation, no dependence on input order, no dependence on the clock when today is given', () => {
    const rows = [acme, zed, bell].map((q) => ({ ...q }));
    const before = JSON.stringify(rows);
    const one = compareQuotes(rows, { today: TODAY });
    const two = compareQuotes([...rows].reverse(), { today: TODAY });
    const three = compareQuotes(rows, { today: TODAY });
    expect(JSON.stringify(rows)).toBe(before);
    expect(one).toEqual(two);
    expect(one).toEqual(three);
    expect(Object.isFrozen(rows[0])).toBe(false);
    expect(compareQuotes([], { today: TODAY })).toEqual({ ranked: [], excluded: [], lowest: null, ties: [], summary: 'No quotes on file.' });
  });

  it('gives every reason a catalogue key whose placeholders match its params', () => {
    const seen = new Set<string>();
    const all = [
      compareQuotes([acme, zed, bell], { today: TODAY }),
      compareQuotes([quote({ id: 'x', contractor_name: 'X', amount_cents: 1, notes: 'n' }), quote({ id: 'y', contractor_name: 'Y', amount_cents: 2, lead_time_days: 1, notes: 'n' })], { today: TODAY }),
      compareQuotes([quote({ id: 'w', contractor_name: 'W', amount_cents: 0, status: 'requested' }), quote({ id: 'd', contractor_name: 'D', amount_cents: 5, status: 'declined' }), quote({ id: 'e', contractor_name: 'E', amount_cents: 5, valid_until: '2020-01-01' }), quote({ id: 'z', contractor_name: 'Z', amount_cents: 0 }), quote({ id: 's', contractor_name: 'S', amount_cents: 5, status: 'accepted', valid_until: '2026-09-06' })], { today: TODAY }),
    ];
    for (const c of all) {
      const reasons = [...c.ranked.flatMap((r) => r.reasons), ...c.excluded.map((e) => e.reason), ...c.ties];
      for (const r of reasons) {
        seen.add(r.code);
        const template = MESSAGES[r.labelKey];
        expect(template, `${r.labelKey} is in en-US`).toBeTruthy();
        const holders = (template.match(/\{(\w+)\}/g) ?? []).map((h) => h.slice(1, -1)).sort();
        expect(Object.keys(r.params ?? {}).sort(), `${r.code} params`).toEqual(holders);
        expect(r.text.length).toBeGreaterThan(0);
      }
    }
    expect([...seen].sort()).toEqual([
      'above_lowest', 'accepted', 'declined', 'expired', 'expires_soon', 'has_notes', 'includes_materials', 'labour_only', 'lead_time', 'lowest_price',
      'no_amount', 'no_lead_time', 'no_notes', 'shortest_lead_time', 'still_waiting', 'tie_broken_by_price',
    ]);
  });
});

describe('services.compareQuotes is a read-only tool over the family\'s own quotes', () => {
  const tool = getTool('services.compareQuotes')!;
  const FAMILY = 'family-1';
  const OTHER = 'family-2';

  function scopeFor(db: SupabaseClient<Database>, familyId = FAMILY): ServiceScope {
    return { db, familyId, userId: 'user-1', memberId: 'member-1', role: 'parent', actorKind: 'ai', tz: 'UTC', now: new Date('2026-09-05T12:00:00Z') };
  }

  function seeded() {
    const db = createInMemorySupabase<SupabaseClient<Database>>();
    db.seed('home_projects', [
      { id: 'p-kitchen', family_id: FAMILY, title: 'Kitchen tap', status: 'quoting', updated_at: '2026-09-01T00:00:00Z' },
      { id: 'p-roof', family_id: FAMILY, title: 'Roof repair', status: 'quoting', updated_at: '2026-09-02T00:00:00Z' },
      { id: 'p-other', family_id: OTHER, title: 'Kitchen tap', status: 'quoting', updated_at: '2026-09-03T00:00:00Z' },
    ]);
    db.seed('project_quotes', [
      { id: 'q1', family_id: FAMILY, project_id: 'p-kitchen', contractor_name: 'Bell Plumbing', amount_cents: 120_000, includes_materials: true, lead_time_days: 3, valid_until: null, status: 'received', notes: 'warranty' },
      { id: 'q2', family_id: FAMILY, project_id: 'p-kitchen', contractor_name: 'Acme Pipes', amount_cents: 150_000, includes_materials: false, lead_time_days: 10, valid_until: null, status: 'received', notes: null },
      { id: 'q3', family_id: FAMILY, project_id: 'p-kitchen', contractor_name: 'Waiting Co', amount_cents: 0, includes_materials: false, lead_time_days: null, valid_until: null, status: 'requested', notes: null },
      { id: 'q4', family_id: FAMILY, project_id: 'p-roof', contractor_name: 'Roofers', amount_cents: 500_000, includes_materials: true, lead_time_days: null, valid_until: null, status: 'received', notes: null },
      { id: 'q9', family_id: OTHER, project_id: 'p-other', contractor_name: 'Not Yours', amount_cents: 1, includes_materials: true, lead_time_days: 0, valid_until: null, status: 'received', notes: 'x' },
    ]);
    return db;
  }

  it('is registered read-only, low risk, in the home domain, under its dotted name and aliases', () => {
    expect(tool).not.toBeNull();
    expect(tool.readOnly).toBe(true);
    expect(tool.capability).toBe('view');
    expect(tool.risk).toBe('low');
    expect(tool.domain).toBe('home_maintenance');
    expect(getTool('compare_quotes')).toBe(tool);
    expect(getTool('services_compareQuotes')).toBe(tool);
    expect(tool.description).toMatch(/never solicits a quote or names a provider that is not on file/);
  });

  it('ranks the named project\'s quotes and reports what it excluded', async () => {
    const db = seeded();
    const res = await tool.execute(scopeFor(db), { project: 'kitchen' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const out = res.data as { project: { id: string } | null; ranked: { quote_id: string; rank: number; reasons: string[] }[]; excluded: { quote_id: string; reason: string }[]; summary: string; candidates: unknown[] };
    expect(out.project?.id).toBe('p-kitchen');
    expect(out.ranked.map((r) => r.quote_id)).toEqual(['q1', 'q2']);
    expect(out.ranked[0].reasons).toContain('Materials included');
    expect(out.excluded).toEqual([{ quote_id: 'q3', contractor_name: 'Waiting Co', reason: 'Still waiting for this quote' }]);
    expect(out.candidates).toEqual([]);
    expect(tool.summarize({ project: 'kitchen' }, out)).toBe(`Kitchen tap: ${out.summary}`);
    // The output honours the tool's own schema, so the executor will accept it.
    expect(tool.output.safeParse(out).success).toBe(true);
  });

  it('asks which project when several have quotes, and picks the only one when there is one', async () => {
    const db = seeded();
    const ambiguous = await tool.execute(scopeFor(db), {});
    expect(ambiguous.ok).toBe(true);
    if (!ambiguous.ok) return;
    const out = ambiguous.data as { project: unknown; ranked: unknown[]; candidates: { id: string; quote_count: number }[] };
    expect(out.project).toBeNull();
    expect(out.ranked).toEqual([]);
    expect(out.candidates.map((c) => [c.id, c.quote_count])).toEqual([['p-kitchen', 3], ['p-roof', 1]]);
    expect(tool.summarize({}, out)).toBe('2 projects have quotes — say which one to compare');

    db.replace('project_quotes', db.table('project_quotes').filter((q) => q.project_id !== 'p-roof'));
    const single = await tool.execute(scopeFor(db), {});
    expect(single.ok && (single.data as { project: { id: string } | null }).project?.id).toBe('p-kitchen');
  });

  it('never sees another family\'s quotes, even for a project with the same title', async () => {
    const db = seeded();
    const res = await tool.execute(scopeFor(db, OTHER), { project: 'Kitchen tap' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const out = res.data as { project: { id: string } | null; ranked: { quote_id: string }[] };
    expect(out.project?.id).toBe('p-other');
    expect(out.ranked.map((r) => r.quote_id)).toEqual(['q9']);
    const mine = await tool.execute(scopeFor(db), { project_id: 'p-other' });
    expect(mine.ok).toBe(false);
    if (!mine.ok) expect(mine.code).toBe('not_found');
  });

  it('fails closed when the quotes read fails, instead of ranking an empty list', async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const failing = {
        from: () => {
          const chain: Record<string, unknown> = {};
          const self = () => chain;
          Object.assign(chain, {
            select: self, eq: self, ilike: self, in: self, order: self, limit: self,
            then: (resolve: (v: unknown) => void) => resolve({ data: null, error: { code: '57P01', message: 'terminating connection', details: null, hint: null } }),
          });
          return chain;
        },
      } as unknown as SupabaseClient<Database>;
      const res = await tool.execute(scopeFor(failing), { project: 'kitchen' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('db');
      expect(errors.some((e) => String((e as unknown[])[0]).includes('[service:home]'))).toBe(true);
    } finally {
      console.error = original;
    }
  });
});
