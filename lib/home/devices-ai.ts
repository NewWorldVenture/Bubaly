export type DevicesInsights = {
  totalDevices: number;
  onlineCount: number;
  offlineCount: number;
  roomCount: number;
  summary: string;
};

export interface DeviceEntryLike {
  name: string;
  type: string;
  room: string | null;
  status: string;
  integration: string;
}

export function analyzeDevices(devices: readonly DeviceEntryLike[]): DevicesInsights {
  let onlineCount = 0;
  let offlineCount = 0;
  const rooms = new Set<string>();

  for (const d of devices) {
    if (d.status === 'online') onlineCount++;
    else if (d.status === 'offline') offlineCount++;
    if (d.room) rooms.add(d.room);
  }

  const parts: string[] = [];
  parts.push(`${devices.length} device${devices.length === 1 ? '' : 's'}`);
  parts.push(`${onlineCount} online`);
  if (offlineCount > 0) parts.push(`${offlineCount} offline`);
  parts.push(`${rooms.size} room${rooms.size === 1 ? '' : 's'}`);

  return { totalDevices: devices.length, onlineCount, offlineCount, roomCount: rooms.size, summary: parts.join(' · ') };
}

export function buildDevicesPrompt(devices: readonly DeviceEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly smart home assistant. Analyze the family's smart home devices and suggest improvements. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable smart home suggestion"],
  "sceneIdeas": ["automation scene idea based on the devices they have"],
  "organizationTip": "one short tip for better smart home management"
}

Rules:
- suggestions: max 4 practical suggestions based on current device setup
- sceneIdeas: max 3 automation scene ideas (e.g. "Good Night scene: lock all doors, dim lights, arm cameras")
- organizationTip: one concrete tip
- Consider room coverage, device types, and integration compatibility.`;

  const summary = devices.map((d) => `${d.name} (${d.type}, ${d.room ?? 'no room'}, ${d.status}, ${d.integration})`).join('\n');
  const user = `The smart home has ${devices.length} devices:\n\n${summary}\n\nReturn the JSON now.`;
  return { system, user };
}

export type DevicesAIResponse = {
  suggestions: string[];
  sceneIdeas: string[];
  organizationTip: string;
};

export function parseDevicesResponse(raw: string): DevicesAIResponse {
  const empty: DevicesAIResponse = { suggestions: [], sceneIdeas: [], organizationTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      sceneIdeas: Array.isArray(parsed.sceneIdeas)
        ? parsed.sceneIdeas.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      organizationTip: typeof parsed.organizationTip === 'string' ? parsed.organizationTip : '',
    };
  } catch {
    return empty;
  }
}
