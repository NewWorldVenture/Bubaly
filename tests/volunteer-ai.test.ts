import { describe, expect, it } from 'vitest';
import { analyzeVolunteer, buildVolunteerPrompt, parseVolunteerResponse, type VolunteerOpportunityForAI } from '@/lib/volunteer/volunteer-ai';

function opportunity(overrides: Partial<VolunteerOpportunityForAI> = {}): VolunteerOpportunityForAI {
  return { title: 'Food bank sorting', organization: 'Local Food Bank', category: 'community', start_date: '2025-07-01', total_hours: 8, ...overrides };
}

describe('analyzeVolunteer', () => {
  it('summarizes opportunities', () => {
    const r = analyzeVolunteer([opportunity(), opportunity({ category: 'education', total_hours: 4 })]);
    expect(r.totalOpportunities).toBe(2);
    expect(r.totalHours).toBe(12);
  });
  it('handles empty', () => { expect(analyzeVolunteer([]).summary).toContain('No volunteer'); });
});

describe('buildVolunteerPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildVolunteerPrompt([opportunity()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Food bank');
  });
});

describe('parseVolunteerResponse', () => {
  it('parses valid JSON', () => {
    const r = parseVolunteerResponse('{"suggestions":["track impact"],"impactTips":["involve kids"],"opportunityIdea":"park cleanup day"}');
    expect(r.suggestions).toEqual(['track impact']);
  });
  it('handles malformed', () => { expect(parseVolunteerResponse('bad').suggestions).toEqual([]); });
});
