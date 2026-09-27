// A failed Guardian profile read is not a member without a profile.
//
// The settings page destructured only `data`:
//
//     const [{ data: profile }, { data: member }] = await Promise.all([...])
//
// so a failed read arrived as `profile === null` — exactly how "this member has
// no profile row yet" arrives. `RoutingSettings` then seeded itself from a
// hard-coded `defaults` object and Save upserted THOSE over the family's real
// call routing: persona name, AI greeting, voicemail greeting, the five context
// overrides and every routing mode, with no way back from the UI. A household
// that had set unknown callers to `blocked` silently became `ai_handle_first`,
// and unknown callers started getting through.
//
// These render the real page with the real form, one read state at a time, and
// require the three states to be DIFFERENT PAGES. The old code passed the
// absent-row assertions here identically to the failed-read ones, which is the
// whole defect: nothing downstream could tell them apart.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { ROUTING_MODE_DESCRIPTION_KEYS } from '@/lib/guardian/pipeline';
import { getMessages, translate } from '@/lib/i18n/messages';

// The map holds catalogue keys now; the page renders what they resolve to.
// Counting the resolved sentence is the same assertion as before, and it
// additionally fails if a key ever stops resolving and renders raw.
const described = (mode: keyof typeof ROUTING_MODE_DESCRIPTION_KEYS) =>
  translate(getMessages('en-US'), ROUTING_MODE_DESCRIPTION_KEYS[mode]);
import { routingDefaults, type RoutingProfile } from '@/lib/guardian/routing-form';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const ERROR_COPY = MESSAGES['guardianSettings.couldnTLoadYourGuardianSettings'];

type ReadResult = { data: unknown; error: unknown } | 'reject';
const reads = vi.hoisted(() => ({
  profile: { data: null, error: null } as ReadResult,
  member: { data: { id: 'mem-1', display_name: 'Rosa' }, error: null } as ReadResult,
}));

/** A query builder that answers whatever `reads` says for the table asked for. */
function fakeClient() {
  const answer = (table: string) => {
    const result = table === 'guardian_member_profiles' ? reads.profile : reads.member;
    if (result === 'reject') return Promise.reject(new Error('CONNECT_TIMEOUT'));
    return Promise.resolve({ ...result, count: null });
  };
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'order', 'limit', 'range']) {
      chain[method] = () => chain;
    }
    chain.maybeSingle = () => answer(table);
    chain.single = () => answer(table);
    chain.then = (...args: unknown[]) => (answer(table) as unknown as PromiseLike<unknown>)
      .then(...(args as [never, never]));
    return chain;
  };
  return { from: (table: string) => builder(table) };
}

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    active: { familyId: 'fam-1', member: { id: 'mem-1' }, role: 'parent' },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => fakeClient() }));
vi.mock('@/lib/guardian/twilio', () => ({ isTwilioConfigured: () => false }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => MESSAGES[key] ?? key,
}));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string) => MESSAGES[key] ?? key,
  useLocale: () => 'en-US',
}));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: () => {}, error: () => {}, info: () => {}, show: () => {} }),
}));
// The server action the form posts to. Never called here — this file only asks
// what the page RENDERS — but importing the real module would drag next/headers
// into the test.
vi.mock('@/app/(app)/guardian/actions', () => ({
  upsertMemberProfileAction: async () => ({ ok: true }),
}));
// A marker instead of the real number form, so "the page rendered the
// self-serve guardian-number form" is a thing this file can assert about. On a
// failed read it showed an EMPTY number field, which reads as "you have no
// guardian number" to a family that has one.
vi.mock('@/components/guardian/guardian-number-form', () => ({
  GuardianNumberForm: () => 'GUARDIAN-NUMBER-FORM',
}));

const { default: GuardianSettingsPage } = await import('@/app/(app)/guardian/settings/page');

const render = async () => renderToStaticMarkup(await GuardianSettingsPage());
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const stored: RoutingProfile = {
  ...routingDefaults('mem-1'),
  id: 'prof-1',
  ai_persona_name: 'Sentry',
  default_mode_immediate: 'blocked',
  default_mode_close: 'blocked',
  default_mode_trusted: 'blocked',
  default_mode_known: 'blocked',
  default_mode_unknown: 'blocked',
  default_mode_suspected_spam: 'blocked',
};

beforeEach(() => {
  reads.profile = { data: null, error: null };
  reads.member = { data: { id: 'mem-1', display_name: 'Rosa' }, error: null };
});

describe('the Guardian settings page tells a failed read from an absent profile', () => {
  it('says the read failed, and renders nothing that can be saved', async () => {
    reads.profile = { data: null, error: { message: 'permission denied for relation' } };
    const html = await render();
    expect(html).toContain(ERROR_COPY);
    expect(html).not.toContain('Save Settings');
    expect(html).not.toContain('GUARDIAN-NUMBER-FORM');
  });

  // A transport failure REJECTS the query instead of resolving with { error },
  // so `Promise.all` took the whole page to the error boundary — "This page hit
  // a snag" — rather than to the branch above. settleAll is what makes the two
  // failures arrive in the same shape.
  it('survives a read that never completed, and says the same thing', async () => {
    reads.profile = 'reject';
    const html = await render();
    expect(html).toContain(ERROR_COPY);
    expect(html).not.toContain('Save Settings');
  });

  // The negative control. Without it, "no Save button" above would also pass on
  // a page that renders no form for anybody.
  it('still gives a member with no profile row the defaults to save', async () => {
    reads.profile = { data: null, error: null };
    const html = await render();
    expect(html).not.toContain(ERROR_COPY);
    expect(html).toContain('Save Settings');
    expect(html).toContain('GUARDIAN-NUMBER-FORM');
    // Seeded from the factory defaults: immediate/close/trusted all ring.
    expect(occurrences(html, described('immediate_ring'))).toBe(3);
  });

  it('seeds the form from the stored profile, not the defaults', async () => {
    reads.profile = { data: stored, error: null };
    const html = await render();
    expect(html).not.toContain(ERROR_COPY);
    // All six editable tiers are stored as `blocked`, so no row may describe a
    // default it was never given.
    expect(occurrences(html, described('blocked'))).toBe(6);
    expect(occurrences(html, described('immediate_ring'))).toBe(0);
    expect(occurrences(html, described('ai_handle_first'))).toBe(0);
  });

  // The heart of it: the page a failed read produces must not be the page an
  // absent row produces. Before the fix these two strings were identical.
  it('renders a different page for a failed read than for an absent row', async () => {
    reads.profile = { data: null, error: { message: 'permission denied for relation' } };
    const failed = await render();
    reads.profile = { data: null, error: null };
    const absent = await render();
    expect(failed).not.toEqual(absent);
  });

  // The member's display name is decoration; the profile is the data. A failed
  // name lookup must not cost the family its settings page.
  it('keeps the settings page when only the member name fails', async () => {
    reads.member = 'reject';
    reads.profile = { data: stored, error: null };
    const html = await render();
    expect(html).not.toContain(ERROR_COPY);
    expect(html).toContain('Save Settings');
    expect(html).toContain('For you');
  });
});
