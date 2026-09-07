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
 */
export const getCachedSocialLinks = unstable_cache(
  async (): Promise<SocialLinks> => getSocialLinks(createServiceClient()),
  ['social-links'],
  { revalidate: 3600, tags: [SOCIAL_LINKS_TAG] },
);

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
