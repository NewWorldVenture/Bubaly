// lib/messages/overview.ts — pure, tested helpers for the Messages page:
// conversation-tab filtering, last-message previews, unread detection, and
// compact list timestamps. No Supabase/React so it stays unit-testable.

import { createFormat } from '@/lib/utils/format';
import { DEFAULT_LOCALE, type LocaleCode } from '@/lib/i18n/locales';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export type ConvTab = 'all' | 'direct' | 'group' | 'announcement';

export function convMatchesTab(kind: string, tab: ConvTab): boolean {
  if (tab === 'all') return true;
  if (tab === 'group') return kind === 'group' || kind === 'channel';
  return kind === tab;
}

export interface PreviewMsg {
  kind: string;
  content: string | null;
  attachment_name: string | null;
  sender_name: string | null;
  sender_id: string | null;
}

/** "You: …" / "Mia: …" with icons for non-text messages. */
export function previewText(m: PreviewMsg, selfId: string): string {
  const who = m.sender_id === selfId ? 'You' : (m.sender_name?.split(' ')[0] ?? 'Someone');
  let body: string;
  switch (m.kind) {
    case 'image': body = '📷 Photo'; break;
    case 'file': body = `📎 ${m.attachment_name ?? 'File'}`; break;
    case 'voice': body = '🎤 Voice message'; break;
    default: body = (m.content ?? '').replace(/\s+/g, ' ').trim(); break;
  }
  return `${who}: ${body}`.trim();
}

/** A message counts as unread for me if someone else sent it and I'm not in read_by. */
export function isUnread(m: { read_by?: string[] | null; sender_id: string | null }, selfId: string): boolean {
  return m.sender_id !== selfId && !(m.read_by ?? []).includes(selfId);
}


function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Compact conversation-list timestamp: time today, "Yesterday", weekday
 *  within a week, else M/D/YY. */
export function shortTime(
  iso: string,
  now: Date = new Date(),
  locale: LocaleCode = DEFAULT_LOCALE,
  t?: Translate,
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const fmt = createFormat(locale);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) return fmt.fmtTime(d);
  if (days === 1) return t ? t('completedByBubaly.yesterday') : 'Yesterday';
  // This used to index a seven-entry English array. Intl knows the short weekday in
  // all eleven locales, so the array is gone rather than left sitting unused.
  if (days < 7) return fmt.fmtDate(d, 'EEE');
  return fmt.fmtDate(d, 'M/d/yy');
}

/** Reduce a batch of messages (any order) to the latest one per conversation
 *  plus the per-conversation unread count for `selfId`. */
export function summarizeConversations(
  messages: Array<PreviewMsg & { conversation_id: string; created_at: string; read_by?: string[] | null }>,
  selfId: string,
): {
  lastByConv: Map<string, PreviewMsg & { conversation_id: string; created_at: string }>;
  unreadByConv: Map<string, number>;
} {
  const lastByConv = new Map<string, PreviewMsg & { conversation_id: string; created_at: string }>();
  const unreadByConv = new Map<string, number>();
  for (const m of messages) {
    const prev = lastByConv.get(m.conversation_id);
    if (!prev || m.created_at > prev.created_at) lastByConv.set(m.conversation_id, m);
    if (isUnread(m, selfId)) unreadByConv.set(m.conversation_id, (unreadByConv.get(m.conversation_id) ?? 0) + 1);
  }
  return { lastByConv, unreadByConv };
}
