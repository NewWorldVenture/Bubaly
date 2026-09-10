import 'server-only';
import type { Json } from '@/lib/database.types';
import { getTranslations } from '@/lib/i18n/server';
import { DEFAULT_SIDEBAR_NAV_KEYS, ALL_SERVICES_KEYS } from '@/lib/constants/navigation';
import { resolveNavKeys, sanitizeNavKeys, sanitizeChildMap, SIDEBAR_NAV_PREF_KEY, SIDEBAR_NAV_CHILDREN_PREF_KEY, type NavChildMap } from '@/lib/navigation/customize';
import { outcomeNavigationPreset } from '@/lib/outcomes/navigation-preset';
import { fail, ok, SERVICE_CODES, type ServiceScope, type ServiceResult } from '@/lib/services/types';

export type SidebarPrefs = { nav: string[] | null; children: NavChildMap | null };
export type NavigationInput = { keys: string[]; children?: NavChildMap } | { preset: 'outcomes' };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function extract(prefs: Record<string, unknown>): SidebarPrefs {
  const nav = prefs[SIDEBAR_NAV_PREF_KEY];
  const children = prefs[SIDEBAR_NAV_CHILDREN_PREF_KEY];
  return { nav: Array.isArray(nav) ? nav.filter((value): value is string => typeof value === 'string') : null,
    children: children && typeof children === 'object' && !Array.isArray(children) ? sanitizeChildMap(children) : null };
}
async function unavailable() { return fail((await getTranslations())('outcomeDiscovery.navigationUnavailable'), { code: SERVICE_CODES.db, retryable: true }); }

export async function loadSidebarNavigation(scope: ServiceScope): Promise<ServiceResult<SidebarPrefs>> {
  if (!scope.userId || scope.actorKind !== 'member') return unavailable();
  try {
    const result = await scope.db.from('user_preferences').select('notification_prefs').eq('user_id', scope.userId).maybeSingle();
    if (result.error) throw result.error;
    return ok(extract(record(result.data?.notification_prefs)));
  } catch (error) {
    console.error('[service:navigation] preference read failed', error);
    return unavailable();
  }
}

export async function saveSidebarNavigation(scope: ServiceScope, input: NavigationInput): Promise<ServiceResult<SidebarPrefs>> {
  if (!scope.userId || scope.actorKind !== 'member') return unavailable();
  try {
    const existing = await scope.db.from('user_preferences').select('notification_prefs, updated_at').eq('user_id', scope.userId).maybeSingle();
    if (existing.error) throw existing.error;
    const prefs = record(existing.data?.notification_prefs);
    const keys = 'preset' in input
      ? outcomeNavigationPreset(resolveNavKeys(prefs[SIDEBAR_NAV_PREF_KEY], DEFAULT_SIDEBAR_NAV_KEYS, ALL_SERVICES_KEYS))
      : sanitizeNavKeys(input.keys);
    if (!keys) return fail((await getTranslations())('outcomeDiscovery.navigationFull'), { code: SERVICE_CODES.invalidInput });
    const merged: Record<string, unknown> = { ...prefs, [SIDEBAR_NAV_PREF_KEY]: keys };
    if ('children' in input && input.children !== undefined) merged[SIDEBAR_NAV_CHILDREN_PREF_KEY] = sanitizeChildMap(input.children);
    // Guard the read/merge against another device changing notification
    // preferences in between; a failed match asks the caller to retry.
    if (existing.data) {
      if (!existing.data.updated_at) return unavailable();
      const saved = await scope.db.from('user_preferences').update({ notification_prefs: merged as Json })
        .eq('user_id', scope.userId).eq('updated_at', existing.data.updated_at).select('user_id').maybeSingle();
      if (saved.error) throw saved.error;
      if (!saved.data) return unavailable();
    } else {
      const saved = await scope.db.from('user_preferences').insert({ user_id: scope.userId, notification_prefs: merged as Json });
      if (saved.error) throw saved.error;
    }
    return ok(extract(merged));
  } catch (error) {
    console.error('[service:navigation] preference read or save failed', error);
    return unavailable();
  }
}
