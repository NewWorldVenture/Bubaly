import { describe, it, expect } from 'vitest';
import {
  processingFeeCents, computeFunding, totalFeesCents, serviceFeeLabel,
  SERVICE_FEE_CENTS,
} from '@/lib/wallet/fees';
import {
  WALLET_TIERS, WALLET_TIER_ORDER, walletFeatureEnabled, aiCoachLevel,
  physicalCardLevel, AI_COACH_DAILY_LIMIT, walletTierForPlanLevel,
} from '@/lib/wallet/tiers';

describe('processingFeeCents', () => {
  it('is 2.9% + $0.30 (Stripe standard online)', () => {
    expect(processingFeeCents(5000)).toBe(175); // $50 → $1.75
    expect(processingFeeCents(0)).toBe(30);
  });
});

describe('computeFunding — matches published pricing examples', () => {
  it('Free plan: $50 gift costs $52.74, child gets $50', () => {
    const b = computeFunding(5000, 'free');
    expect(b.processingCents).toBe(175);
    expect(b.serviceFeeCents).toBe(99);
    expect(b.totalChargedCents).toBe(5274);
    expect(b.amountCents).toBe(5000);
  });
  it('Plus plan: $50 gift costs $51.75 (no Bubaly fee)', () => {
    const b = computeFunding(5000, 'plus');
    expect(b.serviceFeeCents).toBe(0);
    expect(b.totalChargedCents).toBe(5175);
  });
  it('Basic plan: reduced fee', () => {
    const b = computeFunding(5000, 'basic');
    expect(b.serviceFeeCents).toBe(SERVICE_FEE_CENTS.basic);
    expect(b.totalChargedCents).toBe(5000 + 175 + 49);
  });
  it('charges nothing on a $0 funding', () => {
    expect(computeFunding(0, 'free')).toMatchObject({ processingCents: 0, serviceFeeCents: 0, totalChargedCents: 0 });
  });
});

describe('totalFeesCents / serviceFeeLabel', () => {
  it('sums processing + service fee', () => {
    expect(totalFeesCents(5000, 'free')).toBe(274);
    expect(totalFeesCents(5000, 'plus')).toBe(175);
  });
  it('labels the service fee per tier', () => {
    expect(serviceFeeLabel('free')).toBe('Yes');
    expect(serviceFeeLabel('basic')).toBe('Reduced');
    expect(serviceFeeLabel('plus')).toBe('None');
  });
});

describe('wallet tier matrix', () => {
  it('every tier has wallet, gifts, chores', () => {
    for (const t of WALLET_TIER_ORDER) {
      expect(walletFeatureEnabled(t, 'wallet')).toBe(true);
      expect(walletFeatureEnabled(t, 'gifts')).toBe(true);
      expect(walletFeatureEnabled(t, 'chores')).toBe(true);
    }
  });
  it('allowances are Basic+ only', () => {
    expect(walletFeatureEnabled('free', 'allowances')).toBe(false);
    expect(walletFeatureEnabled('basic', 'allowances')).toBe(true);
    expect(walletFeatureEnabled('plus', 'allowances')).toBe(true);
  });
  it('AI coach scales none → limited → unlimited', () => {
    expect(aiCoachLevel('free')).toBe('none');
    expect(aiCoachLevel('basic')).toBe('limited');
    expect(aiCoachLevel('plus')).toBe('unlimited');
    expect(AI_COACH_DAILY_LIMIT.free).toBe(0);
    expect(AI_COACH_DAILY_LIMIT.basic).toBe(5);
    expect(AI_COACH_DAILY_LIMIT.plus).toBe(Infinity);
  });
  it('physical cards scale none → optional → included', () => {
    expect(physicalCardLevel('free')).toBe('none');
    expect(physicalCardLevel('basic')).toBe('optional');
    expect(physicalCardLevel('plus')).toBe('included');
  });
  it('serviceFee drops full → reduced → none', () => {
    expect(WALLET_TIERS.free.serviceFee).toBe('full');
    expect(WALLET_TIERS.basic.serviceFee).toBe('reduced');
    expect(WALLET_TIERS.plus.serviceFee).toBe('none');
  });
});

describe('walletTierForPlanLevel', () => {
  it('maps plan levels 0/1/2 to free/basic/plus', () => {
    expect(walletTierForPlanLevel(0)).toBe('free');
    expect(walletTierForPlanLevel(1)).toBe('basic');
    expect(walletTierForPlanLevel(2)).toBe('plus');
    expect(walletTierForPlanLevel(99)).toBe('plus');
  });
});
