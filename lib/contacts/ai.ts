export type ContactInsights = {
  emergencyReady: boolean;
  missingCategories: string[];
  duplicates: { name: string; count: number }[];
  summary: string;
};

const ESSENTIAL_CATEGORIES = ['emergency', 'doctor', 'dentist'];

export interface ContactLike {
  name: string;
  category: string;
  is_emergency: boolean;
  phone: string | null;
  email: string | null;
}

export function analyzeContacts(contacts: readonly ContactLike[]): ContactInsights {
  const hasEmergency = contacts.some((c) => c.is_emergency && c.phone);
  const categories = new Set(contacts.map((c) => c.category));
  const missingCategories = ESSENTIAL_CATEGORIES.filter((c) => !categories.has(c));

  const nameCounts = new Map<string, number>();
  for (const c of contacts) {
    const norm = c.name.trim().toLowerCase();
    if (norm) nameCounts.set(norm, (nameCounts.get(norm) ?? 0) + 1);
  }
  const duplicates = [...nameCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({ name, count }));

  const parts: string[] = [];
  parts.push(`${contacts.length} contact${contacts.length === 1 ? '' : 's'}`);
  if (!hasEmergency) parts.push('no emergency contact with phone');
  if (missingCategories.length > 0) parts.push(`missing: ${missingCategories.join(', ')}`);
  if (duplicates.length > 0) parts.push(`${duplicates.length} possible duplicate${duplicates.length === 1 ? '' : 's'}`);

  return {
    emergencyReady: hasEmergency,
    missingCategories,
    duplicates,
    summary: parts.join(' · '),
  };
}

export function buildContactsPrompt(contacts: readonly ContactLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family contacts assistant. Analyze the family's contact list and provide helpful suggestions. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable suggestion"],
  "missingRoles": ["role that most families should have"],
  "organizationTip": "one short tip for better contact organization"
}

Rules:
- suggestions: max 5 practical, specific suggestions based on what's present/missing
- missingRoles: common roles most families need (pediatrician, pharmacy, school, etc.) that aren't covered
- organizationTip: one concrete tip for organizing contacts better
- Never invent contact details. Only suggest categories/roles to add.`;

  const summary = contacts.map((c) =>
    `${c.name} (${c.category}${c.is_emergency ? ', EMERGENCY' : ''}${c.phone ? ', has phone' : ''}${c.email ? ', has email' : ''})`
  ).join('\n');

  const user = `Here are the family's ${contacts.length} contacts:\n\n${summary}\n\nReturn the JSON now.`;
  return { system, user };
}

export type ContactAIResponse = {
  suggestions: string[];
  missingRoles: string[];
  organizationTip: string;
};

export function parseContactsResponse(raw: string): ContactAIResponse {
  const empty: ContactAIResponse = { suggestions: [], missingRoles: [], organizationTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 5)
        : [],
      missingRoles: Array.isArray(parsed.missingRoles)
        ? parsed.missingRoles.filter((s): s is string => typeof s === 'string').slice(0, 5)
        : [],
      organizationTip: typeof parsed.organizationTip === 'string' ? parsed.organizationTip : '',
    };
  } catch {
    return empty;
  }
}
