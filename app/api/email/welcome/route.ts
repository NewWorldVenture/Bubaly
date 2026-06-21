import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { sendReactEmail } from '@/lib/email';
import { WelcomeEmail } from '@/lib/emails/welcome';
import * as React from 'react';

// Called server-side after onboarding completes (via server action).
export async function POST(req: NextRequest) {
  try {
    // Verify internal secret so this can only be called from our own server actions
    const auth = req.headers.get('x-internal-secret');
    if (auth !== process.env.INTERNAL_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { email, name } = await req.json() as { email: string; name: string };
    if (!email || !name) return NextResponse.json({ error: 'Missing params' }, { status: 400 });

    const { ok } = await sendReactEmail({
      to: email,
      subject: 'Welcome to Bubaly 🎉',
      react: React.createElement(WelcomeEmail, { name }),
    });
    if (!ok) return NextResponse.json({ error: 'Failed to send welcome email' }, { status: 502 });

    return NextResponse.json({ sent: true });
  } catch (err) {
    console.error('Welcome email error:', err);
    return NextResponse.json({ error: 'Failed to send welcome email' }, { status: 500 });
  }
}
