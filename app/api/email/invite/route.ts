import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { sendReactEmail } from '@/lib/email';
import { InviteEmail } from '@/lib/emails/invite';
import * as React from 'react';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';

const MAX_EMAIL_REQUEST_BYTES = 4_096;

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const body = await readBoundedRequestJson(req, MAX_EMAIL_REQUEST_BYTES);
    if (!body.ok) return NextResponse.json({ error: body.reason === 'too_large' ? 'Request body too large.' : 'Invalid request body.' }, { status: body.reason === 'too_large' ? 413 : 400 });
    const { inviteId } = (body.value && typeof body.value === 'object' ? body.value : {}) as { inviteId?: string };
    if (!inviteId || inviteId.length > 80) return NextResponse.json({ error: t('invite.invalidInvite') }, { status: 400 });

    const supabase = await createServer();

    const { data: invite } = await supabase
      .from('invites')
      .select('*, families(name)')
      .eq('id', inviteId)
      .eq('family_id', ctx.active.familyId)
      .single();

    if (!invite) return NextResponse.json({ error: t('invite.inviteNotFound') }, { status: 404 });

    // The recipient of this mail is a free-text address the inviter chose —
    // components/family/invite-form.tsx inserts the row straight from the
    // browser — and this route re-sends on every call, with no dedupe and no
    // count. So one invite row could be turned into unlimited mail from
    // Bubaly's own sender to an address of the caller's choosing.
    //
    // Every sibling endpoint with an outbound side effect already carries this
    // guard (billing, sync, gift, contact, forms, push, blog subscribe), and
    // the referral path — which mails a caller-chosen address for the same
    // reason — has a dedicated per-family policy of its own. This was the one
    // that had neither. Keyed per FAMILY, because the thing to bound is that
    // household's total outbound, not one member's share of it.
    const limited = await enforceRequestRateLimit(
      supabase, `email:invite:${ctx.active.familyId}`, { limit: 20, windowMs: 3_600_000 },
    );
    if (!limited.ok) {
      return NextResponse.json(
        { error: t('requests.tooManyRequestsPleaseTry') },
        { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
      );
    }

    const inviterName = ctx.active.member.display_name;
    const familyName = ctx.active.family.name;

    const { ok } = await sendReactEmail({
      to: invite.email,
      subject: `${inviterName} invited you to join ${familyName} on Bubaly`,
      react: React.createElement(InviteEmail, {
        familyName,
        inviterName,
        token: invite.token,
        role: invite.role,
      }),
    });
    if (!ok) return NextResponse.json({ error: t('invite.failedToSendInvite') }, { status: 502 });

    return NextResponse.json({ sent: true });
  } catch (err) {
    console.error('Invite email error:', err);
    return NextResponse.json({ error: t('invite.failedToSendInvite') }, { status: 500 });
  }
}
