// lib/notifications/digest.ts — pure helpers for the notification email digest.
// No Supabase / React so grouping + icon mapping stay unit testable.

import type { NotificationType } from '@/lib/database.types';

const ICONS: Record<NotificationType, string> = {
  chore_due: '✅',
  medication_due: '💊',
  calendar_event: '📅',
  school_event: '📚',
  sports_event: '⚽',
  maintenance_task: '🔧',
  grocery_reminder: '🛒',
  document_expiry: '📄',
  family_invite: '✉️',
  system: '🔔',
};

export function iconForType(type: NotificationType): string {
  return ICONS[type] ?? '🔔';
}

export interface PendingNotification {
  id: string;
  user_id: string | null;
  type: NotificationType;
  title: string;
  body: string | null;
}

/**
 * Groups user-targeted notifications by recipient, preserving input order.
 * Rows with a null user_id (whole-family) are dropped — they live in-app only,
 * since there's no single inbox to email them to.
 */
export function groupByUser<T extends { user_id: string | null }>(notifications: T[]): Map<string, T[]> {
  const byUser = new Map<string, T[]>();
  for (const n of notifications) {
    if (!n.user_id) continue;
    const arr = byUser.get(n.user_id) ?? [];
    arr.push(n);
    byUser.set(n.user_id, arr);
  }
  return byUser;
}
