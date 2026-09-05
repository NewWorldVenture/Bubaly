'use server';

// Server actions behind the run page and the Ask bar — the same operations as
// the /api/ai/requests route and the /api/ai/runs/[id] control routes, for
// components that prefer a form action over a fetch. Every action goes through the identical
// intake/control module, so the web UI cannot diverge from the mobile app in
// what it persists or who it lets do what.
//
// `kickRun` relies on `after()`, which is available inside server actions the
// same way it is inside route handlers, so execution still starts in the
// background and the action returns as soon as the plan is persisted.
//
// The gates are the routes' gates. Asking and answering are model calls, so
// they carry the same durable per-user rate limit as POST /api/ai/requests;
// answering, resuming and re-running each start execution with the run's
// authority, so they pass the feature/plan/allowance check first — a form
// action must not be the door around what the JSON edge refuses.
import { revalidatePath } from 'next/cache';
import { MAX_AI_ANSWER_CHARS, parseAIRequestIntake, runPagePath, type AIRequestResponse } from '@/lib/ai/chat-request';
import { loadRunDetail, toRunView, type RunView } from '@/lib/ai/runs/detail';
import {
  answerClarification, applyRunControl, submitRequest, type RunControlAction, type RunControlResult,
} from '@/lib/ai/runs/intake';
import { isAIConfigured } from '@/lib/ai/provider';
import { isManager } from '@/lib/constants/roles';
import { assertAIAccess, type AIAccessDenial } from '@/lib/server/ai-access';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { scopeFromUserContext } from '@/lib/services/scope';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

export type RunActionResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

/** Same window as the request route: an action and a fetch draw on one budget per user. */
const REQUEST_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;

/** Controls that start (or restart) execution and therefore need the concierge to be available to this family. */
const KICKING_CONTROLS: readonly RunControlAction[] = ['resume', 'rerun'];

function rateLimited(): RunActionResult<never> {
  return { ok: false, error: 'Too many requests. Please try again shortly.', code: 'rate_limited' };
}

function accessDenied(denial: AIAccessDenial): RunActionResult<never> {
  return { ok: false, error: denial.status === 404 ? 'Ask Bubaly is not available for your family.' : denial.error, code: denial.code };
}

/**
 * Ask Bubaly from a form: file the request and return where to go next.
 * `clientRequestId` (a hidden field generated once per form render) lets a
 * resubmitted form get the request it already filed instead of a second one.
 */
export async function askBubalyAction(input: {
  text: string;
  conversationId?: string | null;
  context?: { module?: string; entityIds?: string[] } | null;
  answers?: Record<string, string> | null;
  clientRequestId?: string | null;
}): Promise<RunActionResult<AIRequestResponse>> {
  const startedAt = Date.now();
  const parsed = parseAIRequestIntake({
    text: input.text,
    conversationId: input.conversationId ?? undefined,
    context: input.context ?? undefined,
    answers: input.answers ?? undefined,
    clientRequestId: input.clientRequestId ?? undefined,
  });
  if (!parsed.ok) {
    const copy = {
      invalid_body: 'Tell Bubaly what you need.',
      text_required: 'Tell Bubaly what you need.',
      text_too_long: 'That request is too long. Try a shorter one.',
      conversation_invalid: 'That conversation could not be opened.',
      client_request_id_invalid: 'That request could not be identified. Try again.',
    } as const;
    return { ok: false, error: copy[parsed.error], code: parsed.error };
  }

  const ctx = await requireUserContext();
  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-requests:${ctx.user.id}`, REQUEST_RATE_LIMIT);
  if (!limited.ok) return rateLimited();
  const access = await assertAIAccess(ctx, { db: supabase });
  if (!access.ok) return accessDenied(access);
  if (!(await isAIConfigured())) {
    return { ok: false, error: 'The AI engine isn’t set up yet. Add an OpenAI API key in Admin → AI Engine.', code: 'not_configured' };
  }

  const result = await submitRequest(scopeFromUserContext(ctx, supabase), parsed.value, { startedAtMs: startedAt });
  if (!result.ok) return { ok: false, error: result.error, code: result.code };
  revalidatePath('/home');
  revalidatePath('/dashboard');
  return { ok: true, data: result.data };
}

/** Answer the clarifying question a run is waiting on. A model call: rate-limited and gated like a request. */
export async function answerRunAction(runId: string, answer: string): Promise<RunActionResult<AIRequestResponse>> {
  const startedAt = Date.now();
  const reply = answer.trim();
  if (!runId) return { ok: false, error: 'That run could not be found.', code: 'not_found' };
  if (!reply) return { ok: false, error: 'Type an answer for Bubaly.', code: 'answer_required' };
  if (reply.length > MAX_AI_ANSWER_CHARS) return { ok: false, error: 'That answer is too long.', code: 'answer_too_long' };

  const ctx = await requireUserContext();
  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-requests:${ctx.user.id}`, REQUEST_RATE_LIMIT);
  if (!limited.ok) return rateLimited();
  const access = await assertAIAccess(ctx, { db: supabase });
  if (!access.ok) return accessDenied(access);

  const result = await answerClarification(scopeFromUserContext(ctx, supabase), runId, reply, { startedAtMs: startedAt });
  if (!result.ok) return { ok: false, error: result.error, code: result.code };
  revalidatePath(runPagePath(runId));
  if (result.data.runId && result.data.runId !== runId) revalidatePath(runPagePath(result.data.runId));
  return { ok: true, data: result.data };
}

/**
 * Pause, resume, cancel, or re-run a step. Authority is decided in
 * lib/ai/runs/controls.ts; resume and rerun additionally need the concierge
 * available to the family, because they kick execution. Pause and cancel are
 * never gated: stopping Bubaly must work even after a plan lapses.
 */
export async function controlRunAction(
  runId: string,
  action: RunControlAction,
  args: { stepId?: string | null } = {},
): Promise<RunActionResult<RunControlResult>> {
  const startedAt = Date.now();
  if (!runId) return { ok: false, error: 'That run could not be found.', code: 'not_found' };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  if (KICKING_CONTROLS.includes(action)) {
    const access = await assertAIAccess(ctx, { db: supabase });
    if (!access.ok) return accessDenied(access);
  }
  const result = await applyRunControl(scopeFromUserContext(ctx, supabase), runId, action, args, { startedAtMs: startedAt });
  if (!result.ok) return { ok: false, error: result.error, code: result.code };
  revalidatePath(runPagePath(runId));
  revalidatePath('/home');
  return { ok: true, data: result.data };
}

/** The run view for the page's client refresh — the same boundary the page renders; null when the run is not this family's. */
export async function loadRunAction(runId: string): Promise<RunActionResult<RunView | null>> {
  if (!runId) return { ok: true, data: null };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const detail = await loadRunDetail(supabase, ctx.active.familyId, runId, { viewerRole: ctx.active.role });
  if (!detail.ok) return { ok: false, error: detail.error, code: detail.code };
  return { ok: true, data: detail.data ? toRunView(detail.data, ctx.active.familyId, isManager(ctx.active.role)) : null };
}
