import { describe, expect, it } from 'vitest';
import { analyzePolls, buildVotingPrompt, parseVotingResponse, type PollForAI } from '@/lib/voting/voting-ai';

function poll(overrides: Partial<PollForAI> = {}): PollForAI {
  return { question: 'Where to eat?', kind: 'single', status: 'open', closes_at: null, option_count: 3, vote_count: 5, ...overrides };
}

describe('analyzePolls', () => {
  it('summarizes polls', () => {
    const r = analyzePolls([poll(), poll({ status: 'closed', vote_count: 8 })]);
    expect(r.totalPolls).toBe(2);
    expect(r.activeCount).toBe(1);
    expect(r.closedCount).toBe(1);
    expect(r.totalVotes).toBe(13);
  });

  it('handles empty list', () => {
    const r = analyzePolls([]);
    expect(r.totalPolls).toBe(0);
    expect(r.totalVotes).toBe(0);
  });
});

describe('buildVotingPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildVotingPrompt([poll({ question: 'Movie night pick?' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Movie night pick?');
  });
});

describe('parseVotingResponse', () => {
  it('parses valid JSON', () => {
    const r = parseVotingResponse('{"suggestions":["set deadline"],"engagementTips":["notify everyone"],"decisionTip":"majority wins"}');
    expect(r.suggestions).toEqual(['set deadline']);
    expect(r.decisionTip).toBe('majority wins');
  });

  it('handles malformed input', () => {
    expect(parseVotingResponse('bad').suggestions).toEqual([]);
  });
});
