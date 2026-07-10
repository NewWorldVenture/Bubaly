import { describe, it, expect } from 'vitest';
import { resolveCapabilities, DEFAULT_MONEY_FLAGS, type MoneyFlags, type StripeEnv } from '@/lib/stripe/capabilities';
import { decideAuthorization, precheckCardAuthorization } from '@/lib/stripe/webhook';

const NO_ENV: StripeEnv = { hasSecretKey: false, hasWebhookSecret: false };
const FULL_ENV: StripeEnv = { hasSecretKey: true, hasWebhookSecret: true };
const allFlags = (over: Partial<MoneyFlags> = {}): MoneyFlags => ({ ...DEFAULT_MONEY_FLAGS, ...over });

describe('resolveCapabilities', () => {
  it('falls back to ledger mode when no secret key (graceful degradation)', () => {
    const c = resolveCapabilities(NO_ENV, allFlags({ stripe_connect_enabled: true, stripe_issuing_enabled: true }));
    expect(c.mode).toBe('ledger');
    expect(c.issuing).toBe(false);
    expect(c.connectOnboarding).toBe(false);
    expect(c.ledger).toBe(true);
    expect(c.reason).toMatch(/credentials/i);
  });

  it('stays in ledger mode when all flags are off, even with credentials', () => {
    const c = resolveCapabilities(FULL_ENV, DEFAULT_MONEY_FLAGS);
    expect(c.mode).toBe('ledger');
    expect(c.reason).toMatch(/flags are off/i);
  });

  it('enables connect onboarding when flag + credentials present', () => {
    const c = resolveCapabilities(FULL_ENV, allFlags({ stripe_connect_enabled: true }));
    expect(c.mode).toBe('stripe');
    expect(c.connectOnboarding).toBe(true);
    expect(c.treasury).toBe(false); // treasury flag still off
  });

  it('gates treasury and issuing behind connect (layered)', () => {
    const c = resolveCapabilities(FULL_ENV, allFlags({ stripe_treasury_enabled: true, stripe_issuing_enabled: true }));
    // connect flag off → treasury/issuing cannot turn on
    expect(c.treasury).toBe(false);
    expect(c.issuing).toBe(false);
  });

  it('enables issuing only when connect + issuing flags both on', () => {
    const c = resolveCapabilities(FULL_ENV, allFlags({ stripe_connect_enabled: true, stripe_issuing_enabled: true }));
    expect(c.issuing).toBe(true);
    expect(c.physicalCards).toBe(false); // physical flag off
  });

  it('gates physical cards and custom designs behind issuing', () => {
    const c = resolveCapabilities(FULL_ENV, allFlags({
      stripe_connect_enabled: true, stripe_issuing_enabled: true,
      physical_cards_enabled: true, custom_card_designs_enabled: true,
    }));
    expect(c.physicalCards).toBe(true);
    expect(c.customCardDesigns).toBe(true);
  });

  it('requires webhook secret for funded payments', () => {
    const withFlag = allFlags({ stripe_payments_enabled: true });
    expect(resolveCapabilities({ hasSecretKey: true, hasWebhookSecret: false }, withFlag).payments).toBe(false);
    expect(resolveCapabilities(FULL_ENV, withFlag).payments).toBe(true);
  });
});

describe('decideAuthorization', () => {
  const base = { isFrozen: false, cardStatus: 'active', blockedCategories: [] as string[], merchantCategory: null as string | null };

  it('approves when balance covers the amount', () => {
    expect(decideAuthorization({ ...base, spendableCents: 5000, amountCents: 2500 }))
      .toEqual({ approve: true, reason: 'approved' });
  });

  it('declines when amount exceeds spendable balance (no overspend)', () => {
    const d = decideAuthorization({ ...base, spendableCents: 1000, amountCents: 2500 });
    expect(d.approve).toBe(false);
    expect(d.reason).toBe('insufficient_spend_balance');
  });

  it('declines a frozen card', () => {
    const d = decideAuthorization({ ...base, isFrozen: true, spendableCents: 9999, amountCents: 100 });
    expect(d).toEqual({ approve: false, reason: 'card_frozen' });
  });

  it('declines an inactive card', () => {
    const d = decideAuthorization({ ...base, cardStatus: 'inactive', spendableCents: 9999, amountCents: 100 });
    expect(d.reason).toBe('card_inactive');
  });

  it('declines a blocked merchant category', () => {
    const d = decideAuthorization({ ...base, blockedCategories: ['gambling'], merchantCategory: 'gambling', spendableCents: 9999, amountCents: 100 });
    expect(d.reason).toBe('blocked_category');
  });

  it('approves an allowed category', () => {
    const d = decideAuthorization({ ...base, blockedCategories: ['gambling'], merchantCategory: 'grocery_stores', spendableCents: 9999, amountCents: 100 });
    expect(d.approve).toBe(true);
  });

  it('allows spending exactly the full balance', () => {
    expect(decideAuthorization({ ...base, spendableCents: 2500, amountCents: 2500 }).approve).toBe(true);
  });
});

describe('precheckCardAuthorization (card-level, no balance — balance is reserved atomically)', () => {
  const base = { isFrozen: false, cardStatus: 'active', blockedCategories: [] as string[], merchantCategory: null as string | null };

  it('returns null when the card is fine (caller then reserves funds)', () => {
    expect(precheckCardAuthorization(base)).toBeNull();
  });

  it('declines an inactive card', () => {
    expect(precheckCardAuthorization({ ...base, cardStatus: 'inactive' })).toEqual({ approve: false, reason: 'card_inactive' });
  });

  it('declines a frozen card', () => {
    expect(precheckCardAuthorization({ ...base, isFrozen: true })).toEqual({ approve: false, reason: 'card_frozen' });
  });

  it('declines a blocked merchant category', () => {
    expect(precheckCardAuthorization({ ...base, blockedCategories: ['gambling'], merchantCategory: 'gambling' }))
      .toEqual({ approve: false, reason: 'blocked_category' });
  });

  it('passes an allowed category through (null)', () => {
    expect(precheckCardAuthorization({ ...base, blockedCategories: ['gambling'], merchantCategory: 'grocery_stores' })).toBeNull();
  });
});
