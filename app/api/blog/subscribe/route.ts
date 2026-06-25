import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  const limit = rateLimit(`blog-subscribe:${ip}`, { limit: 5, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } },
    );
  }

  try {
    const { email } = (await req.json()) as { email?: string };

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'A valid email address is required.' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data: existing } = await supabase
      .from('marketing_suppressions')
      .select('email')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ ok: true, message: 'You have been re-subscribed.' });
    }

    await supabase.from('marketing_form_submissions').insert({
      form_id: 'blog-newsletter',
      email: email.toLowerCase(),
      source: 'blog',
    });

    return NextResponse.json({ ok: true, message: 'Thanks for subscribing!' });
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}
