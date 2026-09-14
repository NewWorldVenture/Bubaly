import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0310 is the real boundary: one Guardian number, one family, enforced by a
// unique index — the only thing that can see both families at once, because the
// write side is RLS-bound and scoped to one family by construction.
//
// This pins the code half, which matters for two reasons. F5 means migrations
// are not applied on merge here, so the routes reach production first. And 0310
// deliberately REPORTS duplicates rather than choosing which household loses
// its number, so a database that already holds a pair stays that way until a
// person decides — and until then these routes are the only thing standing
// between a duplicate and a silently dropped call.
//
// The defect was never the lookup. It was `{ data: memberProfile }` with the
// error dropped: `maybeSingle()` answers `data: null` plus PGRST116 on more
// than one row, so a FAILED lookup and an UNKNOWN NUMBER were the same
// observation — and the unknown-number branch tells Twilio 200, which consumes
// the event so nothing is ever retried.

const ROUTES = {
  voice: 'app/api/guardian/inbound/voice/route.ts',
  sms: 'app/api/guardian/inbound/sms/route.ts',
  whatsapp: 'app/api/guardian/inbound/whatsapp/route.ts',
};

/**
 * Comments are prose, not control flow. The voice route's guard explains in its
 * own comment that it must NOT call `markGuardianCallbackProcessed` — and a
 * literal search read that explanation as the call itself. This repo has made
 * that mistake before (a `process.env.X` inside a doc comment failed the
 * env-example test), so the scan strips comments first.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The slice from the profile lookup to the unknown-number branch. */
function lookupBlock(source: string): string {
  const start = source.indexOf("from('guardian_member_profiles')");
  expect(start, 'the profile lookup was not found').toBeGreaterThan(-1);
  const end = source.indexOf('if (!memberProfile)', start);
  expect(end, 'the unknown-number branch was not found').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('a failed Guardian lookup is not an unknown number', () => {
  for (const [name, path] of Object.entries(ROUTES)) {
    const source = readFileSync(path, 'utf8');
    const code = withoutComments(source);

    it(`${name} keeps the lookup error instead of dropping it`, () => {
      expect(source).toContain('error: profileError');
    });

    it(`${name} refuses BEFORE deciding the number is unknown`, () => {
      // Order is the whole point: after the unknown-number branch, the event
      // has already been answered 200 and marked processed.
      expect(lookupBlock(source)).toContain('if (profileError)');
    });

    it(`${name} answers 5xx so Twilio retries rather than consuming the event`, () => {
      const guard = lookupBlock(code).slice(lookupBlock(code).indexOf('if (profileError)'));
      expect(guard).toContain('503');
      // And it must NOT mark the callback processed on the way out — that is
      // exactly what makes the failure permanent.
      expect(guard, `${name} consumes the event on a failed lookup`)
        .not.toContain('markGuardianCallbackProcessed');
      // The voice route's finish() helper marks it too, so calling finish here
      // would be the same bug wearing a different name.
      expect(guard, `${name} routes a failed lookup through finish()`)
        .not.toMatch(/\breturn finish\(/);
    });

    it(`${name} logs the reason somewhere a person can find`, () => {
      const block = lookupBlock(source);
      expect(block.slice(block.indexOf('if (profileError)'))).toContain('console.error');
    });
  }

  it('the assign action surfaces the global clash as a correctable mistake', () => {
    // The action's own check is scoped to one family and runs RLS-bound, so it
    // cannot see another household's claim. 23505 from 0310's index is the only
    // signal it gets, and a generic failure would leave the parent re-typing a
    // number that can never work.
    const source = readFileSync('app/(app)/guardian/actions.ts', 'utf8');
    const upsert = source.slice(source.indexOf("from('guardian_member_profiles')\n    .upsert"));
    expect(upsert).toContain("error.code === '23505'");
    expect(upsert).toContain('uq_guardian_profiles_phone');
    expect(upsert).toContain("t('actions.thatNumberIsAlreadyAssigned')");
  });

  it('0310 reports duplicates rather than choosing which household loses its number', () => {
    const migration = readFileSync(
      'supabase/migrations/0310_a_guardian_number_belongs_to_one_family.sql', 'utf8');
    // Attempted, not forced: no delete, and the index is only created when the
    // data already satisfies it.
    expect(migration).toContain('raise warning');
    expect(migration).not.toMatch(/\bdelete\s+from\b/i);
    expect(migration).toContain('where guardian_phone is not null');
  });
});
