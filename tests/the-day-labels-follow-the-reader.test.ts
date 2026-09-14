// Four surfaces said "Today", "Yesterday" and "Overdue" in English beside a date
// they had already localised.
//
// THE SHAPE, and why it is the harder half of this work. Each of these mixes a
// FORMATTER with ENGLISH LITERALS:
//
//   if (diff < 0) return 'Overdue';
//   ...
//   return d.toLocaleDateString('en-US', { weekday: 'short', ... });
//
// The hardcoded-locale ratchet sees only the second line. Converting just that one
// would have left a German family reading "Overdue" beside "Di., 14. Juli" — a
// half-translated chip, which is worse than a wholly English one because it looks
// like someone tried. So each helper takes the locale AND a translator, on the
// contract fmtRelative already used for "Today"/"Tomorrow": words from the
// catalogue when a caller has one, English when it has none.
//
// Two callers deliberately have none, and that is recorded rather than fixed:
// lib/moments/notify.ts is a cron, and a family's language lives only in a cookie
// it cannot read (I18N-001).
//
// AND TWO ENGLISH ARRAYS ARE GONE. lib/messages/overview.ts and
// lib/memories/memories.ts each indexed a seven-entry weekday array —
// ['Sun','Mon',...] and ['Sunday','Monday',...]. Intl knows the weekday in all
// eleven locales, so the arrays were deleted rather than left sitting unused
// beside a comment explaining that nothing reads them.
import { describe, expect, it } from 'vitest';
import { dueLabel } from '@/lib/chores/dashboard';
import { shortTime } from '@/lib/messages/overview';
import { momentWhen } from '@/lib/moments/prep';
import { relativeDay } from '@/lib/memories/memories';

/** A stand-in catalogue: enough to prove the words come from a translator. */
const de = (key: string, p?: Record<string, string | number>) => ({
  'todos.noDueDate': 'Kein Fälligkeitsdatum',
  'todos.overdue': 'Überfällig',
  'calendar.today': 'Heute',
  'quickCapture.tomorrow': 'Morgen',
  'completedByBubaly.yesterday': 'Gestern',
  'moments.startingNow': 'beginnt jetzt',
  'moments.inNHours': `in ${p?.hours} Std.`,
  'ambient.inNMin': `in ${p?.minutes} Min.`,
  'memories.lastWeekday': `Letzten ${p?.weekday}`,
}[key] ?? key);

const NOW = new Date(2026, 6, 14, 12, 0, 0);           // Tuesday 14 July 2026, local
const at = (d: number, h = 12) => new Date(2026, 6, 14 + d, h, 0, 0).toISOString();

describe('lib/chores/dashboard dueLabel', () => {
  it('keeps English and the same tones when no translator is supplied', () => {
    expect(dueLabel(null, NOW)).toEqual({ label: 'No due date', tone: 'none' });
    expect(dueLabel(at(-1), NOW)).toEqual({ label: 'Overdue', tone: 'overdue' });
    expect(dueLabel(at(0), NOW)).toEqual({ label: 'Today', tone: 'today' });
    expect(dueLabel(at(1), NOW)).toEqual({ label: 'Tomorrow', tone: 'soon' });
    expect(dueLabel(at(4), NOW)).toEqual({ label: 'Sat, Jul 18', tone: 'normal' });
  });

  it('translates the words and localises the date, and the TONE never moves', () => {
    expect(dueLabel(at(-1), NOW, 'de-DE', de)).toEqual({ label: 'Überfällig', tone: 'overdue' });
    expect(dueLabel(at(0), NOW, 'de-DE', de)).toEqual({ label: 'Heute', tone: 'today' });
    expect(dueLabel(at(4), NOW, 'de-DE', de)).toEqual({ label: 'Sa., 18. Juli', tone: 'normal' });
    // The tone drives colour and urgency. A locale must never reach it.
    for (const days of [-1, 0, 1, 4]) {
      expect(dueLabel(at(days), NOW, 'de-DE', de).tone).toBe(dueLabel(at(days), NOW).tone);
    }
  });

  it('still reports an unparseable due date as having none', () => {
    expect(dueLabel('not-a-date', NOW, 'de-DE', de).label).toBe('Kein Fälligkeitsdatum');
  });
});

describe('lib/messages/overview shortTime', () => {
  it('shows a clock today, a word yesterday, a weekday this week, a date beyond', () => {
    expect(shortTime(at(0, 15), NOW)).toBe('3:00 PM');
    expect(shortTime(at(-1), NOW)).toBe('Yesterday');
    expect(shortTime(at(-3), NOW)).toBe('Sat');
    expect(shortTime(at(-30), NOW)).toBe('6/14/26');
  });

  it('follows the reader at every rung', () => {
    expect(shortTime(at(0, 15), NOW, 'de-DE', de)).toBe('15:00');
    expect(shortTime(at(-1), NOW, 'de-DE', de)).toBe('Gestern');
    expect(shortTime(at(-3), NOW, 'de-DE', de)).toBe('Sa');
    expect(shortTime(at(-30), NOW, 'de-DE', de)).toBe('14.6.26');
    // fr-FR writes the day first — which the old M/D/YY could never express.
    expect(shortTime(at(-30), NOW, 'fr-FR')).toBe('14/06/26');
  });
});

describe('lib/moments/prep momentWhen', () => {
  const soon = (mins: number) => new Date(NOW.getTime() + mins * 60_000).toISOString();

  it('keeps its English shape for a caller with no reader — the cron', () => {
    expect(momentWhen(soon(0), false, NOW)).toBe('starting now');
    expect(momentWhen(soon(25), false, NOW)).toBe('in 25 min');
    expect(momentWhen(soon(120), false, NOW)).toBe('in 2 hours');
    expect(momentWhen(at(1, 9), false, NOW)).toBe('Tomorrow 9:00 AM');
    expect(momentWhen(at(1), true, NOW)).toBe('Tomorrow');
  });

  it('translates every rung and localises the clock', () => {
    expect(momentWhen(soon(0), false, NOW, 'de-DE', de)).toBe('beginnt jetzt');
    expect(momentWhen(soon(25), false, NOW, 'de-DE', de)).toBe('in 25 Min.');
    expect(momentWhen(soon(120), false, NOW, 'de-DE', de)).toBe('in 2 Std.');
    // `hour: 'numeric'`, so German renders 9 rather than 09 — the 24-hour clock is
    // the locale's, the zero-padding is the pattern's, and they are separate choices.
    expect(momentWhen(at(1, 9), false, NOW, 'de-DE', de)).toBe('Morgen 9:00');
    expect(momentWhen(at(4, 9), false, NOW, 'de-DE', de)).toBe('Sa., 18. Juli 9:00');
  });
});

describe('lib/memories/memories relativeDay', () => {
  it('names the weekday in the reader language, with the word around it translated', () => {
    expect(relativeDay(at(0), NOW)).toBe('Today');
    expect(relativeDay(at(-1), NOW)).toBe('Yesterday');
    expect(relativeDay(at(-3), NOW)).toBe('Last Saturday');
    expect(relativeDay(at(-3), NOW, 'de-DE', de)).toBe('Letzten Samstag');
    // French puts the word AFTER the day, which a `Last ${weekday}` template
    // could not express however well the weekday itself was localised.
    expect(relativeDay(at(-3), NOW, 'fr-FR', (k, p) => (k === 'memories.lastWeekday' ? `${p?.weekday} dernier` : k)))
      .toBe('samedi dernier');
    expect(relativeDay(at(-30), NOW, 'de-DE', de)).toBe('14. Juni 2026');
  });
});

// The two seven-entry English weekday arrays are gone, not merely unread.
describe('the English weekday arrays', () => {
  it('are deleted rather than left sitting unused', async () => {
    const fs = await import('node:fs');
    for (const file of ['lib/messages/overview.ts', 'lib/memories/memories.ts']) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, `${file} still hardcodes weekday names`).not.toMatch(/\[\s*'Sun'|\[\s*'Sunday'/);
    }
  });
});
