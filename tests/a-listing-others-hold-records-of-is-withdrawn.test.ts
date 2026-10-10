import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, between, bodyOf } from './helpers/source-order';

// The held 0505 refuses a seller's hard delete of a listing other families hold
// records of (an order, an offer, a question, a bid, a negotiation, a report):
// the cascade would erase them. The marketplace module's Remove must meet that
// refusal by withdrawing the listing, which keeps every record, rather than
// reporting a failure the seller cannot act on. Before 0505 is released the
// refusal never comes and Remove deletes as it always has.

const MODULE = 'components/modules/marketplace-module.tsx';
const MIGRATION = 'supabase/reserved/0505_a_listing_others_hold_records_of_is_withdrawn_not_erased.sql';

describe("a listing other families hold records of is withdrawn, not erased", () => {
  const src = readFileSync(MODULE, 'utf8');
  const sql = readFileSync(MIGRATION, 'utf8');

  it("recognises 0505's own refusal, and only that", () => {
    const sentence = /raise exception '([^']+)'\s+using errcode = '42501'/.exec(sql)?.[1];
    expect(sentence).toBe('A listing other families hold records of is withdrawn, not removed');
    const pattern = /\/([^/]+)\/\.test\(err\.message/.exec(src.slice(at(src, 'function keptForOthersRecords')))?.[1];
    expect(pattern, 'keptForOthersRecords tests the message against a literal pattern').toBeTruthy();
    expect(new RegExp(pattern!).test(sentence!)).toBe(true);
    expect(bodyOf(src, 'function keptForOthersRecords', '\n}')).toContain("err.code === '42501'");
  });

  it('withdraws the kept listing before any other error is reported', () => {
    const remove = between(src, 'async function remove(', 'async function keepWithdrawn(');
    expect(at(remove, 'keptForOthersRecords(err)')).toBeLessThan(at(remove, 'toastError(describeDbError(err))'));
    expect(remove).toContain('await keepWithdrawn(l); return;');
  });

  it('keeps every record: withdraws, never deletes, and clears the photo it removed', () => {
    const keep = between(src, 'async function keepWithdrawn(', 'async function withdraw(');
    expect(keep).toContain("sb.rpc('marketplace_set_listing_status', { p_listing: l.id, p_status: 'withdrawn' })");
    expect(keep).not.toContain('.delete(');
    expect(keep).toContain(".update({ photo_url: null })");
    expect(keep).toContain(".eq('family_id', familyId).select('id')");
    // A listing already withdrawn or completed is not withdrawn again.
    expect(keep).toContain("l.status !== 'withdrawn' && l.status !== 'completed'");
  });

  it('says so in every language', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      expect(messages['marketplaceModule.keptAndWithdrawn'], locale).toBeTruthy();
      expect(messages['marketplaceModule.keptWithItsRecords'], locale).toBeTruthy();
    }
  });
});
