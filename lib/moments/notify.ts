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

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
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
): MomentNotice[] {
  const horizon = now.getTime() + horizonHours * 3600_000;
  const merged: MomentEvent[] = [...(events ?? []), ...upcomingBirthdayEvents(members ?? [], now, 1)];
  const out: { at: number; notice: MomentNotice }[] = [];
  for (const e of merged) {
    const t = Date.parse(e.starts_at);
    if (Number.isNaN(t) || t > horizon) continue;
    // Timed events must still be ahead; all-day events count through their day.
    if (e.all_day ? t < now.getTime() - 86_400_000 : t < now.getTime()) continue;

    const prep = buildMomentPrep(e, { now });
    if (prep.category === 'general') continue;

    const leave = prep.leaveByISO ? `Leave by ${fmtClock(prep.leaveByISO)}` : null;
    const steps = prep.items.slice(0, 3).map((i) => i.label).join(' · ');
    const body = [leave, steps || null].filter(Boolean).join(' — ') || 'Open Moments for the prep list.';

    out.push({
      at: t,
      notice: {
        relatedId: `moment:${e.id}:${e.starts_at.slice(0, 10)}`,
        title: `${EMOJI[prep.category]} Get ready: ${e.title} · ${momentWhen(e.starts_at, e.all_day, now)}`,
        body,
      },
    });
  }
  // Soonest first; cap so a packed weekend can't flood the notification list.
  return out.sort((a, b) => a.at - b.at).slice(0, 6).map((x) => x.notice);
}
