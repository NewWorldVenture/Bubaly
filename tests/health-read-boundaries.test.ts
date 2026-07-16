import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const healthSource = readFileSync('components/modules/health-module.tsx', 'utf8');
const medicationsSource = readFileSync('components/modules/medications-module.tsx', 'utf8');
const recordsSource = readFileSync('components/modules/medical-records-module.tsx', 'utf8');

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

  it('coordinates active-medication reads with Medical Records data', () => {
    expect(recordsSource).toContain('error: medsError, refresh: refreshMeds');
    expect(recordsSource).toContain('const loading = pLoading || polLoading || profLoading || medsLoading;');
    expect(recordsSource).toContain('const error = pError || polError || profError || medsError;');
    expect(recordsSource).toContain('const refresh = () => { void refreshProviders(); void refreshPolicies(); void refreshProfiles(); void refreshMeds(); };');
  });
});
