import { describe, expect, it } from 'vitest';
import { analyzeCollege, buildCollegePrompt, parseCollegeResponse, type CollegeAppForAI, type ScholarshipForAI } from '@/lib/college/college-ai';

function app(overrides: Partial<CollegeAppForAI> = {}): CollegeAppForAI {
  return { school_name: 'MIT', program: 'CS', status: 'applied', deadline: '2025-03-01', tuition: 50000, financial_aid: 10000, ...overrides };
}
function scholarship(overrides: Partial<ScholarshipForAI> = {}): ScholarshipForAI {
  return { name: 'Merit Award', provider: 'Foundation', amount: 5000, status: 'applied', deadline: '2025-02-15', ...overrides };
}

describe('analyzeCollege', () => {
  it('summarizes apps and scholarships', () => {
    const r = analyzeCollege([app()], [scholarship()]);
    expect(r.totalApplications).toBe(1);
    expect(r.totalScholarships).toBe(1);
    expect(r.totalTuition).toBe(50000);
    expect(r.totalAid).toBe(15000);
  });

  it('handles empty', () => {
    const r = analyzeCollege([], []);
    expect(r.totalApplications).toBe(0);
    expect(r.summary).toContain('No college');
  });
});

describe('buildCollegePrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildCollegePrompt([app()], [scholarship()]);
    expect(system).toContain('JSON');
    expect(user).toContain('MIT');
  });
});

describe('parseCollegeResponse', () => {
  it('parses valid JSON', () => {
    const r = parseCollegeResponse('{"suggestions":["apply early"],"deadlineTips":["check dates"],"strategyTip":"diversify"}');
    expect(r.suggestions).toEqual(['apply early']);
    expect(r.strategyTip).toBe('diversify');
  });

  it('handles malformed', () => {
    expect(parseCollegeResponse('bad').suggestions).toEqual([]);
  });
});
