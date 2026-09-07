import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import { readFileSync } from 'node:fs';

const devicesSource = readFileSync('components/modules/devices-module.tsx', 'utf8');
const immunizationsSource = readFileSync('components/modules/immunizations-module.tsx', 'utf8');
const securitySource = readFileSync('components/modules/security-module.tsx', 'utf8');

describe('safety read boundaries', () => {
  it('surfaces device read failures before the empty device state', () => {
    expect(devicesSource).toContain('error, refresh } = useRealtimeQuery');
    expectSays(devicesSource, 'devicesModule.couldNotLoadFamilyDevices', 'Could not load family devices. Refresh and try again.');
  });

  it('surfaces immunization read failures before the empty record state', () => {
    expect(immunizationsSource).toContain('error, refresh } = useRealtimeQuery');
    expectSays(immunizationsSource, 'immunizationsModule.couldNotLoadImmunizationRecords', 'Could not load immunization records. Refresh and try again.');
  });

  it('surfaces security-event read failures before the empty event state', () => {
    expect(securitySource).toContain('error, refresh } = useRealtimeQuery');
    expectSays(securitySource, 'securityModule.couldNotLoadSecurityEvents', 'Could not load security events. Refresh and try again.');
  });
});
