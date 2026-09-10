import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ReferralListRow as Referral } from './server';
import { rewardRecordFrom, rewardSideSettled } from './core';

type DB = SupabaseClient<Database>;
export type AdminReferralRow = Pick<Referral, 'id' | 'code' | 'referrer_family_id' | 'referred_email' | 'status' | 'referrer_reward_cents' | 'created_at' | 'metadata'>;
export type AdminReferralSummary = {
  total: number;
  converted: number;
  conversionRate: number | null;
  unconfirmedReferrerCents: number;
  recent: AdminReferralRow[];
  topReferrers: [string, number][];
  untilIso: string;
};

/** Complete current referral evidence; the recent table alone is bounded.
 * A recorded credit can fail after provider success, so absent receipts are
 * called unconfirmed, never proof that the provider still owes a payment. */
export async function loadAdminReferralSummary(db: DB, now = new Date()): Promise<
  { data: AdminReferralSummary; error: null } | { data: null; error: Error }
> {
  try {
    const untilIso = now.toISOString();
    const families = new Map<string, number>();
    let cursor = '', total = 0, converted = 0, unconfirmedReferrerCents = 0;
    let recent: AdminReferralRow[] = [];
    for (;;) {
      let query = db.from('referrals')
        .select('id, code, referrer_family_id, referred_email, status, referrer_reward_cents, created_at, metadata')
        .lte('created_at', untilIso).order('id', { ascending: true }).limit(500);
      if (cursor) query = query.gt('id', cursor);
      const { data, error } = await query;
      if (error || !Array.isArray(data)) throw new Error('Referral summary page unavailable');
      // Providers can impose a page size smaller than requested. Only an empty
      // page establishes completion; a nonadvancing cursor is a read failure.
      if (!data.length) break;
      for (const row of data) {
        if (!row.id || row.id <= cursor || !row.referrer_family_id || !Number.isFinite(Date.parse(row.created_at))) {
          throw new Error('Referral summary page did not advance or contained invalid evidence');
        }
        cursor = row.id;
        total += 1;
        families.set(row.referrer_family_id, (families.get(row.referrer_family_id) ?? 0) + 1);
        if (row.status === 'converted' || row.status === 'rewarded') converted += 1;
        if (row.status === 'converted' && !rewardSideSettled(rewardRecordFrom(row.metadata), 'referrer')) {
          if (!Number.isSafeInteger(row.referrer_reward_cents) || row.referrer_reward_cents < 0) {
            throw new Error('Referral reward amount unavailable');
          }
          unconfirmedReferrerCents += row.referrer_reward_cents;
          if (!Number.isSafeInteger(unconfirmedReferrerCents)) throw new Error('Referral reward total outside supported range');
        }
      }
      recent = [...recent, ...data].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id)).slice(0, 25);
    }
    const topReferrers = [...families.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
    return { data: { total, converted, conversionRate: total ? converted / total : null, unconfirmedReferrerCents, recent, topReferrers, untilIso }, error: null };
  } catch (cause) {
    console.error('[referrals/admin-summary] complete read failed', cause);
    return { data: null, error: new Error('Referral summary unavailable') };
  }
}
