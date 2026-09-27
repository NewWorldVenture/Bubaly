import 'server-only';
import { createHash } from 'node:crypto';
import { unstable_cache } from 'next/cache';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';
import { sanitizeSocialLinks, SOCIAL_PLATFORMS, type SocialLinks } from '@/lib/marketing/social-links';

// lib/server/social-links.ts — reading and writing the published social profiles.
//
// Stored in app_settings under one key, the same way feature tiers and the AI
// config are. The catalogue and the URL validation live in
// lib/marketing/social-links.ts so the admin form can share them.

type DB = SupabaseClient<Database>;
const KEY = 'social_links';

/** Cache tag, so an admin save can drop the cached copy immediately. */
export const SOCIAL_LINKS_TAG = 'social-links';

/**
 * The row's value exactly as stored, throwing on failure instead of degrading.
 *
 * This is the ONLY reader of the row, because "the admin has configured
 * nothing" and "the database did not answer" are the same value and very
 * different facts. Each caller decides what a failure means for it: the public
 * footer's cache below swallows it to {} for rendering, the admin console
 * refuses to render an editable form at all (see readSocialLinksSnapshot), and
 * a save refuses to write (see setSocialLinks).
 *
 * It returns the RAW value, not the sanitized links. The footer sanitizes it;
 * the admin form must not, because a stored `http://` URL that sanitizing drops
 * is still a stored URL, and a form that cannot show it would replace it on the
 * next Save without the operator ever having seen it.
 *
 * There used to be a second, exported `getSocialLinks` that degraded to {}, and
 * the admin page was the only thing that called it — the one caller for which
 * degrading is wrong. It is gone rather than left beside this one: an exported
 * reader that turns an outage into "nothing configured" is a loaded gun on a
 * page whose Save button replaces the whole stored object.
 */
async function readStoredOrThrow(supabase: DB): Promise<unknown> {
  // 1.5 s, for all three callers. Optional footer profiles must not hold the
  // whole public layout through database retry backoff, and the admin page must
  // not hang on it either. The same budget bounds the confirmation read inside
  // setSocialLinks, which is a deliberate tightening of the save path: a
  // database that cannot return one primary-key row in 1.5 s gets the save
  // REFUSED (nothing written, describeActionError's message, retry succeeds once
  // it answers) rather than a write that waited through backoff to replace a
  // value it could not confirm. A timeout always throws; each caller above
  // decides what that means.
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', KEY)
    .abortSignal(AbortSignal.timeout(1500)).maybeSingle();
  if (error) throw error;
  return data?.value;
}

/**
 * What the admin form shows for each platform: the stored string, whether or
 * not it would be published.
 *
 * Deliberately NOT sanitizeSocialLinks. A URL typed into the Supabase dashboard
 * as `http://…` is dropped by the footer and by the Organization schema, but it
 * is still in the row, and the form's Save replaces the whole row. Showing it —
 * the form marks it "Must be a full https:// URL to be published", and a save
 * that keeps it reports it as rejected — is what makes that replace one the
 * operator saw. Non-string values and unknown platform keys have no field to be
 * shown in; they are dropped by any save, as sanitizeSocialLinks always has.
 */
function editableSocialFields(stored: unknown): SocialLinks {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const fields: SocialLinks = {};
  for (const { key } of SOCIAL_PLATFORMS) {
    const value = (stored as Record<string, unknown>)[key];
    if (typeof value === 'string' && value !== '') fields[key] = value;
  }
  return fields;
}

/**
 * A fingerprint of what the admin form shows for a stored value, so a save can
 * prove which value it replaces.
 *
 * setSocialLinks replaces the whole jsonb column — there is no merge and
 * app_settings keeps no history (0023_admin_console.sql), so a form built on a
 * value it never actually read deletes everything it did not know about. The
 * admin page hands this to the form, the form posts it back, and the write
 * below refuses when the row no longer shows the same thing in any field.
 *
 * Taken over the editable fields rather than the sanitized links, so two rows
 * that differ only in an unpublishable URL do not share a fingerprint, and
 * serialised as JSON so no stored string (a newline typed into the dashboard,
 * say) can make two different rows canonicalise to the same text. What the save
 * returns is already clean, so the fingerprint of what it wrote is the
 * fingerprint of what the next read will show.
 */
export function socialLinksRevision(stored: unknown): string {
  const fields = editableSocialFields(stored);
  const canonical = JSON.stringify(SOCIAL_PLATFORMS.map(({ key }) => [key, fields[key] ?? null]));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** The stored links are not the ones the submitting form was shown. */
export class SocialLinksConflictError extends Error {
  readonly current: SocialLinks;
  constructor(current: SocialLinks) {
    super('social links changed since the form was loaded');
    this.name = 'SocialLinksConflictError';
    this.current = current;
  }
}

/**
 * What the admin console loaded, and whether it loaded at all.
 *
 * `{ ok: false }` is not "no links" — it is "we do not know", and the page must
 * not draw six empty inputs over it. Six blanks under a preview captioned
 * "Dimmed icons are using the default URL — save your own to replace them" says
 * in words that nothing is configured, and one Save on that screen used to
 * replace the stored object with {} and report "Social links updated".
 */
export type SocialLinksSnapshot =
  /** `fields` is what is stored per platform, published or not — see editableSocialFields. */
  | { ok: true; fields: SocialLinks; revision: string }
  | { ok: false; error: unknown };

export async function readSocialLinksSnapshot(supabase: DB): Promise<SocialLinksSnapshot> {
  try {
    const stored = await readStoredOrThrow(supabase);
    return { ok: true, fields: editableSocialFields(stored), revision: socialLinksRevision(stored) };
  } catch (error) {
    console.error('[social-links] admin read failed', error);
    return { ok: false, error };
  }
}

const cachedRead = unstable_cache(
  async (): Promise<SocialLinks> => sanitizeSocialLinks(await readStoredOrThrow(createServiceClient())),
  ['social-links'],
  { revalidate: 3600, tags: [SOCIAL_LINKS_TAG] },
);

/**
 * The links for the marketing footer, cached.
 *
 * The footer renders in the marketing layout, so it renders on EVERY public
 * page view — and this read was going to Postgres every single time. One row,
 * that changes when an admin edits it and not otherwise, was being fetched
 * once per page view across the whole public site.
 *
 * Cached under a tag rather than a short TTL so an admin edit is still visible
 * immediately: saveSocialLinksAction revalidates the tag, which drops this
 * entry on the spot. The hour is only a backstop for a write that happened
 * somewhere else (a direct row edit in the Supabase dashboard, say).
 *
 * The catch is OUTSIDE the cache on purpose. Degrading a failed read to {} is
 * right for rendering — but caching that would turn one bad second into an hour
 * of missing icons, and during a database incident that is exactly when the
 * read fails. Letting the error escape the cached function means nothing is
 * stored, so the next render tries again.
 */
export async function getCachedSocialLinks(): Promise<SocialLinks> {
  try {
    return await cachedRead();
  } catch (e) {
    console.error('[social-links] cached read failed', e);
    return {};
  }
}

/**
 * Replaces the stored set. Blank/invalid entries are dropped, which is how an
 * admin removes a link: clear the field and save.
 *
 * `expectedRevision` makes that a compare-and-set, because the replace is of the
 * WHOLE column. The current value is re-read HERE, server-side, rather than
 * trusted from the submission — the page is force-dynamic and a client can post
 * anything, and the submission that matters is one whose own read failed, which
 * arrives looking exactly like "the admin cleared every field".
 *
 * A failed re-read throws out of readStoredOrThrow and NOTHING is written.
 * That is deliberate and it is the point: a save that cannot confirm what it is
 * about to overwrite must not overwrite it. Degrading that read to {} here would
 * be the original defect moved one function deeper.
 *
 * app_settings keeps only the current value, so after a replace lands the value
 * it replaced — exactly as stored, unpublishable URLs included — goes to
 * audit_logs. That is the only undo there is for a deliberate total clear the
 * operator regrets. It is written through logAudit, which is best-effort and
 * loud: the links have already been replaced by then, and refusing to report a
 * save that happened because its history row did not land would be a lie in
 * the other direction.
 *
 * The row carries `via: 'site_admin'`, like every other write the admin console
 * makes (adminAuditLog in app/(app)/admin/actions.ts, the benchmarks export
 * route). /admin/audit and /admin/security classify rows on that marker: the
 * Scope filter, the red badge and the "site admin actions" count all read it.
 * Without it a super-admin replacing the SITE-WIDE links would be filed as
 * in-family activity. The marker is hardcoded here rather than passed in
 * because app_settings has no family scope and the super-admin console is the
 * only thing that can write this key.
 */
export async function setSocialLinks(
  supabase: DB,
  links: SocialLinks,
  updatedBy: string,
  expectedRevision: string,
): Promise<SocialLinks> {
  const stored = await readStoredOrThrow(supabase);
  if (socialLinksRevision(stored) !== expectedRevision) {
    throw new SocialLinksConflictError(editableSocialFields(stored));
  }

  const clean = sanitizeSocialLinks(links);
  const { error } = await supabase.from('app_settings').upsert(
    {
      key: KEY,
      value: clean as Database['public']['Tables']['app_settings']['Insert']['value'],
      updated_by: updatedBy,
    },
    { onConflict: 'key' },
  );
  if (error) throw error;

  await logAudit(supabase, {
    familyId: null,
    actorId: updatedBy,
    action: 'update',
    resource: 'app_settings',
    metadata: { key: KEY, previous: stored ?? null, saved: clean, via: 'site_admin' },
  });
  return clean;
}
