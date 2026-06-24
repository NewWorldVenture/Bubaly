import { describe, expect, it } from 'vitest';
import {
  analyzeTimetable,
  buildTimetablePrompt,
  parseTimetableResponse,
  type TimetableClassLike,
} from '@/lib/school/timetable-ai';

function cls(overrides: Partial<TimetableClassLike> = {}): TimetableClassLike {
  return {
    subject: 'Math', teacher: 'Ms. Lee', room: '204', time_slot: '9:00 AM',
    day_of_week: 1, week_pattern: 'all', member_id: 'kid1', ...overrides,
  };
}

describe('analyzeTimetable', () => {
  it('summarizes classes', () => {
    const r = analyzeTimetable([
      cls({ subject: 'Math', day_of_week: 1 }),
      cls({ subject: 'English', day_of_week: 2 }),
      cls({ subject: 'Math', day_of_week: 3 }),
    ]);
    expect(r.totalClasses).toBe(3);
    expect(r.subjectCounts['Math']).toBe(2);
    expect(r.subjectCounts['English']).toBe(1);
    expect(r.summary).toContain('3 classes');
  });

  it('finds busiest day', () => {
    const r = analyzeTimetable([
      cls({ day_of_week: 1 }),
      cls({ day_of_week: 1 }),
      cls({ day_of_week: 2 }),
    ]);
    expect(r.busiestDay).toBe('Monday');
  });

  it('counts unique students', () => {
    const r = analyzeTimetable([
      cls({ member_id: 'kid1' }),
      cls({ member_id: 'kid2' }),
      cls({ member_id: 'kid1' }),
    ]);
    expect(r.memberCount).toBe(2);
  });

  it('handles empty list', () => {
    const r = analyzeTimetable([]);
    expect(r.totalClasses).toBe(0);
    expect(r.busiestDay).toBeNull();
  });
});

describe('buildTimetablePrompt', () => {
  it('builds prompt with class info', () => {
    const { system, user } = buildTimetablePrompt([cls({ subject: 'Science', teacher: 'Mr. Smith' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Science');
    expect(user).toContain('Mr. Smith');
  });
});

describe('parseTimetableResponse', () => {
  it('parses valid JSON', () => {
    const r = parseTimetableResponse('{"suggestions":["review before class"],"studyTips":["use flashcards"],"organizationTip":"color code binders"}');
    expect(r.suggestions).toEqual(['review before class']);
    expect(r.studyTips).toEqual(['use flashcards']);
    expect(r.organizationTip).toBe('color code binders');
  });

  it('handles malformed input', () => {
    const r = parseTimetableResponse('nothing');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseTimetableResponse('```json\n{"suggestions":["x"],"studyTips":["y"],"organizationTip":"z"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
