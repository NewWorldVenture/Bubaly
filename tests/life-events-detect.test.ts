// M34 — the household's own rows say which transition is coming.
//
// The detector is the difference between a menu of eleven playbooks and a
// product that says "Emma's term starts in 30 days — want the school checklist?"
// so every rule here is pinned against the evidence it claims to read, and the
// negative cases matter as much: a proposal with no evidence behind it is a
// guess dressed up as intelligence, and a proposal for a plan the family is
// already running is nagging.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  detectLifeEvents, daysBetweenKeys, launchDateFor,
  CAMP_WINDOW_DAYS, HOLIDAY_WINDOW_DAYS, NEW_PET_WINDOW_DAYS, SCHOOL_START_WINDOW_DAYS,
} from '@/lib/life-events/detect';
import { LIFE_EVENT_TEMPLATES } from '@/lib/life-events/templates';

const TODAY = '2026-03-10';
const keysOf = (list: { templateKey: string }[]) => list.map((s) => s.templateKey);

describe('day arithmetic', () => {
  it('counts whole days in both directions', () => {
    expect(daysBetweenKeys('2026-03-10', '2026-03-20')).toBe(10);
    expect(daysBetweenKeys('2026-03-10', '2026-03-01')).toBe(-9);
    expect(daysBetweenKeys('2026-02-27', '2026-03-01')).toBe(2);
    expect(Number.isNaN(daysBetweenKeys('nope', '2026-03-01'))).toBe(true);
  });
});

describe('an empty household proposes nothing', () => {
  it('returns no suggestions with no signals at all', () => {
    expect(detectLifeEvents({ todayKey: TODAY })).toEqual([]);
  });
  it('refuses a nonsense date rather than guessing', () => {
    expect(detectLifeEvents({ todayKey: 'later', pets: [{ name: 'Biscuit', createdKey: TODAY }] })).toEqual([]);
  });
});

describe('school start', () => {
  it('proposes it inside the window, with the term and the days in the reason', () => {
    const out = detectLifeEvents({ todayKey: TODAY, termStarts: [{ label: 'Autumn term', startKey: '2026-04-09' }] });
    const school = out.find((s) => s.templateKey === 'school_start')!;
    expect(school).toBeDefined();
    expect(school.eventDate).toBe('2026-04-09');
    expect(school.reason).toContain('Autumn term');
    expect(school.reasonKey).toBe('lifeEventsDetect.termStartsInDays');
    expect(school.reasonParams).toEqual({ label: 'Autumn term', days: 30 });
  });

  it('is silent past the window and for a term that already started', () => {
    const past = detectLifeEvents({ todayKey: TODAY, termStarts: [{ label: 'Spring term', startKey: '2026-03-01' }] });
    expect(keysOf(past)).not.toContain('school_start');
    const far = detectLifeEvents({
      todayKey: TODAY,
      termStarts: [{ label: 'Autumn term', startKey: `2026-06-01` }],
    });
    expect(daysBetweenKeys(TODAY, '2026-06-01')).toBeGreaterThan(SCHOOL_START_WINDOW_DAYS);
    expect(keysOf(far)).not.toContain('school_start');
  });

  it('scores a nearer term higher than a distant one', () => {
    const near = detectLifeEvents({ todayKey: TODAY, termStarts: [{ label: 'Term', startKey: '2026-03-15' }] })[0];
    const later = detectLifeEvents({ todayKey: TODAY, termStarts: [{ label: 'Term', startKey: '2026-04-20' }] })[0];
    expect(near.score).toBeGreaterThan(later.score);
  });
});

describe('a new pet', () => {
  it('proposes the playbook for a pet added this week', () => {
    const out = detectLifeEvents({ todayKey: TODAY, pets: [{ name: 'Biscuit', createdKey: '2026-03-08' }] });
    const pet = out.find((s) => s.templateKey === 'new_pet')!;
    expect(pet.reason).toContain('Biscuit');
    expect(pet.reasonParams).toEqual({ name: 'Biscuit' });
    expect(pet.eventDate).toBe('2026-03-08');
  });

  it('says nothing about a pet the family has had for a month', () => {
    const old = detectLifeEvents({ todayKey: TODAY, pets: [{ name: 'Rex', createdKey: '2026-02-01' }] });
    expect(daysBetweenKeys('2026-02-01', TODAY)).toBeGreaterThan(NEW_PET_WINDOW_DAYS);
    expect(keysOf(old)).toEqual([]);
  });

  it('proposes once for two pets added the same week', () => {
    const out = detectLifeEvents({
      todayKey: TODAY,
      pets: [{ name: 'Biscuit', createdKey: '2026-03-08' }, { name: 'Crumb', createdKey: '2026-03-09' }],
    });
    expect(keysOf(out).filter((k) => k === 'new_pet')).toHaveLength(1);
  });
});

describe('a renovation still being thought about', () => {
  it('proposes it for a project at planning or quoting', () => {
    const planning = detectLifeEvents({ todayKey: TODAY, homeProjects: [{ title: 'Kitchen', status: 'planning' }] });
    expect(planning[0]).toMatchObject({ templateKey: 'renovation', reasonParams: { title: 'Kitchen' }, eventDate: null });
    const quoting = detectLifeEvents({ todayKey: TODAY, homeProjects: [{ title: 'Kitchen', status: 'quoting' }] });
    expect(quoting[0].score).toBeGreaterThan(planning[0].score);
  });

  it('says nothing about a project already under way or finished', () => {
    for (const status of ['in_progress', 'done', 'cancelled', 'scheduled']) {
      expect(keysOf(detectLifeEvents({ todayKey: TODAY, homeProjects: [{ title: 'Kitchen', status }] })), status).toEqual([]);
    }
  });
});

describe('caring for a parent', () => {
  it('needs both a parent and a care word before it proposes anything', () => {
    const both = detectLifeEvents({ todayKey: TODAY, facts: [{ label: "Mum's medication", value: 'Two a day, 8am and 8pm' }] });
    expect(both[0]).toMatchObject({ templateKey: 'aging_parent' });
    expect(keysOf(detectLifeEvents({ todayKey: TODAY, facts: [{ label: "Mum's birthday", value: 'April 3' }] }))).toEqual([]);
    expect(keysOf(detectLifeEvents({ todayKey: TODAY, facts: [{ label: 'Car care', value: 'Service every year' }] }))).toEqual([]);
  });
});

describe('the season', () => {
  it('proposes the holidays only once they are close', () => {
    const close = detectLifeEvents({ todayKey: '2026-11-20' });
    expect(keysOf(close)).toContain('holidays');
    const far = detectLifeEvents({ todayKey: '2026-08-01' });
    expect(daysBetweenKeys('2026-08-01', '2026-11-27')).toBeGreaterThan(HOLIDAY_WINDOW_DAYS);
    expect(keysOf(far)).not.toContain('holidays');
  });

  it('proposes camp before the summer, but only for a household with school on file', () => {
    const withSchool = detectLifeEvents({ todayKey: '2026-04-01', termStarts: [{ label: 'Summer term', startKey: '2026-04-20' }] });
    expect(daysBetweenKeys('2026-04-01', '2026-06-15')).toBeLessThan(CAMP_WINDOW_DAYS);
    expect(keysOf(withSchool)).toContain('camp');
    expect(keysOf(detectLifeEvents({ todayKey: '2026-04-01' }))).not.toContain('camp');
  });
});

describe('what the family is already running', () => {
  it('never proposes a plan that is already live', () => {
    const signals = {
      todayKey: TODAY,
      termStarts: [{ label: 'Autumn term', startKey: '2026-04-09' }],
      pets: [{ name: 'Biscuit', createdKey: '2026-03-08' }],
    };
    // Camp rides along: this household has school on file and June is inside
    // the booking window from March.
    expect(keysOf(detectLifeEvents(signals)).sort()).toEqual(['camp', 'new_pet', 'school_start']);
    expect(keysOf(detectLifeEvents({ ...signals, activePlanKeys: ['school_start'] })).sort()).toEqual(['camp', 'new_pet']);
    expect(detectLifeEvents({ ...signals, activePlanKeys: ['school_start', 'new_pet', 'camp'] })).toEqual([]);
  });

  // The transitions this detector exists for come round every year. A family
  // who ran "The Holidays" in 2026 and ticked it off has a `life_event_plans`
  // row that never gets archived — so if a COMPLETED plan reached
  // `activePlanKeys`, holidays, school_start and camp would be silenced for
  // good, in the module and in the planner's proactive slice alike. Only a
  // plan with status 'active' belongs in this set.
  it('proposes the transition again next year once the last plan is finished', () => {
    const lastYear = { todayKey: '2026-11-20', activePlanKeys: ['holidays'] };
    expect(keysOf(detectLifeEvents(lastYear))).not.toContain('holidays');
    // A year on, the 2026 plan is completed — it is history, not a live plan,
    // so it is not in the set and the proposal comes back.
    expect(keysOf(detectLifeEvents({ todayKey: '2027-11-20', activePlanKeys: [] }))).toContain('holidays');

    const school = { termStarts: [{ label: 'Autumn term', startKey: '2027-09-02' }] };
    expect(keysOf(detectLifeEvents({ todayKey: '2027-08-10', activePlanKeys: [], ...school }))).toContain('school_start');
  });

  // Pinning the callers, because the bug the case above describes lives in the
  // QUERY, not in the detector: both reads must ask for active plans only.
  it('is fed only active plans by the page and by the proactive slice', () => {
    for (const file of ['app/(app)/dashboard/life-events/page.tsx', 'lib/ai/context/slices/proactive.ts']) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const read = source.split('\n').find((line) => line.includes("from('life_event_plans')"));
      expect(read, file).toBeDefined();
      expect(read, file).toContain("eq('status', 'active')");
      expect(read, file).not.toContain("neq('status'");
    }
  });
});

describe('the output is usable by the UI', () => {
  it('is sorted by urgency and names a template that really exists', () => {
    const out = detectLifeEvents({
      todayKey: TODAY,
      termStarts: [{ label: 'Autumn term', startKey: '2026-03-20' }],
      homeProjects: [{ title: 'Loft', status: 'planning' }],
      facts: [{ label: "Dad's carer", value: 'Comes Tuesdays' }],
    });
    expect(out.length).toBeGreaterThan(2);
    for (let i = 1; i < out.length; i += 1) expect(out[i - 1].score >= out[i].score).toBe(true);
    const keys = new Set(LIFE_EVENT_TEMPLATES.map((t) => t.key));
    for (const s of out) {
      expect(keys, s.templateKey).toContain(s.templateKey);
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.reasonKey.startsWith('lifeEventsDetect.')).toBe(true);
    }
  });

  it('falls back to the template lead time when the signal has no date', () => {
    const renovation = detectLifeEvents({ todayKey: TODAY, homeProjects: [{ title: 'Loft', status: 'planning' }] })[0];
    expect(renovation.eventDate).toBeNull();
    // Home Renovation's default lead time is 60 days.
    expect(launchDateFor(renovation, TODAY)).toBe('2026-05-09');
    const school = detectLifeEvents({ todayKey: TODAY, termStarts: [{ label: 'Term', startKey: '2026-04-09' }] })[0];
    expect(launchDateFor(school, TODAY)).toBe('2026-04-09');
  });
});
