import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const cardsView = readFileSync('components/wallet/money-cards-view.tsx', 'utf8');
const childView = readFileSync('components/wallet/child-detail-view.tsx', 'utf8');

describe('wallet card availability contract', () => {
  it('does not promise cards when the provider capability is disabled', () => {
    expect(cardsView).toContain('Spending cards are unavailable');
    expect(cardsView).toContain('card program has been configured');
    expect(cardsView).not.toContain('Spending cards coming soon');
  });

  it('labels the child card surface as a non-issued preview', () => {
    expect(childView).toContain('function SpendingCardPreview');
    expect(childView).toContain('No payment card issued');
    expect(childView).toContain('Ledger only');
    expect(childView).not.toContain('>VISA</p>');
  });
});
