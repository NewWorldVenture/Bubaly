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

/**
 * What to assume when the family's settings could NOT be read.
 *
 * A family with no settings row is legitimately permissive — the columns DEFAULT
 * to true/false (0094) — so DEFAULT_DASH_SETTINGS is the right answer for "no
 * row". It is the WRONG answer for "we could not find out": PostgREST resolves a
 * failed read with `{ data: null, error }`, so the two are indistinguishable
 * once the error is dropped, and defaulting then hands a child the customize
 * permission a parent may have turned off.
 *
 * The permission is the half that must close: no child customization. A
 * manager still passes `canCustomizeDashboard`, because locking a parent out of
 * their own dashboard is not what failing closed means — their save is refused
 * at the action, which re-reads the settings and reports an honest, retryable
 * error.
 *
 * `lockToFamilyDefault` stays FALSE, deliberately. It is not a permission —
 * 0325:81-87 classifies both flags as a product setting — it only decides which
 * saved layout is SHOWN, and assuming it true is not neutral: every member of a
 * family that never locked anything (the default) would be moved onto the
 * family layout for the page load, and a parent's Customize editor would open
 * seeded with the FAMILY keys, so their next Save would overwrite their own
 * layout with the family's. With it false, each member sees what an unlocked
 * family sees; in a genuinely locked family a member may briefly see their own
 * older personal layout, which is display only — a child cannot save it, and a
 * parent's personal save while locked writes a row that is never shown.
 *
 * A caller that can refuse outright should do that instead of assuming this.
 * This is for render paths that must still paint a page.
 */
export const CLOSED_DASH_SETTINGS: DashSettings = {
  allowChildCustomization: false,
  lockToFamilyDefault: false,
};

export type DashSettingsRead = {
  /** The rules to apply. Never the permissive default when the read failed. */
  settings: DashSettings;
  /**
   * True when the settings could NOT be read. A caller must not present these
   * values to anyone as the family's saved configuration — not as the prefilled
   * state of a parent's settings form, where one Save would persist a policy
   * nobody chose, and not as a caption claiming a parent set anything.
   */
  unknown: boolean;
};

/**
 * Turn a `family_dashboard_settings` read into the rules to apply.
 *
 * This exists because `{ data: null, error: null }` and `{ data: null, error }`
 * mean opposite things and look identical if the error is dropped: the first is
 * a family that never touched the setting (permissive by design), the second is
 * a statement timeout. Deciding from `data` alone turns the second into the
 * first and fails OPEN.
 */
export function readDashSettings(
  row: { allow_child_customization: boolean; lock_to_family_default: boolean } | null | undefined,
  error: unknown,
): DashSettingsRead {
  if (error) return { settings: CLOSED_DASH_SETTINGS, unknown: true };
  return {
    settings: normalizeSettings(
      row ? { allowChildCustomization: row.allow_child_customization, lockToFamilyDefault: row.lock_to_family_default } : null,
    ),
    unknown: false,
  };
}

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
