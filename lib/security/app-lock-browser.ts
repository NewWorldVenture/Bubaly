'use client';

import { lockAppAction } from '@/app/(app)/settings/app-lock-actions';
import { clearAllCache } from '@/lib/offline/cache';

// These messages contain no credential and grant no access. They can only
// retire a rendered page. Only a fresh server render can show the app again.
export type AppLockIntent = {
  userId: string;
  id: string;
  phase: 'pending' | 'locked' | 'unavailable' | 'unlocked' | 'changed';
};
const PREFIX = 'bubaly:app-lock:';
const CHANNEL = 'bubaly:app-lock';
const intents = new Map<string, AppLockIntent>();
const listeners = new Set<(intent: AppLockIntent) => void>();
let channel: BroadcastChannel | null = null;
let listening = false;

function parse(value: unknown): AppLockIntent | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as AppLockIntent;
  return typeof entry.userId === 'string' && typeof entry.id === 'string'
    && ['pending', 'locked', 'unavailable', 'unlocked', 'changed'].includes(entry.phase) ? entry : null;
}

export function readAppLockIntent(userId: string): AppLockIntent | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + userId);
    const stored = raw ? parse(JSON.parse(raw)) : null;
    // Reading ahead of the queued storage/BroadcastChannel event must not
    // consume its notification: mounted pages still need to be retired.
    if (stored?.userId === userId) return stored;
  } catch { /* Memory still retires this document when storage is unavailable. */ }
  return intents.get(userId) ?? null;
}

function receive(intent: AppLockIntent) {
  const previous = intents.get(intent.userId);
  if (previous?.id === intent.id && previous.phase === intent.phase) return;
  // A completion from an earlier request cannot replace a later lock intent.
  if (intent.phase !== 'pending' && intent.phase !== 'changed' && previous && previous.id !== intent.id) return;
  intents.set(intent.userId, intent);
  if (intent.phase !== 'unlocked') clearAllCache();
  for (const listener of listeners) listener(intent);
}

function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('storage', event => {
    if (!event.key?.startsWith(PREFIX) || !event.newValue) return;
    try { const intent = parse(JSON.parse(event.newValue)); if (intent) receive(intent); } catch { /* malformed message */ }
  });
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = event => { const intent = parse(event.data); if (intent) receive(intent); };
  } catch { /* The storage event and foreground checks remain available. */ }
}

export function subscribeAppLock(listener: (intent: AppLockIntent) => void): () => void {
  listen();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publish(intent: AppLockIntent) {
  listen();
  // Notify this document before any await or cross-tab delivery.
  receive(intent);
  try { window.localStorage.setItem(PREFIX + intent.userId, JSON.stringify(intent)); } catch { /* private mode */ }
  try { channel?.postMessage(intent); } catch { /* closed or unavailable channel */ }
}

/** The synchronous retirement happens before the server request starts. */
export async function requestAppLock(userId: string): Promise<void> {
  const intent: AppLockIntent = { userId, id: crypto.randomUUID(), phase: 'pending' };
  publish(intent);
  let ok = false;
  try { ok = (await lockAppAction()).ok; } catch { /* The boundary stays closed and offers a retry. */ }
  if (readAppLockIntent(userId)?.id !== intent.id) return;
  publish({ ...intent, phase: ok ? 'locked' : 'unavailable' });
}

/** Clearing a local marker never reuses children; the caller reloads. */
export function acceptAppUnlock(userId: string, expectedId: string | null): boolean {
  if ((readAppLockIntent(userId)?.id ?? null) !== expectedId) return false;
  const intent: AppLockIntent = { userId, id: expectedId ?? crypto.randomUUID(), phase: 'unlocked' };
  publish(intent);
  return true;
}

export function notifyAppLockSettingsChanged(userId: string): void {
  publish({ userId, id: crypto.randomUUID(), phase: 'changed' });
}
