import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { sendReactEmail } from '@/lib/email';
import { InviteEmail } from '@/lib/emails/invite';
import * as React from 'react';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';

const MAX_EMAIL_REQUEST_BYTES = 4_096;

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const body = await readBoundedRequestJson(req, MAX_EMAIL_REQUEST_BYTES);
    if (!body.ok) return NextResponse.json({ error: body.reason === 'too_large' ? 'Request body too large.' : 'Invalid request body.' }, { status: body.reason === 'too_large' ? 413 : 400 });
    const { inviteId } = (body.value && typeof body.value === 'object' ? body.value : {}) as { inviteId?: string };
    if (!inviteId || inviteId.length > 80) return NextResponse.json({ error: 'Invalid invite' }, { status: 400 });

    const supabase = await createServer();

    const { data: invite } = await supabase
      .from('invites')
      .select('*, families(name)')
      .eq('id', inviteId)
      .eq('family_id', ctx.active.familyId)
      .single();

    if (!invite) return NextResponse.json({ error: 'Invite not found' }, { status: 404 });

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
    if (!ok) return NextResponse.json({ error: 'Failed to send invite' }, { status: 502 });

    return NextResponse.json({ sent: true });
  } catch (err) {
    console.error('Invite email error:', err);
    return NextResponse.json({ error: 'Failed to send invite' }, { status: 500 });
  }
}
