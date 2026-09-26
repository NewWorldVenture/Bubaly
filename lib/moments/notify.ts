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
  const merged: MomentEvent[] = [...(events ?? []), ...upcomingBirthdayEvents(members ?? [], now, 1)];
  const out: { at: number; notice: MomentNotice }[] = [];
  for (const e of merged) {
    const t = Date.parse(e.starts_at);
    if (Number.isNaN(t) || t > horizon) continue;
    // Timed events must still be ahead; all-day events count through their day.
    if (e.all_day ? t < now.getTime() - 86_400_000 : t < now.getTime()) continue;

    const prep = buildMomentPrep(e, { now, timeZone });
    if (prep.category === 'general') continue;

    // Both of these reach a phone as a PUSH NOTIFICATION, so the clock and the
    // "Tomorrow" have to be the family's, not the server's. lib/server/notifications.ts
    // has resolved their zone 200 lines before it calls this.
    const leave = prep.leaveByISO ? `Leave by ${fmtClock(prep.leaveByISO, timeZone)}` : null;
    const steps = prep.items.slice(0, 3).map((i) => i.label).join(' · ');
    const body = [leave, steps || null].filter(Boolean).join(' — ') || 'Open Moments for the prep list.';

    out.push({
      at: t,
      notice: {
        relatedId: `moment:${e.id}:${e.starts_at.slice(0, 10)}`,
        title: `${EMOJI[prep.category]} Get ready: ${e.title} · ${momentWhen(e.starts_at, e.all_day, now, undefined, undefined, timeZone)}`,
        body,
      },
    });
  }
  // Soonest first; cap so a packed weekend can't flood the notification list.
  return out.sort((a, b) => a.at - b.at).slice(0, 6).map((x) => x.notice);
}
