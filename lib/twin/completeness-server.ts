import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { graphCompleteness, type CompletenessSnapshot, type GraphCompleteness } from './completeness';

type DB = SupabaseClient<Database>;

/**
 * Read the household rows X7 scores over.
 *
 * `{ ok: false }` when ANY of them failed. A partial snapshot would produce a
 * confidently wrong score — "Bubaly doesn't know where home is" when in truth
 * the places table just did not answer — and the family would go and re-enter
 * data they already gave us. Fail closed; the card says so and offers a retry.
 */
export async function loadGraphCompleteness(
  sb: DB,
  familyId: string,
): Promise<{ ok: true; data: GraphCompleteness } | { ok: false }> {
  const [members, places, accounts, routines, classes, teams, providers, vehicles, pets] = await Promise.all([
    sb.from('family_members').select('id, display_name, birthday').eq('family_id', familyId).eq('is_active', true),
    sb.from('family_places').select('id').eq('family_id', familyId),
    sb.from('financial_accounts').select('id').eq('family_id', familyId),
    sb.from('family_routines').select('id, member_id').eq('family_id', familyId).eq('status', 'active'),
    sb.from('school_classes').select('id, member_id').eq('family_id', familyId),
    sb.from('teams').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
    sb.from('health_providers').select('id, member_id').eq('family_id', familyId),
    sb.from('vehicles').select('id, primary_driver').eq('family_id', familyId).is('deleted_at', null),
    sb.from('pets').select('id').eq('family_id', familyId).eq('is_active', true),
  ]);

  const readError = [members, places, accounts, routines, classes, teams, providers, vehicles, pets]
    .find((r) => r.error)?.error;
  if (readError) {
    console.error('[twin-completeness] household read failed', readError);
    return { ok: false };
  }

  const snapshot: CompletenessSnapshot = {
    members: (members.data ?? []).map((m) => ({ id: m.id, name: m.display_name, birthday: m.birthday })),
    places: places.data ?? [],
    accounts: accounts.data ?? [],
    routines: routines.data ?? [],
    classes: classes.data ?? [],
    teams: teams.data ?? [],
    providers: providers.data ?? [],
    vehicles: vehicles.data ?? [],
    pets: pets.data ?? [],
  };
  return { ok: true, data: graphCompleteness(snapshot) };
}
