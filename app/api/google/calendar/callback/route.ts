import { NextRequest, NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { exchangeGoogleCode, type GoogleToken } from '@/lib/google';

// Google redirects here after the user grants calendar access.
// Exchanges code for tokens and stores in user_preferences.notification_prefs.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';

  if (errorParam || !code || !state) {
    return NextResponse.redirect(`${appUrl}/dashboard/calendar?gcal=error`);
  }

  try {
    const { userId } = JSON.parse(Buffer.from(state, 'base64url').toString()) as { userId: string; familyId: string };

    const token: GoogleToken = await exchangeGoogleCode(code);

    const supabase = await createServer();

    // Load existing prefs to merge
    const { data: prefs } = await supabase
      .from('user_preferences')
      .select('notification_prefs')
      .eq('user_id', userId)
      .maybeSingle();

    const existing = (prefs?.notification_prefs as Record<string, unknown>) ?? {};
    const merged = { ...existing, googleCalendarToken: token };

    await supabase
      .from('user_preferences')
      .upsert({ user_id: userId, notification_prefs: merged }, { onConflict: 'user_id' });

    return NextResponse.redirect(`${appUrl}/dashboard/calendar?gcal=connected`);
  } catch (err) {
    console.error('Google Calendar callback error:', err);
    return NextResponse.redirect(`${appUrl}/dashboard/calendar?gcal=error`);
  }
}
