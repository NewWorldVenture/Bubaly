export type AnnouncementsInsights = {
  totalAnnouncements: number;
  pinnedCount: number;
  summary: string;
};

export interface AnnouncementForAI {
  title: string;
  body: string | null;
  is_pinned: boolean;
  created_at: string;
}

export function analyzeAnnouncements(items: AnnouncementForAI[]): AnnouncementsInsights {
  let pinnedCount = 0;
  for (const a of items) {
    if (a.is_pinned) pinnedCount++;
  }

  const summary = items.length === 0
    ? 'No announcements posted yet.'
    : `${items.length} announcements. ${pinnedCount} pinned.`;

  return { totalAnnouncements: items.length, pinnedCount, summary };
}

export function buildAnnouncementsPrompt(items: AnnouncementForAI[]) {
  const system = `You are a family communications advisor. Analyze announcement data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"communicationTips":["..."],"engagementTip":"..."}
suggestions: up to 4 actionable ideas. communicationTips: up to 3 tips. engagementTip: one sentence about keeping the family informed.`;

  const user = `Announcements:\n${JSON.stringify(items.slice(0, 50))}`;
  return { system, user };
}

export type AnnouncementsAIResponse = {
  suggestions: string[];
  communicationTips: string[];
  engagementTip: string;
};

export function parseAnnouncementsResponse(raw: string): AnnouncementsAIResponse {
  const empty: AnnouncementsAIResponse = { suggestions: [], communicationTips: [], engagementTip: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      communicationTips: Array.isArray(parsed.communicationTips) ? parsed.communicationTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      engagementTip: typeof parsed.engagementTip === 'string' ? parsed.engagementTip : '',
    };
  } catch { return empty; }
}
