import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { FAMILY_EMAIL_MIN_PLAN_LEVEL, planLevel } from '@/lib/constants/plans';
import { POST } from '@/app/api/contact-center/email/route';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/contact-center/concierge', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/contact-center/concierge')>(),
  runConcierge: vi.fn(async () => ({ intent: 'other', summary: 'Received', reply: 'Received' })),
}));
vi.mock('@/lib/server/email', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/guardian/twilio', () => ({ sendSms: vi.fn() }));

type DB = SupabaseClient<Database>;
const FAMILY = 'family-1';
let db: ReturnType<typeof createInMemorySupabase<DB>>;

function seedFamily(plan: string | null) {
  db = createInMemorySupabase<DB>({
    uniques: { family_inbox_messages: [['channel', 'provider_ref']] },
    defaults: { family_inbox_messages: { status: 'new', ai_handled: false } },
  });
  db.seed('families', [{ id: FAMILY, name: 'Test household', timezone: 'UTC' }]);
  db.seed('family_contact_channels', [{ family_id: FAMILY, email_local: 'household', ai_concierge_enabled: false }]);
  if (plan) db.seed('subscriptions', [{ family_id: FAMILY, plan, status: 'active' }]);
  state.db = db;
}

async function deliver() {
  const form = new FormData();
  form.set('to', 'household@bubaly.com');
  form.set('from', 'teacher@school.test');
  form.set('subject', 'Parents evening');
  form.set('text', 'Thursday at 5pm.');
  form.set('Message-Id', 'gate-1');
  return POST(new NextRequest('http://localhost/api/contact-center/email', {
    method: 'POST', headers: { 'x-inbound-secret': 'test-secret' }, body: form,
  }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv('CONTACT_CENTER_INBOUND_SECRET', 'test-secret');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/**
 * The family @bubaly.com address is Family+.
 *
 * It was Family+ on the SCREEN only. Traced on 2026-09-13, the gate existed at
 * `requirePlanLevel(2)` in the Contact Center page and nowhere else: onboarding
 * provisioned an address for every tier, and the inbound webhook had no plan
 * check at all. A Free family therefore had a working address that received
 * mail, ran the AI concierge over it and auto-replied AS the family — the only
 * thing they could not do was open the inbox.
 *
 * These pin the three places that must now agree, and the constant they agree
 * through.
 */
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

const PAGE = 'app/(app)/dashboard/contact-center/page.tsx';
const ONBOARDING = 'app/onboarding/actions.ts';
const WEBHOOK = 'app/api/contact-center/email/route.ts';

describe('family email is gated to Family+ in one place', () => {
  it('sets the entitlement at the Plus level', () => {
    expect(FAMILY_EMAIL_MIN_PLAN_LEVEL).toBe(2);
    // Stated against the plan map rather than the bare number, so renaming or
    // renumbering a tier fails here instead of silently moving the feature.
    expect(planLevel('plus')).toBe(FAMILY_EMAIL_MIN_PLAN_LEVEL);
    expect(planLevel('plus_annual')).toBe(FAMILY_EMAIL_MIN_PLAN_LEVEL);
    expect(planLevel('basic')).toBeLessThan(FAMILY_EMAIL_MIN_PLAN_LEVEL);
    expect(planLevel(null)).toBeLessThan(FAMILY_EMAIL_MIN_PLAN_LEVEL);
  });

  it('gates all three surfaces through the shared constant, not a literal', () => {
    for (const file of [PAGE, ONBOARDING, WEBHOOK]) {
      expect(read(file)).toContain('FAMILY_EMAIL_MIN_PLAN_LEVEL');
    }
    // The screen's bare requirePlanLevel(2) is what let the other two drift.
    expect(read(PAGE)).not.toMatch(/requirePlanLevel\(\s*2\s*\)/);
  });

  it('gates provisioning, so a family below the line never gets an address', () => {
    const source = read(ONBOARDING);
    expect(source).toContain('resolveFamilyPlanLevel');
    expect(source).toMatch(/planLevelForFamily\s*>=\s*FAMILY_EMAIL_MIN_PLAN_LEVEL/);
  });

  it('gates the inbound webhook', () => {
    const source = read(WEBHOOK);
    expect(source).toMatch(/familyPlanLevel\s*<\s*FAMILY_EMAIL_MIN_PLAN_LEVEL/);
    expect(source).toContain("skipped: 'plan'");
  });

  it('answers 503 — never 200 — when the plan itself cannot be read', () => {
    // This is the case that matters most. resolveFamilyPlanLevel throws on a
    // failed subscription read, and an unreadable plan is NOT an unentitled
    // family. A 200 would tell the provider the message was handled, so there
    // would be no retry and no copy of it anywhere: a teacher's email would be
    // gone because a database read blipped.
    const source = read(WEBHOOK);
    const guard = /catch \(error\) \{\s*console\.error\('\[contact-center\] email plan read failed', error\);\s*return new NextResponse\('Contact Center temporarily unavailable', \{ status: 503 \}\);/;
    expect(source).toMatch(guard);
  });

  // ---------------------------------------------------------------------------
  // The cases above read SOURCE. That is how the sitemap defect (F4) shipped
  // under a green test, so the gate gets exercised for real as well: these drive
  // the actual route and look at what it did.
  // ---------------------------------------------------------------------------

  it('refuses an inbound message for a Free family, and files nothing', async () => {
    seedFamily(null);

    const response = await deliver();

    expect(await response.json()).toMatchObject({ skipped: 'plan' });
    expect(db.table('family_inbox_messages')).toHaveLength(0);
  });

  it('refuses a Basic family too — the line is Plus, not merely paid', async () => {
    seedFamily('basic');

    const response = await deliver();

    expect(await response.json()).toMatchObject({ skipped: 'plan' });
    expect(db.table('family_inbox_messages')).toHaveLength(0);
  });

  it('files the message for a Family+ household', async () => {
    seedFamily('plus');

    const response = await deliver();
    const body = await response.json();

    expect(body.skipped).toBeUndefined();
    expect(db.table('family_inbox_messages')).toHaveLength(1);
  });

  it('keeps provisioning unable to fail onboarding', () => {
    // The plan read throws, and it now sits inside the provisioning block. That
    // block must still be wrapped, or a subscription blip turns a completed
    // signup into a retry.
    const source = read(ONBOARDING);
    const block = source.slice(source.indexOf('const planLevelForFamily'));
    const wrapped = source.slice(0, source.indexOf('const planLevelForFamily')).lastIndexOf('try {');
    expect(wrapped).toBeGreaterThan(-1);
    expect(block).toContain("console.error('[onboarding] family email provisioning failed'");
    expect(block.slice(0, block.indexOf('}'))).not.toContain('return');
  });
});
