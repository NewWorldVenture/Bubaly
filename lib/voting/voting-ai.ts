export type VotingInsights = {
  totalPolls: number;
  activeCount: number;
  closedCount: number;
  totalVotes: number;
  summary: string;
};

export interface PollForAI {
  question: string;
  kind: string;
  status: string;
  closes_at: string | null;
  option_count: number;
  vote_count: number;
}

export function analyzePolls(polls: readonly PollForAI[]): VotingInsights {
  let activeCount = 0;
  let closedCount = 0;
  let totalVotes = 0;

  for (const p of polls) {
    totalVotes += p.vote_count;
    if (p.status === 'closed') closedCount++;
    else activeCount++;
  }

  const parts: string[] = [];
  parts.push(`${polls.length} poll${polls.length === 1 ? '' : 's'}`);
  parts.push(`${activeCount} active`);
  parts.push(`${closedCount} closed`);
  parts.push(`${totalVotes} total votes`);

  return { totalPolls: polls.length, activeCount, closedCount, totalVotes, summary: parts.join(' · ') };
}

export function buildVotingPrompt(polls: readonly PollForAI[]): { system: string; user: string } {
  const system = `You are the Bubaly family decision-making advisor. Analyze family polls and suggest how to make better collaborative decisions. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable voting or decision suggestion"],
  "engagementTips": ["tip for getting more family members to participate"],
  "decisionTip": "one short tip for better family decision-making"
}

Rules:
- suggestions: max 4 practical suggestions based on current polls
- engagementTips: max 3 tips for improving participation
- decisionTip: one concrete recommendation
- Focus on participation rates, fair decision-making, and acting on results.`;

  const pollList = polls.map((p) =>
    `"${p.question}" (${p.kind}, ${p.status}, ${p.option_count} options, ${p.vote_count} votes${p.closes_at ? `, closes: ${p.closes_at.slice(0, 10)}` : ''})`
  ).join('\n');
  const user = `The family has ${polls.length} polls:\n\n${pollList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type VotingAIResponse = {
  suggestions: string[];
  engagementTips: string[];
  decisionTip: string;
};

export function parseVotingResponse(raw: string): VotingAIResponse {
  const empty: VotingAIResponse = { suggestions: [], engagementTips: [], decisionTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      engagementTips: Array.isArray(parsed.engagementTips)
        ? parsed.engagementTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      decisionTip: typeof parsed.decisionTip === 'string' ? parsed.decisionTip : '',
    };
  } catch {
    return empty;
  }
}
