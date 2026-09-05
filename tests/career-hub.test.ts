import { describe, expect, it } from 'vitest';
import {
  parseKeywords, containsKeyword, atsScore, pipelineStats, followUps, salaryFit, careerMap, careerSummary, OPEN_STAGES,
  type ProfileLike, type ApplicationLike,
} from '@/lib/career/hub';

const TODAY = new Date('2026-09-05T12:00:00');
const profile = (p: Partial<ProfileLike> & { id: string }): ProfileLike => ({ member_id: 'm1', skills: [], target_roles: [], target_keywords: [], status: 'active_search', weekly_goal: 5, salary_target_cents: null, ...p });
const app = (p: Partial<ApplicationLike> & { id: string }): ApplicationLike => ({ profile_id: 'p1', company: 'Acme', role_title: 'Engineer', stage: 'applied', applied_on: '2026-09-01', last_activity_on: null, next_step: null, next_step_on: null, salary_min_cents: null, salary_max_cents: null, excitement: null, created_at: '2026-09-01T00:00:00Z', ...p });

describe('keywords', () => {
  it('parses lines and matches whole words only', () => {
    expect(parseKeywords('React, Node.js; SQL\nreact ')).toEqual(['react', 'node.js', 'sql']);
    expect(containsKeyword('Built APIs with Node.js and SQL.', 'node.js')).toBe(true);
    expect(containsKeyword('Used SQLite heavily', 'sql')).toBe(false);
    expect(containsKeyword('C++ and C# services', 'c++')).toBe(true);
  });
});

describe('atsScore', () => {
  const body = `Summary\nEngineer with 6 years shipping React and Node.js products.\nExperience\nCut page load 40% for 2M users. Led a team of 4.\nSkills\nReact, Node.js, SQL, Git, Testing`;
  it('scores keyword coverage plus structure and lists what is missing', () => {
    const r = atsScore(`${body} ${'lorem '.repeat(250)}`, ['react', 'node.js', 'sql', 'kubernetes', 'graphql']);
    expect(r.matched).toEqual(['react', 'node.js', 'sql']);
    expect(r.missing).toEqual(['kubernetes', 'graphql']);
    expect(r.score).toBe(68); // 3/5 × 80 + 4/4 × 20
    expect(r.hints[0]).toContain('Missing 2 of 5');
  });
  it('flags a short unstructured resume', () => {
    const r = atsScore('I worked at a shop and did things.', ['pos', 'customer service']);
    expect(r.score).toBe(0);
    expect(r.hints).toContain('Add a 2–3 line summary at the top');
    expect(r.hints.some((h) => h.startsWith('Too short'))).toBe(true);
  });
});

describe('pipelineStats', () => {
  it('counts stages, rates and this week against the goal', () => {
    const apps = [
      app({ id: 'a', stage: 'applied', applied_on: '2026-09-03' }),
      app({ id: 'b', stage: 'screening', applied_on: '2026-08-20', last_activity_on: '2026-08-26' }),
      app({ id: 'c', stage: 'interview', applied_on: '2026-08-15', last_activity_on: '2026-08-25' }),
      app({ id: 'd', stage: 'rejected', applied_on: '2026-08-01' }),
      app({ id: 'e', stage: 'saved', applied_on: null }),
      app({ id: 'x', profile_id: 'other' }),
    ];
    const s = pipelineStats(apps, profile({ id: 'p1', weekly_goal: 4 }), TODAY);
    expect(s.total).toBe(5);
    expect(s.open).toBe(4);
    expect(s.byStage.interview).toBe(1);
    expect(s.responseRate).toBe(50); // b, c of a,b,c,d
    expect(s.interviewRate).toBe(25);
    expect(s.appliedThisWeek).toBe(1);
    expect(s.goalPct).toBe(25);
    expect(s.avgDaysToResponse).toBe(8); // (6 + 10) / 2
  });
});

describe('followUps', () => {
  it('orders overdue, due, then quiet applications', () => {
    const apps = [
      app({ id: 'quiet', stage: 'applied', applied_on: '2026-08-20' }),
      app({ id: 'due', stage: 'interview', next_step: 'Panel interview', next_step_on: '2026-09-05', last_activity_on: '2026-09-04' }),
      app({ id: 'late', stage: 'screening', next_step: 'Send references', next_step_on: '2026-09-02' }),
      app({ id: 'fresh', stage: 'applied', applied_on: '2026-09-04' }),
      app({ id: 'closed', stage: 'rejected', applied_on: '2026-07-01' }),
      app({ id: 'saved', stage: 'saved' }),
    ];
    const n = followUps(apps, 'p1', TODAY);
    expect(n.map((x) => x.application.id)).toEqual(['late', 'due', 'quiet']);
    expect(n[0].text).toBe('Send references was due 3 days ago');
    expect(n[1].text).toBe('Panel interview today');
    expect(n[2].kind).toBe('no_follow_up');
  });
});

describe('salaryFit + careerMap + summary', () => {
  it('compares ranges with the target and maps skills to roles', () => {
    const apps = [
      app({ id: 'a', salary_min_cents: 9000000, salary_max_cents: 11000000 }),
      app({ id: 'b', salary_min_cents: 7000000, salary_max_cents: 8000000 }),
      app({ id: 'c', stage: 'rejected', salary_min_cents: 1, salary_max_cents: 2 }),
    ];
    expect(salaryFit(apps, 'p1', 10000000)).toEqual({ withRange: 2, atOrAbove: 1, below: 1, medianMidCents: 10000000 });
    const map = careerMap({ skills: ['SQL', 'Excel', 'Python'], target_roles: ['Data Analyst', 'Software Engineer'], target_keywords: [] });
    expect(map[0].role).toBe('Data Analyst');
    expect(map[0].have).toEqual(['sql', 'excel', 'python']);
    expect(map[0].fitPct).toBe(38);
    expect(map[1].gap).toContain('react');
    expect(OPEN_STAGES).toContain('offer');
    const s = careerSummary([profile({ id: 'p1' })], [app({ id: 'o', stage: 'offer' })], TODAY);
    expect(s.text).toBe('1 offer on the table');
    expect(careerSummary([], [], TODAY).text).toBe('No career profiles yet');
  });
});
