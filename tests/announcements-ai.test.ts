import { describe, expect, it } from 'vitest';
import { analyzeAnnouncements, buildAnnouncementsPrompt, parseAnnouncementsResponse, type AnnouncementForAI } from '@/lib/announcements/announcements-ai';

function announcement(overrides: Partial<AnnouncementForAI> = {}): AnnouncementForAI {
  return { title: 'Family BBQ this Saturday', body: 'Bring a side dish!', is_pinned: false, created_at: '2025-07-01T10:00:00Z', ...overrides };
}

describe('analyzeAnnouncements', () => {
  it('summarizes announcements', () => {
    const r = analyzeAnnouncements([announcement(), announcement({ is_pinned: true })]);
    expect(r.totalAnnouncements).toBe(2);
    expect(r.pinnedCount).toBe(1);
  });
  it('handles empty', () => { expect(analyzeAnnouncements([]).summary).toContain('No announcements'); });
});

describe('buildAnnouncementsPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildAnnouncementsPrompt([announcement()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Family BBQ');
  });
});

describe('parseAnnouncementsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseAnnouncementsResponse('{"suggestions":["weekly updates"],"communicationTips":["be concise"],"engagementTip":"ask for feedback"}');
    expect(r.suggestions).toEqual(['weekly updates']);
  });
  it('handles malformed', () => { expect(parseAnnouncementsResponse('bad').suggestions).toEqual([]); });
});
