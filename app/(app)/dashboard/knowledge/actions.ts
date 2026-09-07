// The write path for the family's memory.
//
// `family_facts` was written from two modules — the knowledge base and life
// events — with every update and delete filtering `id` alone. That bypassed a
// rule the service has always had and the database does not:
//
//   forgetFact: "Only a parent or adult can forget a memory about someone else."
//
// Migration 0264 gates `medical` and `account` rows to managers and NOTHING
// else, so on every other category — a preference, a size, a milestone — a CHILD
// could edit or delete a memory about a sibling straight from the module.
// Verified against the replayed schema rather than inferred: acting as a child,
// `delete from family_facts` where the row belonged to a sibling removed one row.
//
// `updateFact` is by ID and carries the same rule. It is not `rememberFact`,
// which upserts by KEY — editing a fact whose label changed would have created a
// second memory rather than renaming the first.
'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { forgetFact, rememberFact, updateFact, type UpdateFactInput } from '@/lib/services/memory';
import { scopeFromUserContext } from '@/lib/services/scope';
import { describeActionError } from '@/lib/supabase/errors';

const KNOWLEDGE = '/dashboard/knowledge';
const LIFE_EVENTS = '/dashboard/life-events';

export type FactActionResult = { ok: true; id: string } | { ok: false; error: string };

/** Session + scope, resolved OUTSIDE the try: `requireUserContext` redirects by throwing. */
async function memoryScope() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  return scopeFromUserContext(ctx, supabase);
}

function refresh(): void {
  // Both modules render `family_facts`; a write from one must not leave the
  // other showing what it replaced.
  revalidatePath(KNOWLEDGE);
  revalidatePath(LIFE_EVENTS);
}

export async function saveFactAction(
  factId: string | null,
  input: UpdateFactInput & { label: string; value: string },
): Promise<FactActionResult> {
  const scope = await memoryScope();

  try {
    if (factId) {
      const result = await updateFact(scope, factId, input);
      if (!result.ok) return { ok: false, error: result.error };
      refresh();
      return { ok: true, id: result.data.id };
    }

    // `source: 'user'` is the whole point of 0265's column: a person typed this,
    // so it is not AI memory and "Clear memories" must never take it.
    const result = await rememberFact(scope, {
      key: input.label,
      content: input.value,
      category: input.category ?? null,
      note: input.notes ?? null,
      memberId: input.memberId ?? null,
      source: 'user',
      confidence: 100,
    });
    if (!result.ok) return { ok: false, error: result.error };
    refresh();
    return result.data.kind === 'fact'
      ? { ok: true, id: result.data.fact.id }
      : { ok: true, id: result.data.suggestion.id };
  } catch (err) {
    console.error('[memory-action] save failed', err);
    return { ok: false, error: describeActionError(err, 'Could not save that memory.') };
  }
}

export async function setFactPinnedAction(factId: string, pinned: boolean): Promise<FactActionResult> {
  if (!factId) return { ok: false, error: 'That memory could not be found.' };
  const scope = await memoryScope();

  try {
    const result = await updateFact(scope, factId, { pinned });
    if (!result.ok) return { ok: false, error: result.error };
    refresh();
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[memory-action] pin failed', err);
    return { ok: false, error: describeActionError(err, 'Could not pin that memory.') };
  }
}

export async function forgetFactAction(factId: string): Promise<FactActionResult> {
  if (!factId) return { ok: false, error: 'That memory could not be found.' };
  const scope = await memoryScope();

  try {
    const result = await forgetFact(scope, factId, { kind: 'fact' });
    if (!result.ok) return { ok: false, error: result.error };
    refresh();
    return { ok: true, id: factId };
  } catch (err) {
    console.error('[memory-action] forget failed', err);
    return { ok: false, error: describeActionError(err, 'Could not remove that memory.') };
  }
}
