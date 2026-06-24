export type SecurityInsights = {
  totalEvents: number;
  openEvents: number;
  criticalOpen: number;
  allClear: boolean;
  summary: string;
};

export interface SecurityEventLike {
  kind: string;
  severity: string;
  resolved: boolean;
  title: string;
}

export function analyzeSecurityEvents(events: readonly SecurityEventLike[]): SecurityInsights {
  let openEvents = 0;
  let criticalOpen = 0;

  for (const e of events) {
    if (!e.resolved) {
      openEvents++;
      if (e.severity === 'critical') criticalOpen++;
    }
  }

  const allClear = openEvents === 0;

  const parts: string[] = [];
  parts.push(`${events.length} event${events.length === 1 ? '' : 's'} total`);
  if (allClear) {
    parts.push('all clear');
  } else {
    parts.push(`${openEvents} open`);
    if (criticalOpen > 0) parts.push(`${criticalOpen} critical`);
  }

  return { totalEvents: events.length, openEvents, criticalOpen, allClear, summary: parts.join(' · ') };
}

export function buildSecurityPrompt(events: readonly SecurityEventLike[]): { system: string; user: string } {
  const system = `You are the Bubaly home security assistant. Analyze the family's security events and suggest improvements. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable security suggestion"],
  "priorities": ["most important security action to take"],
  "safetyTip": "one short home safety tip"
}

Rules:
- suggestions: max 4 practical suggestions based on the event patterns
- priorities: max 3 most important actions based on open/critical events
- safetyTip: one concrete home safety tip
- Focus on patterns (repeated event types, unresolved items) not individual event details.`;

  const summary = events.map((e) => `[${e.severity}] ${e.kind}: "${e.title}" (${e.resolved ? 'resolved' : 'open'})`).join('\n');
  const user = `The family has ${events.length} security events:\n\n${summary}\n\nReturn the JSON now.`;
  return { system, user };
}

export type SecurityAIResponse = {
  suggestions: string[];
  priorities: string[];
  safetyTip: string;
};

export function parseSecurityResponse(raw: string): SecurityAIResponse {
  const empty: SecurityAIResponse = { suggestions: [], priorities: [], safetyTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      priorities: Array.isArray(parsed.priorities)
        ? parsed.priorities.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      safetyTip: typeof parsed.safetyTip === 'string' ? parsed.safetyTip : '',
    };
  } catch {
    return empty;
  }
}
