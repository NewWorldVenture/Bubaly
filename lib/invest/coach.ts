// lib/invest/coach.ts — AI investing EXPLAINER for kids. PURE + tested.
//
// Strictly educational: explains an investment idea (what it is, why
// diversification/compound-growth matter) in kid-friendly language. It NEVER
// gives buy/sell financial advice or promises returns (compliance). The route
// builds the prompt and parses the structured reply, so this is unit-tested.

export type InvestCoachInput = {
  childName: string;
  assetName: string | null;       // the asset the child is curious about (optional)
  assetDescription: string | null;
  riskLevel: string | null;       // low | medium | high
  portfolioValueCents: number;
  holdingsCount: number;
};

export type InvestCoaching = {
  /** A warm, kid-friendly explanation (2-4 sentences). */
  explainer: string;
  /** A few short learning tips (diversification, patience, compound growth…). */
  tips: string[];
};

export function buildInvestCoachPrompt(input: InvestCoachInput): { system: string; user: string } {
  const system = `You are the Bubaly Money Mentor for kids — warm, simple, and encouraging. You teach money & investing CONCEPTS at a child's level. This is EDUCATIONAL only: a safe, simulated learning tool.

Return STRUCTURED JSON only (no markdown, no code fences). Start with { end with }.

Shape:
{
  "explainer": "2-4 kid-friendly sentences explaining the idea",
  "tips": ["short learning tip", "another"]
}

HARD RULES:
- NEVER tell the child (or parent) to buy or sell anything. No financial advice.
- NEVER promise or imply returns, profits, or that any investment is "safe money".
- Teach concepts: diversification ("don't put all your eggs in one basket"), patience,
  compound growth, risk vs. reward, that values go UP and DOWN.
- Age-appropriate, kind, 2-4 tips. Plain words.`;

  const asset = input.assetName
    ? `Curious about: "${input.assetName}"${input.riskLevel ? ` (risk: ${input.riskLevel})` : ''}. ${input.assetDescription ?? ''}`
    : 'No specific investment selected — give a general beginner concept.';
  const portfolio = input.holdingsCount > 0
    ? `They currently hold ${input.holdingsCount} different investment(s), worth about $${(input.portfolioValueCents / 100).toFixed(2)} (pretend money).`
    : 'They have not invested any pretend money yet.';

  const user = `Child: ${input.childName}\n${asset}\n${portfolio}\n\nReturn the educational JSON now.`;
  return { system, user };
}

function asStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0).slice(0, max);
}

export function parseInvestCoach(raw: string): InvestCoaching {
  const empty: InvestCoaching = { explainer: '', tips: [] };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(match[0]) as Record<string, unknown>; } catch { return empty; }
  return {
    explainer: typeof parsed.explainer === 'string' ? parsed.explainer.trim() : '',
    tips: asStringArray(parsed.tips, 4),
  };
}
