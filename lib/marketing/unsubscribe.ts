import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed unsubscribe tokens so the public unsubscribe link can't be forged or
// enumerated. Token = HMAC-SHA256(email) using a server secret.
function secret(): string {
  return (
    process.env.MARKETING_UNSUB_SECRET ||
    process.env.INTERNAL_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    'familyos-dev-unsub-secret'
  );
}

export function unsubToken(email: string): string {
  return createHmac('sha256', secret()).update(email.trim().toLowerCase()).digest('hex');
}

export function verifyUnsubToken(email: string, token: string): boolean {
  if (!token) return false;
  const expected = unsubToken(email);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function unsubUrl(appUrl: string, email: string): string {
  const e = encodeURIComponent(email.trim().toLowerCase());
  return `${appUrl.replace(/\/$/, '')}/api/marketing/unsubscribe?e=${e}&t=${unsubToken(email)}`;
}
