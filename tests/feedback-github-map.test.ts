import { describe, it, expect } from 'vitest';
import {
  listLabelForKind, githubLabels, issueTitle, issueBody, feedbackMarker,
  feedbackIdFromBody, statusFromIssue, githubStateForStatus,
  GH_BUG_LABEL, GH_ENHANCEMENT_LABEL, GH_MARKER_LABEL,
} from '@/lib/feedback/github-map';

const ID = '11111111-2222-4333-8444-555555555555';

describe('kind → list label (the two lists)', () => {
  it('bug goes to the bug list, idea to enhancement', () => {
    expect(listLabelForKind('bug')).toBe(GH_BUG_LABEL);
    expect(listLabelForKind('idea')).toBe(GH_ENHANCEMENT_LABEL);
    expect(listLabelForKind(null)).toBe(GH_ENHANCEMENT_LABEL);
    expect(listLabelForKind('nonsense')).toBe(GH_ENHANCEMENT_LABEL);
  });

  it('labels include the list label, marker, and area', () => {
    expect(githubLabels({ kind: 'bug', category: 'calendar' })).toEqual([GH_BUG_LABEL, GH_MARKER_LABEL, 'area:calendar']);
    expect(githubLabels({ kind: 'idea', category: 'nope' })).toEqual([GH_ENHANCEMENT_LABEL, GH_MARKER_LABEL]);
  });
});

describe('issue title + body + marker round-trip', () => {
  it('tags the title by kind', () => {
    expect(issueTitle({ title: 'Dark mode', kind: 'idea' })).toBe('[Idea] Dark mode');
    expect(issueTitle({ title: 'Crash on save', kind: 'bug' })).toBe('[Bug] Crash on save');
    expect(issueTitle({ title: '', kind: 'bug' })).toBe('[Bug] Untitled');
  });

  it('embeds a recoverable feedback-id marker in the body', () => {
    const body = issueBody({ id: ID, title: 'X', kind: 'bug', problem: 'It breaks', category: 'meals', vote_count: 3, author_name: 'Sam' }, 'https://b/feedback');
    expect(body).toContain(feedbackMarker(ID));
    expect(body).toContain('steps to reproduce');
    expect(body).toContain('Votes:** 3');
    expect(feedbackIdFromBody(body)).toBe(ID);
  });

  it('recovers the id from a messy body and returns null when absent', () => {
    expect(feedbackIdFromBody(`noise\n<!--   bubaly-feedback:${ID}  -->\nmore`)).toBe(ID);
    expect(feedbackIdFromBody('no marker here')).toBeNull();
    expect(feedbackIdFromBody(null)).toBeNull();
  });

  it('uses idea-flavored copy for ideas', () => {
    const body = issueBody({ id: ID, title: 'X', kind: 'idea', problem: 'toil', body: 'do it', category: 'other' }, 'u');
    expect(body).toContain('Problem it solves');
    expect(body).toContain('The idea');
  });
});

describe('statusFromIssue — GitHub state → feedback status', () => {
  it('closed as completed → shipped', () => {
    expect(statusFromIssue({ state: 'closed', stateReason: 'completed', labels: [] })).toBe('shipped');
    expect(statusFromIssue({ state: 'closed', stateReason: null, labels: ['bug'] })).toBe('shipped');
  });
  it('closed as not-planned / wontfix → declined', () => {
    expect(statusFromIssue({ state: 'closed', stateReason: 'not_planned', labels: [] })).toBe('declined');
    expect(statusFromIssue({ state: 'closed', stateReason: 'completed', labels: ['wontfix'] })).toBe('declined');
  });
  it('open + workflow labels', () => {
    expect(statusFromIssue({ state: 'open', labels: ['in progress'] })).toBe('in_progress');
    expect(statusFromIssue({ state: 'open', labels: ['Planned'] })).toBe('planned');
  });
  it('open with no workflow label → no change', () => {
    expect(statusFromIssue({ state: 'open', labels: ['bug', 'bubaly-feedback'] })).toBeNull();
  });
});

describe('githubStateForStatus', () => {
  it('closes shipped/declined, keeps the rest open', () => {
    expect(githubStateForStatus('shipped')).toBe('closed');
    expect(githubStateForStatus('declined')).toBe('closed');
    expect(githubStateForStatus('planned')).toBe('open');
    expect(githubStateForStatus('under_review')).toBe('open');
  });
});
