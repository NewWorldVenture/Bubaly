// A recommendation's link is written by any family member and shown to a
// parent as Bubaly's own suggestion. It must not take that parent off the app.
//
// `family_ai_recommendations` is `is_family_member` for INSERT and UPDATE (0022),
// and `cta_href` is a whitelisted column of the generic record action
// (lib/family/actions.ts). A child can therefore file
//   { title: 'Card declined — confirm your details', priority: 'high',
//     cta_href: 'https://evil.example/login' }
// and the parent's Home "Needs you" queue, the Needs-you page and the morning
// brief all list it as an urgent Bubaly recommendation.
//
// The brief already refused an off-app href (lib/briefing/decisions.ts), but
// with a regex — `/^\/(?!\/)/` — that passes `/\evil.example`, which a browser
// resolves to https://evil.example/. Home did not check at all.
import { describe, expect, it } from 'vitest';
import { buildHomeNeeds, type HomeNeedsInput } from '@/lib/home/needs-build';
import { recommendationToNeed } from '@/lib/home/needs-sources';
import { BriefDecisionSchema, isAppPath } from '@/lib/briefing/response-schema';
import { readBriefDecisions } from '@/lib/briefing/decisions';
import { SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const ORIGIN = 'https://www.bubaly.com';
/** Where a browser on the app lands when it follows `href`. */
const landsOn = (href: string) => new URL(href, `${ORIGIN}/home`).origin;

// Every one of these leaves the app when clicked from a page on it.
const OFF_APP = [
  'https://evil.example/login',
  'http://evil.example',
  '//evil.example/login',
  '/\\evil.example/login',
  '/\t/evil.example',
  ' https://evil.example',
];

const reader = { locale: 'en-US' as const, t: (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
const base: HomeNeedsInput = {
  approvals: [], renewals: [], documents: [], conflicts: [],
  pendingApprovals: 0, overdueMeds: false, overdueReminders: 0, dueTodayReminders: 0,
  pendingChores: 0, lowGrocery: false, openTodos: 0, now: new Date('2026-09-05T12:00:00Z'), reader,
};
const rec = (cta_href: string | null) => ({ id: 'rec-1', title: 'Card declined — confirm your details', priority: 'high', cta_href, created_at: '2026-09-05T09:00:00Z' });

describe('the attack strings really do leave the app', () => {
  it('each resolves to another origin in a browser', () => {
    // Guards the guard: a list that stayed on the app would prove nothing below.
    for (const href of OFF_APP) expect(landsOn(href.trim()), href).not.toBe(ORIGIN);
  });
});

describe('Home "Needs you" keeps a member-written recommendation link on the app', () => {
  it('never renders an off-app cta_href as the item link', () => {
    for (const href of OFF_APP) {
      const item = recommendationToNeed(rec(href));
      expect(landsOn(item.href), `${JSON.stringify(href)} -> ${item.href}`).toBe(ORIGIN);
      expect(item.href).toBe('/dashboard/needs-you');
    }
  });

  it('does so through the queue Home and the Needs-you page actually build', () => {
    for (const href of OFF_APP) {
      const out = buildHomeNeeds({ ...base, recommendations: [rec(href)] });
      const item = out.find((n) => n.kind === 'recommendation');
      expect(item, href).toBeDefined();
      expect(landsOn(item!.href), href).toBe(ORIGIN);
    }
  });

  it('keeps an ordinary in-app link exactly as written, and the default when there is none', () => {
    expect(recommendationToNeed(rec('/dashboard/documents')).href).toBe('/dashboard/documents');
    expect(recommendationToNeed(rec('/dashboard/concierge/runs?tab=open#top')).href).toBe('/dashboard/concierge/runs?tab=open#top');
    expect(recommendationToNeed(rec(null)).href).toBe('/dashboard/autonomous-family-management');
    expect(recommendationToNeed(rec('  ')).href).toBe('/dashboard/autonomous-family-management');
  });
});

describe('the brief\'s own decision guard uses the same-origin rule', () => {
  it('refuses the backslash spelling its regex let through', () => {
    expect(isAppPath('/\\evil.example')).toBe(false);
    expect(isAppPath('/\t/evil.example')).toBe(false);
    expect(isAppPath('/dashboard/needs-you')).toBe(true);
  });

  it('and so does the schema the client enforces on a cached brief', () => {
    const decision = { id: 'recommendation:rec-1', kind: 'recommendation', title: 'x', href: '/\\evil.example', urgency: 'urgent', createdAt: '2026-09-05T09:00:00Z' };
    expect(BriefDecisionSchema.safeParse(decision).success).toBe(false);
    expect(BriefDecisionSchema.safeParse({ ...decision, href: '/dashboard/needs-you' }).success).toBe(true);
  });

  it('sends a planted recommendation to the decisions list in the brief', async () => {
    const db = createInMemorySupabase();
    db.seed('family_members', [
      { id: 'm-parent', family_id: 'fam-1', user_id: 'auth-parent', display_name: 'Alex', role: 'parent', is_active: true },
    ]);
    db.seed('family_ai_recommendations', OFF_APP.map((href, i) => ({
      id: `rec-${i}`, family_id: 'fam-1', title: 'Card declined — confirm your details', status: 'pending', priority: 'high',
      cta_href: href, created_at: `2026-09-05T09:0${i}:00Z`,
    })));
    const scope: ServiceScope = {
      db: db as unknown as ServiceScope['db'], familyId: 'fam-1', userId: 'auth-parent', memberId: 'm-parent',
      role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date('2026-09-05T12:00:00Z'),
    };
    const res = await readBriefDecisions(scope, reader);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const recs = res.data.items.filter((i) => i.kind === 'recommendation');
    expect(recs).toHaveLength(OFF_APP.length);
    for (const item of recs) {
      expect(landsOn(item.href), item.id).toBe(ORIGIN);
      expect(BriefDecisionSchema.safeParse(item).success).toBe(true);
    }
  });
});
