// lib/guardian/scam.ts — AI Scam Detection patterns and scoring.

export type ScamType =
  | 'robocall'
  | 'warranty_scam'
  | 'irs_scam'
  | 'grandparent_scam'
  | 'tech_support_scam'
  | 'prize_scam'
  | 'bank_scam'
  | 'social_security_scam'
  | 'medicare_scam'
  | 'utility_scam'
  | 'charity_scam'
  | 'romance_scam'
  | 'phishing'
  | 'spoofed_number';

export type ScamDetectionResult = {
  isScam: boolean;
  scamType: ScamType | null;
  confidence: number;   // 0-100
  signals: string[];    // human-readable flags
  recommendation: 'block' | 'flag' | 'monitor' | 'safe';
};

/** Known robocall phrase patterns (regex). */
const ROBOCALL_PATTERNS = [
  /this is an? (important|final|urgent) (message|notice|call)/i,
  /press \d+ (to|if you want to)/i,
  /your (car|vehicle|auto) warranty/i,
  /your (social security|ss) (number|card|account)/i,
  /irs (has|is|will|filed)/i,
  /arrest (warrant|order)/i,
  /congratulations.{0,30}(winner|won|prize|award)/i,
  /Microsoft (Windows|Support|Technical)/i,
  /do not (ignore|discard|delete) this/i,
  /last (attempt|warning|notice|chance)/i,
  /your (account|card) (has been|was) (suspended|compromised|hacked|flagged)/i,
  /gift card/i,
  /wire transfer/i,
  /bitcoin|crypto(currency)?/i,
  /act (now|immediately|today) to avoid/i,
  /grandm(a|other)|grandson|granddaughter/i,
  /in (jail|trouble|accident|hospital) (and )?need (money|help|bail)/i,
];

/** High-risk caller number patterns. */
const SUSPICIOUS_NUMBER_PATTERNS = [
  /^1(800|888|877|866|855|844|833)\d{7}$/,  // toll-free (sometimes spoofed)
  /^1900/,                                    // premium rate
];

/**
 * Analyze a transcript or SMS body for scam signals.
 * Returns a DetectionResult without making any AI call — purely deterministic.
 */
export function detectScamFromText(text: string, callerNumber?: string): ScamDetectionResult {
  const signals: string[] = [];
  let score = 0;
  let scamType: ScamType | null = null;

  for (const pattern of ROBOCALL_PATTERNS) {
    if (pattern.test(text)) {
      signals.push(`Matched pattern: ${pattern.source.slice(0, 60)}`);
      score += 20;
      if (!scamType) {
        if (/warranty/i.test(pattern.source)) scamType = 'warranty_scam';
        else if (/irs|arrest/i.test(pattern.source)) scamType = 'irs_scam';
        else if (/social security/i.test(pattern.source)) scamType = 'social_security_scam';
        else if (/microsoft|technical/i.test(pattern.source)) scamType = 'tech_support_scam';
        else if (/winner|prize/i.test(pattern.source)) scamType = 'prize_scam';
        else if (/grandm/i.test(pattern.source)) scamType = 'grandparent_scam';
        else if (/gift card|bitcoin|wire/i.test(pattern.source)) scamType = 'bank_scam';
        else scamType = 'robocall';
      }
    }
  }

  if (callerNumber) {
    const normalized = callerNumber.replace(/\D/g, '');
    for (const p of SUSPICIOUS_NUMBER_PATTERNS) {
      if (p.test(normalized)) {
        signals.push('Suspicious caller number pattern');
        score += 10;
      }
    }
  }

  // Urgency + payment combo = very high risk
  const hasUrgency = /urgent|immediately|right now|today|within \d+ (hour|minute)/i.test(text);
  const hasPayment = /gift card|wire transfer|bitcoin|zelle|cash app|venmo/i.test(text);
  if (hasUrgency && hasPayment) {
    signals.push('Urgency + payment method combo — classic scam pattern');
    score += 40;
    scamType = scamType ?? 'bank_scam';
  }

  const confidence = Math.min(score, 100);
  const isScam = confidence >= 50;
  const recommendation = confidence >= 80 ? 'block' : confidence >= 50 ? 'flag' : confidence >= 20 ? 'monitor' : 'safe';

  return { isScam, scamType, confidence, signals, recommendation };
}

/**
 * Use Claude to deeply analyze a transcript for scam content.
 * Falls back to pattern matching if AI is unavailable.
 */
export async function detectScamWithAI(
  transcript: string,
  callerNumber: string | null,
  familyContext: string,
): Promise<ScamDetectionResult> {
  const patternResult = detectScamFromText(transcript, callerNumber ?? undefined);

  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return patternResult;

  try {
    let responseText = '';

    if (process.env.ANTHROPIC_API_KEY) {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: `You are a scam detection expert. Analyze this phone transcript/message and respond with JSON only.

Family context: ${familyContext}
Caller number: ${callerNumber ?? 'unknown'}
Transcript: ${transcript.slice(0, 1000)}

Respond with exactly this JSON:
{"isScam": boolean, "scamType": string|null, "confidence": 0-100, "signals": ["..."], "recommendation": "block"|"flag"|"monitor"|"safe"}

scamType options: robocall, warranty_scam, irs_scam, grandparent_scam, tech_support_scam, prize_scam, bank_scam, social_security_scam, phishing, spoofed_number, null`,
        }],
      });
      responseText = msg.content[0].type === 'text' ? msg.content[0].text : '';
    } else {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 256,
          response_format: { type: 'json_object' },
          messages: [{
            role: 'user',
            content: `Analyze this for scams. Respond JSON: {"isScam":bool,"scamType":string|null,"confidence":0-100,"signals":[],"recommendation":"block"|"flag"|"monitor"|"safe"}\n\nTranscript: ${transcript.slice(0, 800)}`,
          }],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        responseText = data.choices?.[0]?.message?.content ?? '';
      }
    }

    const parsed = JSON.parse(responseText.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
    if (typeof parsed.isScam === 'boolean') {
      return {
        isScam: parsed.isScam,
        scamType: parsed.scamType ?? null,
        confidence: Math.min(Math.max(Number(parsed.confidence) || 0, 0), 100),
        signals: Array.isArray(parsed.signals) ? parsed.signals : patternResult.signals,
        recommendation: parsed.recommendation ?? patternResult.recommendation,
      };
    }
  } catch {
    // Fall through to pattern result
  }

  return patternResult;
}

/** Human-readable scam type labels. */
export const SCAM_TYPE_LABELS: Record<string, string> = {
  robocall: 'Robocall',
  warranty_scam: 'Warranty Scam',
  irs_scam: 'IRS / Government Scam',
  grandparent_scam: 'Grandparent Scam',
  tech_support_scam: 'Tech Support Scam',
  prize_scam: 'Prize / Lottery Scam',
  bank_scam: 'Bank / Payment Scam',
  social_security_scam: 'Social Security Scam',
  medicare_scam: 'Medicare Scam',
  utility_scam: 'Utility Scam',
  charity_scam: 'Charity Scam',
  romance_scam: 'Romance Scam',
  phishing: 'Phishing',
  spoofed_number: 'Spoofed Number',
};
