import { describe, expect, it } from 'vitest';
import {
  analyzeDevices,
  buildDevicesPrompt,
  parseDevicesResponse,
  type DeviceEntryLike,
} from '@/lib/home/devices-ai';

function device(overrides: Partial<DeviceEntryLike>): DeviceEntryLike {
  return { name: 'Light', type: 'light', room: 'Living Room', status: 'online', integration: 'homekit', ...overrides };
}

describe('analyzeDevices', () => {
  it('summarizes devices', () => {
    const r = analyzeDevices([
      device({ name: 'Light', status: 'online', room: 'Kitchen' }),
      device({ name: 'Lock', status: 'offline', room: 'Front Door' }),
      device({ name: 'Thermostat', status: 'online', room: 'Kitchen' }),
    ]);
    expect(r.totalDevices).toBe(3);
    expect(r.onlineCount).toBe(2);
    expect(r.offlineCount).toBe(1);
    expect(r.roomCount).toBe(2);
    expect(r.summary).toContain('3 devices');
    expect(r.summary).toContain('1 offline');
  });

  it('handles no rooms', () => {
    const r = analyzeDevices([device({ room: null })]);
    expect(r.roomCount).toBe(0);
  });

  it('handles empty', () => {
    const r = analyzeDevices([]);
    expect(r.totalDevices).toBe(0);
    expect(r.summary).toContain('0 devices');
  });
});

describe('buildDevicesPrompt', () => {
  it('builds prompt with device info', () => {
    const { system, user } = buildDevicesPrompt([device({ name: 'Front Door Lock', type: 'lock', room: 'Hallway' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Front Door Lock');
    expect(user).toContain('lock');
  });
});

describe('parseDevicesResponse', () => {
  it('parses valid JSON', () => {
    const r = parseDevicesResponse('{"suggestions":["add motion sensor"],"sceneIdeas":["Good Night"],"organizationTip":"group by room"}');
    expect(r.suggestions).toEqual(['add motion sensor']);
    expect(r.sceneIdeas).toEqual(['Good Night']);
    expect(r.organizationTip).toBe('group by room');
  });

  it('handles malformed input', () => {
    const r = parseDevicesResponse('garbage');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseDevicesResponse('```json\n{"suggestions":["x"],"sceneIdeas":[],"organizationTip":"y"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
