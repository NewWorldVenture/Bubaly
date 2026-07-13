import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isTwilioBodyTooLarge, isValidGuardianEventId } from '@/lib/guardian/callbacks';

const root = process.cwd();
const callbackRoutes = [
  'app/api/guardian/inbound/sms/route.ts',
  'app/api/guardian/inbound/whatsapp/route.ts',
  'app/api/guardian/inbound/voice/route.ts',
  'app/api/guardian/screen/route.ts',
  'app/api/guardian/status/voicemail/route.ts',
];

describe('Guardian callback replay and input boundaries', () => {
  it('accepts provider-safe callback identifiers only', () => {
    expect(isValidGuardianEventId('SM123:screen:1')).toBe(true);
    expect(isValidGuardianEventId('')).toBe(false);
    expect(isValidGuardianEventId('sid with spaces')).toBe(false);
    expect(isValidGuardianEventId('sid/with/slashes')).toBe(false);
    expect(isValidGuardianEventId('x'.repeat(161))).toBe(false);
  });

  it('rejects oversized Twilio request bodies before form parsing', () => {
    expect(isTwilioBodyTooLarge(new Request('https://example.test', { headers: { 'content-length': '65537' } }))).toBe(true);
    expect(isTwilioBodyTooLarge(new Request('https://example.test', { headers: { 'content-length': '65536' } }))).toBe(false);
    expect(isTwilioBodyTooLarge(new Request('https://example.test'))).toBe(false);
  });

  it.each(callbackRoutes)('claims %s before downstream side effects', (relativePath) => {
    const source = readFileSync(resolve(root, relativePath), 'utf8');
    expect(source).toContain('claimGuardianCallback');
    expect(source).toContain('isTwilioBodyTooLarge');
    expect(source).toContain('markGuardianCallbackProcessed');

    const claimIndex = source.indexOf('await claimGuardianCallback');
    expect(claimIndex).toBeGreaterThanOrEqual(0);
    const sideEffectIndexes = [
      source.indexOf('runDecisionPipeline('),
      source.indexOf('detectScamWithAI('),
      source.indexOf('screeningTurn({'),
      source.indexOf("from('notifications')"),
    ].filter((index) => index >= 0);
    expect(sideEffectIndexes.every((index) => claimIndex < index)).toBe(true);
  });

  it('keeps screening callbacks bounded to five exact turns', () => {
    const source = readFileSync(resolve(root, 'app/api/guardian/screen/route.ts'), 'utf8');
    expect(source).toContain('turn < 1 || turn > 5');
    expect(source).toContain('speechResult.length > 4096');
    expect(source).toContain('`${callSid}:screen:${turn}`');
  });

  it('keeps callback state service-only in the migration', () => {
    const sql = readFileSync(resolve(root, 'supabase/migrations/0181_guardian_callback_replay.sql'), 'utf8');
    expect(sql).toMatch(/create table if not exists public\.guardian_callback_events/i);
    expect(sql).toMatch(/alter table public\.guardian_callback_events enable row level security/i);
    expect(sql).not.toMatch(/create policy/i);
  });
});
