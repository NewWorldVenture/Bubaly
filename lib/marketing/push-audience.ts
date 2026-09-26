import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { selectPushRecipients } from '@/lib/marketing/push';

type DB = SupabaseClient<Database>;
const PAGE_SIZE = 200;
// A PostgREST `.in()` filter travels in the QUERY STRING, so the id list is
// bounded separately from the row page. lib/supabase/chunked-in.ts settled on
// 100 ids per request because that "keeps the longest URL near 4 KB, well
// inside the common 8 KB limit"; reusing PAGE_SIZE here would put ~200 UUIDs at
// roughly 40 bytes each into one request line, which is the 8 KB limit itself
// rather than a margin under it. Past it the read comes back `URI too long`,
// and this module turns an incomplete read into a refusal — so the whole
// campaign would stop, at exactly the audience size that makes it matter.
const ID_CHUNK = 100;
const MAX_READ_ROWS = 50_000;
const MAX_READ_REQUESTS = 1_000;
// Match the existing marketing email audience's conservative address format.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type ReadBudget = { rows: number; requests: number };

/** A short page can be the Data API's response cap, so only an empty page ends traversal. */
async function readPages<T>(
  load: (cursor: string | null) => PromiseLike<{ data: T[] | null; error: unknown }>,
  rowKey: (row: T) => unknown,
  budget: ReadBudget,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    if (++budget.requests > MAX_READ_REQUESTS) throw new Error('Marketing push audience exceeds the 1,000-request read limit. No campaign push was sent.');
    const result = await load(cursor);
    if (result.error || !Array.isArray(result.data)) throw new Error(`Could not completely load marketing push ${label}. No campaign push was sent.`);
    budget.rows += result.data.length;
    if (budget.rows > MAX_READ_ROWS) throw new Error('Marketing push audience exceeds the 50,000-row read limit. No campaign push was sent.');
    if (result.data.length === 0) return rows;
    for (const row of result.data) {
      const key = rowKey(row);
      if (typeof key !== 'string' || !key.trim() || seen.has(key)) throw new Error(`Invalid or repeated marketing push ${label} page key. No campaign push was sent.`);
      seen.add(key);
      rows.push(row);
      // Keep the database's raw key/collation. Normalizing an email cursor can
      // skip mixed-case or whitespace-bearing suppression rows.
      cursor = key;
    }
  }
}

/** Resolve the entire bounded audience before the sender reads consent or contacts any device. */
export async function loadPushCampaignAudience(supabase: DB): Promise<string[]> {
  const budget: ReadBudget = { rows: 0, requests: 0 };
  const devices = await readPages(cursor => {
    let query = supabase.from('push_devices').select('id, user_id')
      .eq('enabled', true).order('id', { ascending: true }).limit(PAGE_SIZE);
    if (cursor !== null) query = query.gt('id', cursor);
    return query;
  }, row => row.id, budget, 'devices');

  const userIds = new Set<string>();
  for (const device of devices) {
    if (typeof device.user_id !== 'string' || !device.user_id.trim()) throw new Error('A marketing push device has no verifiable owner. No campaign push was sent.');
    userIds.add(device.user_id);
  }
  if (userIds.size === 0) return [];

  const uniqueIds = [...userIds];
  const emailByUser: Record<string, string | null> = Object.create(null);
  for (let offset = 0; offset < uniqueIds.length; offset += ID_CHUNK) {
    const chunk = uniqueIds.slice(offset, offset + ID_CHUNK);
    const wanted = new Set(chunk);
    const profiles = await readPages(cursor => {
      let query = supabase.from('profiles').select('id, email')
        .in('id', chunk).order('id', { ascending: true }).limit(PAGE_SIZE);
      if (cursor !== null) query = query.gt('id', cursor);
      return query;
    }, row => row.id, budget, 'profiles');
    for (const profile of profiles) {
      if (!wanted.has(profile.id) || (profile.email !== null && (typeof profile.email !== 'string' || !EMAIL_RE.test(profile.email.trim())))) {
        throw new Error('A marketing push profile has no verifiable email preference. No campaign push was sent.');
      }
      // An explicit stored null is supported for phone-only accounts. A missing
      // profile/column is an incomplete read, never equivalent to that null.
      emailByUser[profile.id] = profile.email;
    }
    if (chunk.some(id => !Object.hasOwn(emailByUser, id))) throw new Error('A marketing push recipient profile is missing. No campaign push was sent.');
  }

  const suppressions = await readPages(cursor => {
    let query = supabase.from('marketing_suppressions').select('email')
      .order('email', { ascending: true }).limit(PAGE_SIZE);
    if (cursor !== null) query = query.gt('email', cursor);
    return query;
  }, row => row.email, budget, 'suppressions');

  return selectPushRecipients(uniqueIds, emailByUser, suppressions.map(row => row.email));
}
