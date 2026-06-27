import { describe, it, expect } from 'vitest';
import { tallyVotes, winningOption, summarizeBallots } from '@/lib/recipes/voting';

describe('tallyVotes', () => {
  it('counts choices and scores them', () => {
    const t = tallyVotes(['a', 'b'], [
      { option_id: 'a', choice: 'yes' }, { option_id: 'a', choice: 'yes' }, { option_id: 'a', choice: 'no' },
      { option_id: 'b', choice: 'maybe' }, { option_id: 'b', choice: 'yes' },
    ]);
    expect(t[0]).toEqual({ optionId: 'a', yes: 2, no: 1, maybe: 0, score: 1.5 });
    expect(t[1]).toEqual({ optionId: 'b', yes: 1, no: 0, maybe: 1, score: 1.5 });
  });
  it('ignores ballots for unknown options', () => {
    const t = tallyVotes(['a'], [{ option_id: 'zzz', choice: 'yes' }]);
    expect(t[0].yes).toBe(0);
  });
});

describe('winningOption', () => {
  it('returns highest score, breaking ties by yes count', () => {
    const t = tallyVotes(['a', 'b'], [
      { option_id: 'a', choice: 'yes' }, { option_id: 'a', choice: 'yes' },
      { option_id: 'b', choice: 'yes' }, { option_id: 'b', choice: 'maybe' },
    ]);
    // a: score 2 (2 yes); b: score 1.5 → a wins
    expect(winningOption(t)).toBe('a');
  });
  it('returns null when there are no votes', () => {
    expect(winningOption(tallyVotes(['a', 'b'], []))).toBeNull();
  });
});

describe('summarizeBallots', () => {
  it('counts ballots and distinct voters', () => {
    expect(summarizeBallots([{ member_id: 'm1' }, { member_id: 'm1' }, { member_id: 'm2' }]))
      .toEqual({ totalBallots: 3, voters: 2 });
  });
});
