// The family's own answer to "what may Bubaly do without asking?" — one row
// (0257 `family_ai_settings`), read by the tool gate, the planner and the
// Settings → Bubaly AI tab.
//
// TWO RULES THIS FILE EXISTS TO KEEP:
//
//  1. A missing row is the DEFAULTS, never "anything goes". Every reader gets
//     a fully-populated object, so no call site has to decide what absent
//     means — and the defaults are the cautious ones (`prepare`: Bubaly gets
//     the work ready and a person says go).
//
//  2. A risk override may RAISE a tool's tier and may only lower it where
//     lowering is safe. Money and documents (§12, D17) keep `medium` as their
//     floor no matter what the row says, so a mis-set — or maliciously set —
//     override cannot make a transfer as cheap as adding a note.
import type { Database, Json } from '@/lib/database.types';
import type { AutonomyBehavior } from '@/lib/trust/engine';
import { HIGH_STAKES_AI_DOMAINS } from '@/lib/trust/engine';

export type RiskLevel = 'low' | 'medium' | 'high';

export type AISettings = {
  familyId: string;
  /** False turns Bubaly's autonomous work off entirely; requests still answer, nothing executes unasked. */
  enabled: boolean;
  /** The whole-family default when a category says nothing (see DEFAULT_AI_SETTINGS). */
  behavior: AutonomyBehavior;
  /** Per trust domain, e.g. `{ meals: 'execute', finances: 'recommend' }`. */
  categoryBehavior: Record<string, AutonomyBehavior>;
  /** Per tool name, e.g. `{ 'calendar.createEvent': 'high' }`. */
  riskOverrides: Record<string, RiskLevel>;
  /** How Bubaly may reach a child directly. */
  childChannels: Record<string, boolean>;
  /** §2's opt-out: when false nothing is remembered. */
  memoryEnabled: boolean;
  quietHours: { start: number; end: number } | null;
};

const BEHAVIORS: readonly AutonomyBehavior[] = ['recommend', 'prepare', 'execute'];
const RISKS: readonly RiskLevel[] = ['low', 'medium', 'high'];

/**
 * The defaults are today's shipped behaviour, not a new stance: `execute`
 * contributes nothing to the gate on its own (the role matrix still guards
 * sensitive domains and `high` risk still needs a person), so a family that
 * has never opened the settings page sees exactly what it saw before 0257.
 * Tightening to `prepare` or `recommend` is a choice a parent makes.
 */
export const DEFAULT_AI_SETTINGS: Omit<AISettings, 'familyId'> = {
  enabled: true,
  behavior: 'execute',
  categoryBehavior: {},
  riskOverrides: {},
  childChannels: {},
  memoryEnabled: true,
  quietHours: null,
};

export function isBehavior(value: unknown): value is AutonomyBehavior {
  return typeof value === 'string' && (BEHAVIORS as readonly string[]).includes(value);
}

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === 'string' && (RISKS as readonly string[]).includes(value);
}

function behaviorMap(value: Json | null | undefined): Record<string, AutonomyBehavior> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => isBehavior(v)),
  ) as Record<string, AutonomyBehavior>;
}

function riskMap(value: Json | null | undefined): Record<string, RiskLevel> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => isRiskLevel(v)),
  ) as Record<string, RiskLevel>;
}

function boolMap(value: Json | null | undefined): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'boolean'),
  ) as Record<string, boolean>;
}

type Row = Database['public']['Tables']['family_ai_settings']['Row'];

/**
 * A row (or the absence of one) as the settings every reader can use.
 *
 * Unknown values inside the jsonb columns are dropped rather than trusted:
 * they are written by a settings form today, but the column is jsonb and a
 * future writer's typo must not become a behaviour nobody chose.
 */
export function settingsFromRow(familyId: string, row: Row | null | undefined): AISettings {
  if (!row) return { familyId, ...DEFAULT_AI_SETTINGS };
  const start = row.quiet_hours_start;
  const end = row.quiet_hours_end;
  return {
    familyId,
    // Only an explicit `false` switches something off. A row from an older
    // schema — or a read that answered something unexpected — must not read as
    // "the family turned Bubaly off"; that is a decision, not a default.
    enabled: row.enabled !== false,
    behavior: isBehavior(row.behavior) ? row.behavior : DEFAULT_AI_SETTINGS.behavior,
    categoryBehavior: behaviorMap(row.category_behavior),
    riskOverrides: riskMap(row.risk_overrides),
    childChannels: boolMap(row.child_channels),
    memoryEnabled: row.memory_enabled !== false,
    quietHours: typeof start === 'number' && typeof end === 'number' ? { start, end } : null,
  };
}

/** The autonomy level for one trust domain: the category's own answer, else the family default. */
export function behaviorForDomain(settings: AISettings, domain: string): AutonomyBehavior {
  return settings.categoryBehavior[domain] ?? settings.behavior;
}

/**
 * The tier a tool is actually gated at.
 *
 * An override raises freely. Lowering is allowed only where the consequence of
 * being wrong is recoverable: a high-stakes domain (money, documents, medical
 * — `HIGH_STAKES_AI_DOMAINS`) keeps `medium` as its floor, and no tool the
 * registry declares `high` in such a domain can be dropped below it.
 */
export function effectiveRisk(
  settings: AISettings,
  tool: { name: string; domain: string; risk: RiskLevel },
): RiskLevel {
  const override = settings.riskOverrides[tool.name];
  if (!override) return tool.risk;
  const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
  if (rank[override] >= rank[tool.risk]) return override;
  const floor: RiskLevel = HIGH_STAKES_AI_DOMAINS.includes(tool.domain) ? 'medium' : 'low';
  return rank[override] >= rank[floor] ? override : floor;
}
