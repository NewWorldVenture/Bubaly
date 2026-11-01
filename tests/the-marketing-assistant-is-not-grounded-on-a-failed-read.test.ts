import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

// admin-writers N17. The marketing assistant hands the model "real data" and
// tells it to use ONLY that. It read the customers through
// getMarketingCustomers, which drops the view's error, and the segment and
// campaign reads through a settled batch whose errors it never looked at. So a
// failed read, or a platform past the view's 2,000-family ceiling, became
// "Customers: 0 total ... Est. MRR $0.00" and "Existing segments: none", and
// every answer was written about a business with no customers. A list of 25
// was never said to be a prefix either. The REAL route against the in-memory
// database; only the model is fake.

const h = vi.hoisted(() => ({ db: null as unknown, prompts: [] as string[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => ({ id: 'admin-1', email: 'root@example.com' }),
  isSuperAdmin: async () => true,
}));
vi.mock('@/lib/auth/super-admin-assurance', () => ({
  superAdminAssurance: async () => ({ ok: true }),
  decideSuperAdminAssurance: () => ({ ok: true }),
  SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin',
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params) };
});
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({
    complete: async ({ messages }: { messages: { content: string }[] }) => {
      h.prompts.push(messages[0].content);
      return { text: 'A plan.' };
    },
  }),
}));

const { POST } = await import('@/app/api/admin/marketing/ai/route');

let db: InMemorySupabase;
const pad = (i: number) => String(i).padStart(5, '0');
const ask = () => POST(new NextRequest('https://bubaly.test/api/admin/marketing/ai', {
  method: 'POST', body: JSON.stringify({ task: 'analyze' }), headers: { 'content-type': 'application/json' },
}));

function families(n: number) {
  db.seed('families', Array.from({ length: n }, (_, i) => ({ id: `fam-${pad(i)}`, name: `F${i}`, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', closed_at: null })));
  db.seed('family_members', Array.from({ length: Math.min(n, 5) }, (_, i) => ({ id: `m-${pad(i)}`, family_id: `fam-${pad(i)}`, user_id: `u-${pad(i)}`, role: 'parent', is_active: true })));
  db.seed('profiles', Array.from({ length: Math.min(n, 5) }, (_, i) => ({ id: `u-${pad(i)}`, email: `p${i}@example.com` })));
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  h.prompts = [];
  for (const table of ['subscriptions', 'marketing_segments', 'marketing_campaigns', 'marketing_audit_logs']) db.seed(table, []);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a read the assistant could not make', () => {
  it.each(['profiles', 'subscriptions', 'marketing_segments', 'marketing_campaigns'])('(%s) answers 503 and asks the model nothing', async (table) => {
    families(3);
    h.db = withFaults(db, (name) => (name === table ? { message: `${table} unavailable` } : null));
    const res = await ask();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(SOURCE_MESSAGES['ai.marketingGroundingUnavailable']);
    expect(h.prompts, 'the model was handed zeros and "none" as fact').toEqual([]);
  });
});

describe('a customer base past the view\'s ceiling', () => {
  it('is said to be unavailable, never handed over as zero customers', async () => {
    families(2001);
    expect((await ask()).status).toBe(200);
    const [prompt] = h.prompts;
    expect(prompt).toContain('Customers: figures unavailable');
    expect(prompt).not.toContain('Customers: 0 total');
    expect(prompt).not.toContain('Est. MRR $0.00');
  });
});

describe('a list longer than the context holds', () => {
  it('says it is the newest 25, and a short list is given whole (control)', async () => {
    families(3);
    db.seed('marketing_segments', Array.from({ length: 30 }, (_, i) => ({ id: `seg-${pad(i)}`, name: `Segment ${i}`, deleted_at: null, created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() })));
    db.seed('marketing_campaigns', [{ id: 'mc-1', name: 'Autumn', channel: 'email', status: 'draft', deleted_at: null, created_at: '2026-01-01T00:00:00Z' }]);
    expect((await ask()).status).toBe(200);
    const [prompt] = h.prompts;
    expect(prompt).toMatch(/Existing segments: Segment 29, Segment 28, .*Segment 5 \(the 25 newest segments; more exist\)\./);
    expect(prompt).not.toContain('Segment 4,');
    expect(prompt).toContain('Existing campaigns: Autumn (email/draft).');
    expect(prompt).toContain('Customers: 3 total');
  });
});
