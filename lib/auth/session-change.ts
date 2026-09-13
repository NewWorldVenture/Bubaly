'use client';

// This is a request to read the current cookie jar, never an assertion about
// which account signed out. A delayed message must not retire a newer login.
const CHANNEL = 'bubaly:session-storage-change';
const STORAGE_KEY = 'bubaly:session-storage-change';
const MESSAGE = 'reread-session';
let revision = 0;
let sequence = 0;
let channel: BroadcastChannel | null = null;
let removeStorageListener: (() => void) | null = null;
const listeners = new Set<() => void>();
const received = new Set<string>();

function receive(message: unknown) {
  if (typeof message !== 'string' || !message.startsWith(`${MESSAGE}:`)
    || message.length <= MESSAGE.length + 1 || message.length > 160 || received.has(message)) return;
  received.add(message);
  if (received.size > 128) received.delete(received.values().next().value!);
  revision += 1;
  for (const listener of [...listeners]) {
    try { listener(); }
    catch { /* One reader cannot prevent others from seeing a completed change. */ }
  }
}

function connect() {
  if (removeStorageListener || typeof window === 'undefined') return;
  const target = window;
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) receive(event.newValue);
  };
  target.addEventListener('storage', onStorage);
  removeStorageListener = () => target.removeEventListener('storage', onStorage);
  try {
    channel = new target.BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => receive(event.data);
  } catch { /* Storage events and foreground reconciliation remain available. */ }
}

/** Local revision only; no user identifiers or credentials cross tabs. */
export function getSessionStorageChangeRevision(): number { return revision; }

export function subscribeSessionStorageChanges(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  listeners.add(listener);
  connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    removeStorageListener?.();
    removeStorageListener = null;
    try { channel?.close(); }
    catch { /* A disposed browser transport must not interrupt component cleanup. */ }
    channel = null;
  };
}

/** Announce a cookie mutation, or request a local reread of conflicting evidence. */
export function notifySessionStorageChanged(options: { broadcast?: boolean } = {}): void {
  if (typeof window === 'undefined') return;
  const message = `${MESSAGE}:${Date.now()}:${++sequence}:${Math.random()}`;
  // Same-tab readers invalidate stale work synchronously, before any I/O.
  receive(message);
  if (options.broadcast === false) return;
  let publisher: BroadcastChannel | null = channel;
  try {
    publisher ??= new window.BroadcastChannel(CHANNEL);
    publisher.postMessage(message);
  } catch { /* A denied/unavailable channel falls back to a storage event. */ }
  finally {
    if (publisher !== channel) {
      try { publisher?.close(); }
      catch { /* Storage peers still need notification after a failed close. */ }
    }
  }
  try {
    // Also reach peers where BroadcastChannel is unavailable. Receivers dedupe
    // the same nonce delivered by both transports. No session data is persisted.
    window.localStorage.setItem(STORAGE_KEY, message);
    window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* Same-tab reconciliation already ran; lifecycle reads cover recovery. */ }
}
