import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { sanitizeSocialLinks, type SocialLinks } from '@/lib/marketing/social-links';

// lib/server/social-links.ts — reading and writing the published social profiles.
//
// Stored in app_settings under one key, the same way feature tiers and the AI
// config are. The catalogue and the URL validation live in
// lib/marketing/social-links.ts so the admin form can share them.

type DB = SupabaseClient<Database>;
const KEY = 'social_links';

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
