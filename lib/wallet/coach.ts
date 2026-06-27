// lib/wallet/coach.ts — AI Financial Coach prompt/parse. PURE + tested.
// Family-wide coach: buildWalletCoachPrompt / parseWalletCoach.
// Child-specific coach: buildChildCoachPrompt (same parse).
import { formatCents } from '@/lib/wallet/ledger';

export type CoachChild = { name: string; totalCents: number; saveCents: number };
export type CoachGoal = { childName: string | null; title: string; savedCents: number; targetCents: number; weeksToGoal: number | null };

export type WalletCoaching = {
  /** A warm one-line headline. */
  headline: string;
  /** Specific, data-grounded money insights. */
  insights: string[];
  /** One concrete suggestion (e.g. a savings move or allowance tweak). */
  suggestion: string;
};

export function buildWalletCoachPrompt(input: { children: CoachChild[]; goals: CoachGoal[]; familyName: string }): { system: string; user: string } {
  const system = `You are the Bubaly Family Financial Coach — warm, concrete, and encouraging, teaching healthy money habits without lecturing. You receive a family's wallet snapshot and return STRUCTURED JSON only (no markdown, no code fences). Start with { end with }.

Shape:
{
  "headline": "one warm sentence about the family's money momentum",
  "insights": ["specific, number-grounded observation", "another"],
  "suggestion": "one concrete next step (a savings move, allowance idea, or goal nudge)"
}

Rules:
- Use real numbers from the snapshot. Reference goal forecasts ("3 weeks away") when present.
- 2-4 insights. Celebrate saving and giving; never shame spending.
- Family-friendly and age-aware. Never give regulated investment advice or promise returns.`;

  const kids = input.children.map((c) => `- ${c.name}: ${formatCents(c.totalCents)} total (${formatCents(c.saveCents)} saved)`);
  const goals = input.goals.map((g) => {
    const who = g.childName ? `${g.childName}'s ` : 'Family ';
    const fc = g.weeksToGoal === 0 ? 'reached!' : g.weeksToGoal == null ? 'no contributions yet' : `~${g.weeksToGoal} weeks away`;
    return `- ${who}"${g.title}": ${formatCents(g.savedCents)} / ${formatCents(g.targetCents)} (${fc})`;
  });

  const user = `Family: ${input.familyName}\n\nChildren:\n${kids.join('\n') || '- (no child wallets yet)'}\n\nGoals:\n${goals.join('\n') || '- (no goals yet)'}\n\nReturn the coaching JSON now.`;
  return { system, user };
}

// ─── Child-specific coach ─────────────────────────────────────────────────────

export type CoachChildDetail = {
  name: string;
  totalCents: number;
  buckets: { spend: number; save: number; give: number; invest: number };
  weeklyCreditCents: number;
  goals: CoachGoal[];
};

export function buildChildCoachPrompt(input: CoachChildDetail): { system: string; user: string } {
  const system = `You are the Bubaly Family Financial Coach — warm, encouraging, and concrete, teaching healthy money habits. You receive ONE child's wallet snapshot and return STRUCTURED JSON only (no markdown, no code fences). Start with { end with }.

Shape:
{
  "headline": "one warm, specific sentence about this child's money momentum",
  "insights": ["data-grounded observation", "another"],
  "suggestion": "one concrete next step (a savings move, spending habit, or goal nudge)"
}

Rules:
- Reference real numbers. Use the child's name. Reference goal forecasts when present.
- 2-4 insights. Celebrate saving and giving; never shame spending.
- Family-friendly and age-appropriate. Never give regulated investment advice or promise returns.`;

  const buckets = [
    `Spend: ${formatCents(input.buckets.spend)}`,
    `Save: ${formatCents(input.buckets.save)}`,
    `Give: ${formatCents(input.buckets.give)}`,
    `Invest: ${formatCents(input.buckets.invest)}`,
  ].join(', ');

  const weeklyRate = input.weeklyCreditCents > 0
    ? `~${formatCents(Math.round(input.weeklyCreditCents))}/week`
    : 'no recent contributions';

  const goals = input.goals.length > 0
    ? input.goals.map((g) => {
        const fc = g.weeksToGoal === 0 ? 'reached!' : g.weeksToGoal == null ? 'no contributions yet' : `~${g.weeksToGoal} weeks away`;
        return `- "${g.title}": ${formatCents(g.savedCents)} / ${formatCents(g.targetCents)} (${fc})`;
      }).join('\n')
    : '- (no goals yet)';

  const user = `Child: ${input.name}
Total balance: ${formatCents(input.totalCents)}
Buckets: ${buckets}
Recent savings rate: ${weeklyRate}

Goals:
${goals}

Return the coaching JSON now.`;

  return { system, user };
}

function asStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0).slice(0, max);
}

export function parseWalletCoach(raw: string): WalletCoaching {
  const empty: WalletCoaching = { headline: '', insights: [], suggestion: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(match[0]) as Record<string, unknown>; } catch { return empty; }
  return {
    headline: typeof parsed.headline === 'string' ? parsed.headline.trim() : '',
    insights: asStringArray(parsed.insights, 4),
    suggestion: typeof parsed.suggestion === 'string' ? parsed.suggestion.trim() : '',
  };
}
