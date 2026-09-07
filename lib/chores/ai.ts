// lib/chores/ai.ts
// Modular AI service layer for Family Missions. Every function degrades safely:
// if the model is unconfigured or errors, chore validation falls back to
// "parent_review_required" (never an automatic rejection), so a kid is never
// penalised by an AI outage.
import 'server-only';
import { getProvider, type AIImage } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import type { ServiceScope } from '@/lib/services/types';

export type ValidationStatus = 'approved' | 'needs_improvement' | 'unclear' | 'rejected' | 'parent_review_required';

export type AiValidationResult = {
  status: ValidationStatus;
  quality_score: number;          // 0..100
  confidence: number;             // 0..100
  recommended_reward_type: 'cash' | 'points' | 'prize' | 'none';
  recommended_reward_amount: number;
  kid_feedback: string;
  parent_summary: string;
  detected_issues: string[];
  safety_flags: string[];
  needs_parent_review: boolean;
  is_fallback: boolean;
  model: string | null;
};

export type ValidateInput = {
  choreTitle: string;
  instructions?: string | null;
  proofKind: 'none' | 'photo' | 'video' | 'before_after';
  difficulty?: string | null;
  safetyLevel?: string | null;
  kidNote?: string | null;
  childAge?: number | null;
  images?: AIImage[];             // base64 frames (photos, or video stills)
};

function aiConfigured(): boolean {
  // OpenAI-only deployment; chore validation uses the env-configured OpenAI key.
  return !!process.env.OPENAI_API_KEY;
}

/** A safe, honest fallback used whenever the model can't be reached. */
export function fallbackValidation(reason: string): AiValidationResult {
  return {
    status: 'parent_review_required',
    quality_score: 0,
    confidence: 0,
    recommended_reward_type: 'none',
    recommended_reward_amount: 0,
    kid_feedback: 'Nice work! A grown-up will take a quick look and finish this up. 🙌',
    parent_summary: `Automatic review unavailable (${reason}). Please review this submission manually.`,
    detected_issues: [],
    safety_flags: [],
    needs_parent_review: true,
    is_fallback: true,
    model: null,
  };
}

const VALIDATION_SYSTEM =
  'You are a kind, fair family chore reviewer helping verify that a child completed a chore. ' +
  'You are shown the chore instructions, the child\'s note, and any photo(s) they submitted as proof. ' +
  'Judge ONLY what you can actually see and read — never invent details. Be encouraging and age-appropriate; ' +
  'never shame the child. If you cannot clearly tell the task is done, prefer "unclear" or ' +
  '"parent_review_required" rather than rejecting. Flag any safety concern you can see (chemicals, sharp ' +
  'objects, stove/oven, ladders, heavy lifting, pool, pets). ' +
  'Respond with ONLY a single JSON object (no prose, no code fences) matching exactly this shape: ' +
  '{"status":"approved|needs_improvement|unclear|rejected|parent_review_required",' +
  '"quality_score":0-100,"confidence":0-100,"recommended_reward_type":"cash|points|prize|none",' +
  '"recommended_reward_amount":number,"kid_feedback":string,"parent_summary":string,' +
  '"detected_issues":string[],"safety_flags":string[],"needs_parent_review":boolean}';

/**
 * Validate a chore submission. Sends the chore context + the kid's note + any
 * submitted images to the model and parses a structured verdict. Falls back to
 * parent review on any failure.
 */
export async function validateChoreSubmission(scope: ServiceScope, input: ValidateInput): Promise<AiValidationResult> {
  // Four ways this ends at `fallbackValidation`, and from the child's side they
  // are one thing: the chore they did goes to a parent instead of being
  // auto-approved, and they wait. Two of the four are silent failures (the model
  // answered unusably; the provider threw) and had no record at all.
  //
  // The two above the model call are NOT failures and open no row: no key
  // configured is a setting, and a photo chore with no photo is a guard that
  // fires before anything is asked of a model. A row for either would fill the
  // ledger with non-events and make the failure count useless.
  if (!aiConfigured()) return fallbackValidation('AI not configured');
  // Without any visual proof we cannot truly verify a photo/video chore.
  if ((input.proofKind === 'photo' || input.proofKind === 'video' || input.proofKind === 'before_after') && !input.images?.length) {
    return fallbackValidation('no image provided');
  }

  const userText =
    `Chore: ${input.choreTitle}\n` +
    (input.instructions ? `Instructions: ${input.instructions}\n` : '') +
    (input.difficulty ? `Difficulty: ${input.difficulty}\n` : '') +
    (input.safetyLevel && input.safetyLevel !== 'none' ? `Safety level: ${input.safetyLevel}\n` : '') +
    (input.childAge != null ? `Child age: ${input.childAge}\n` : '') +
    `Proof type: ${input.proofKind}\n` +
    `Child's note: ${input.kidNote?.trim() || '(none)'}\n` +
    (input.images?.length ? `Photos attached: ${input.images.length}.` : 'No photo attached.');

  try {
    return await withAiRequest(
      scope,
      // The chore title, not the child's note: a kid's own words about what they
      // did are not something the request ledger needs to carry.
      { feature: 'chores.validate', text: `Validate a chore submission: ${input.choreTitle}` },
      async (obs) => {
        const provider = getProvider();
        const completion = await provider.complete({
          system: VALIDATION_SYSTEM,
          messages: [{ role: 'user', content: userText, images: input.images?.slice(0, 4) }],
          tools: [],
        });
        obs.used(provider.model, completion.usage);
        const parsed = parseJsonLoose(completion.text);
        if (!parsed) {
          obs.failed(new Error('The verdict did not parse; the chore went to parent review.'));
          return fallbackValidation('could not parse AI response');
        }
        return normalize(parsed, provider.model);
      },
    );
  } catch (err) {
    // The wrapper recorded it on the way past; this still swallows, because a
    // child whose proof cannot be checked should get a parent, not an error.
    return fallbackValidation(err instanceof Error ? err.message : 'AI error');
  }
}

// ---------- Chore plan generation ----------
export type ChorePlanItem = {
  title: string;
  description: string;
  assignee_age: number | null;
  difficulty: 'easy' | 'medium' | 'hard';
  est_minutes: number;
  suggested_points: number;
  suggested_cash_cents: number;
  recurrence: 'none' | 'daily' | 'weekly' | 'monthly';
  proof_required: 'none' | 'photo' | 'video' | 'before_after';
  safety_level: 'none' | 'caution' | 'parent_required';
  auto_approve_eligible: boolean;
};

const PLAN_SYSTEM =
  'You are a family routines expert. Given a parent request and the kids\' ages, propose a balanced, ' +
  'age-appropriate chore plan. Never assign unsafe tasks (chemicals, stove, ladders, sharp tools, pool, ' +
  'heavy lifting) to young children; mark anything sensitive with the right safety_level. ' +
  'Respond with ONLY a JSON array (no prose, no code fences) of objects matching: ' +
  '{"title":string,"description":string,"assignee_age":number|null,"difficulty":"easy|medium|hard",' +
  '"est_minutes":number,"suggested_points":number,"suggested_cash_cents":number,' +
  '"recurrence":"none|daily|weekly|monthly","proof_required":"none|photo|video|before_after",' +
  '"safety_level":"none|caution|parent_required","auto_approve_eligible":boolean}';

export async function generateChorePlan(
  scope: ServiceScope,
  prompt: string,
  kidAges: number[] = [],
): Promise<{ items: ChorePlanItem[]; error?: string }> {
  if (!aiConfigured()) return { items: [], error: 'AI is not configured.' };
  const userText = `Kids' ages: ${kidAges.length ? kidAges.join(', ') : 'unspecified'}\nRequest: ${prompt.slice(0, 1500)}`;
  try {
    return await withAiRequest(
      scope,
      { feature: 'chores.plan', text: prompt.slice(0, 200) },
      async (obs) => {
        const provider = getProvider();
        const completion = await provider.complete({ system: PLAN_SYSTEM, messages: [{ role: 'user', content: userText }], tools: [] });
        obs.used(provider.model, completion.usage);
        const parsed = parseJsonLoose(completion.text);
        if (!Array.isArray(parsed)) {
          obs.failed(new Error('The chore plan did not parse as a JSON array.'));
          return { items: [], error: 'Could not parse the AI plan.' };
        }
        return { items: parsed.map(normalizePlanItem).filter(Boolean) as ChorePlanItem[] };
      },
    );
  } catch (err) {
    return { items: [], error: err instanceof Error ? err.message : 'AI request failed.' };
  }
}

// ---------- parsing helpers ----------
/** Extract the first JSON object/array from possibly-noisy model output. */
export function parseJsonLoose(text: string): unknown {
  if (!text) return null;
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.search(/[[{]/);
  if (start === -1) return null;
  const open = trimmed[start];
  const close = open === '{' ? '}' : ']';
  const end = trimmed.lastIndexOf(close);
  if (end <= start) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string').slice(0, 10) as string[];
}

const STATUSES: ValidationStatus[] = ['approved', 'needs_improvement', 'unclear', 'rejected', 'parent_review_required'];

function normalize(raw: unknown, model: string): AiValidationResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const status = STATUSES.includes(o.status as ValidationStatus) ? (o.status as ValidationStatus) : 'parent_review_required';
  const safety = strArr(o.safety_flags);
  const rewardType = ['cash', 'points', 'prize', 'none'].includes(o.recommended_reward_type as string)
    ? (o.recommended_reward_type as AiValidationResult['recommended_reward_type']) : 'none';
  // Safety always forces a human in the loop.
  const needsReview = Boolean(o.needs_parent_review) || safety.length > 0 || status === 'parent_review_required';
  return {
    status,
    quality_score: clampInt(o.quality_score, 0, 100, 0),
    confidence: clampInt(o.confidence, 0, 100, 0),
    recommended_reward_type: rewardType,
    recommended_reward_amount: Math.max(0, Number(o.recommended_reward_amount) || 0),
    kid_feedback: typeof o.kid_feedback === 'string' ? o.kid_feedback.slice(0, 600) : 'Thanks for sending your proof!',
    parent_summary: typeof o.parent_summary === 'string' ? o.parent_summary.slice(0, 600) : '',
    detected_issues: strArr(o.detected_issues),
    safety_flags: safety,
    needs_parent_review: needsReview,
    is_fallback: false,
    model,
  };
}

function normalizePlanItem(raw: unknown): ChorePlanItem | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.title !== 'string' || !o.title.trim()) return null;
  const diff = ['easy', 'medium', 'hard'].includes(o.difficulty as string) ? (o.difficulty as ChorePlanItem['difficulty']) : 'medium';
  const rec = ['none', 'daily', 'weekly', 'monthly'].includes(o.recurrence as string) ? (o.recurrence as ChorePlanItem['recurrence']) : 'weekly';
  const proof = ['none', 'photo', 'video', 'before_after'].includes(o.proof_required as string) ? (o.proof_required as ChorePlanItem['proof_required']) : 'photo';
  const safety = ['none', 'caution', 'parent_required'].includes(o.safety_level as string) ? (o.safety_level as ChorePlanItem['safety_level']) : 'none';
  return {
    title: o.title.slice(0, 120),
    description: typeof o.description === 'string' ? o.description.slice(0, 400) : '',
    assignee_age: o.assignee_age == null ? null : clampInt(o.assignee_age, 1, 21, 10),
    difficulty: diff,
    est_minutes: clampInt(o.est_minutes, 1, 240, 15),
    suggested_points: clampInt(o.suggested_points, 0, 1000, 20),
    suggested_cash_cents: clampInt(o.suggested_cash_cents, 0, 100000, 0),
    recurrence: rec,
    proof_required: proof,
    safety_level: safety,
    auto_approve_eligible: Boolean(o.auto_approve_eligible) && safety === 'none',
  };
}
