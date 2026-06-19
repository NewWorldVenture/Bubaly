// Small, dependency-light formatting helpers shared across the app.
import { format, formatDistanceToNow, isToday, isTomorrow, parseISO } from 'date-fns';

export function fmtDate(value: string | Date | null | undefined, pattern = 'EEE, MMM d'): string {
  if (!value) return '';
  const d = typeof value === 'string' ? parseISO(value) : value;
  return format(d, pattern);
}

export function fmtTime(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = typeof value === 'string' ? parseISO(value) : value;
  return format(d, 'h:mm a');
}

export function fmtDateTime(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = typeof value === 'string' ? parseISO(value) : value;
  return format(d, "EEE, MMM d 'at' h:mm a");
}

/** Friendly relative label for upcoming/overdue items. */
export function fmtRelative(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = typeof value === 'string' ? parseISO(value) : value;
  if (isToday(d)) return `Today, ${format(d, 'h:mm a')}`;
  if (isTomorrow(d)) return `Tomorrow, ${format(d, 'h:mm a')}`;
  return formatDistanceToNow(d, { addSuffix: true });
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const fmtMoney = (cents: number) => CURRENCY.format(cents / 100);
