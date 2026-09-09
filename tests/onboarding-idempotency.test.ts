import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { onboardingItemKey, onboardingRunKey } from '@/lib/onboarding/idempotency';

describe('onboarding finalization idempotency', () => {
  it('keeps the same submission key stable while separating users and payloads', () => {
    const payload = { family: { name: 'Hughen' }, members: [{ kind: 'local', name: 'Ava' }] };
    expect(onboardingRunKey('user-a', payload)).toBe(onboardingRunKey('user-a', { members: payload.members, family: payload.family }));
    expect(onboardingRunKey('user-a', payload)).not.toBe(onboardingRunKey('user-b', payload));
    expect(onboardingRunKey('user-a', payload)).not.toBe(onboardingRunKey('user-a', { ...payload, family: { name: 'Other' } }));
  });

  it('gives each row in one submission a deterministic, distinct identity', () => {
    const run = onboardingRunKey('user-a', { family: { name: 'Hughen' } });
    expect(onboardingItemKey(run, 'member', 0, { name: 'Ava' })).toBe(onboardingItemKey(run, 'member', 0, { name: 'Ava' }));
    expect(onboardingItemKey(run, 'member', 0, { name: 'Ava' })).not.toBe(onboardingItemKey(run, 'member', 1, { name: 'Ava' }));
    expect(onboardingItemKey(run, 'member', 0, { name: 'Ava' })).not.toBe(onboardingItemKey(run, 'invite', 0, { name: 'Ava' }));
  });

  it('uses database conflict targets for every replayable finalization write', () => {
    const fullSource = readFileSync('app/onboarding/actions.ts', 'utf8');
    const source = fullSource.slice(fullSource.indexOf('export async function finalizeOnboardingAction'));
    const migration = readFileSync('supabase/migrations/0210_onboarding_idempotency.sql', 'utf8');

    expect(source).toContain("onboarding_key: onboardingItemKey(runKey, 'member'");
    expect(source).toContain("onConflict: 'family_id,onboarding_key'");
    expect(source).toContain("onboarding_key: onboardingItemKey(runKey, 'calendar-event'");
    expect(source).toContain("onboardingItemKey(runKey, 'calendar-import'");
    expect(source).toContain("onboardingItemKey(connectedReceipt.accountId, 'connected-calendar-import'");
    expect(source).toContain("admin.rpc('onboarding_claim_family'");
    expect(source).not.toContain(".from('family_members').insert({");
    expect(source).not.toContain(".from('calendar_events').insert(chunk)");
    expect(migration).toContain('add column if not exists onboarding_key text');
    expect(migration).toContain('idx_family_members_onboarding_key');
    expect(migration).toContain('idx_invites_onboarding_key');
    expect(migration).toContain('idx_calendar_events_onboarding_key');
    expect(migration).toContain('idx_onboarding_imports_onboarding_key');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('onboarding_claim_family');
  });
});
