// lib/guardian/rules.ts — Deterministic routing rules engine.
// Rules are evaluated in priority order (lower number = higher priority).
// All rules are parent-approved; AI may only suggest new rules.

import type { TrustLevel } from './trust';
import type { RoutingMode } from './pipeline';

export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun

export type GuardianRule = {
  id: string;
  name: string;
  priority: number;
  is_active: boolean;
  // Conditions (all must match)
  condition_contact_id: string | null;
  condition_trust_levels: TrustLevel[] | null;
  condition_time_start: string | null;   // 'HH:MM' local time
  condition_time_end: string | null;
  condition_days_of_week: DayOfWeek[] | null;
  condition_contexts: string[] | null;
  condition_caller_pattern: string | null;  // regex string
  // Action
  action_routing_mode: RoutingMode;
  action_notify_members: string[] | null;
};

export type RuleMatchContext = {
  contactId: string | null;
  trustLevel: TrustLevel;
  callerPhone: string | null;
  callerName: string | null;
  currentContext: string;  // 'normal'|'driving'|'meeting'|'sleeping'|'vacation'
  localHour: number;       // 0-23
  localMinute: number;
  dayOfWeek: DayOfWeek;
};

export type RuleMatchResult = {
  matched: boolean;
  rule: GuardianRule | null;
  routingMode: RoutingMode | null;
  reason: string;
};

/** Evaluate a time range condition, handling overnight ranges (e.g. 22:00–07:00). */
function timeInRange(hour: number, minute: number, start: string, end: string): boolean {
  const toMins = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const now = hour * 60 + minute;
  const s = toMins(start);
  const e = toMins(end);
  if (s <= e) return now >= s && now <= e;
  // Overnight: e.g. 22:00–07:00
  return now >= s || now <= e;
}

/** Match a single rule against the current call context. */
function matchesRule(rule: GuardianRule, ctx: RuleMatchContext): boolean {
  if (!rule.is_active) return false;

  // Contact ID match
  if (rule.condition_contact_id && rule.condition_contact_id !== ctx.contactId) return false;

  // Trust level match
  if (rule.condition_trust_levels?.length && !rule.condition_trust_levels.includes(ctx.trustLevel)) return false;

  // Time range match
  if (rule.condition_time_start && rule.condition_time_end) {
    if (!timeInRange(ctx.localHour, ctx.localMinute, rule.condition_time_start, rule.condition_time_end)) return false;
  }

  // Day of week match
  if (rule.condition_days_of_week?.length && !rule.condition_days_of_week.includes(ctx.dayOfWeek)) return false;

  // Context match
  if (rule.condition_contexts?.length && !rule.condition_contexts.includes(ctx.currentContext)) return false;

  // Caller pattern match. The pattern is parent-entered free text, so a malformed
  // regex (e.g. "(") must NOT throw and take down the whole routing pipeline — an
  // uncompilable pattern simply cannot match.
  if (rule.condition_caller_pattern) {
    let re: RegExp;
    try {
      re = new RegExp(rule.condition_caller_pattern, 'i');
    } catch {
      return false;
    }
    const phone = ctx.callerPhone ?? '';
    const name = ctx.callerName ?? '';
    if (!re.test(phone) && !re.test(name)) return false;
  }

  return true;
}

/**
 * Run the rules engine. Returns the first (highest-priority) matching rule's action,
 * or null if no rules match (caller falls through to profile defaults).
 */
export function evaluateRules(rules: GuardianRule[], ctx: RuleMatchContext): RuleMatchResult {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  for (const rule of sorted) {
    if (matchesRule(rule, ctx)) {
      return {
        matched: true,
        rule,
        routingMode: rule.action_routing_mode,
        reason: `Rule "${rule.name}" matched`,
      };
    }
  }
  return { matched: false, rule: null, routingMode: null, reason: 'No rules matched — using profile default' };
}

/** Build the context object from current call data and family timezone. */
export function buildRuleContext(params: {
  contactId: string | null;
  trustLevel: TrustLevel;
  callerPhone: string | null;
  callerName: string | null;
  memberContext: string;
  timezone?: string;
}): RuleMatchContext {
  const tz = params.timezone ?? 'America/New_York';
  const now = new Date();
  const localStr = now.toLocaleString('en-US', { timeZone: tz, hour12: false });
  // Parse "6/25/2026, 14:30:00" format
  const timePart = localStr.split(', ')[1] ?? '0:0:0';
  const [hStr, mStr] = timePart.split(':');
  const localHour = parseInt(hStr ?? '0', 10);
  const localMinute = parseInt(mStr ?? '0', 10);
  const dayOfWeek = new Date(now.toLocaleString('en-US', { timeZone: tz })).getDay() as DayOfWeek;

  return {
    contactId: params.contactId,
    trustLevel: params.trustLevel,
    callerPhone: params.callerPhone,
    callerName: params.callerName,
    currentContext: params.memberContext,
    localHour,
    localMinute,
    dayOfWeek,
  };
}
