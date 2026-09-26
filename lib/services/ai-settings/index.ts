// Reading and writing the family's Bubaly settings (0257 `family_ai_settings`).
//
// There are TWO kinds of read of the same row, because two kinds of caller need
// different answers when the read fails:
//
//  - `loadAISettings` / `loadAISettingsFor` are the STRICT read. A missing row
//    is still the defaults — that is genuinely what applies to a family that
//    never saved one — but a read that FAILED answers an error. Every caller
//    that ENFORCES one of the family's opt-outs must use it and fail closed on
//    that error, because the defaults are "Bubaly on, `execute`, memory on":
//    handing them to an enforcing caller turned a family's "switch Bubaly off"
//    or "don't remember" back on for as long as the failure lasted (SEC-009).
//    The enforcing callers today: the tool gate (lib/ai/tools/execute.ts), the
//    shared AI gate for chat, Magic Import and the school desk
//    (lib/trust/ai-gate.ts), the routine cron
//    (app/api/cron/family-routines/route.ts), the speaker capture
//    (lib/assistant/service.ts), the concierge autopilot
//    (app/(app)/dashboard/concierge/actions.ts), the memory write path
//    (lib/services/memory), the memory recall tool and context slice
//    (lib/ai/tools/memory.ts, lib/ai/context/slices/memory.ts) and onboarding's
//    remembered answers (lib/onboarding/remember.ts). The settings page reads
//    it too: the defaults are not this family's settings, and presenting them
//    as if they were told a family that had switched Bubaly off that it was on.
//
//  - `getAISettings` is the FORGIVING read: a failed read answers the defaults.
//    It is only for a caller whose answer SHAPES something that an enforcing
//    caller checks again, or whose failure mode is a documented decision:
//    the planner (the plan it shapes is executed through the tool gate, which
//    re-reads strictly) and quiet hours in lib/services/notifications (fail
//    open by decision: a late-night notice beats a lost one). A new caller that
//    decides whether Bubaly may ACT, REMEMBER or USE what it remembers does not
//    belong here.
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

type SettingsRead = { ok: true; settings: AISettings } | { ok: false; error: unknown };

async function querySettings(db: ServiceScope['db'], familyId: string): Promise<SettingsRead> {
  const { data, error } = await db
    .from('family_ai_settings')
    .select('*')
    .eq('family_id', familyId)
    .maybeSingle();
  if (error) return { ok: false, error };
  return { ok: true, settings: settingsFromRow(familyId, (data as Row | null) ?? null) };
}

/**
 * The family's settings, or the defaults when the read failed. See the header:
 * ONLY for callers that shape rather than enforce — never for one that decides
 * whether Bubaly may act, remember, or use what it remembers.
 */
export async function getAISettings(scope: ServiceScope): Promise<AISettings> {
  const read = await querySettings(scope.db, scope.familyId);
  if (!read.ok) {
    console.error('[service:ai-settings] read failed; shaping with the defaults', read.error);
    return { familyId: scope.familyId, ...DEFAULT_AI_SETTINGS };
  }
  return read.settings;
}

/**
 * The family's settings — or an error when the read failed. See the header:
 * this is the read that must not pass the defaults off as the family's own
 * answer, and the one every caller enforcing an opt-out uses.
 */
export async function loadAISettings(scope: ServiceScope): Promise<ServiceResult<AISettings>> {
  return loadAISettingsFor(scope.db, scope.familyId);
}

/**
 * `loadAISettings` for callers that hold a client and a family id but no
 * `ServiceScope` — the shared AI gate and the speaker assistant.
 */
export async function loadAISettingsFor(
  db: ServiceScope['db'],
  familyId: string,
): Promise<ServiceResult<AISettings>> {
  const read = await querySettings(db, familyId);
  if (!read.ok) {
    console.error('[service:ai-settings] read failed', read.error);
    return fail(describeDbError(read.error, 'Could not load your Bubaly settings.'), { code: SERVICE_CODES.db, retryable: true });
  }
  return ok(read.settings);
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
