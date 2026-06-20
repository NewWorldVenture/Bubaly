import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { sendReactEmail } from '@/lib/email';
import { InviteEmail } from '@/lib/emails/invite';
import * as React from 'react';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const { inviteId } = await req.json() as { inviteId: string };

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
      subject: `${inviterName} invited you to join ${familyName} on FamilyOS`,
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
