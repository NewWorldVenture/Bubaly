import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { sendReactEmail } from '@/lib/email';
import { WelcomeEmail } from '@/lib/emails/welcome';
import * as React from 'react';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { hasInternalSecret } from '@/lib/server/cron-auth';

const MAX_EMAIL_REQUEST_BYTES = 4_096;

// Called server-side after onboarding completes (via server action).
export async function POST(req: NextRequest) {
  try {
    // Verify internal secret so this can only be called from our own server actions
    if (!hasInternalSecret(req)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await readBoundedRequestJson(req, MAX_EMAIL_REQUEST_BYTES);
    if (!body.ok) return NextResponse.json({ error: body.reason === 'too_large' ? 'Request body too large.' : 'Invalid request body.' }, { status: body.reason === 'too_large' ? 413 : 400 });
    const { email, name } = (body.value && typeof body.value === 'object' ? body.value : {}) as { email?: string; name?: string };
    if (!email || !name) return NextResponse.json({ error: 'Missing params' }, { status: 400 });
    if (email.length > 320 || name.length > 120) return NextResponse.json({ error: 'Invalid params' }, { status: 400 });

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
