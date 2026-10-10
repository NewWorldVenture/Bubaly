import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { sendReactEmail } from '@/lib/email';
import { InviteEmail } from '@/lib/emails/invite';
import * as React from 'react';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { describeReadError } from '@/lib/supabase/settle';
import { isManager } from '@/lib/constants/roles';

const MAX_EMAIL_REQUEST_BYTES = 4_096;

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    // Only someone who may create an invite may have Bubaly mail one: the same
    // parent/adult rule as `invites_insert` (can_manage_family). Every member
    // can READ the family's invites, so without this a child or guest could mail
    // each of them under their own name, and spend the family's invite budget
    // below until a parent's real invite was refused.
    if (!isManager(ctx.active.role)) {
      return NextResponse.json({ error: t('actions.onlyAParentGuardianCan16') }, { status: 403 });
    }
    const body = await readBoundedRequestJson(req, MAX_EMAIL_REQUEST_BYTES);
    if (!body.ok) return NextResponse.json({ error: body.reason === 'too_large' ? 'Request body too large.' : 'Invalid request body.' }, { status: body.reason === 'too_large' ? 413 : 400 });
    const { inviteId } = (body.value && typeof body.value === 'object' ? body.value : {}) as { inviteId?: string };
    if (!inviteId || inviteId.length > 80) return NextResponse.json({ error: t('invite.invalidInvite') }, { status: 400 });

    const supabase = await createServer();

    // A refused read left the binding null and took the same branch as a row
    // that genuinely is not there, so the caller was told their own invite
    // does not exist. "Not found" is a claim about their data; it has to come
    // from an answer, not from the absence of one. Fails closed either way —
    // this changes WHICH closed answer is given, not whether one is. C1-S9-38.
    const { data: invite, error: inviteError } = await supabase
      .from('invites')
      .select('*, families(name)')
      .eq('id', inviteId)
      .eq('family_id', ctx.active.familyId)
      .maybeSingle();

    if (inviteError) {
      console.error('[email/invite] invite read failed', { familyId: ctx.active.familyId, error: describeReadError(inviteError) });
      return NextResponse.json({ error: t('invite.inviteDataIsTemporarilyUnavailable') }, { status: 503 });
    }
    if (!invite) return NextResponse.json({ error: t('invite.inviteNotFound') }, { status: 404 });
    // A revoked, accepted or expired invite was mailed like a live one and
    // reported sent; its link can only fail. Refused before the budget is spent.
    if (invite.status !== 'pending' || !(Date.parse(invite.expires_at) > Date.now())) {
      return NextResponse.json({ error: t('actions.inviteIsNoLongerPending') }, { status: 409 });
    }

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
    //
    // Evaluated with the service client. `rate_limit_hit` (0179) refuses a key
    // from a signed-in caller unless it names that caller's own id, so a family
    // key sent on the member's session raised, the limiter failed closed, and
    // every invite email answered 429: the invite form said it could not send
    // the invite, every time. The family key is the right bound; it is only
    // this server code, with no `auth.uid()`, that may reserve it.
    const limited = await enforceRequestRateLimit(
      createServiceClient(), `email:invite:${ctx.active.familyId}`, { limit: 20, windowMs: 3_600_000 },
    );
    if (!limited.ok) {
      return NextResponse.json(
        { error: t('requests.tooManyRequestsPleaseTry') },
        { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
      );
    }

    const inviterName = ctx.active.member.display_name;
    const familyName = ctx.active.family.name;

    const { ok, skipped } = await sendReactEmail({
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
    // No mail provider: the invite was not sent, so the inviter must not be told it was.
    if (skipped) return NextResponse.json({ error: t('invite.failedToSendInvite') }, { status: 503 });

    return NextResponse.json({ sent: true });
  } catch (err) {
    console.error('Invite email error:', err);
    return NextResponse.json({ error: t('invite.failedToSendInvite') }, { status: 500 });
  }
}
