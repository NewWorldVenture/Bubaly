// lib/declutter/missions.ts — pure, deterministic decluttering engine.
//
// The differentiator: "clean the house" becomes 10–15 minute missions tied to
// real zones, generated from each zone's clutter score and kind, spread across
// the family for the week, with streaks and items-removed totals that make the
// progress visible. No AI needed to plan; the AI coach adds motivation + order.

import type { DeclutterMissionStatus, DeclutterZoneKind } from '@/lib/database.types';

export type MissionTemplate = { title: string; minutes: number; points: number };

export const ZONE_KINDS: { value: DeclutterZoneKind; label: string; emoji: string; templates: MissionTemplate[] }[] = [
  { value: 'surface', label: 'Counter / table', emoji: '🍽️', templates: [
    { title: 'Clear everything that doesn’t live here', minutes: 10, points: 5 },
    { title: 'Sort the paper pile: file, act, recycle', minutes: 15, points: 8 },
    { title: 'Wipe and reset with only 3 things', minutes: 10, points: 5 },
  ] },
  { value: 'closet', label: 'Closet', emoji: '🚪', templates: [
    { title: 'Pull 10 things you haven’t worn this year', minutes: 15, points: 8 },
    { title: 'Match hangers, face everything one way', minutes: 10, points: 5 },
    { title: 'Bag one donation', minutes: 15, points: 10 },
  ] },
  { value: 'drawer', label: 'Drawer', emoji: '🗃️', templates: [
    { title: 'Empty it, keep only what you use monthly', minutes: 10, points: 5 },
    { title: 'Add a divider and group like with like', minutes: 10, points: 5 },
  ] },
  { value: 'floor', label: 'Floor', emoji: '🧹', templates: [
    { title: 'Floor pickup: nothing on the floor but furniture', minutes: 10, points: 5 },
    { title: 'Corner sweep: one corner to zero', minutes: 5, points: 3 },
  ] },
  { value: 'shelf', label: 'Shelf / bookcase', emoji: '📚', templates: [
    { title: 'Remove 5 things that don’t belong', minutes: 10, points: 5 },
    { title: 'Donate 3 books or games nobody opens', minutes: 15, points: 8 },
  ] },
  { value: 'fridge', label: 'Fridge / pantry', emoji: '🧊', templates: [
    { title: 'Toss expired, wipe one shelf', minutes: 15, points: 8 },
    { title: 'Front-face and label leftovers', minutes: 10, points: 5 },
  ] },
  { value: 'garage', label: 'Garage', emoji: '🚗', templates: [
    { title: 'One bin: sort, keep, donate, trash', minutes: 20, points: 10 },
    { title: 'Clear a parking-spot-sized square', minutes: 25, points: 12 },
  ] },
  { value: 'entryway', label: 'Entryway', emoji: '🚪', templates: [
    { title: 'Shoes: one pair per person out, rest away', minutes: 5, points: 3 },
    { title: 'Coats, bags, mail to their homes', minutes: 10, points: 5 },
  ] },
  { value: 'desk', label: 'Desk', emoji: '🖥️', templates: [
    { title: 'Cables, chargers, pens: one tray', minutes: 10, points: 5 },
    { title: 'Clear the surface, keep 3 essentials', minutes: 10, points: 5 },
  ] },
  { value: 'toys', label: 'Toys / play area', emoji: '🧸', templates: [
    { title: 'Bin the broken, box the outgrown', minutes: 15, points: 8 },
    { title: 'Everything back to its bin — race the timer', minutes: 10, points: 5 },
  ] },
  { value: 'digital', label: 'Digital', emoji: '📱', templates: [
    { title: 'Delete 50 photos / screenshots', minutes: 10, points: 5 },
    { title: 'Unsubscribe from 10 emails', minutes: 10, points: 5 },
  ] },
  { value: 'other', label: 'Other', emoji: '📦', templates: [
    { title: '10-minute reset', minutes: 10, points: 5 },
    { title: 'Find 5 things to let go of', minutes: 10, points: 5 },
  ] },
];

export const MISSION_STATUSES: { value: DeclutterMissionStatus; label: string }[] = [
  { value: 'planned', label: 'Planned' }, { value: 'done', label: 'Done' }, { value: 'skipped', label: 'Skipped' },
];

export const zoneKindMeta = (k: DeclutterZoneKind) => ZONE_KINDS.find((x) => x.value === k) ?? ZONE_KINDS[ZONE_KINDS.length - 1];

export const SCORE_LABELS: Record<number, string> = { 1: 'Tidy', 2: 'Lived-in', 3: 'Cluttered', 4: 'Overflowing', 5: 'Avalanche' };

export type ZoneLike = { id: string; name: string; room: string | null; kind: DeclutterZoneKind; clutter_score: number; last_reset_at: string | null; is_active: boolean };
export type MissionLike = { id: string; zone_id: string | null; title: string; minutes: number; assignee_id: string | null; status: DeclutterMissionStatus; scheduled_for: string | null; completed_at: string | null; items_removed: number; points: number };
export type SessionLike = { started_at: string; minutes: number; items_removed: number; member_id: string | null };

const DAY_MS = 86_400_000;
const dateOnly = (v: string | Date) => (typeof v === 'string' ? new Date(`${v.slice(0, 10)}T00:00:00`) : new Date(v.getFullYear(), v.getMonth(), v.getDate()));
export const dayDiff = (from: string | Date, to: string | Date) => Math.round((dateOnly(to).getTime() - dateOnly(from).getTime()) / DAY_MS);
export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Missions to generate for a zone right now: more when it's worse, none when tidy. */
export function missionsForZone(zone: ZoneLike): MissionTemplate[] {
  if (!zone.is_active || zone.clutter_score <= 1) return [];
  const templates = zoneKindMeta(zone.kind).templates;
  const count = Math.min(templates.length, zone.clutter_score - 1);
  return templates.slice(0, count);
}

export type ZoneHealth = 'fresh' | 'due' | 'overdue' | 'never';

/** A zone "decays": the worse its score, the sooner it needs a reset. */
export function zoneHealth(zone: ZoneLike, today: Date): { health: ZoneHealth; daysSinceReset: number | null; intervalDays: number } {
  const intervalDays = zone.clutter_score >= 4 ? 7 : zone.clutter_score === 3 ? 14 : 30;
  if (!zone.last_reset_at) return { health: 'never', daysSinceReset: null, intervalDays };
  const days = dayDiff(zone.last_reset_at, today);
  return { health: days > intervalDays * 1.5 ? 'overdue' : days > intervalDays ? 'due' : 'fresh', daysSinceReset: days, intervalDays };
}

export type PlannedMission = { day: string; dayLabel: string; zone: ZoneLike; template: MissionTemplate; assigneeId: string | null };

/**
 * Spread this week's missions across 7 days and the family: worst zones first,
 * at most `perDay` missions a day, assignees round-robin. Zones that already
 * have a planned mission this week are skipped so re-planning never duplicates.
 */
export function weeklyPlan(zones: ZoneLike[], existing: MissionLike[], memberIds: string[], today: Date, perDay = 2): PlannedMission[] {
  const weekStart = isoDate(today);
  const weekEnd = isoDate(new Date(today.getTime() + 6 * DAY_MS));
  const alreadyPlanned = new Set(existing.filter((m) => m.status === 'planned' && m.scheduled_for && m.scheduled_for >= weekStart && m.scheduled_for <= weekEnd).map((m) => m.zone_id));
  const candidates = zones
    .filter((z) => z.is_active && z.clutter_score > 1 && !alreadyPlanned.has(z.id))
    .sort((a, b) => b.clutter_score - a.clutter_score || (zoneHealth(b, today).daysSinceReset ?? 9999) - (zoneHealth(a, today).daysSinceReset ?? 9999) || a.name.localeCompare(b.name));
  const plan: PlannedMission[] = [];
  let slot = 0;
  for (const zone of candidates) {
    const templates = missionsForZone(zone).slice(0, 1);
    for (const template of templates) {
      const dayIndex = Math.floor(slot / perDay);
      if (dayIndex > 6) return plan;
      const d = new Date(today.getTime() + dayIndex * DAY_MS);
      plan.push({ day: isoDate(d), dayLabel: d.toLocaleDateString('en-US', { weekday: 'short' }), zone, template, assigneeId: memberIds.length ? memberIds[slot % memberIds.length] : null });
      slot += 1;
    }
  }
  return plan;
}

/** Consecutive days (ending today or yesterday) with at least one session. */
export function sessionStreak(sessions: SessionLike[], today: Date): number {
  const days = new Set(sessions.map((s) => isoDate(dateOnly(s.started_at))));
  let streak = 0;
  let cursor = dateOnly(today);
  if (!days.has(isoDate(cursor))) cursor = new Date(cursor.getTime() - DAY_MS);
  while (days.has(isoDate(cursor))) { streak += 1; cursor = new Date(cursor.getTime() - DAY_MS); }
  return streak;
}

export type DeclutterSummary = {
  zones: number;
  avgScore: number | null;
  worst: ZoneLike | null;
  dueZones: number;
  doneThisWeek: number;
  itemsRemovedMonth: number;
  minutesMonth: number;
  streak: number;
  text: string;
};

export function declutterSummary(zones: ZoneLike[], missions: MissionLike[], sessions: SessionLike[], today: Date): DeclutterSummary {
  const active = zones.filter((z) => z.is_active);
  const avgScore = active.length ? Math.round((active.reduce((a, z) => a + z.clutter_score, 0) / active.length) * 10) / 10 : null;
  const worst = [...active].sort((a, b) => b.clutter_score - a.clutter_score)[0] ?? null;
  const dueZones = active.filter((z) => { const h = zoneHealth(z, today).health; return h === 'due' || h === 'overdue'; }).length;
  const doneThisWeek = missions.filter((m) => m.status === 'done' && m.completed_at && dayDiff(m.completed_at, today) >= 0 && dayDiff(m.completed_at, today) < 7).length;
  const month = sessions.filter((s) => dayDiff(s.started_at, today) >= 0 && dayDiff(s.started_at, today) < 30);
  const itemsRemovedMonth = month.reduce((a, s) => a + s.items_removed, 0) + missions.filter((m) => m.status === 'done' && m.completed_at && dayDiff(m.completed_at, today) < 30).reduce((a, m) => a + m.items_removed, 0);
  const minutesMonth = month.reduce((a, s) => a + s.minutes, 0);
  const streak = sessionStreak(sessions, today);
  const text = active.length === 0 ? 'No zones yet' : avgScore !== null && avgScore <= 1.5 ? 'Home is in great shape' : `${dueZones} zone${dueZones === 1 ? '' : 's'} due · avg clutter ${avgScore}/5`;
  return { zones: active.length, avgScore, worst, dueZones, doneThisWeek, itemsRemovedMonth, minutesMonth, streak, text };
}

/** Points for a completed mission: base + a bonus for items actually removed. */
export function missionPoints(mission: Pick<MissionLike, 'points' | 'items_removed'>): number {
  return mission.points + Math.min(10, Math.floor(mission.items_removed / 5));
}
