'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { describeDbError } from '@/lib/supabase/errors';

// Save a learned Playbook insight into the Knowledge Base as a real family_fact
// the family then owns (and can edit/pin/delete like any other). Family-scoped
// via RLS; the family chose to save it, so this is an explicit, reversible write.
export async function savePlaybookFactAction(input: {
  category: string; label: string; value: string; detail?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const ctx = await requireUserContext();
    const supabase = await createServer();
    if (!input.label?.trim() || !input.value?.trim()) {
      return { ok: false, error: 'Nothing to save.' };
    }
    const { error } = await supabase.from('family_facts').insert({
      family_id: ctx.active.familyId,
      category: input.category || 'preference',
      label: input.label.trim(),
      value: input.value.trim(),
      notes: input.detail ? `Learned from your activity — ${input.detail}` : null,
      created_by: ctx.user.id,
    });
    if (error) return { ok: false, error: describeDbError(error, 'Could not save to the playbook.') };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeDbError(err, 'Could not save to the playbook.') };
  }
}
