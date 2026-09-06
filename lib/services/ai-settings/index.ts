// Reading and writing the family's Bubaly settings (0257 `family_ai_settings`).
//
// The row is a preference, so the read is deliberately forgiving — a missing
// row, or a read that fails because the table is not there yet in a partially
// migrated environment, both answer the DEFAULTS rather than an error. The
// gate calls this on every tool execution; a settings hiccup must never be the
// reason a family's work stops, and the defaults are the cautious ones.
//
// The write is the opposite: manager-only, validated field by field, and
// stamped with who changed it. What a family may hand to an AI is exactly the
// kind of setting a child should not be able to widen.
import 'server-only';
import { isManager } from '@/lib/constants/roles';
import type { Database, Json } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import {
  DEFAULT_AI_SETTINGS, isBehavior, isRiskLevel, settingsFromRow,
  type AISettings, type RiskLevel,
} from '@/lib/ai/family-settings';
import type { AutonomyBehavior } from '@/lib/trust/engine';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

type Row = Database['public']['Tables']['family_ai_settings']['Row'];

/** The family's settings, or the defaults. Never fails: see the header. */
export async function getAISettings(scope: ServiceScope): Promise<AISettings> {
  return readAISettings(scope.db, scope.familyId);
}

/**
 * The same read for callers that hold a client and a family id but no
 * `ServiceScope` — the chat assistant's trust wrapper, which gates the tools a
 * family actually talks to and needs to know whether Bubaly is switched on.
 */
export async function readAISettings(
  db: ServiceScope['db'],
  familyId: string,
): Promise<AISettings> {
  const { data, error } = await db
    .from('family_ai_settings')
    .select('*')
    .eq('family_id', familyId)
    .maybeSingle();
  if (error) {
    console.error('[service:ai-settings] read failed; using defaults', error);
    return { familyId, ...DEFAULT_AI_SETTINGS };
  }
  return settingsFromRow(familyId, (data as Row | null) ?? null);
}

export type AISettingsPatch = {
  enabled?: boolean;
  behavior?: AutonomyBehavior;
  categoryBehavior?: Record<string, AutonomyBehavior>;
  riskOverrides?: Record<string, RiskLevel>;
  childChannels?: Record<string, boolean>;
  memoryEnabled?: boolean;
  quietHours?: { start: number; end: number } | null;
};

/** The longest night a family may declare. Beyond this it is a mute switch wearing a schedule's clothes. */
const MAX_QUIET_HOURS = 14;

function validate(patch: AISettingsPatch): string | null {
  if (patch.behavior !== undefined && !isBehavior(patch.behavior)) return 'That autonomy level is not one Bubaly offers.';
  for (const [domain, behavior] of Object.entries(patch.categoryBehavior ?? {})) {
    if (!isBehavior(behavior)) return `“${domain}” was given an autonomy level Bubaly does not offer.`;
  }
  for (const [tool, risk] of Object.entries(patch.riskOverrides ?? {})) {
    if (!isRiskLevel(risk)) return `“${tool}” was given a risk level Bubaly does not use.`;
  }
  const quiet = patch.quietHours;
  if (quiet) {
    const whole = (n: number) => Number.isInteger(n) && n >= 0 && n <= 23;
    if (!whole(quiet.start) || !whole(quiet.end)) return 'Quiet hours are whole hours between 0 and 23.';
    // A window has to leave a waking day on the other side of it. `{0, 23}`
    // passed the bounds check and is a 23-hour mute switch — legal to save,
    // impossible to notice, and with nothing in the product that would explain
    // why Bubaly had gone silent. Quiet hours are for a night, not for a life.
    if (quiet.start === quiet.end) return 'Quiet hours need a start and an end that differ.';
    const span = (quiet.end - quiet.start + 24) % 24;
    if (span > MAX_QUIET_HOURS) {
      return `Quiet hours can cover at most ${MAX_QUIET_HOURS} hours. To stop Bubaly entirely, switch it off above.`;
    }
  }
  return null;
}

/**
 * Save a manager's changes. Upserts, because 0257 backfills every family but a
 * row can still be missing in an environment where the migration has not run —
 * and a settings page that cannot save is worse than one that creates the row.
 */
export async function updateAISettings(scope: ServiceScope, patch: AISettingsPatch): Promise<ServiceResult<AISettings>> {
  if (!isManager(scope.role)) {
    return fail('Only a parent or adult can change what Bubaly may do.', { code: SERVICE_CODES.denied });
  }
  const invalid = validate(patch);
  if (invalid) return fail(invalid, { code: SERVICE_CODES.invalidInput });

  const row: Database['public']['Tables']['family_ai_settings']['Insert'] = { family_id: scope.familyId };
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  if (patch.behavior !== undefined) row.behavior = patch.behavior;
  if (patch.categoryBehavior !== undefined) row.category_behavior = patch.categoryBehavior as unknown as Json;
  if (patch.riskOverrides !== undefined) row.risk_overrides = patch.riskOverrides as unknown as Json;
  if (patch.childChannels !== undefined) row.child_channels = patch.childChannels as unknown as Json;
  if (patch.memoryEnabled !== undefined) row.memory_enabled = patch.memoryEnabled;
  if (patch.quietHours !== undefined) {
    row.quiet_hours_start = patch.quietHours?.start ?? null;
    row.quiet_hours_end = patch.quietHours?.end ?? null;
  }
  row.updated_by = scope.userId;

  const { data, error } = await scope.db
    .from('family_ai_settings')
    .upsert(row, { onConflict: 'family_id' })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:ai-settings] save failed', error);
    return fail(describeDbError(error, 'Could not save those settings.'), { code: SERVICE_CODES.db });
  }
  return ok(settingsFromRow(scope.familyId, data as Row));
}
