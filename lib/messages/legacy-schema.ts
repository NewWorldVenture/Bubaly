// Device-local mute remains available when durable preferences are absent.
const muteKey = (familyId: string) => `muted-convs:${familyId}`;

/** main's per-conversation mute: a device-local preference. */
export function readDeviceMutes(familyId: string): Set<string> {
  try {
    const raw = localStorage.getItem(muteKey(familyId));
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
}

export function writeDeviceMutes(familyId: string, ids: ReadonlySet<string>): void {
  try { localStorage.setItem(muteKey(familyId), JSON.stringify([...ids])); } catch { /* storage unavailable */ }
}
