'use server';

import { getTranslations } from '@/lib/i18n/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { ROLE_LABEL_KEYS, ROLE_ORDER, type MemberRole } from '@/lib/constants/roles';
import { isChildLoginEmail } from '@/lib/onboarding/child-login';
import { closePendingInvitesFor } from '@/lib/server/member-invites';

export type InvitePreview =
  | { ok: true; familyName: string; roleLabel: string }
  | { ok: false; reason: 'signed_out' | 'kid_login' | 'different_email' | 'invalid' | 'unavailable' };

/**
 * What an invite would do, shown BEFORE it is accepted.
 *
 * The join page used to call accept_invite as soon as it loaded, so any page
 * that redirected a signed-in person to /join?token=… enrolled them in the
 * inviting family without a click — their name went to that family, and its
 * notifications to their phone. The page now asks first, and this is what it
 * shows: the family and the role, and only to the address the invite names
 * (the same address accept_invite insists on), so a token tells nobody else
 * anything. Service role, because the invitee is not yet a member who could
 * read the invite or the family.
 */
export async function previewInviteAction(token: string): Promise<InvitePreview> {
  if (typeof token !== 'string' || !token || token.length > 200) return { ok: false, reason: 'invalid' };
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, reason: 'signed_out' };
  if (isChildLoginEmail(auth.user.email)) return { ok: false, reason: 'kid_login' };

  const { data: invite, error } = await createServiceClient().from('invites')
    .select('family_id, email, role, status, expires_at, accepted_by, family:families(name)')
    .eq('token', token).maybeSingle();
  if (error) {
    console.error('[join] invite preview read failed', { code: (error as { code?: string }).code ?? null });
    return { ok: false, reason: 'unavailable' };
  }
  if (!invite) return { ok: false, reason: 'invalid' };
  const mine = (invite.email ?? '').trim().toLowerCase() === (auth.user.email ?? '').trim().toLowerCase();
  if (!mine) return { ok: false, reason: 'different_email' };
  // accept_invite answers a re-accept of your own accepted invite with success,
  // so the page offers it the same way; anything else that is not live is dead.
  const acceptedByMe = invite.status === 'accepted' && invite.accepted_by === auth.user.id;
  const expires = Date.parse(invite.expires_at ?? '');
  const live = invite.status === 'pending' && Number.isFinite(expires) && expires > Date.now();
  if (!acceptedByMe && !live) return { ok: false, reason: 'invalid' };

  const t = await getTranslations();
  const role = (ROLE_ORDER as string[]).includes(invite.role) ? invite.role as MemberRole : null;
  const family = invite.family as { name?: string | null } | null;
  return { ok: true, familyName: family?.name?.trim() || t('joinInvite.aFamily'), roleLabel: role ? t(ROLE_LABEL_KEYS[role]) : String(invite.role) };
}

/**
 * After joining through one invite, close the caller's OTHER pending invites
 * to the families they now belong to.
 *
 * accept_invite (0136) leaves sibling invites pending, and they are what let a
 * member the family later removed walk back in. Best-effort: the join stands
 * either way, and removal revokes them too. The families are the caller's own
 * active memberships, read here — never a family id the caller names — and
 * only invites addressed to the caller's own account are closed.
 */
export async function settleOtherInvitesAction(): Promise<{ ok: boolean }> {
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user?.email) return { ok: false };
  const service = createServiceClient();
  const { data: memberships, error } = await service.from('family_members').select('id, family_id')
    .eq('user_id', auth.user.id).eq('is_active', true).order('id').limit(100);
  if (error || !memberships) return { ok: false };
  let ok = true;
  for (const familyId of new Set(memberships.map((m) => m.family_id))) {
    if (!(await closePendingInvitesFor(service, familyId, { user_id: null, email: auth.user.email }, 'expired'))) ok = false;
  }
  return { ok };
}
