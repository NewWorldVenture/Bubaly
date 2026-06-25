// lib/dashboard/permissions.ts — pure rules for who may customize the dashboard
// and which saved layout applies. Family-level settings let a parent allow/deny
// child customization and optionally lock everyone to the family default.

export type DashSettings = {
  allowChildCustomization: boolean;
  lockToFamilyDefault: boolean;
};

export const DEFAULT_DASH_SETTINGS: DashSettings = {
  allowChildCustomization: true,
  lockToFamilyDefault: false,
};

/** Coerce a stored/partial settings object into a complete one. */
export function normalizeSettings(s: Partial<DashSettings> | null | undefined): DashSettings {
  return {
    allowChildCustomization: s?.allowChildCustomization ?? DEFAULT_DASH_SETTINGS.allowChildCustomization,
    lockToFamilyDefault: s?.lockToFamilyDefault ?? DEFAULT_DASH_SETTINGS.lockToFamilyDefault,
  };
}

/**
 * Can this member edit a PERSONAL dashboard layout?
 *  - When locked to the family default, only a parent/admin may change anything.
 *  - Otherwise children may customize only if the family allows it; parents always can.
 */
export function canCustomizeDashboard(isManager: boolean, settings: DashSettings): boolean {
  if (settings.lockToFamilyDefault) return isManager;
  if (!isManager && !settings.allowChildCustomization) return false;
  return true;
}

/** Only a parent/admin may set the family default or change these settings. */
export function canManageFamilyDashboard(isManager: boolean): boolean {
  return isManager;
}

/**
 * Which saved key list actually applies for a member: when locked to the family
 * default, the family layout wins regardless of any personal layout; otherwise
 * the personal layout takes precedence, then the family default, then null
 * (→ tier default).
 */
export function effectiveSavedKeys(
  myKeys: string[] | null | undefined,
  familyKeys: string[] | null | undefined,
  settings: DashSettings,
): string[] | null {
  if (settings.lockToFamilyDefault) return familyKeys ?? null;
  return myKeys ?? familyKeys ?? null;
}
