'use server';

import { createServer } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';
import { sendEmail } from '@/lib/server/email';
import { createFamilySchema, inviteSchema } from '@/lib/validation';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

/** Creates a family, makes the caller its parent (via DB trigger), sets it active. */
export async function createFamilyAction(input: { name: string; timezone: string }): Promise<Result<{ familyId: string }>> {
  const parsed = createFamilySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  const { data: family, error } = await supabase
    .from('families')
    .insert({ name: parsed.data.name, timezone: parsed.data.timezone, created_by: auth.user.id })
    .select()
    .single();
  if (error || !family) return { ok: false, error: error?.message ?? 'Could not create family' };

  // Add the creator as a parent member of the new family.
  const displayName = auth.user.user_metadata?.full_name
    ?? auth.user.email?.split('@')[0]
    ?? 'Parent';
  await supabase.from('family_members').insert({
    family_id: family.id,
    user_id: auth.user.id,
    role: 'parent',
    display_name: displayName,
    is_active: true,
  });

  // Make this the active family for the creator.
  await supabase.from('user_preferences').upsert(
    { user_id: auth.user.id, active_family_id: family.id },
    { onConflict: 'user_id' },
  );

  await logAudit(supabase, {
    familyId: family.id, actorId: auth.user.id,
    action: 'create', resource: 'families', resourceId: family.id,
    metadata: { name: family.name },
  });

  return { ok: true, data: { familyId: family.id } };
}

/** Adds a managed member with no login (e.g. a young child). */
export async function addLocalMemberAction(input: {
  familyId: string; displayName: string; role: 'child' | 'teen' | 'adult'; color?: string;
}): Promise<Result> {
  const name = input.displayName.trim();
  if (name.length < 1) return { ok: false, error: 'Name is required' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  const { error } = await supabase.from('family_members').insert({
    family_id: input.familyId,
    role: input.role,
    display_name: name,
    color: input.color ?? null,
  });
  if (error) return { ok: false, error: error.message };

  await logAudit(supabase, {
    familyId: input.familyId, actorId: auth.user.id,
    action: 'create', resource: 'family_members', metadata: { display_name: name, role: input.role },
  });
  return { ok: true };
}

/** Creates an invite row and emails a join link. */
export async function inviteMemberAction(input: {
  familyId: string; email: string; role: 'adult' | 'teen' | 'caregiver' | 'guest';
}): Promise<Result> {
  const parsed = inviteSchema.safeParse({ email: input.email, role: input.role });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid invite' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  const { data: invite, error } = await supabase
    .from('invites')
    .insert({ family_id: input.familyId, email: parsed.data.email, role: parsed.data.role, invited_by: auth.user.id })
    .select('token')
    .single();
  if (error || !invite) return { ok: false, error: error?.message ?? 'Could not create invite' };

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? '';
  const link = `${origin}/join?token=${invite.token}`;
  await sendEmail({
    to: parsed.data.email,
    subject: 'You’re invited to a family on FamilyOS',
    html: `<p>You’ve been invited to join a family on FamilyOS.</p><p><a href="${link}">Accept your invite</a></p>`,
  });

  await logAudit(supabase, {
    familyId: input.familyId, actorId: auth.user.id,
    action: 'create', resource: 'invites', metadata: { email: parsed.data.email, role: parsed.data.role },
  });
  return { ok: true };
}
