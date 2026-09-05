'use server';

// Server actions behind the run page and the Ask bar — the same operations as
// the /api/ai/requests and /api/ai/runs/[id]/* routes, for components that
// prefer a form action over a fetch. Every action goes through the identical
// intake/control module, so the web UI cannot diverge from the mobile app in
// what it persists or who it lets do what.
//
// `kickRun` relies on `after()`, which is available inside server actions the
// same way it is inside route handlers, so execution still starts in the
// background and the action returns as soon as the plan is persisted.
import { revalidatePath } from 'next/cache';
import { MAX_AI_ANSWER_CHARS, parseAIRequestIntake, runPagePath, type AIRequestResponse } from '@/lib/ai/chat-request';
import { loadRunDetail, type RunDetailView } from '@/lib/ai/runs/detail';
import {
  answerClarification, applyRunControl, submitRequest, type RunControlAction, type RunControlResult,
} from '@/lib/ai/runs/intake';
import { isAIConfigured } from '@/lib/ai/provider';
import { assertAIAccess } from '@/lib/server/ai-access';
import { scopeFromUserContext } from '@/lib/services/scope';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

export type RunActionResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

/** Ask Bubaly from a form: file the request and return where to go next. */
export async function askBubalyAction(input: {
  text: string;
  conversationId?: string | null;
  context?: { module?: string; entityIds?: string[] } | null;
  answers?: Record<string, string> | null;
}): Promise<RunActionResult<AIRequestResponse>> {
  const startedAt = Date.now();
  const parsed = parseAIRequestIntake({
    text: input.text,
    conversationId: input.conversationId ?? undefined,
    context: input.context ?? undefined,
    answers: input.answers ?? undefined,
  });
  if (!parsed.ok) {
    const copy = {
      invalid_body: 'Tell Bubaly what you need.',
      text_required: 'Tell Bubaly what you need.',
      text_too_long: 'That request is too long. Try a shorter one.',
      conversation_invalid: 'That conversation could not be opened.',
    } as const;
    return { ok: false, error: copy[parsed.error], code: parsed.error };
  }

  const ctx = await requireUserContext();
  const supabase = await createServer();
  const access = await assertAIAccess(ctx, { db: supabase });
  if (!access.ok) return { ok: false, error: access.status === 404 ? 'Ask Bubaly is not available for your family.' : access.error, code: access.code };
  if (!(await isAIConfigured())) {
    return { ok: false, error: 'The AI engine isn’t set up yet. Add an OpenAI API key in Admin → AI Engine.', code: 'not_configured' };
  }

  const result = await submitRequest(scopeFromUserContext(ctx, supabase), parsed.value, { startedAtMs: startedAt });
  if (!result.ok) return { ok: false, error: result.error, code: result.code };
  revalidatePath('/home');
  revalidatePath('/dashboard');
  return { ok: true, data: result.data };
}

/** Answer the clarifying question a run is waiting on. */
export async function answerRunAction(runId: string, answer: string): Promise<RunActionResult<AIRequestResponse>> {
  const startedAt = Date.now();
  const reply = answer.trim();
  if (!runId) return { ok: false, error: 'That run could not be found.', code: 'not_found' };
  if (!reply) return { ok: false, error: 'Type an answer for Bubaly.', code: 'answer_required' };
  if (reply.length > MAX_AI_ANSWER_CHARS) return { ok: false, error: 'That answer is too long.', code: 'answer_too_long' };

  const ctx = await requireUserContext();
  const supabase = await createServer();
  const result = await answerClarification(scopeFromUserContext(ctx, supabase), runId, reply, { startedAtMs: startedAt });
  if (!result.ok) return { ok: false, error: result.error, code: result.code };
  revalidatePath(runPagePath(runId));
  if (result.data.runId && result.data.runId !== runId) revalidatePath(runPagePath(result.data.runId));
  return { ok: true, data: result.data };
}

/** Pause, resume, cancel, or re-run a step. Authority is decided in lib/ai/runs/controls.ts. */
export async function controlRunAction(
  runId: string,
  action: RunControlAction,
  args: { stepId?: string | null } = {},
): Promise<RunActionResult<RunControlResult>> {
  const startedAt = Date.now();
  if (!runId) return { ok: false, error: 'That run could not be found.', code: 'not_found' };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const result = await applyRunControl(scopeFromUserContext(ctx, supabase), runId, action, args, { startedAtMs: startedAt });
  if (!result.ok) return { ok: false, error: result.error, code: result.code };
  revalidatePath(runPagePath(runId));
  revalidatePath('/home');
  return { ok: true, data: result.data };
}

/** The run detail for the page's client refresh; null when the run is not this family's. */
export async function loadRunAction(runId: string): Promise<RunActionResult<RunDetailView | null>> {
  if (!runId) return { ok: true, data: null };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const detail = await loadRunDetail(supabase, ctx.active.familyId, runId, { viewerRole: ctx.active.role });
  if (!detail.ok) return { ok: false, error: detail.error, code: detail.code };
  return { ok: true, data: detail.data };
}
