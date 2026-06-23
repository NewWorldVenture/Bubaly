import { describe, expect, it } from 'vitest';
import {
  buildGrandparentDigest, digestSummary, celebrationCountdown,
  type MemberSnapshot, type PhotoSnapshot, type MilestoneSnapshot,
  type AnnouncementSnapshot, type CelebrationSnapshot,
} from '@/lib/grandparent/digest';

const members: MemberSnapshot[] = [
  { name: 'Mom', birthday: '1980-06-15', color: '#7c5dfa', role: 'parent' },
  { name: 'Dad', birthday: '1978-03-22', color: '#f59e0b', role: 'parent' },
  { name: 'Emma', birthday: '2015-09-01', color: '#22c55e', role: 'child' },
];

const photos: PhotoSnapshot[] = [
  { url: 'https://example.com/1.jpg', caption: 'Beach day', date: '2026-06-10' },
  { url: 'https://example.com/2.jpg', caption: null, date: '2026-06-08' },
];

const milestones: MilestoneSnapshot[] = [
  { title: 'First loose tooth', description: 'Emma lost her first tooth', date: '2026-06-01', memberName: 'Emma' },
];

const announcements: AnnouncementSnapshot[] = [
  { title: 'Summer camp starts Monday', body: 'Pack sunscreen!', authorName: 'Mom', date: '2026-06-20' },
];

const celebrations: CelebrationSnapshot[] = [
  { title: "Emma's birthday", date: '2026-09-01', daysUntil: 70 },
  { title: 'Anniversary', date: '2026-12-25', daysUntil: 185 },
  { title: 'School play', date: '2026-06-25', daysUntil: 2 },
];

describe('grandparent digest', () => {
  it('builds a digest with correct limits', () => {
    const d = buildGrandparentDigest({ familyName: 'The Smiths', members, photos, milestones, announcements, celebrations });
    expect(d.familyName).toBe('The Smiths');
    expect(d.members).toHaveLength(3);
    expect(d.recentPhotos).toHaveLength(2);
    expect(d.recentMilestones).toHaveLength(1);
    expect(d.recentAnnouncements).toHaveLength(1);
  });

  it('filters celebrations to 90 days and sorts by soonest', () => {
    const d = buildGrandparentDigest({ familyName: 'Test', members: [], photos: [], milestones: [], announcements: [], celebrations });
    expect(d.upcomingCelebrations).toHaveLength(2);
    expect(d.upcomingCelebrations[0].title).toBe('School play');
    expect(d.upcomingCelebrations[1].title).toBe("Emma's birthday");
  });

  it('digestSummary', () => {
    const d = buildGrandparentDigest({ familyName: 'Test', members, photos, milestones, announcements, celebrations });
    const s = digestSummary(d);
    expect(s).toContain('3 family members');
    expect(s).toContain('2 recent photos');
    expect(s).toContain('1 milestone');
  });

  it('celebrationCountdown', () => {
    expect(celebrationCountdown(0)).toBe('Today!');
    expect(celebrationCountdown(1)).toBe('Tomorrow');
    expect(celebrationCountdown(5)).toBe('in 5 days');
    expect(celebrationCountdown(21)).toBe('in 3 weeks');
    expect(celebrationCountdown(75)).toBe('in 3 months');
  });

  it('empty input produces empty digest', () => {
    const d = buildGrandparentDigest({ familyName: 'Empty', members: [], photos: [], milestones: [], announcements: [], celebrations: [] });
    expect(d.members).toHaveLength(0);
    expect(d.upcomingCelebrations).toHaveLength(0);
    expect(digestSummary(d)).toBe('0 family members');
  });
});
