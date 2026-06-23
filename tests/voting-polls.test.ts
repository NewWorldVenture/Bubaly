import { describe, expect, it } from 'vitest';
import {
  tallyPoll, voterCount, memberSelections, winningLabels, isPollClosed,
  type OptionLike, type VoteLike,
} from '@/lib/voting/polls';

const options: OptionLike[] = [
  { id: 'a', label: 'Beach', sort: 0 },
  { id: 'b', label: 'Mountains', sort: 1 },
  { id: 'c', label: 'City', sort: 2 },
];
const votes: VoteLike[] = [
  { option_id: 'a', member_id: 'm1' },
  { option_id: 'a', member_id: 'm2' },
  { option_id: 'b', member_id: 'm3' },
];

describe('tallyPoll', () => {
  it('counts, percentages and leader', () => {
    const t = tallyPoll(options, votes);
    expect(t[0]).toEqual({ optionId: 'a', label: 'Beach', count: 2, pct: 67, leading: true });
    expect(t[1].count).toBe(1);
    expect(t[2].count).toBe(0);
    expect(t[1].leading).toBe(false);
  });
  it('flags ties as both leading', () => {
    const t = tallyPoll(options, [{ option_id: 'a', member_id: 'm1' }, { option_id: 'b', member_id: 'm2' }]);
    expect(t.filter((x) => x.leading).map((x) => x.optionId).sort()).toEqual(['a', 'b']);
  });
  it('no votes → no leader', () => {
    expect(tallyPoll(options, []).some((t) => t.leading)).toBe(false);
  });
});

describe('voterCount / memberSelections / winningLabels', () => {
  it('counts distinct voters', () => {
    expect(voterCount(votes)).toBe(3);
  });
  it('member selections', () => {
    expect([...memberSelections(votes, 'm1')]).toEqual(['a']);
    expect(memberSelections(votes, 'mX').size).toBe(0);
  });
  it('winning labels', () => {
    expect(winningLabels(tallyPoll(options, votes))).toEqual(['Beach']);
  });
});

describe('isPollClosed', () => {
  const now = new Date('2026-06-24T12:00:00Z');
  it('explicit closed', () => {
    expect(isPollClosed('closed', null, now)).toBe(true);
  });
  it('deadline passed', () => {
    expect(isPollClosed('open', '2026-06-24T11:00:00Z', now)).toBe(true);
    expect(isPollClosed('open', '2026-06-24T13:00:00Z', now)).toBe(false);
  });
  it('open, no deadline', () => {
    expect(isPollClosed('open', null, now)).toBe(false);
  });
});
