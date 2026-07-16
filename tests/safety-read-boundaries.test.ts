import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const devicesSource = readFileSync('components/modules/devices-module.tsx', 'utf8');
const immunizationsSource = readFileSync('components/modules/immunizations-module.tsx', 'utf8');
const securitySource = readFileSync('components/modules/security-module.tsx', 'utf8');

describe('safety read boundaries', () => {
  it('surfaces device read failures before the empty device state', () => {
    expect(devicesSource).toContain('error, refresh } = useRealtimeQuery');
    expect(devicesSource).toContain('Could not load family devices. Refresh and try again.');
  });

  it('surfaces immunization read failures before the empty record state', () => {
    expect(immunizationsSource).toContain('error, refresh } = useRealtimeQuery');
    expect(immunizationsSource).toContain('Could not load immunization records. Refresh and try again.');
  });

  it('surfaces security-event read failures before the empty event state', () => {
    expect(securitySource).toContain('error, refresh } = useRealtimeQuery');
    expect(securitySource).toContain('Could not load security events. Refresh and try again.');
  });
});
