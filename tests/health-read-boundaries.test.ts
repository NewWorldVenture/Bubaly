import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const healthSource = readFileSync('components/modules/health-module.tsx', 'utf8');
const medicationsSource = readFileSync('components/modules/medications-module.tsx', 'utf8');

describe('health read boundaries', () => {
  it('coordinates health metrics, activity, appointments, reminders, symptoms, and goals', () => {
    expect(healthSource).toContain('error: symptomsError, refresh: refreshSymptoms');
    expect(healthSource).toContain('error: goalsError, refresh: refreshGoals');
    expect(healthSource).toContain('const loading = metricsLoading || workoutsLoading || apptLoading || remLoading || symptomsLoading || goalsLoading;');
    expect(healthSource).toContain('onRetry={refresh}');
  });

  it('coordinates medication, schedule, and dose reads before adherence metrics', () => {
    expect(medicationsSource).toContain('error: schedulesError, refresh: refreshSchedules');
    expect(medicationsSource).toContain('error: dosesError, refresh: refreshDoses');
    expect(medicationsSource).toContain('Could not load medication data. Refresh and try again.');
    expect(medicationsSource).toContain('void refreshMeds(); void refreshSchedules(); void refreshDoses();');
  });
});
