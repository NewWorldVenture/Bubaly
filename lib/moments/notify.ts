// lib/moments/notify.ts — one proactive nudge per imminent life-moment.
//
// The Moments engine builds prep bundles; this pure module decides WHEN the
// family gets pinged: a moment inside the horizon (default 36h) whose prep has
// real substance — a classified category, not 'general', since plain events are
// already covered by the ordinary calendar_event notification. Birthdays enter
// through the same synthetic-event projection the Moments page uses. The
// notification engine dedups permanently by related_id; ours embeds the
// event's calendar date, so each occurrence pings once and a recurring
// birthday naturally pings again next year.

import { buildMomentPrep, momentWhen, type MomentEvent, type MomentCategory } from '@/lib/moments/prep';
import { upcomingBirthdayEvents, type BirthdayMember } from '@/lib/moments/birthdays';
import { dayKeyIn } from '@/lib/time/zoned';
import { allDayDate } from '@/lib/calendar/day';

export type MomentNotice = { relatedId: string; title: string; body: string };

const EMOJI: Record<MomentCategory, string> = {
  sports: '⚽', celebration: '🎉', trip: '🧳', appointment: '🩺',
  school: '🎒', outdoors: '🌳', general: '🎯',
};

// A second, local `fmtClock` — lib/moments/prep.ts has one too, and this one had
// neither a locale nor a zone. It renders the "Leave by …" half of a push
// notification, so with no `timeZone` it announced the server's clock: a 16:00
// leave-by in Los Angeles arriving as "Leave by 11:00 PM".
function fmtClock(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
}

/**
 * Family-wide notices for moments starting within `horizonHours`. Deterministic
 * given `now`; returns [] on a calm horizon. Birthday members are merged as
 * synthetic events (today/tomorrow only, so the ping lands when it matters).
 */
export function imminentMomentNotices(
  events: MomentEvent[],
  members: BirthdayMember[],
  now: Date = new Date(),
  horizonHours = 36,
  timeZone?: string,
): MomentNotice[] {
  const horizon = now.getTime() + horizonHours * 3600_000;
  // The birthdays are counted from the FAMILY's day when the zone is known:
  // on the UTC cron, the host's "today" is tomorrow from 5pm in California,
  // and a birthday "tomorrow" was announced a day early and today's not at all.
  const merged: MomentEvent[] = [...(events ?? []), ...upcomingBirthdayEvents(members ?? [], now, 1, timeZone)];
  // An all-day moment is a DAY, and its start is a zone-less
  // 'YYYY-MM-DDT00:00:00' (lib/moments/birthdays.ts says why). `Date.parse`
  // reads that as the HOST's midnight, so the "still counts through its day"
  // test below was Greenwich's on the cron: the family's 3 October, parsed as
  // 3 October 00:00Z, was already more than a day old at 5:30pm in California,
  // and today's birthday ping never went out. With the zone known, an all-day
  // moment is kept by its DAY: from the family's today through the day the
  // horizon ends on. Without one, the local reading stands as before.
  const todayKey = timeZone ? dayKeyIn(now, timeZone) : null;
  const horizonKey = timeZone ? dayKeyIn(new Date(horizon), timeZone) : null;
  const out: { at: number; notice: MomentNotice }[] = [];
  for (const e of merged) {
    let t: number;
    if (e.all_day && todayKey && horizonKey) {
      const day = e.starts_at.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < todayKey || day > horizonKey) continue;
      // Ordering only: the day as a zone-free instant.
      t = Date.parse(`${day}T00:00:00Z`);
    } else {
      t = Date.parse(e.starts_at);
      if (Number.isNaN(t) || t > horizon) continue;
      // Timed events must still be ahead; all-day events count through their day.
      if (e.all_day ? t < now.getTime() - 86_400_000 : t < now.getTime()) continue;
    }

    const prep = buildMomentPrep(e, { now, timeZone });
    if (prep.category === 'general') continue;

    // Both of these reach a phone as a PUSH NOTIFICATION, so the clock and the
    // "Tomorrow" have to be the family's, not the server's. lib/server/notifications.ts
    // has resolved their zone 200 lines before it calls this.
    const leave = prep.leaveByISO ? `Leave by ${fmtClock(prep.leaveByISO, timeZone)}` : null;
    const steps = prep.items.slice(0, 3).map((i) => i.label).join(' · ');
    const body = [leave, steps || null].filter(Boolean).join(' — ') || 'Open Moments for the prep list.';

    // The key's date is the occurrence's day on the FAMILY's wall clock (an
    // all-day moment's own date): Greenwich's date can give two occurrences of
    // a daily series one key on a DST night, and the second is never sent.
    const day = e.all_day ? allDayDate(e.starts_at) : timeZone ? dayKeyIn(new Date(t), timeZone) : e.starts_at.slice(0, 10);
    out.push({
      at: t,
      notice: {
        relatedId: `moment:${e.id}:${day}`,
        title: `${EMOJI[prep.category]} Get ready: ${e.title} · ${momentWhen(e.starts_at, e.all_day, now, undefined, undefined, timeZone)}`,
        body,
      },
    });
  }
  // Soonest first; cap so a packed weekend can't flood the notification list.
  return out.sort((a, b) => a.at - b.at).slice(0, 6).map((x) => x.notice);
}
