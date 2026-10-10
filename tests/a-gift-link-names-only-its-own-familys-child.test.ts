// A gift link names only its own family's child.
//
// gift_links' write policy checks only the row's own family_id, so a household
// could save a link whose child_wallet_id is ANOTHER family's child wallet
// (measured on a replay of main 36a516d7c, as family A's parent under RLS).
// The public gift page and its AI assistant run with the service role and
// resolved the wallet's child by id alone, so a stranger's link showed that
// child's name under the first household's name, and handed it to the model.
// Money was never at risk: approval refuses a wallet outside the family.
//
// These drive the real page and route. The control is the family's own child,
// who must still be named, or a page that names nobody would pass.
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';

const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const FAMILY = '00000000-0000-4000-8000-00000000a6f1';
const OTHER_FAMILY = '00000000-0000-4000-8000-00000000b6f1';

type Db = ReturnType<typeof createInMemorySupabase>;
const state = vi.hoisted(() => ({ db: null as unknown, prompts: [] as string[] }));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => EN_US[key] ?? key }));
vi.mock('@/components/wallet/public-gift-form', () => ({ PublicGiftForm: () => 'GIFT-FORM' }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true }), clientIp: () => '203.0.113.9' }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({
    complete: async ({ system, messages }: { system: string; messages: { content: string }[] }) => {
      state.prompts.push(`${system}\n${messages.map((m) => m.content).join('\n')}`);
      return { text: JSON.stringify({ messages: ['Happy birthday!'], gifts: [] }) };
    },
  }),
}));

function seed(wallet: 'cw-own' | 'cw-stranger'): void {
  const db = createInMemorySupabase();
  db.seed('families', [{ id: FAMILY, name: 'Link House' }, { id: OTHER_FAMILY, name: 'Their House' }]);
  db.seed('family_members', [
    { id: 'm-own', family_id: FAMILY, display_name: 'Robin Own' },
    { id: 'm-stranger', family_id: OTHER_FAMILY, display_name: 'Quinn Stranger' },
  ]);
  db.seed('child_wallets', [
    { id: 'cw-own', family_id: FAMILY, member_id: 'm-own' },
    { id: 'cw-stranger', family_id: OTHER_FAMILY, member_id: 'm-stranger' },
  ]);
  db.seed('gift_links', [{
    id: 'g1', token: 'tok', is_active: true, occasion: 'birthday', message: null, suggested_cents: [500],
    child_wallet_id: wallet, family_id: FAMILY,
  }]);
  db.seed('wallet_goals', []);
  state.db = db as Db;
}

async function page(): Promise<string> {
  const { default: PublicGiftPage } = await import('@/app/gift/[token]/page');
  return renderTranslated(await PublicGiftPage({ params: Promise.resolve({ token: 'tok' }) }));
}

async function assistant(): Promise<number> {
  const { POST } = await import('@/app/api/ai/gift/route');
  const response = await POST(new NextRequest('https://app.example.test/api/ai/gift', {
    method: 'POST', body: JSON.stringify({ token: 'tok', relationship: 'aunt' }), headers: { 'content-type': 'application/json' },
  }));
  return response.status;
}

beforeEach(() => { state.prompts = []; });

describe('the public gift page', () => {
  it('control: names the family\'s own child', async () => {
    seed('cw-own');
    const html = await page();
    expect(html).toContain('Robin Own');
    expect(html).toContain('Link House');
  });

  it('does not name a child from another family whose wallet the link carries', async () => {
    seed('cw-stranger');
    const html = await page();
    expect(html).not.toContain('Quinn');
    expect(html).toContain('GIFT-FORM');
  });
});

describe('the public gift assistant', () => {
  it('control: tells the model the family\'s own child\'s first name', async () => {
    seed('cw-own');
    expect(await assistant()).toBe(200);
    expect(state.prompts.join('\n')).toContain('Robin');
  });

  it('does not hand another family\'s child\'s name to the model', async () => {
    seed('cw-stranger');
    expect(await assistant()).toBe(200);
    expect(state.prompts).toHaveLength(1);
    expect(state.prompts.join('\n')).not.toContain('Quinn');
  });
});
