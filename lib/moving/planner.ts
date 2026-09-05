// lib/moving/planner.ts — pure, deterministic move-planning engine.
//
// A move is a ten-week project with a fixed deadline. The differentiator is
// the template: every task the family forgets (mail forwarding, the vet's
// records, the deposit walk-through) laid out by lead time from move day,
// filtered to the family's situation (kids, pets, renting out), then tracked
// as a burn-down. Boxes get the same treatment: labelled, numbered, tracked
// from packed to unpacked so "where is the kettle?" has an answer on day one.

import type { MoveBoxStatus, MoveKind, MoveStatus, MoveTaskCategory, MoveTaskStatus } from '@/lib/database.types';

export type TaskTemplate = {
  key: string;
  title: string;
  category: MoveTaskCategory;
  /** Days relative to move day: negative = before, positive = after. */
  offsetDays: number;
  /** Only when the move matches. Omit = always. */
  when?: { kids?: boolean; pets?: boolean; rentingOut?: boolean; kinds?: MoveKind[] };
};

export const MOVE_STATUSES: { value: MoveStatus; label: string }[] = [
  { value: 'planning', label: 'Planning' }, { value: 'packing', label: 'Packing' }, { value: 'moving_day', label: 'Moving day' },
  { value: 'settling', label: 'Settling in' }, { value: 'done', label: 'Done' }, { value: 'cancelled', label: 'Cancelled' },
];
export const MOVE_KINDS: { value: MoveKind; label: string }[] = [
  { value: 'local', label: 'Local (same area)' }, { value: 'long_distance', label: 'Long distance' },
  { value: 'international', label: 'International' }, { value: 'within_building', label: 'Same building / next door' },
];
export const TASK_CATEGORIES: { value: MoveTaskCategory; label: string; emoji: string }[] = [
  { value: 'admin', label: 'Admin', emoji: '🗂️' }, { value: 'address', label: 'Address changes', emoji: '📮' },
  { value: 'utilities', label: 'Utilities', emoji: '💡' }, { value: 'movers', label: 'Movers & transport', emoji: '🚚' },
  { value: 'packing', label: 'Packing', emoji: '📦' }, { value: 'school', label: 'School & childcare', emoji: '🎒' },
  { value: 'medical', label: 'Medical', emoji: '🩺' }, { value: 'pets', label: 'Pets', emoji: '🐾' },
  { value: 'finance', label: 'Money & insurance', emoji: '💳' }, { value: 'cleaning', label: 'Cleaning & handover', emoji: '🧹' },
  { value: 'settling', label: 'Settling in', emoji: '🏡' }, { value: 'other', label: 'Other', emoji: '📝' },
];
export const BOX_STATUSES: { value: MoveBoxStatus; label: string }[] = [
  { value: 'empty', label: 'Empty' }, { value: 'packed', label: 'Packed' }, { value: 'loaded', label: 'On the truck' },
  { value: 'delivered', label: 'Delivered' }, { value: 'unpacked', label: 'Unpacked' },
];
export const BOX_ORDER: MoveBoxStatus[] = ['empty', 'packed', 'loaded', 'delivered', 'unpacked'];

export const categoryMeta = (c: MoveTaskCategory) => TASK_CATEGORIES.find((x) => x.value === c) ?? TASK_CATEGORIES[TASK_CATEGORIES.length - 1];

/** The T-8w → T+2w template. Ordered by offset; the ids are stable so a re-plan never duplicates. */
export const MOVE_TEMPLATE: TaskTemplate[] = [
  { key: 'budget', title: 'Set the moving budget and open a moving folder', category: 'finance', offsetDays: -56 },
  { key: 'quotes', title: 'Get three mover quotes (or book a truck)', category: 'movers', offsetDays: -56, when: { kinds: ['local', 'long_distance', 'international'] } },
  { key: 'declutter', title: 'Declutter room by room: sell, donate, toss', category: 'packing', offsetDays: -49 },
  { key: 'school-notify', title: 'Tell the current school and request records', category: 'school', offsetDays: -49, when: { kids: true } },
  { key: 'school-enrol', title: 'Enrol at the new school / childcare', category: 'school', offsetDays: -42, when: { kids: true } },
  { key: 'landlord', title: 'Give notice to the landlord / confirm handover date', category: 'admin', offsetDays: -42 },
  { key: 'book-movers', title: 'Book the movers and confirm the date in writing', category: 'movers', offsetDays: -42, when: { kinds: ['local', 'long_distance', 'international'] } },
  { key: 'visa', title: 'Visas, work permits and customs paperwork', category: 'admin', offsetDays: -42, when: { kinds: ['international'] } },
  { key: 'supplies', title: 'Order boxes, tape, markers and bubble wrap', category: 'packing', offsetDays: -35 },
  { key: 'vet', title: 'Vet visit: records, vaccines, travel certificate', category: 'pets', offsetDays: -35, when: { pets: true } },
  { key: 'medical-records', title: 'Transfer doctor, dentist and pharmacy records', category: 'medical', offsetDays: -35 },
  { key: 'insurance', title: 'Update home / renters and car insurance', category: 'finance', offsetDays: -28 },
  { key: 'pack-storage', title: 'Pack storage, books, off-season clothes', category: 'packing', offsetDays: -28 },
  { key: 'utilities-new', title: 'Set up power, water, internet at the new place', category: 'utilities', offsetDays: -21 },
  { key: 'utilities-old', title: 'Schedule final readings / disconnect at the old place', category: 'utilities', offsetDays: -21 },
  { key: 'mail', title: 'Mail forwarding with the post office', category: 'address', offsetDays: -14 },
  { key: 'address-bank', title: 'Change address: bank, cards, employer, subscriptions', category: 'address', offsetDays: -14 },
  { key: 'address-gov', title: 'Change address: licence, vehicle registration, voter roll', category: 'address', offsetDays: -14 },
  { key: 'tenant-ads', title: 'List the old place for rent and screen tenants', category: 'admin', offsetDays: -14, when: { rentingOut: true } },
  { key: 'pack-rooms', title: 'Pack every room except the kitchen and daily essentials', category: 'packing', offsetDays: -10 },
  { key: 'time-off', title: 'Book time off work and arrange childcare for move day', category: 'admin', offsetDays: -10 },
  { key: 'pet-sitter', title: 'Arrange a pet sitter or a quiet room for move day', category: 'pets', offsetDays: -7, when: { pets: true } },
  { key: 'confirm-movers', title: 'Confirm movers, parking and elevator booking', category: 'movers', offsetDays: -7 },
  { key: 'essentials-box', title: 'Pack the first-night essentials box (kettle, meds, chargers, sheets)', category: 'packing', offsetDays: -3 },
  { key: 'defrost', title: 'Empty and defrost the fridge / freezer', category: 'cleaning', offsetDays: -2 },
  { key: 'kids-bag', title: 'Each kid packs a moving-day backpack', category: 'school', offsetDays: -2, when: { kids: true } },
  { key: 'cash-tips', title: 'Cash for tips, snacks and water for the crew', category: 'movers', offsetDays: -1 },
  { key: 'walkthrough', title: 'Final walk-through, photos, meter readings, keys', category: 'cleaning', offsetDays: 0 },
  { key: 'load', title: 'Load: fragile last on, essentials box in the car', category: 'movers', offsetDays: 0 },
  { key: 'beds-first', title: 'Beds, bathroom and kitchen unpacked first', category: 'settling', offsetDays: 1 },
  { key: 'deposit', title: 'Return keys and chase the deposit', category: 'finance', offsetDays: 3 },
  { key: 'register-local', title: 'Register with a new doctor, dentist and vet', category: 'medical', offsetDays: 7 },
  { key: 'pet-tag', title: 'Update the pet’s microchip and tag address', category: 'pets', offsetDays: 7, when: { pets: true } },
  { key: 'unpack-all', title: 'Every box unpacked and flattened', category: 'settling', offsetDays: 14 },
  { key: 'neighbours', title: 'Meet the neighbours, find the nearest playground and pharmacy', category: 'settling', offsetDays: 14 },
];

export type MoveLike = { id: string; move_date: string; status: MoveStatus; move_kind: MoveKind; has_kids: boolean; has_pets: boolean; is_renting_out: boolean; budget_cents: number | null; spent_cents: number; mover_quote_cents: number | null };
export type TaskLike = { id: string; move_id: string; title: string; category: MoveTaskCategory; offset_days: number; due_date: string | null; status: MoveTaskStatus; template_key: string | null; assignee_id: string | null };
export type BoxLike = { id: string; move_id: string; box_number: number; label: string; to_room: string | null; status: MoveBoxStatus; is_fragile: boolean; is_essential: boolean; contents: string[] };

const DAY_MS = 86_400_000;
const dateOnly = (v: string | Date) => (typeof v === 'string' ? new Date(`${v.slice(0, 10)}T00:00:00`) : new Date(v.getFullYear(), v.getMonth(), v.getDate()));
export const dayDiff = (from: string | Date, to: string | Date) => Math.round((dateOnly(to).getTime() - dateOnly(from).getTime()) / DAY_MS);
export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDays = (iso: string, days: number) => isoDate(new Date(dateOnly(iso).getTime() + days * DAY_MS));

/** Template rows that apply to this move. */
export function applicableTemplate(move: Pick<MoveLike, 'move_kind' | 'has_kids' | 'has_pets' | 'is_renting_out'>): TaskTemplate[] {
  return MOVE_TEMPLATE.filter((t) => {
    const w = t.when;
    if (!w) return true;
    if (w.kids !== undefined && w.kids !== move.has_kids) return false;
    if (w.pets !== undefined && w.pets !== move.has_pets) return false;
    if (w.rentingOut !== undefined && w.rentingOut !== move.is_renting_out) return false;
    if (w.kinds && !w.kinds.includes(move.move_kind)) return false;
    return true;
  });
}

export type PlannedTask = { key: string; title: string; category: MoveTaskCategory; offsetDays: number; dueDate: string };

/**
 * Tasks to insert for this move: the applicable template minus anything
 * already generated (matched by template key). Due dates come from move day;
 * a task whose date has already passed keeps its date so it shows as overdue
 * rather than silently vanishing.
 */
export function planTasks(move: MoveLike, existing: TaskLike[]): PlannedTask[] {
  const have = new Set(existing.filter((t) => t.move_id === move.id && t.template_key).map((t) => t.template_key as string));
  return applicableTemplate(move)
    .filter((t) => !have.has(t.key))
    .map((t) => ({ key: t.key, title: t.title, category: t.category, offsetDays: t.offsetDays, dueDate: addDays(move.move_date, t.offsetDays) }));
}

export type Phase = { key: string; label: string; from: number; to: number };
export const PHASES: Phase[] = [
  { key: 'w8', label: '8–6 weeks out', from: -365, to: -36 },
  { key: 'w5', label: '5–3 weeks out', from: -35, to: -15 },
  { key: 'w2', label: '2 weeks out', from: -14, to: -8 },
  { key: 'w1', label: 'Final week', from: -7, to: -1 },
  { key: 'day', label: 'Moving day', from: 0, to: 0 },
  { key: 'after', label: 'After the move', from: 1, to: 365 },
];

export const phaseFor = (offsetDays: number): Phase => PHASES.find((p) => offsetDays >= p.from && offsetDays <= p.to) ?? PHASES[PHASES.length - 1];

/** Tasks grouped by phase, each phase sorted by due date then title. Empty phases are omitted. */
export function timeline<T extends TaskLike>(tasks: T[], moveId: string): { phase: Phase; tasks: T[] }[] {
  const mine = tasks.filter((t) => t.move_id === moveId);
  return PHASES
    .map((phase) => ({ phase, tasks: mine.filter((t) => phaseFor(t.offset_days).key === phase.key).sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '') || a.title.localeCompare(b.title)) }))
    .filter((g) => g.tasks.length > 0);
}

/** Which of the move's own statuses fits its calendar position. */
export function suggestedStatus(move: Pick<MoveLike, 'move_date' | 'status'>, today: Date): MoveStatus {
  if (move.status === 'done' || move.status === 'cancelled') return move.status;
  const d = dayDiff(today, move.move_date); // days until move day
  if (d > 14) return 'planning';
  if (d > 0) return 'packing';
  if (d === 0) return 'moving_day';
  if (d >= -21) return 'settling';
  return 'done';
}

export type BudgetHealth = { status: 'no_budget' | 'under' | 'near' | 'over'; committedCents: number; remainingCents: number | null; pct: number | null };

/** Budget health counts money already spent plus the accepted mover quote. */
export function budgetHealth(move: Pick<MoveLike, 'budget_cents' | 'spent_cents' | 'mover_quote_cents'>): BudgetHealth {
  const committedCents = move.spent_cents + (move.mover_quote_cents ?? 0);
  if (!move.budget_cents) return { status: 'no_budget', committedCents, remainingCents: null, pct: null };
  const pct = Math.round((committedCents / move.budget_cents) * 100);
  const remainingCents = move.budget_cents - committedCents;
  return { status: pct > 100 ? 'over' : pct >= 85 ? 'near' : 'under', committedCents, remainingCents, pct };
}

export type MoveSummary = {
  daysToMove: number;
  total: number;
  done: number;
  overdue: number;
  dueThisWeek: number;
  pct: number;
  boxes: { total: number; packed: number; unpacked: number; fragile: number; essentials: number };
  onTrack: boolean;
  text: string;
};

export function moveSummary(move: MoveLike, tasks: TaskLike[], boxes: BoxLike[], today: Date): MoveSummary {
  const mine = tasks.filter((t) => t.move_id === move.id && t.status !== 'skipped');
  const done = mine.filter((t) => t.status === 'done').length;
  const todayIso = isoDate(today);
  const open = mine.filter((t) => t.status !== 'done');
  const overdue = open.filter((t) => t.due_date && t.due_date < todayIso).length;
  const dueThisWeek = open.filter((t) => t.due_date && t.due_date >= todayIso && dayDiff(todayIso, t.due_date) <= 7).length;
  const pct = mine.length ? Math.round((done / mine.length) * 100) : 0;
  const myBoxes = boxes.filter((b) => b.move_id === move.id);
  const packed = myBoxes.filter((b) => b.status !== 'empty').length;
  const unpacked = myBoxes.filter((b) => b.status === 'unpacked').length;
  const daysToMove = dayDiff(today, move.move_date);
  // Expected progress: linear over the ten-week window, so 4 weeks out ≈ 45 %.
  const expectedPct = Math.min(100, Math.max(0, Math.round(((70 - Math.max(0, daysToMove)) / 70) * 100)));
  const onTrack = overdue === 0 && (mine.length === 0 || pct >= expectedPct - 15);
  const text = move.status === 'done' ? 'Moved and settled'
    : move.status === 'cancelled' ? 'Move cancelled'
    : daysToMove > 0 ? `${daysToMove} day${daysToMove === 1 ? '' : 's'} to go · ${overdue ? `${overdue} overdue` : onTrack ? 'on track' : 'behind the template'}`
    : daysToMove === 0 ? 'Moving day!'
    : `${-daysToMove} day${daysToMove === -1 ? '' : 's'} in · ${unpacked}/${myBoxes.length} boxes unpacked`;
  return { daysToMove, total: mine.length, done, overdue, dueThisWeek, pct, boxes: { total: myBoxes.length, packed, unpacked, fragile: myBoxes.filter((b) => b.is_fragile).length, essentials: myBoxes.filter((b) => b.is_essential).length }, onTrack, text };
}

/** The next free box number for a move. */
export const nextBoxNumber = (boxes: Pick<BoxLike, 'move_id' | 'box_number'>[], moveId: string) => boxes.filter((b) => b.move_id === moveId).reduce((m, b) => Math.max(m, b.box_number), 0) + 1;

/** Boxes by destination room, unpacked last so what still needs doing is at the top of each room. */
export function boxesByRoom<T extends BoxLike>(boxes: T[], moveId: string): { room: string; boxes: T[] }[] {
  const map = new Map<string, T[]>();
  for (const b of boxes.filter((x) => x.move_id === moveId)) {
    const room = b.to_room?.trim() || 'Unassigned';
    map.set(room, [...(map.get(room) ?? []), b]);
  }
  return [...map.entries()]
    .map(([room, list]) => ({ room, boxes: list.sort((a, b) => BOX_ORDER.indexOf(a.status) - BOX_ORDER.indexOf(b.status) || a.box_number - b.box_number) }))
    .sort((a, b) => (a.room === 'Unassigned' ? 1 : 0) - (b.room === 'Unassigned' ? 1 : 0) || a.room.localeCompare(b.room));
}

/** Case-insensitive "which box is the kettle in?" */
export function findInBoxes<T extends BoxLike>(boxes: T[], moveId: string, query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return boxes.filter((b) => b.move_id === moveId && (b.label.toLowerCase().includes(q) || b.contents.some((c) => c.toLowerCase().includes(q)) || (b.to_room ?? '').toLowerCase().includes(q)));
}

export const money = (cents: number | null | undefined) => cents === null || cents === undefined ? '—' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
