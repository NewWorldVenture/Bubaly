'use server';

// The server actions behind the approval card (components/approvals/approval-card.tsx).
//
// They are deliberately thin: identity comes from `requireUserContext`, the
// manager gate and every write live in `lib/services/approvals`, and the
// result is the service's own `ServiceResult` so the card can show the same
// copy whether the decision came from Home, the trust inbox, a run page or a
// chat bubble. `revalidatePath` covers every surface that lists approvals, so
// a card that disappears optimistically is also gone on the next render.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { decide, editAndApprove, type DecideResult, type EditResult } from '@/lib/services/approvals';
import type { ServiceResult } from '@/lib/services/types';

const SURFACES = ['/home', '/dashboard', '/dashboard/trust', '/dashboard/inbox', '/dashboard/concierge', '/dashboard/autonomous-family-management'];

function revalidateSurfaces(): void {
  for (const path of SURFACES) revalidatePath(path);
}

export async function decideApproval(input: {
  id: string;
  decision: 'approved' | 'rejected';
  note?: string | null;
}): Promise<ServiceResult<DecideResult>> {
  const ctx = await requireUserContext();
  const scope = scopeFromUserContext(ctx, await createServer());
  const result = await decide(scope, input.id, input.decision, input.note ?? null);
  revalidateSurfaces();
  return result;
}

export async function editAndApproveApproval(input: {
  id: string;
  edits: Record<string, string | number | boolean>;
  note?: string | null;
}): Promise<ServiceResult<EditResult>> {
  const ctx = await requireUserContext();
  const scope = scopeFromUserContext(ctx, await createServer());
  const result = await editAndApprove(scope, input.id, input.edits, input.note ?? null);
  revalidateSurfaces();
  return result;
}
