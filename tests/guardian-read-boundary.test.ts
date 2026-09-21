// The safety surface must not make a safety claim it could not check.
//
// All five AI Call Guardian pages read their data and discarded the error, and
// none of them appeared in the 127 existing `*-read-boundary` guards. What a
// failed read rendered:
//
//   /guardian           "0 blocked", "0 scams stopped" — from `count ?? 0`, on a
//                       dashboard whose whole job is to say what was stopped
//   /guardian/history   "0 total" and "No communications match your filters",
//                       over a log that may be full of blocked scam calls — and
//                       inviting the reader to clear a filter that is not the
//                       problem
//   /guardian/rules     no routing rules, i.e. "you have written none"
//   /guardian/contacts  "0 contacts", i.e. "you have trusted nobody"
//   /guardian/settings  the factory defaults (fixed separately; that one also
//                       SAVED them over the family's real routing)
//
// And `/family/activity`, the family's audit trail, rendered "No activity
// recorded yet" — the one screen whose purpose is to say what happened, saying
// nothing did. It already used settleAll, whose own header says "the caller's
// existing error handling then runs for transport failures too". There was none.
//
// These render the real pages with the real components, once per read state, and
// assert on the markup. The claim is never "the source destructures error" — it is
// that the number, or the sentence, is not there.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const t = (key: string) => MESSAGES[key] ?? key;

type Answer = { data: unknown; count: number | null; error: unknown } | 'reject';
const reads = vi.hoisted(() => ({
  /** table → what the query resolves to. Anything unnamed succeeds empty. */
  byTable: {} as Record<string, Answer>,
}));

const ok = (data: unknown, count: number | null = null) => ({ data, count, error: null });
const failed = { data: null, count: null, error: { message: 'permission denied for relation' } } as const;

function fakeClient() {
  const answer = (table: string) => {
    const result = reads.byTable[table] ?? ok([], 0);
    if (result === 'reject') return Promise.reject(new Error('CONNECT_TIMEOUT'));
    return Promise.resolve(result);
  };
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'neq', 'is', 'gte', 'lte', 'order', 'limit', 'range', 'ilike', 'or']) {
      chain[method] = () => chain;
    }
    chain.maybeSingle = () => answer(table);
    chain.single = () => answer(table);
    chain.then = (...args: unknown[]) => (answer(table) as PromiseLike<unknown>).then(...(args as [never, never]));
    return chain;
  };
  return { from: (table: string) => builder(table) };
}

// `family` is part of the shape, not an optional extra: `FamilyMembership`
// declares `family: Tables<'families'>` and `requireUserContext()` always
// resolves one. This mock omitted it, and the page read
// `ctx.active.family.timezone` and threw.
//
// Fixed HERE rather than by writing `ctx.active.family?.timezone` in the page.
// The optional chain is the reflex and it is the wrong one: the type says this
// value is always present, so `?.` would silently fall back to UTC in a state
// that cannot occur — turning a loud, correct failure into a quiet wrong answer
// in exactly the subsystem this pass is fixing.
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    active: {
      familyId: 'fam-1',
      member: { id: 'mem-1' },
      role: 'parent',
      family: { id: 'fam-1', name: 'Test Family', timezone: 'America/New_York' },
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => fakeClient() }));
// `getLocaleContext` too, now that the page binds its formatter with
// `getFormat(tz)` — which resolves the reader's locale as well as their zone.
// Same reasoning as the `family` field above: the export exists, so the mock
// has to carry it rather than the page working around its absence.
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => t,
  getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages: {} }),
}));
vi.mock('@/lib/guardian/twilio', () => ({ isTwilioConfigured: () => true }));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => t,
  useLocale: () => 'en-US',
}));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: () => {}, error: () => {}, info: () => {}, show: () => {} }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/guardian',
  useSearchParams: () => new URLSearchParams(),
}));
// Server actions the client components import. Never invoked here.
vi.mock('@/app/(app)/guardian/actions', () => new Proxy({}, {
  get: () => async () => ({ ok: true }),
  has: () => true,
}));
vi.mock('@/components/guardian/guardian-number-form', () => ({
  GuardianNumberForm: () => 'GUARDIAN-NUMBER-FORM',
}));

const { default: GuardianPage } = await import('@/app/(app)/guardian/page');
const { default: HistoryPage } = await import('@/app/(app)/guardian/history/page');
const { default: RulesPage } = await import('@/app/(app)/guardian/rules/page');
const { default: ContactsPage } = await import('@/app/(app)/guardian/contacts/page');
const { default: ActivityPage } = await import('@/app/(app)/family/activity/page');

beforeEach(() => { reads.byTable = {}; });

const render = async (element: Promise<React.ReactElement>) => renderToStaticMarkup(await element);
const history = () => HistoryPage({ searchParams: Promise.resolve({}) });

describe('/guardian does not report zero for a count it could not read', () => {
  // The counts all come from the same table, so one failure takes all four
  // tiles — which is the realistic case and the dangerous one.
  it('shows an em dash and says what failed, not 0 blocked and 0 scams stopped', async () => {
    reads.byTable.guardian_communications = failed;
    const html = await render(GuardianPage());
    expect(html).toContain(t('guardian.someOfThisScreenCouldNotBeLoaded'));
    expect(html).toContain('permission denied for relation');
    expect(html).toContain('—');
    // The stat tiles must not read as an all-clear.
    expect(html).not.toMatch(/>0</);
  });

  it('survives a read that never completed', async () => {
    reads.byTable.guardian_communications = 'reject';
    const html = await render(GuardianPage());
    expect(html).toContain(t('guardian.someOfThisScreenCouldNotBeLoaded'));
    expect(html).not.toMatch(/>0</);
  });

  // The negative control: a family that genuinely had a quiet day must still see
  // zeros, and no banner. Without this, "no 0" above would pass on a page that
  // can no longer render a number at all.
  it('still reports a real zero as zero, with no banner', async () => {
    reads.byTable.guardian_communications = ok([], 0);
    const html = await render(GuardianPage());
    expect(html).not.toContain(t('guardian.someOfThisScreenCouldNotBeLoaded'));
    expect(html).toMatch(/>0</);
  });

  it('names only the read that failed when the others are fine', async () => {
    reads.byTable.guardian_suggestions = failed;
    const html = await render(GuardianPage());
    // The name of the read is the family's half of the line and now comes from
    // the catalogue; the Postgres reason is the machine's half and renders as
    // <code> BESIDE it rather than joined onto it with a colon, because a
    // translated label glued to an untranslatable string is one sentence in two
    // languages (I18N-006). Both halves are still required to be on screen — and
    // matching the whole <li> is what keeps "escalations" from being satisfied
    // by the word appearing in prose elsewhere on the page.
    expect(html).toMatch(
      new RegExp(`<li>${t('guardian.suggestions')} <code[^>]*>permission denied for relation</code></li>`),
    );
    expect(html).not.toMatch(new RegExp(`<li>${t('guardian.escalations')} <code`));
  });
});

describe('/guardian/history does not call a failed read an empty log', () => {
  it('says the read failed instead of "no communications match your filters"', async () => {
    reads.byTable.guardian_communications = failed;
    const html = await render(history());
    expect(html).toContain(t('guardianHistory.couldnTLoadTheCommunicationHistory'));
    expect(html).not.toContain(t('callHistory.noCommunicationsMatchYourFilter'));
    expect(html).not.toContain('0 total');
  });

  it('still shows an empty log as empty — and says nothing about filters', async () => {
    reads.byTable.guardian_communications = ok([], 0);
    const html = await render(history());
    expect(html).not.toContain(t('guardianHistory.couldnTLoadTheCommunicationHistory'));
    expect(html).toContain('0 total');
    // The two facts are different: an empty log is not a filtered-out log.
    expect(html).toContain(t('callHistory.noCallsOrMessagesYet'));
    expect(html).not.toContain(t('callHistory.noCommunicationsMatchYourFilter'));
  });
});

describe('/guardian/rules and /guardian/contacts do not report "none" for a failed read', () => {
  it('rules says the read failed', async () => {
    reads.byTable.guardian_routing_rules = failed;
    const html = await render(RulesPage());
    expect(html).toContain(t('guardianRules.couldnTLoadYourRoutingRules'));
  });

  it('rules still renders the editor when the read succeeds', async () => {
    reads.byTable.guardian_routing_rules = ok([]);
    const html = await render(RulesPage());
    expect(html).not.toContain(t('guardianRules.couldnTLoadYourRoutingRules'));
  });

  it('contacts says the read failed, and shows no contact count', async () => {
    reads.byTable.guardian_contacts = failed;
    const html = await render(ContactsPage());
    expect(html).toContain(t('guardianContacts.couldnTLoadYourTrustGraph'));
    expect(html).not.toContain('0 contacts');
  });

  it('contacts still reports a real zero as zero', async () => {
    reads.byTable.guardian_contacts = ok([]);
    const html = await render(ContactsPage());
    expect(html).not.toContain(t('guardianContacts.couldnTLoadYourTrustGraph'));
    expect(html).toContain('0 contacts');
  });

  // A failed MEMBER lookup is decoration on this page — it fills a name dropdown.
  // It must not cost the family their trust graph.
  it('contacts keeps the trust graph when only the member lookup fails', async () => {
    reads.byTable.guardian_contacts = ok([]);
    reads.byTable.family_members = 'reject';
    const html = await render(ContactsPage());
    expect(html).not.toContain(t('guardianContacts.couldnTLoadYourTrustGraph'));
  });
});

describe('/family/activity does not say nothing happened when it could not look', () => {
  it('says the read failed', async () => {
    reads.byTable.audit_logs = failed;
    const html = await render(ActivityPage());
    expect(html).toContain(t('activity.couldnTLoadTheActivityLog'));
    expect(html).not.toContain(t('activity.noActivityRecordedYet'));
  });

  it('survives a transport rejection', async () => {
    reads.byTable.audit_logs = 'reject';
    const html = await render(ActivityPage());
    expect(html).toContain(t('activity.couldnTLoadTheActivityLog'));
  });

  it('still reports a genuinely empty trail as empty', async () => {
    reads.byTable.audit_logs = ok([]);
    const html = await render(ActivityPage());
    expect(html).toContain(t('activity.noActivityRecordedYet'));
    expect(html).not.toContain(t('activity.couldnTLoadTheActivityLog'));
  });
});
