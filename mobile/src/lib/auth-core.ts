// Pure helpers behind the auth provider (unit-tested from the repo root).

/** Turn Supabase auth error strings into copy a person can act on. */
export function friendlyAuthError(message: string | null | undefined): string {
  const m = (message ?? '').toLowerCase();
  if (!m) return 'Something went wrong. Please try again.';
  if (m.includes('invalid login credentials') || m.includes('invalid_credentials')) return 'That email and password don’t match.';
  if (m.includes('email not confirmed')) return 'Confirm your email first — check your inbox for the link.';
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts. Wait a minute and try again.';
  if (m.includes('network') || m.includes('fetch')) return 'Can’t reach Bubaly. Check your connection and try again.';
  return message ?? 'Something went wrong. Please try again.';
}

export function validateCredentials(email: string, password: string): string | null {
  const e = email.trim();
  if (!e) return 'Enter your email.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'That doesn’t look like an email address.';
  if (!password) return 'Enter your password.';
  return null;
}
