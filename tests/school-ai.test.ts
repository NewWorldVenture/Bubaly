import { describe, expect, it } from 'vitest';
import { analyzeSchool, buildSchoolPrompt, parseSchoolResponse, type SchoolGradeForAI } from '@/lib/school/school-ai';

function grade(overrides: Partial<SchoolGradeForAI> = {}): SchoolGradeForAI {
  return { subject: 'Math', grade_type: 'test', score: 92, max_score: 100, date: '2025-06-01', ...overrides };
}

describe('analyzeSchool', () => {
  it('summarizes school data', () => {
    const r = analyzeSchool(4, [grade(), grade({ subject: 'English', score: 88 })]);
    expect(r.totalClasses).toBe(4);
    expect(r.totalGrades).toBe(2);
    expect(r.averageScore).toBe(90);
  });
  it('handles empty', () => { expect(analyzeSchool(0, []).summary).toContain('No school'); });
});

describe('buildSchoolPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildSchoolPrompt([grade()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Math');
  });
});

describe('parseSchoolResponse', () => {
  it('parses valid JSON', () => {
    const r = parseSchoolResponse('{"suggestions":["review weak areas"],"studyTips":["use flashcards"],"encouragement":"Keep up the great work!"}');
    expect(r.suggestions).toEqual(['review weak areas']);
  });
  it('handles malformed', () => { expect(parseSchoolResponse('bad').suggestions).toEqual([]); });
});
