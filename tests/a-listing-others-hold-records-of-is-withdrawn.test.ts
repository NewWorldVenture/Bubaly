import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { between } from './helpers/source-order';
import {
  ALREADY_KEPT, KEPT_FOR_OTHERS_RECORDS, keptForOthersRecords, removeListing, type RemoveListingDeps,
} from '@/lib/marketplace/remove-listing';

// The held 0505 refuses a seller's hard delete of a listing other families hold
// records of (an order, an offer, a question, a bid, a negotiation, a report):
// the cascade would erase them. Remove must meet that refusal by withdrawing the
// listing, which keeps every record, and must not lose the listing's photo on
// the way: the photo goes only once the row is really gone. Whether a kept
// listing still needs withdrawing is decided by the server from the row as it
// is now (0317's locked status change), not by the screen's copy. Before 0505
// is released the refusal never comes and Remove deletes as it always has.

const MODULE = 'components/modules/marketplace-module.tsx';
const MIGRATION = 'supabase/reserved/0505_a_listing_others_hold_records_of_is_withdrawn_not_erased.sql';
const STATUS_RPC = 'supabase/migrations/0317_listing_status_decides_from_a_locked_row.sql';

const refusal = { code: '42501', message: 'A listing other families hold records of is withdrawn, not removed' };
const PHOTO = 'https://x.supabase.co/storage/v1/object/public/marketplace-photos/u1/1700000000000-bike.jpg';

/** A fake database: which delete answer it gives, which status the row has NOW, and what the photo store does. */
function fake(opts: {
  deleteAnswer: 'refused' | 'removed' | 'filtered' | 'other-error';
  statusNow?: string;
  withdrawFailsWith?: string;
  photoFails?: boolean;
}) {
  const calls: string[] = [];
  let status = opts.statusNow ?? 'available';
  let photoStored = true;
  const deps: RemoveListingDeps = {
    deleteRow: vi.fn(async () => {
      calls.push('delete');
      if (opts.deleteAnswer === 'refused') return { data: null, error: refusal };
      if (opts.deleteAnswer === 'other-error') return { data: null, error: { code: '23503', message: 'fk' } };
      if (opts.deleteAnswer === 'filtered') return { data: [], error: null };
      return { data: [{ id: 'l1', photo_url: PHOTO }], error: null };
    }),
    withdraw: vi.fn(async () => {
      calls.push('withdraw');
      if (opts.withdrawFailsWith) return { error: { message: opts.withdrawFailsWith } };
      // 0317: decided from the row as it is now, under its lock.
      if (status === 'withdrawn' || status === 'completed') {
        return { error: { message: `Cannot move listing from ${status} to withdrawn` } };
      }
      status = 'withdrawn';
      return { error: null };
    }),
    removePhoto: vi.fn(async (url: string) => {
      calls.push(`photo:${url}`);
      if (opts.photoFails) return { error: 'storage down' };
      photoStored = false;
      return { error: null };
    }),
  };
  return { deps, calls, status: () => status, photoStored: () => photoStored };
}

describe("a listing other families hold records of is withdrawn, not erased, and keeps its photo", () => {
  it('a refused delete withdraws the listing and never touches its photo', async () => {
    const f = fake({ deleteAnswer: 'refused' });
    await expect(removeListing(f.deps)).resolves.toEqual({ kind: 'withdrawn' });
    expect(f.calls).toEqual(['delete', 'withdraw']);
    expect(f.photoStored()).toBe(true);
    expect(f.status()).toBe('withdrawn');
  });

  it('a withdrawal that fails reports the failure and still keeps the photo', async () => {
    const f = fake({ deleteAnswer: 'refused', withdrawFailsWith: 'Only the listing owner can change this listing' });
    const out = await removeListing(f.deps);
    expect(out.kind).toBe('error');
    expect(f.calls).toEqual(['delete', 'withdraw']);
    expect(f.photoStored()).toBe(true);
  });

  it('a listing the screen saw as withdrawn but another tab relisted is withdrawn, not reported as kept', async () => {
    // The screen's copy says withdrawn; the row now says available.
    const f = fake({ deleteAnswer: 'refused', statusNow: 'available' });
    await expect(removeListing(f.deps)).resolves.toEqual({ kind: 'withdrawn' });
    expect(f.status()).toBe('withdrawn');
  });

  it('a listing already withdrawn or completed is reported as kept, with nothing changed', async () => {
    for (const statusNow of ['withdrawn', 'completed']) {
      const f = fake({ deleteAnswer: 'refused', statusNow });
      await expect(removeListing(f.deps), statusNow).resolves.toEqual({ kind: 'already_kept' });
      expect(f.status()).toBe(statusNow);
      expect(f.photoStored()).toBe(true);
    }
  });

  it('a listing nobody dealt with is deleted, and then the photo its removed row named', async () => {
    const f = fake({ deleteAnswer: 'removed' });
    await expect(removeListing(f.deps)).resolves.toEqual({ kind: 'removed' });
    expect(f.calls).toEqual(['delete', `photo:${PHOTO}`]);
    expect(f.photoStored()).toBe(false);
  });

  it('a removed listing whose photo cannot be deleted says so', async () => {
    const f = fake({ deleteAnswer: 'removed', photoFails: true });
    await expect(removeListing(f.deps)).resolves.toEqual({ kind: 'removed_photo_left', error: 'storage down' });
  });

  it('a filtered delete or any other error changes nothing, photo included', async () => {
    for (const deleteAnswer of ['filtered', 'other-error'] as const) {
      const f = fake({ deleteAnswer });
      const out = await removeListing(f.deps);
      expect(out.kind, deleteAnswer).toBe(deleteAnswer === 'filtered' ? 'not_saved' : 'error');
      expect(f.calls, deleteAnswer).toEqual(['delete']);
      expect(f.photoStored()).toBe(true);
    }
  });

  it("recognises 0505's own refusal, and only that", () => {
    const sentence = /raise exception '([^']+)'\s+using errcode = '42501'/.exec(readFileSync(MIGRATION, 'utf8'))?.[1];
    expect(sentence).toBe(refusal.message);
    expect(KEPT_FOR_OTHERS_RECORDS.test(sentence!)).toBe(true);
    expect(keptForOthersRecords({ code: '42501', message: sentence })).toBe(true);
    expect(keptForOthersRecords({ code: '23503', message: sentence })).toBe(false);
    expect(keptForOthersRecords({ code: '42501', message: 'permission denied for table marketplace_listings' })).toBe(false);
  });

  it("reads 0317's refusal the way 0317 words it", () => {
    expect(readFileSync(STATUS_RPC, 'utf8')).toContain("raise exception 'Cannot move listing from % to %', v_listing.status, p_status;");
    expect(ALREADY_KEPT.test('Cannot move listing from withdrawn to withdrawn')).toBe(true);
    expect(ALREADY_KEPT.test('Cannot move listing from completed to withdrawn')).toBe(true);
    expect(ALREADY_KEPT.test('Cannot move listing from claimed to pending')).toBe(false);
  });

  it('the module removes through removeListing, reading the removed row back', () => {
    const src = readFileSync(MODULE, 'utf8');
    const remove = between(src, 'async function remove(', 'async function withdraw(');
    expect(remove).toContain('const outcome = await removeListing({');
    expect(remove).toContain(".eq('id', l.id).eq('family_id', familyId).select('id, photo_url')");
    expect(remove).toContain("sb.rpc('marketplace_set_listing_status', { p_listing: l.id, p_status: 'withdrawn' })");
    // No decision about the photo or the status is taken before the outcome.
    expect(remove).not.toContain('l.photo_url');
    expect(remove).not.toContain('l.status');
    expect(remove).not.toContain('.update(');
  });

  it('says so in every language', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      for (const key of ['marketplaceModule.keptAndWithdrawn', 'marketplaceModule.keptWithItsRecords', 'marketplaceModule.removedButPhotoLeft']) {
        expect(messages[key], `${locale} ${key}`).toBeTruthy();
      }
    }
  });
});
