export type SignupsInsights = {
  totalSignups: number;
  openCount: number;
  missedCount: number;
  closingSoonCount: number;
  totalCost: number;
  summary: string;
};

export interface SignupEntryLike {
  title: string;
  category: string | null;
  deadline: string | null;
  cost: number | null;
  status: string;
}

export function analyzeSignups(signups: readonly SignupEntryLike[]): SignupsInsights {
  let openCount = 0;
  let missedCount = 0;
  let closingSoonCount = 0;
  let totalCost = 0;
  const now = new Date();
  const soonThreshold = new Date();
  soonThreshold.setDate(soonThreshold.getDate() + 7);

  for (const s of signups) {
    if (s.cost != null) totalCost += s.cost;
    if (s.status === 'missed') { missedCount++; continue; }
    if (s.status === 'passed') continue;
    openCount++;
    if (s.deadline) {
      const dl = new Date(s.deadline);
      if (dl < now) missedCount++;
      else if (dl <= soonThreshold) closingSoonCount++;
    }
  }

  const parts: string[] = [];
  parts.push(`${signups.length} signup${signups.length === 1 ? '' : 's'}`);
  parts.push(`${openCount} open`);
  if (closingSoonCount > 0) parts.push(`${closingSoonCount} closing soon`);
  if (missedCount > 0) parts.push(`${missedCount} missed`);
  if (totalCost > 0) parts.push(`$${totalCost.toFixed(0)} total cost`);

  return { totalSignups: signups.length, openCount, missedCount, closingSoonCount, totalCost, summary: parts.join(' · ') };
}

export function buildSignupsPrompt(signups: readonly SignupEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family activity coordinator. Analyze signups and registrations and suggest timely actions. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable signup suggestion"],
  "deadlineAlerts": ["urgent deadline or action needed"],
  "planningTip": "one short tip for managing registrations"
}

Rules:
- suggestions: max 4 practical suggestions based on current signups
- deadlineAlerts: max 3 urgent items needing attention
- planningTip: one concrete recommendation
- Focus on upcoming deadlines, cost management, and avoiding missed opportunities.`;

  const signupList = signups.map((s) =>
    `${s.title} (${s.category ?? 'other'}, ${s.status}${s.deadline ? `, deadline: ${s.deadline}` : ''}${s.cost != null ? `, $${s.cost}` : ''})`
  ).join('\n');
  const user = `The family has ${signups.length} signups/registrations:\n\n${signupList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type SignupsAIResponse = {
  suggestions: string[];
  deadlineAlerts: string[];
  planningTip: string;
};

export function parseSignupsResponse(raw: string): SignupsAIResponse {
  const empty: SignupsAIResponse = { suggestions: [], deadlineAlerts: [], planningTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      deadlineAlerts: Array.isArray(parsed.deadlineAlerts)
        ? parsed.deadlineAlerts.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      planningTip: typeof parsed.planningTip === 'string' ? parsed.planningTip : '',
    };
  } catch {
    return empty;
  }
}
