// lib/guardian/scam-ai.ts — server-only deep scam analysis via Claude / OpenAI.
//
// Kept separate from scam.ts because this module dynamically imports the
// Anthropic SDK (which pulls in node:fs / node:path). scam.ts stays pure and
// client-safe (constants, types, deterministic pattern detection) so client
// components can import SCAM_TYPE_LABELS without dragging Node-only code into
// the browser bundle.

import { detectScamFromText, type ScamDetectionResult } from './scam';

/**
 * Use Claude (or OpenAI as fallback) to deeply analyze a transcript for scam
 * content. Falls back to deterministic pattern matching if no AI key is set or
 * the call fails. Server-only — do NOT import from a client component.
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
