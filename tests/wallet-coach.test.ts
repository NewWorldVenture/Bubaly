import { describe, it, expect } from 'vitest';
import { buildWalletCoachPrompt, parseWalletCoach } from '@/lib/wallet/coach';

describe('buildWalletCoachPrompt', () => {
  it('embeds children, balances, and goal forecasts; asks for JSON', () => {
    const { system, user } = buildWalletCoachPrompt({
      familyName: 'The Smiths',
      children: [{ name: 'Liam', totalCents: 5800, saveCents: 3000 }],
      goals: [{ childName: 'Liam', title: 'Bike', savedCents: 5800, targetCents: 10000, weeksToGoal: 3 }],
    });
    expect(system).toContain('STRUCTURED JSON');
    expect(user).toContain('Liam');
    expect(user).toContain('$58'); // formatted balance
    expect(user).toContain('3 weeks away');
  });
  it('handles empty children and goals', () => {
    const { user } = buildWalletCoachPrompt({ familyName: 'X', children: [], goals: [] });
    expect(user).toContain('(no child wallets yet)');
    expect(user).toContain('(no goals yet)');
  });
  it('labels reached and uncontributed goals', () => {
    const { user } = buildWalletCoachPrompt({
      familyName: 'X', children: [],
      goals: [
        { childName: null, title: 'Vacation', savedCents: 10000, targetCents: 10000, weeksToGoal: 0 },
        { childName: null, title: 'Car', savedCents: 0, targetCents: 500000, weeksToGoal: null },
      ],
    });
    expect(user).toContain('reached!');
    expect(user).toContain('no contributions yet');
  });
});

describe('parseWalletCoach', () => {
  it('parses a clean object', () => {
    const raw = JSON.stringify({ headline: 'Great momentum!', insights: ['Liam saved $30', 'Giving is up'], suggestion: 'Add $5/wk' });
    expect(parseWalletCoach(raw)).toEqual({ headline: 'Great momentum!', insights: ['Liam saved $30', 'Giving is up'], suggestion: 'Add $5/wk' });
  });
  it('strips code fences and prose, caps insights at 4', () => {
    const raw = '```json\n{"headline":"Hi","insights":["a","b","c","d","e"],"suggestion":"s"}\n```';
    const out = parseWalletCoach(raw);
    expect(out.headline).toBe('Hi');
    expect(out.insights).toHaveLength(4);
  });
  it('returns empty shape on malformed input', () => {
    expect(parseWalletCoach('nope')).toEqual({ headline: '', insights: [], suggestion: '' });
  });
});
