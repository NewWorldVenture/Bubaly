import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { BrowserContext, Cookie } from '@playwright/test';
import type { Database } from '../../../lib/database.types';

/** This fixture never accepts the generic remote-E2E override. */
export function requireLocalOrigin(value: string | undefined): string {
  let url: URL;
  try { url = new URL(value ?? ''); } catch { throw new Error('Durable-session E2E requires local HTTP origins.'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Durable-session E2E refuses non-local or ambiguous origins.');
  }
  return url.origin;
}

type Admin = SupabaseClient<Database>;
export type OwnedAccount = { email: string; password: string; userId: string; familyId: string; dispose: () => Promise<void> };

export async function createOwnedAccount(provider: string, serviceKey: string): Promise<OwnedAccount> {
  const origin = requireLocalOrigin(provider);
  if (!serviceKey) throw new Error('Durable-session E2E requires the disposable backend service key.');
  const admin: Admin = createClient<Database>(origin, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) },
  });
  const email = `durable-session-${randomUUID()}@example.test`;
  const password = `Ds1!${randomBytes(24).toString('base64url')}`;
  const familyId = randomUUID();
  let userId: string | null = null;
  let disposed = false;

  async function dispose() {
    if (disposed || !userId) return;
    let failed = false;
    try {
      // Only IDs created by this fixture, with an additional owner predicate.
      const { error } = await admin.from('families').delete().eq('id', familyId).eq('created_by', userId);
      failed = !!error;
    } catch { failed = true; }
    try {
      const { error } = await admin.auth.admin.deleteUser(userId);
      failed ||= !!error;
    } catch { failed = true; }
    if (failed) throw new Error('Durable-session E2E could not clean up its owned fixture.');
    disposed = true;
  }

  try {
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: 'Session Fixture' },
    });
    if (error || !data.user) throw new Error('Fixture account creation failed.');
    userId = data.user.id;
    const family = await admin.from('families').insert({
      id: familyId, name: 'Durable Session Fixture', created_by: userId,
      timezone: 'UTC', trial_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    if (family.error) throw new Error('Fixture household creation failed.');
    const member = await admin.from('family_members').upsert({
      family_id: familyId, user_id: userId, role: 'parent', display_name: 'Session Fixture', is_active: true,
    }, { onConflict: 'family_id,user_id' });
    if (member.error) throw new Error('Fixture membership creation failed.');
    const preferences = await admin.from('user_preferences').upsert({
      user_id: userId, active_family_id: familyId, notification_prefs: { onboardingComplete: true },
    }, { onConflict: 'user_id' });
    if (preferences.error) throw new Error('Fixture preferences creation failed.');
    return { email, password, userId, familyId, dispose };
  } catch {
    await dispose();
    // Provider errors may carry request details. Keep them out of CI reports.
    throw new Error('Durable-session E2E could not initialize its owned fixture.');
  }
}

export function authCookieName(provider: string): string {
  return `sb-${new URL(requireLocalOrigin(provider)).hostname.split('.')[0]}-auth-token`;
}

export function authCookies(cookies: Cookie[], name: string): Cookie[] {
  return cookies.filter((cookie) => cookie.name === name || (cookie.name.startsWith(`${name}.`) && /^\d+$/.test(cookie.name.slice(name.length + 1))));
}

type StoredSession = { access_token: string; refresh_token: string; expires_at: number; expires_in?: number; user: { id: string }; [key: string]: unknown };

/** Session contents remain in memory and never become matcher input. */
export function readSession(cookies: Cookie[], name: string): StoredSession {
  try {
    const parts = authCookies(cookies, name).sort((a, b) => Number(a.name.slice(name.length + 1)) - Number(b.name.slice(name.length + 1)));
    if (parts.length === 0 || (parts.length === 1 && parts[0].name !== name && parts[0].name !== `${name}.0`)
      || (parts.length > 1 && parts.some((part, index) => part.name !== `${name}.${index}`))) throw new Error();
    let raw = parts.map((cookie) => cookie.value).join('');
    if (raw.startsWith('base64-')) raw = Buffer.from(raw.slice(7), 'base64url').toString('utf8');
    const session = JSON.parse(raw) as StoredSession;
    if (!session || typeof session.access_token !== 'string' || !session.access_token
      || typeof session.refresh_token !== 'string' || !session.refresh_token
      || typeof session.expires_at !== 'number' || !Number.isFinite(session.expires_at)
      || typeof session.user?.id !== 'string') throw new Error();
    return session;
  } catch { throw new Error('Durable-session E2E expected a complete stored session.'); }
}

export function expiredSessionCookies(cookies: Cookie[], name: string, now = Date.now()): Cookie[] {
  const session = readSession(cookies, name);
  // Change the SDK's stored expiry only. Leave the signed JWT and refresh token
  // intact; the next middleware request must perform a real GoTrue refresh.
  session.expires_at = Math.floor(now / 1000) - 3600;
  session.expires_in = 0;
  const raw = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
  const template = authCookies(cookies, name)[0];
  const values = raw.match(/.{1,3180}/g)!;
  return values.map((value, index) => ({ ...template, name: values.length === 1 ? name : `${name}.${index}`, value }));
}

export async function expireStoredSession(context: BrowserContext, name: string): Promise<void> {
  const cookies = await context.cookies();
  const expired = expiredSessionCookies(cookies, name);
  try {
    // Keep locale, consent, and other application cookies. Only auth is changed.
    for (const cookie of authCookies(cookies, name)) await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
    await context.addCookies(expired);
  } catch { throw new Error('Durable-session E2E could not update its in-memory cookie jar.'); }
}

export async function closeWithoutSnapshot(context: BrowserContext): Promise<void> {
  // Close pages before their context so even an assertion failure cannot attach
  // a login form's values to Playwright's automatic error-context snapshot.
  const pages = await Promise.allSettled(context.pages().map((page) => page.close()));
  try { await context.close(); }
  catch { throw new Error('Durable-session E2E could not close its browser context.'); }
  if (pages.some((result) => result.status === 'rejected')) throw new Error('Durable-session E2E could not close its browser pages.');
}
