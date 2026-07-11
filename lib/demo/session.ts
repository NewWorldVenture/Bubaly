import 'server-only';
import { randomBytes } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { DEMO_EMAIL_DOMAIN, demoExpiry } from './config';
import { seedDemoFamily } from './seed';

export type DemoCreds = { userId: string; email: string; password: string; expiresAt: string };

/**
 * Provision a fresh, throwaway Family+ demo: a new auth user under a synthetic
 * (never-emailed) address, a Family+ family (plan 'plus' → full capabilities),
 * seeded with a believable dataset, and a demo_sessions row that expires in 5
 * minutes. Returns credentials the caller uses to sign the visitor in. On any
 * failure the half-created user is deleted so nothing lingers.
 */
export async function startDemoSession(): Promise<DemoCreds | null> {
  const admin = createServiceClient();
  const token = randomBytes(9).toString('hex');
  const email = `demo-${token}@${DEMO_EMAIL_DOMAIN}`;
  const password = randomBytes(24).toString('base64url');

  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { demo: true, full_name: 'Demo Family' },
  });
  if (cErr || !created?.user) { console.error('[demo] createUser failed', cErr); return null; }
  const userId = created.user.id;
  let familyId: string | null = null;

  try {
    const { data: family, error: fErr } = await admin
      .from('families').insert({ name: 'Your Demo Family', timezone: 'UTC', created_by: userId })
      .select('id').single();
    if (fErr || !family) throw fErr ?? new Error('family insert returned no row');
    familyId = family.id;

    await admin.from('family_members').upsert(
      { family_id: familyId, user_id: userId, role: 'parent', display_name: 'You', is_active: true },
      { onConflict: 'family_id,user_id' },
    );
    // Family+ so every capability is unlocked (plan 'plus' resolves to level 2).
    await admin.from('subscriptions').insert({
      family_id: familyId, plan: 'plus', status: 'active',
      current_period_end: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await admin.from('user_preferences').upsert(
      { user_id: userId, active_family_id: familyId }, { onConflict: 'user_id' },
    );

    await seedDemoFamily(admin, familyId, userId);

    const expiresAt = demoExpiry().toISOString();
    await admin.from('demo_sessions').upsert({ user_id: userId, family_id: familyId, expires_at: expiresAt }, { onConflict: 'user_id' });

    return { userId, email, password, expiresAt };
  } catch (e) {
    console.error('[demo] provisioning failed — cleaning up', e);
    if (familyId) await admin.from('families').delete().eq('id', familyId);
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    return null;
  }
}

/**
 * Fully tear down a demo: delete the family (cascades all its data) and the auth
 * user (cascades the membership, prefs and demo_sessions row). Idempotent + safe
 * to call when the user is already gone.
 */
export async function endDemoSession(userId: string): Promise<void> {
  const admin = createServiceClient();
  try {
    const { data } = await admin.from('demo_sessions').select('family_id').eq('user_id', userId).maybeSingle();
    if (data?.family_id) await admin.from('families').delete().eq('id', data.family_id);
  } catch (e) {
    console.error('[demo] family delete failed', e);
  }
  await admin.auth.admin.deleteUser(userId).catch(() => {});
}

/** Reap demo sessions past their expiry (the cron + a guard on each new start). */
export async function cleanupExpiredDemoSessions(now: Date = new Date()): Promise<number> {
  const admin = createServiceClient();
  const { data } = await admin.from('demo_sessions').select('user_id').lt('expires_at', now.toISOString()).limit(500);
  let n = 0;
  for (const r of data ?? []) { await endDemoSession(r.user_id); n++; }
  return n;
}
