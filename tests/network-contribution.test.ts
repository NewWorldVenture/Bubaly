import { describe, it, expect } from 'vitest';
import { computeContribution, type ContributionInput } from '@/lib/network/contribution';

const NOW = new Date('2026-07-06T12:00:00Z');
const get = (bs: ReturnType<typeof computeContribution>, label: string) => bs.find((b) => b.label === label)?.value;

describe('computeContribution', () => {
  it('derives coarse child age bands (never exact ages), de-duplicated and ordered', () => {
    const input: ContributionInput = {
      memberBirthdays: ['2018-01-01', '2019-06-01', '2012-03-01', '1985-01-01'], // 8, 7, 14, adult
      householdSize: 4, plannedDinnersPerWeek: 4, activeActivities: 2,
    };
    const b = computeContribution(input, NOW);
    expect(get(b, 'Children in age bands')).toBe('6–9, 14–17'); // 8 & 7 collapse to 6–9; 14 → 14–17; adult excluded
  });

  it('omits the age-band bucket when there are no children', () => {
    const b = computeContribution({ memberBirthdays: ['1980-01-01', null], householdSize: 2, plannedDinnersPerWeek: 0, activeActivities: 0 }, NOW);
    expect(get(b, 'Children in age bands')).toBeUndefined();
  });

  it('bands household size rather than exact count', () => {
    expect(get(computeContribution({ memberBirthdays: [], householdSize: 1, plannedDinnersPerWeek: 0, activeActivities: 0 }, NOW), 'Household size')).toBe('1–2');
    expect(get(computeContribution({ memberBirthdays: [], householdSize: 4, plannedDinnersPerWeek: 0, activeActivities: 0 }, NOW), 'Household size')).toBe('3–4');
    expect(get(computeContribution({ memberBirthdays: [], householdSize: 7, plannedDinnersPerWeek: 0, activeActivities: 0 }, NOW), 'Household size')).toBe('5+');
  });

  it('bands the dinner-planning habit', () => {
    expect(get(computeContribution({ memberBirthdays: [], householdSize: 3, plannedDinnersPerWeek: 7, activeActivities: 0 }, NOW), 'Dinner planning habit')).toBe('most nights (6–7)');
    expect(get(computeContribution({ memberBirthdays: [], householdSize: 3, plannedDinnersPerWeek: 1, activeActivities: 0 }, NOW), 'Dinner planning habit')).toBe('rarely (0–1)');
  });

  it('bands activity counts', () => {
    expect(get(computeContribution({ memberBirthdays: [], householdSize: 3, plannedDinnersPerWeek: 0, activeActivities: 6 }, NOW), 'Activities')).toBe('5+');
    expect(get(computeContribution({ memberBirthdays: [], householdSize: 3, plannedDinnersPerWeek: 0, activeActivities: 0 }, NOW), 'Activities')).toBe('none');
  });

  it('ignores unparseable/absent birthdays without crashing', () => {
    const b = computeContribution({ memberBirthdays: ['not-a-date', null], householdSize: 3, plannedDinnersPerWeek: 2, activeActivities: 1 }, NOW);
    expect(get(b, 'Children in age bands')).toBeUndefined();
    expect(b.length).toBe(3); // size, dinners, activities
  });
});
