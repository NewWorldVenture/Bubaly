import 'server-only';
import { unstable_cache } from 'next/cache';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/server';
import { sanitizeSocialLinks, type SocialLinks } from '@/lib/marketing/social-links';

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
 * The configured links. A read failure degrades to "no links" rather than
 * taking the marketing footer down with it — an unreachable settings row is not
 * a reason to 500 the homepage.
 */
export async function getSocialLinks(supabase: DB): Promise<SocialLinks> {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  if (error) {
    console.error('[social-links] read failed', error);
    return {};
  }
  return sanitizeSocialLinks(data?.value);
}

/**
 * The same read, but throwing on failure instead of degrading to {}.
 *
 * This exists so the cache below can tell "the admin has configured nothing"
 * apart from "the database did not answer". They are the same value and very
 * different facts.
 */
async function readSocialLinksOrThrow(supabase: DB): Promise<SocialLinks> {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  if (error) throw error;
  return sanitizeSocialLinks(data?.value);
}

const cachedRead = unstable_cache(
  async (): Promise<SocialLinks> => readSocialLinksOrThrow(createServiceClient()),
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
 * The catch is OUTSIDE the cache on purpose. getSocialLinks degrades a failed
 * read to {}, which is right for rendering — but caching that would turn one
 * bad second into an hour of missing icons, and during a database incident
 * that is exactly when the read fails. Letting the error escape the cached
 * function means nothing is stored, so the next render tries again.
 */
export async function getCachedSocialLinks(): Promise<SocialLinks> {
  try {
    return await cachedRead();
  } catch (e) {
    console.error('[social-links] cached read failed', e);
    return {};
  }
}

/** Replaces the stored set. Blank/invalid entries are dropped, which is how an
 *  admin removes a link: clear the field and save. */
export async function setSocialLinks(supabase: DB, links: SocialLinks, updatedBy: string): Promise<SocialLinks> {
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
  return clean;
}
