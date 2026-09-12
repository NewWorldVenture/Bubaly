'use server';

// Creating and revoking the keys that let a speaker act for this family.
//
// Creating one is a parent/admin action: the key is a standing grant to read
// the family's day and add to its lists, and it outlives the session that made
// it. requireUserContext resolves the family; the role check is explicit.
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { logAudit } from '@/lib/server/audit';
import { issueAssistantToken } from '@/lib/assistant/link-token';

const PAGE = '/dashboard/assistants';

export type AssistantActionResult =
  | { ok: true; token?: string; message: string }
  | { ok: false; error: string };

const createSchema = z.object({
  label: z.string().trim().min(2, 'Give this key a name you will recognise').max(80),
  provider: z.enum(['alexa', 'siri', 'google', 'generic']),
  allowCapture: z.boolean(),
});

/** Only a parent or admin can hand out a standing grant. */
function canManage(role: string): boolean {
  return role === 'parent' || role === 'admin';
}

export async function createAssistantLinkAction(formData: FormData): Promise<AssistantActionResult> {
  const ctx = await requireUserContext();
  if (!canManage(ctx.active.role)) return { ok: false, error: 'Only a parent can add an assistant.' };

  const parsed = createSchema.safeParse({
    label: String(formData.get('label') ?? ''),
    provider: String(formData.get('provider') ?? 'generic'),
    allowCapture: formData.get('allowCapture') === 'on',
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form.' };

  const issued = issueAssistantToken();
  // Service-role: the row carries a secret hash the family's own client must
  // not be able to read back, and the column grant in 0283 enforces that.
  const admin = createServiceClient();
  const { error } = await admin.from('assistant_links').insert({
    family_id: ctx.active.familyId,
    user_id: ctx.user.id,
    provider: parsed.data.provider,
    label: parsed.data.label,
    token_hash: issued.tokenHash,
    token_prefix: issued.tokenPrefix,
    scopes: parsed.data.allowCapture ? ['ask', 'capture'] : ['ask'],
    created_by: ctx.user.id,
  });
  if (error) {
    console.error('[assistants] create failed', error);
    return { ok: false, error: 'Could not create that assistant key.' };
  }

  await logAudit(await createServer(), {
    familyId: ctx.active.familyId, actorId: ctx.user.id,
    action: 'create', resource: 'assistant_links',
    metadata: { provider: parsed.data.provider, capture: parsed.data.allowCapture },
  });
  revalidatePath(PAGE);
  // The only time the secret exists outside the caller's device. It is not
  // stored and cannot be shown again.
  return { ok: true, token: issued.token, message: 'Assistant key created. Copy it now — it is not shown again.' };
}

export async function revokeAssistantLinkAction(id: string): Promise<AssistantActionResult> {
  const ctx = await requireUserContext();
  if (!canManage(ctx.active.role)) return { ok: false, error: 'Only a parent can revoke an assistant.' };

  const admin = createServiceClient();
  // Scoped to this family as well as the id: an id from elsewhere must not
  // revoke another household's key.
  const { error } = await admin
    .from('assistant_links')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('family_id', ctx.active.familyId);
  if (error) {
    console.error('[assistants] revoke failed', error);
    return { ok: false, error: 'Could not revoke that key.' };
  }
  await logAudit(await createServer(), {
    familyId: ctx.active.familyId, actorId: ctx.user.id,
    action: 'update', resource: 'assistant_links', resourceId: id,
    metadata: { revoked: true },
  });
  revalidatePath(PAGE);
  return { ok: true, message: 'Assistant key revoked. It stops working immediately.' };
}
