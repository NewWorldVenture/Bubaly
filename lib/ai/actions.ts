// lib/ai/actions.ts — the bridge between AI tool calls and real Supabase writes.
// Every action is RLS-scoped to the caller's family. The AI cannot touch other families'
// data because it runs through the user's authenticated Supabase client.
//
// SINCE THE TOOL REGISTRY LANDED this file is a thin FRONT DOOR, not an
// implementation. `lib/ai/tools/*` is the real one for everything it covers,
// and `runAction` delegates to `executeTool` so those calls get what the
// hand-written branches never had: zod-validated arguments, the
// `ai_tool_calls` idempotency ledger, output validation, §13 verification, a
// family-visible activity line, and services that write the RIGHT foreign key
// (`todo_lists.created_by` references `family_members(id)`, not `auth.users`,
// which the old `add_todo` branch got wrong).
//
// WHY THE NAME AND SHAPE ARE FROZEN: two callers hold `{name, args}` payloads
// written before the registry existed — Magic Import
// (`app/api/ai/import/route.ts`) and the trust queue's auto-execute of an
// approved request (`app/(app)/dashboard/trust/actions.ts`, which reads
// `approval_requests.payload`). The registry resolves those legacy flat names
// as aliases, so a payload stored months ago still lands on the same tool.
//
// WHO CHECKS TRUST: by default `executeTool` does, which is stricter than what
// this file used to get — `wrapToolsWithTrust`'s `TOOL_DOMAIN` map has no entry
// for `create_chore` or `create_reminder`, so those two passed the assistant's
// wrapper ungated. The registry gates by the tool's own domain and §12 risk
// tier, so there is nothing left to forget to list.
//
// `alreadyAuthorized` is the opt-out, for a caller that has just run the same
// check itself: Magic Import calls `evaluateTrust` per item immediately before
// this, and the trust queue reaches here only once a parent has approved the
// request. That second case is not an optimization — re-evaluating a decision a
// parent already made would open a SECOND approval for the same work, and the
// approved action would never run.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import type { AITool } from './provider';
import type { MemberRole } from '@/lib/constants/roles';
import type { ServiceScope } from '@/lib/services/types';
import { describeActionError, describeDbError } from '@/lib/supabase/errors';
import { settleAll } from '@/lib/supabase/settle';
import { executeTool } from './tools/execute';
import { getTool } from './tools/registry';

type Ctx = { supabase: SupabaseClient<Database>; familyId: string; userId: string };

export type RunActionOptions = {
  /**
   * Set only by a caller that has already evaluated this exact call against the
   * trust engine, or that is replaying a request a parent has approved. It
   * suppresses the registry's own gate; see the note at the top of this file
   * for why the approval-replay path must set it.
   */
  alreadyAuthorized?: boolean;
};

function actionFailure(operation: string, error: unknown): { ok: false; error: string } {
  console.error(`[ai-action] ${operation} failed:`, error);
  return { ok: false, error: describeActionError(error, `Could not ${operation}.`) };
}

/**
 * The acting member and the family's zone — what a `ServiceScope` needs and a
 * `Ctx` does not carry.
 *
 * Memoized per Supabase client because Magic Import confirms up to 50 items in
 * one `Promise.all`; without this that is 100 extra round trips for two values
 * that cannot change inside a request. Only successes are cached, so a
 * transient read failure is retried rather than remembered.
 */
type ScopeIdentity = { memberId: string; role: MemberRole; tz: string };
const SCOPE_CACHE = new WeakMap<SupabaseClient<Database>, Map<string, ScopeIdentity>>();

async function resolveScope(ctx: Ctx): Promise<{ ok: true; scope: ServiceScope } | { ok: false; error: string }> {
  const cacheKey = `${ctx.familyId}:${ctx.userId}`;
  let byFamily = SCOPE_CACHE.get(ctx.supabase);
  let identity = byFamily?.get(cacheKey);

  if (!identity) {
    const [{ data: member, error: memberError }, { data: family, error: familyError }] = await settleAll([
      ctx.supabase.from('family_members').select('id, role')
        .eq('family_id', ctx.familyId).eq('user_id', ctx.userId).eq('is_active', true).maybeSingle(),
      ctx.supabase.from('families').select('timezone').eq('id', ctx.familyId).maybeSingle(),
    ]);
    // Fail closed: without the member row a service would write a null or wrong
    // `created_by`, and without the zone every time in every summary is the
    // server's rather than the family's.
    const readError = memberError ?? familyError;
    if (readError) {
      console.error('[ai-action] could not resolve the acting member or family timezone', readError);
      return { ok: false, error: describeDbError(readError, 'Could not confirm who is asking, so nothing was changed.') };
    }
    if (!member) {
      console.error('[ai-action] no active family_members row', { familyId: ctx.familyId, userId: ctx.userId });
      return { ok: false, error: 'You are not an active member of this family, so nothing was changed.' };
    }
    identity = { memberId: member.id, role: member.role as MemberRole, tz: family?.timezone || 'UTC' };
    if (!byFamily) { byFamily = new Map(); SCOPE_CACHE.set(ctx.supabase, byFamily); }
    byFamily.set(cacheKey, identity);
  }

  return {
    ok: true,
    scope: {
      db: ctx.supabase,
      familyId: ctx.familyId,
      userId: ctx.userId,
      memberId: identity.memberId,
      role: identity.role,
      // Every path into `runAction` is the assistant, Magic Import, or the
      // replay of an action the assistant proposed — agent work in all three,
      // which is what the activity feed and `ai_tool_calls.actor_kind` record.
      actorKind: 'ai',
      tz: identity.tz,
    },
  };
}

export const AI_TOOLS: AITool[] = [
  {
    name: 'create_calendar_event',
    description: 'Add an event to the family calendar.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        starts_at: { type: 'string', description: 'ISO 8601 datetime' },
        ends_at: { type: 'string' },
        category: { type: 'string', enum: ['general','school','sports','appointment','medication','maintenance','birthday','holiday','other'] },
      },
      required: ['title', 'starts_at'],
    },
  },
  {
    name: 'create_chore',
    description: 'Create a chore for the household.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string' }, points: { type: 'number' }, due_at: { type: 'string' } },
      required: ['title'],
    },
  },
  {
    name: 'create_reminder',
    description: 'Create a reminder (e.g. change the HVAC filter).',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string' }, remind_at: { type: 'string' }, recurrence: { type: 'string' } },
      required: ['title', 'remind_at'],
    },
  },
  {
    name: 'add_grocery_item',
    description: 'Add an item to the weekly grocery list.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' }, quantity: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'create_meal_plan_entry',
    description: 'Plan a meal on a given date.',
    input_schema: {
      type: 'object',
      properties: { meal_name: { type: 'string' }, plan_date: { type: 'string' }, meal_type: { type: 'string' } },
      required: ['meal_name', 'plan_date'],
    },
  },
];

// Executes a tool call against Supabase. Returns a result the AI can summarize.
// Handles both Magic-Import action names and AI-Assistant chat tool names so
// approved approval_requests payloads can be auto-executed regardless of origin.
//
// Registry-covered names go to `executeTool` (see the header). The switch below
// is what the registry does not cover yet — meal planning, notes, goals and
// announcements — and is the only place a write is still hand-rolled here.
//
// The third argument is optional so every existing call site keeps compiling
// and keeps its current meaning; only a caller that has just evaluated trust
// itself sets it.
export async function runAction(
  ctx: Ctx,
  call: { name: string; args: Record<string, any> },
  opts: RunActionOptions = {},
): Promise<{ ok: boolean; data?: unknown; error?: string; summary?: string }> {
  if (getTool(call.name)) {
    const scoped = await resolveScope(ctx);
    if (!scoped.ok) return { ok: false, error: scoped.error };
    const outcome = await executeTool(scoped.scope, call.name, call.args ?? {}, {
      skipTrust: opts.alreadyAuthorized === true,
    });
    switch (outcome.status) {
      case 'ok':
        return { ok: true, data: outcome.data, summary: outcome.summary };
      case 'denied':
        return { ok: false, error: outcome.reason };
      case 'pending_approval':
        // Unreachable while `skipTrust` is set, and reported as a failure if it
        // ever is reached: `ok` means the change happened, and a pending
        // approval means it has not. Saying otherwise would let Magic Import
        // count it as created and the trust queue stamp it executed.
        return { ok: false, error: outcome.summary };
      default:
        return { ok: false, error: outcome.error };
    }
  }

  // Everything this file used to hand-roll now has a registry tool, so an
  // unresolved name is a name nothing can do — a hallucination, or a tool
  // deleted without its callers. Either way the honest answer is a refusal, not
  // a silent no-op (§43 default deny).
  //
  // The `add_note` and `add_goal` branches that stood here were reachable only
  // while `getTool` returned null for them. `notes.create` and `goals.create`
  // resolve those names now, so the branches became unreachable — and dead code
  // that still looks like the live path is how the next reader learns the wrong
  // thing about where notes are written.
  return { ok: false, error: 'That action is not available.' };

}
