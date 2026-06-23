import { describe, expect, it } from 'vitest';
import {
  normalizeOptions, castVote, totalVotes, memberVote, votePercent,
  leadingOptions, winnerLabel, type PollOption,
} from '@/lib/meals/voting';

const opts = (): PollOption[] => ([
  { id: 'o1', label: 'Tacos', voter_ids: ['m1', 'm2'] },
  { id: 'o2', label: 'Pizza', voter_ids: ['m3'] },
]);

describe('normalizeOptions', () => {
  it('cleans jsonb and drops unlabeled', () => {
    const got = normalizeOptions([
      { id: 'x', label: 'Soup', voter_ids: ['m1', 5] },
      { label: '' },
      'junk',
    ]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: 'x', label: 'Soup', voter_ids: ['m1'] });
  });
  it('synthesizes a stable id when missing', () => {
    const a = normalizeOptions([{ label: 'Curry' }]);
    const b = normalizeOptions([{ label: 'Curry' }]);
    expect(a[0].id).toBe(b[0].id);
  });
  it('returns [] for non-arrays', () => {
    expect(normalizeOptions(null)).toEqual([]);
  });
});

describe('castVote (single choice)', () => {
  it('adds a new vote', () => {
    const next = castVote(opts(), 'o2', 'm4');
    expect(memberVote(next, 'm4')).toBe('o2');
  });
  it('moves a member between options', () => {
    const next = castVote(opts(), 'o2', 'm1');
    expect(memberVote(next, 'm1')).toBe('o2');
    expect(next.find((o) => o.id === 'o1')!.voter_ids).not.toContain('m1');
  });
  it('toggles off when re-voting the same option', () => {
    const next = castVote(opts(), 'o1', 'm1');
    expect(memberVote(next, 'm1')).toBeNull();
  });
});

describe('tallies', () => {
  it('totals + percents', () => {
    expect(totalVotes(opts())).toBe(3);
    expect(votePercent(opts(), 'o1')).toBe(67);
    expect(votePercent(opts(), 'o2')).toBe(33);
  });
  it('percent is 0 with no votes', () => {
    expect(votePercent(normalizeOptions([{ label: 'A' }]), 'anything')).toBe(0);
  });
  it('leading + winner', () => {
    expect(leadingOptions(opts()).map((o) => o.id)).toEqual(['o1']);
    expect(winnerLabel(opts())).toBe('Tacos');
  });
  it('no winner on a tie or empty', () => {
    const tie: PollOption[] = [
      { id: 'a', label: 'A', voter_ids: ['m1'] },
      { id: 'b', label: 'B', voter_ids: ['m2'] },
    ];
    expect(winnerLabel(tie)).toBeNull();
    expect(leadingOptions([{ id: 'a', label: 'A', voter_ids: [] }])).toEqual([]);
  });
});
