// lib/home/devices.ts — pure helpers for the Smart Home device registry.
// Status rollups and room grouping. No Supabase/React.

export const DEVICE_TYPES = ['light', 'lock', 'thermostat', 'camera', 'sensor', 'plug', 'hub', 'speaker', 'doorbell', 'vacuum', 'other'] as const;
export const DEVICE_INTEGRATIONS = ['homekit', 'google', 'alexa', 'smartthings', 'matter', 'manual', 'other'] as const;
export const DEVICE_STATUSES = ['online', 'offline', 'unknown'] as const;

const INTEGRATION_LABELS: Record<string, string> = {
  homekit: 'Apple HomeKit', google: 'Google Home', alexa: 'Amazon Alexa',
  smartthings: 'SmartThings', matter: 'Matter', manual: 'Manual', other: 'Other',
};
export function integrationLabel(v: string): string {
  return INTEGRATION_LABELS[v] ?? v;
}

export type DeviceLike = { status: string; room?: string | null };

export function summarizeDevices(devices: DeviceLike[]) {
  let online = 0, offline = 0, unknown = 0;
  for (const d of devices) {
    if (d.status === 'online') online++;
    else if (d.status === 'offline') offline++;
    else unknown++;
  }
  return { total: devices.length, online, offline, unknown };
}

/** Group devices by room ('Unassigned' bucket last), rooms alphabetical. */
export function groupByRoom<T extends DeviceLike>(devices: T[]): Array<{ room: string; devices: T[] }> {
  const map = new Map<string, T[]>();
  for (const d of devices) { const key = (d.room ?? '').trim() || 'Unassigned'; const a = map.get(key) ?? []; a.push(d); map.set(key, a); }
  return [...map.entries()]
    .sort((a, b) => (a[0] === 'Unassigned' ? 1 : b[0] === 'Unassigned' ? -1 : a[0].localeCompare(b[0])))
    .map(([room, devices]) => ({ room, devices }));
}
