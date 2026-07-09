// lib/sync/hash.ts — provider-neutral content hashing for change detection.
//
// The generic sync engine detects "did this item actually change?" by comparing a
// stable digest of the normalized fields. Kept provider-agnostic here so every
// adapter produces the SAME digest for the same logical event/reminder — that's
// what lets a single mapping row survive re-connecting under a different provider.
// (Field order is fixed and null-safe; changing it invalidates stored hashes.)

import { createHash } from 'node:crypto';

export function eventContentHash(r: {
  title: string; description?: string | null; location?: string | null;
  starts_at: string; ends_at?: string | null; all_day?: boolean; recurrence_rule?: string | null;
}): string {
  const parts = [r.title, r.description ?? '', r.location ?? '', r.starts_at, r.ends_at ?? '', r.all_day ? '1' : '0', r.recurrence_rule ?? ''];
  // Separator MUST match lib/sync/providers/google.ts (a \x01 SOH) so every adapter
  // yields the SAME digest for the same normalized item — see the round-trip test.
  return createHash('sha256').update(parts.join('\x01')).digest('hex');
}

export function reminderContentHash(r: {
  title: string; notes?: string | null; due_at?: string | null; is_completed?: boolean;
}): string {
  const parts = [r.title, r.notes ?? '', r.due_at ?? '', r.is_completed ? '1' : '0'];
  return createHash('sha256').update(parts.join('\x01')).digest('hex');
}
