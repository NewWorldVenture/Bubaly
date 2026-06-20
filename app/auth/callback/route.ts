import { NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { isSuperAdminEmail } from '@/lib/constants/super-admins';

// Handles the redirect after email confirmation / magic link / OAuth.
// Exchanges the code for a session, then sends the user into the app.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/dashboard';

  if (code) {
    const supabase = await createServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Super admins land on the admin console; everyone else on the dashboard.
      // Check the env/code allowlist as well as the DB RPC, so this works even
      // before migration 0008 is applied.
      const { data: { user } } = await supabase.auth.getUser();
      const isAdmin = isSuperAdminEmail(user?.email) || (await supabase.rpc('is_super_admin')).data === true;
      const destination = isAdmin && next === '/dashboard' ? '/admin' : next;
      return NextResponse.redirect(new URL(destination, url.origin));
    }
  }
  return NextResponse.redirect(new URL('/login?error=auth', url.origin));
}
