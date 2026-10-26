// A4 (marketing) — two marketing senders skipped the kid-login address guard.
//
// sendReactEmail and sendEmail refuse an address on kids.bubaly.app, the
// synthetic domain a kid login's account is created under: nothing is ever
// delivered there and the domain is not Bubaly's, so a send is a bounce or a
// child's name in a stranger's inbox. But the automation send_email step and
// the campaign sender call the provider themselves (Resend's send and batch
// APIs), and neither asked. A profile or contact can carry such an address —
// a kid login's own profiles.email, say, which is what a family whose only
// login is a kid login lists as its owner's.
//
// Driven through the real runSteps and the real sendEmailCampaign (with the
// real customer read) against the in-memory database; only the provider is fake.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[], batches: [] as Record<string, unknown>[][] }));

vi.mock('@/lib/email', () => ({
  getResend: () => ({
    emails: {
      send: async (message: Record<string, unknown>) => {
        h.sent.push(message);
        return { data: { id: `re_${h.sent.length}` }, error: null };
      },
    },
  }),
  FROM_EMAIL: 'Bubaly <hello@bubaly.test>',
  emailEnabled: () => true,
  APP_URL: 'https://bubaly.test',
}));
vi.mock('@/lib/server/fetch-with-deadline', () => ({
  fetchWithDeadline: async (_url: string, init: { body: string }) => {
    h.batches.push(JSON.parse(init.body) as Record<string, unknown>[]);
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  },
}));

const { runSteps } = await import('@/lib/marketing/automation-steps');
const { sendEmailCampaign } = await import('@/lib/marketing/send');
type DB = Parameters<typeof runSteps>[3];

const KID = 'child.ava@kids.bubaly.app';
let db: InMemorySupabase;

beforeEach(() => {
  vi.stubEnv('INTERNAL_SECRET', 'kid-login-marketing-fixture');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.sent = [];
  h.batches = [];
  db = createInMemorySupabase();
});

describe('the automation send_email step', () => {
  const step = (email: string) => runSteps([{ action: 'send_email' }], { email, name: 'Ava' }, { subject: 'Hello', body: 'A note.' }, db as unknown as DB);

  it('does not mail a kid login\'s address, in any case', async () => {
    expect(await step(KID)).toEqual(['send_email:skipped(kid-login)']);
    expect(await step('Child.Ava@KIDS.Bubaly.app')).toEqual(['send_email:skipped(kid-login)']);
    expect(h.sent).toEqual([]);
  });

  it('still mails an ordinary address (control)', async () => {
    expect(await step('parent@example.test')).toEqual(['send_email']);
    expect(h.sent.map((m) => m.to)).toEqual(['parent@example.test']);
  });
});

describe('an email campaign', () => {
  it('leaves a kid login\'s address out of the batch it sends', async () => {
    db.seed('families', [
      { id: 'fam-parent', name: 'Parents', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', closed_at: null },
      // A household whose only login is a kid login: its owner's address is the synthetic one.
      { id: 'fam-kid', name: 'Ava', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', closed_at: null },
    ]);
    db.seed('family_members', [
      { family_id: 'fam-parent', user_id: 'u-parent', role: 'parent', is_active: true },
      { family_id: 'fam-kid', user_id: 'u-kid', role: 'parent', is_active: true },
    ]);
    db.seed('profiles', [{ id: 'u-parent', email: 'parent@example.test' }, { id: 'u-kid', email: KID }]);
    db.seed('marketing_email_campaigns', [{ id: 'camp-1', status: 'draft', subject: 'Autumn news', body_html: '<p>News</p>', deleted_at: null, segment_id: null }]);

    const result = await sendEmailCampaign(db as unknown as DB, 'camp-1', 'https://bubaly.test');

    expect(h.batches.flat().map((m) => m.to)).toEqual(['parent@example.test']);
    expect(result).toEqual({ sent: 1, remaining: 0 });
  });
});
