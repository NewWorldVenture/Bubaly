import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { hasMarketingPushConsent, MARKETING_PUSH_EXCLUDED_ROLES, selectPushRecipients } from '@/lib/marketing/push';
import { ROLE_ORDER, isManager } from '@/lib/constants/roles';
import { ageOnDay } from '@/lib/members/age';
import { isChildLoginEmail } from '@/lib/onboarding/child-login';

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
/** A member whose recorded birthday says they are younger than this is a minor, whatever role the row now carries. */
const ADULT_AGE = 18;
/** The excluded roles, as the member_role values an invite carries. */
const MINOR_ROLES = ROLE_ORDER.filter(role => MARKETING_PUSH_EXCLUDED_ROLES.includes(role));
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

  // A kid login's account is a child's whatever its member row now says:
  // removal drops the row to `guest` (REMOVED_MEMBER_PATCH), and the synthetic
  // address it signs in with is what still says whose it is.
  const selected = selectPushRecipients(uniqueIds, emailByUser, suppressions.map(row => row.email))
    .filter(id => !isChildLoginEmail(emailByUser[id]));
  return consentingAdults(supabase, selected, budget);
}

/**
 * Keep only accounts that explicitly opted in to marketing push, hold no
 * child or teen membership in any family (by its role, by the birthday the
 * family recorded on it, or by the role of the invite they joined it by), and
 * are not left only with families that closed their account.
 *
 * The device table says who CAN be reached, not who agreed to marketing: a
 * child with the app installed was in the audience because their family left
 * push on, and the only way out was to turn off all push, including the
 * family's own notices. Closing an account (families.closed_at) leaves its
 * devices enabled, and the email campaign and the automation runner already
 * leave closed families out; a member of an open family stays in. Only an
 * ACTIVE membership makes an account a member of a family: removing someone
 * deactivates their row (REMOVED_MEMBER_PATCH) and does not delete it, so an
 * account whose own family closed stayed in through an old row in a family it
 * was removed from, while the email side counts only active members. Read
 * completely before dispatch, on the same budget; an incomplete read throws,
 * so a refused read sends nothing.
 */
async function consentingAdults(supabase: DB, userIds: string[], budget: ReadBudget): Promise<string[]> {
  const consented = new Set<string>();
  const minors = new Set<string>();
  /** Accounts with an active membership, and those with one in a family still open. */
  const members = new Set<string>();
  const inOpenFamily = new Set<string>();
  // The earliest calendar day anywhere (UTC-12): an account counts as grown up
  // only once its 18th birthday has come in every zone, so no family zone is
  // needed, and a day late is the safe way to be wrong.
  const earliestDay = new Date(Date.now() - 12 * 3_600_000).toISOString().slice(0, 10);
  for (let offset = 0; offset < userIds.length; offset += ID_CHUNK) {
    const chunk = userIds.slice(offset, offset + ID_CHUNK);
    const preferences = await readPages(cursor => {
      let query = supabase.from('user_preferences').select('user_id, notification_prefs')
        .in('user_id', chunk).order('user_id', { ascending: true }).limit(PAGE_SIZE);
      if (cursor !== null) query = query.gt('user_id', cursor);
      return query;
    }, row => row.user_id, budget, 'consent');
    for (const row of preferences) if (hasMarketingPushConsent(row.notification_prefs)) consented.add(row.user_id);
    // Every membership, active or not: a removed child is still a child. Each
    // with its family's closure, joined on the foreign key (a membership has
    // exactly one family), and the birthday the family recorded: removal
    // writes REMOVED_MEMBER_PATCH, which drops a teen's row to `guest`, so the
    // role alone left a teen removed through the app in the audience
    // (R3-AW-REMOVED-MINOR-PUSH). The birthday is kept.
    const memberships = await readPages(cursor => {
      let query = supabase.from('family_members').select('id, family_id, user_id, role, birthday, is_active, family:families!inner(closed_at)')
        .in('user_id', chunk).order('id', { ascending: true }).limit(PAGE_SIZE);
      if (cursor !== null) query = query.gt('id', cursor);
      return query;
    }, row => row.id, budget, 'member roles');
    /** By `<user>:<family>`: whether the family has since said this member is grown up (made them a parent or an adult, or recorded an 18th birthday). */
    const grownUpIn = new Map<string, boolean>();
    for (const row of memberships) {
      if (typeof row.user_id !== 'string') continue;
      const age = ageOnDay(row.birthday, earliestDay);
      if (MARKETING_PUSH_EXCLUDED_ROLES.includes(String(row.role)) || (age !== null && age < ADULT_AGE)) minors.add(row.user_id);
      grownUpIn.set(`${row.user_id}:${row.family_id}`, isManager(row.role) || (age !== null && age >= ADULT_AGE));
      // A family the account was removed from is not one of its families.
      if (!row.is_active) continue;
      members.add(row.user_id);
      // A family that was not returned with the row is not known to be open.
      const family = row.family as { closed_at?: unknown } | null;
      if (family && family.closed_at === null) inOpenFamily.add(row.user_id);
    }
    // R4-AW-REMOVED-TEEN-OWN-ADDRESS. A teen who signs in with their own
    // address, and whose family recorded no birthday, was left with nothing
    // that said so once removed: the row is `guest` by then. The invite they
    // joined by still does. accept_invite (0136) keeps its role and records
    // who accepted it, and nothing deletes one. So an invite accepted at a
    // minor's role marks the account a minor, unless the family has since said
    // otherwise on the row it put them in: a parent's or an adult's role (a
    // teen made an adult), or a recorded birthday 18 years back. A `guest` row
    // does not say so: removal writes it, and accept_invite brings a removed
    // member back at it, whatever the new invite's role. Read only for the
    // accounts still in, so the read costs the shared budget nothing for a
    // chunk no one in it consented. R5-AW-REVOKED-ACCEPTED-INVITE: by who
    // accepted it, whatever its status says now. Only accept_invite writes
    // accepted_by, and 0482 keeps a client from changing it; the super
    // admin's Revoke overwrote an accepted invite's status to 'revoked' with
    // accepted_by kept (now refused, but rows it wrote stand), and a read by
    // status let that teen back in.
    const undecided = chunk.filter(id => consented.has(id) && !minors.has(id));
    const joinedAsMinors = undecided.length === 0 ? [] : await readPages(cursor => {
      let query = supabase.from('invites').select('id, family_id, accepted_by')
        .in('accepted_by', undecided).in('role', MINOR_ROLES)
        .order('id', { ascending: true }).limit(PAGE_SIZE);
      if (cursor !== null) query = query.gt('id', cursor);
      return query;
    }, row => row.id, budget, 'accepted invites');
    for (const invite of joinedAsMinors) {
      if (typeof invite.accepted_by === 'string' && !grownUpIn.get(`${invite.accepted_by}:${invite.family_id}`)) minors.add(invite.accepted_by);
    }
  }
  return userIds.filter(id => consented.has(id) && !minors.has(id) && (!members.has(id) || inOpenFamily.has(id)));
}
