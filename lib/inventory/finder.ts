// lib/inventory/finder.ts — pure "where is it?" engine for the Home Inventory.
//
// The differentiator: a family can ask "where's the passport / ski helmet /
// spare key?" and get the exact room › container path from their own catalog,
// plus the honest signals a household needs — what is lent out and overdue,
// what a warranty still covers, and what the whole home is worth for insurance.

import type { HomeLocationKind, InventoryCategory, InventoryStatus } from '@/lib/database.types';

export const LOCATION_KINDS: { value: HomeLocationKind; label: string; emoji: string; container: boolean }[] = [
  { value: 'room', label: 'Room', emoji: '🚪', container: false },
  { value: 'closet', label: 'Closet', emoji: '🚪', container: true },
  { value: 'garage', label: 'Garage', emoji: '🚗', container: false },
  { value: 'attic', label: 'Attic', emoji: '🏠', container: false },
  { value: 'basement', label: 'Basement', emoji: '🪜', container: false },
  { value: 'shed', label: 'Shed', emoji: '🛖', container: false },
  { value: 'storage_unit', label: 'Storage unit', emoji: '🏬', container: false },
  { value: 'box', label: 'Box / bin', emoji: '📦', container: true },
  { value: 'shelf', label: 'Shelf', emoji: '🗄️', container: true },
  { value: 'drawer', label: 'Drawer', emoji: '🗃️', container: true },
  { value: 'cabinet', label: 'Cabinet', emoji: '🚪', container: true },
  { value: 'vehicle', label: 'Vehicle', emoji: '🚙', container: false },
  { value: 'other', label: 'Other', emoji: '📍', container: true },
];

export const ITEM_CATEGORIES: { value: InventoryCategory; label: string; emoji: string }[] = [
  { value: 'electronics', label: 'Electronics', emoji: '💻' },
  { value: 'tools', label: 'Tools', emoji: '🔧' },
  { value: 'sports', label: 'Sports & bikes', emoji: '⚽' },
  { value: 'toys', label: 'Toys & games', emoji: '🧸' },
  { value: 'documents', label: 'Documents', emoji: '📄' },
  { value: 'kitchen', label: 'Kitchen', emoji: '🍳' },
  { value: 'furniture', label: 'Furniture', emoji: '🛋️' },
  { value: 'seasonal', label: 'Seasonal & holiday', emoji: '🎄' },
  { value: 'clothing', label: 'Clothing & gear', emoji: '🧥' },
  { value: 'outdoor', label: 'Outdoor & garden', emoji: '🌿' },
  { value: 'medical', label: 'Medical', emoji: '🩹' },
  { value: 'keys', label: 'Keys & access', emoji: '🔑' },
  { value: 'jewelry', label: 'Jewelry & valuables', emoji: '💍' },
  { value: 'other', label: 'Other', emoji: '📦' },
];

export const ITEM_STATUSES: { value: InventoryStatus; label: string; emoji: string }[] = [
  { value: 'in_place', label: 'In place', emoji: '✅' },
  { value: 'lent', label: 'Lent out', emoji: '🤝' },
  { value: 'in_repair', label: 'In repair', emoji: '🛠️' },
  { value: 'lost', label: 'Lost', emoji: '❓' },
  { value: 'disposed', label: 'Sold / disposed', emoji: '🗑️' },
];

export const locationKindMeta = (k: HomeLocationKind) => LOCATION_KINDS.find((x) => x.value === k) ?? LOCATION_KINDS[LOCATION_KINDS.length - 1];
export const categoryMeta = (c: InventoryCategory) => ITEM_CATEGORIES.find((x) => x.value === c) ?? ITEM_CATEGORIES[ITEM_CATEGORIES.length - 1];
export const statusMeta = (s: InventoryStatus) => ITEM_STATUSES.find((x) => x.value === s) ?? ITEM_STATUSES[0];

export type LocationLike = { id: string; name: string; kind: HomeLocationKind; parent_id: string | null };
export type ItemLike = {
  id: string; name: string; category: InventoryCategory; location_id: string | null; quantity: number; value_cents: number | null;
  brand: string | null; model: string | null; serial_number: string | null; tags: string[]; status: InventoryStatus;
  lent_to: string | null; lent_on: string | null; warranty_until: string | null;
};

const DAY_MS = 86_400_000;
const dateOnly = (v: string | Date) => (typeof v === 'string' ? new Date(`${v.slice(0, 10)}T00:00:00`) : new Date(v.getFullYear(), v.getMonth(), v.getDate()));
export const dayDiff = (from: string | Date, to: string | Date) => Math.round((dateOnly(to).getTime() - dateOnly(from).getTime()) / DAY_MS);

/** "Garage › Shelf B › Box 3" — walks parents, guards against cycles. */
export function locationPath(locations: LocationLike[], id: string | null | undefined): string[] {
  const byId = new Map(locations.map((l) => [l.id, l]));
  const path: string[] = [];
  const seen = new Set<string>();
  let cur = id ? byId.get(id) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur.name);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return path;
}

export const locationLabel = (locations: LocationLike[], id: string | null | undefined) => locationPath(locations, id).join(' › ') || 'No location yet';

/** Rooms (top level) and their containers, for a tree view. */
export function locationTree<T extends LocationLike>(locations: T[]): { location: T; children: T[] }[] {
  const roots = locations.filter((l) => !l.parent_id || !locations.some((p) => p.id === l.parent_id));
  return roots
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((location) => ({ location, children: locations.filter((c) => c.parent_id === location.id).sort((a, b) => a.name.localeCompare(b.name)) }));
}

export type SearchHit<T extends ItemLike = ItemLike> = { item: T; score: number; matched: string[]; where: string };

const normalizeSearchText = (value: string) => value.normalize('NFKC').replace(/[\u2018\u2019]/g, "'").toLowerCase();
const trimSearchPunctuation = (value: string) => value.replace(/^[^\p{L}\p{N}+#]+|[^\p{L}\p{N}+#]+$/gu, '');

/** Remove request wording, not arbitrary stop words that may identify an item. */
function searchTokens(query: string): string[] {
  let text = trimSearchPunctuation(normalizeSearchText(query).replace(/\s+/g, ' ').trim());
  const request = /^(?:where(?:'s|'re| is| are)|where (?:can|could) (?:i|we) find|where (?:do|did) (?:i|we) (?:keep|put|store)|(?:can|could|would) you (?:find|locate|show me)|(?:please )?(?:find|locate|show me|help me find))(?:\s+|$)/;
  if (request.test(text)) {
    text = text.replace(request, '')
      .replace(/^(?:(?:a|an|the|my|our)(?:\s+|$))+/, '')
      .replace(/(?:,\s*|\s+)please$/, '');
  }
  // Preserve internal model/serial separators and names such as C++ or C#.
  return text.split(/[\s,!?;]+/u).map(trimSearchPunctuation).filter(Boolean);
}

/** Search only supplied records; every meaningful token must match stored evidence. */
export function searchItems<T extends ItemLike>(items: T[], locations: LocationLike[], query: string): SearchHit<T>[] {
  const tokens = searchTokens(query);
  if (!tokens.length) return [];
  const hits: SearchHit<T>[] = [];
  for (const item of items) {
    const where = locationLabel(locations, item.location_id);
    const fields: [string, string][] = [
      ['name', item.name], ['brand', item.brand ?? ''], ['model', item.model ?? ''], ['serial', item.serial_number ?? ''],
      ['tags', item.tags.join(' ')], ['location', where], ['category', categoryMeta(item.category).label],
    ];
    let score = 0;
    const matched = new Set<string>();
    for (const token of tokens) {
      let tokenHit = false;
      for (const [field, value] of fields) {
        const v = normalizeSearchText(value);
        if (!v || !v.includes(token)) continue;
        tokenHit = true;
        matched.add(field);
        score += field === 'name' ? (v.startsWith(token) ? 10 : 6) : field === 'tags' ? 4 : field === 'location' ? 2 : 3;
      }
      if (!tokenHit) { score = 0; break; }
    }
    if (score > 0) hits.push({ item, score: score + (item.status === 'in_place' ? 1 : 0), matched: [...matched], where });
  }
  return hits.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
}

/** Items lent out, with how long they have been gone. */
export function lentOut<T extends ItemLike>(items: T[], today: Date): { item: T; days: number | null; overdue: boolean }[] {
  return items
    .filter((i) => i.status === 'lent')
    .map((i) => { const days = i.lent_on ? dayDiff(i.lent_on, today) : null; return { item: i, days, overdue: days !== null && days >= 30 }; })
    .sort((a, b) => (b.days ?? -1) - (a.days ?? -1));
}

export type WarrantyAlert<T extends ItemLike = ItemLike> = { item: T; days: number; state: 'expired' | 'expiring' };

/** Warranties expired in the last year or expiring within 60 days. */
export function warrantyAlerts<T extends ItemLike>(items: T[], today: Date): WarrantyAlert<T>[] {
  const out: WarrantyAlert<T>[] = [];
  for (const item of items) {
    if (!item.warranty_until || item.status === 'disposed') continue;
    const days = dayDiff(today, item.warranty_until);
    if (days < -365 || days > 60) continue;
    out.push({ item, days, state: days < 0 ? 'expired' : 'expiring' });
  }
  return out.sort((a, b) => a.days - b.days);
}

export type ValueSummary = { totalCents: number; valuedItems: number; byCategory: { category: InventoryCategory; cents: number }[] };

/** Replacement value of everything still owned (quantity × value). */
export function valueSummary(items: ItemLike[]): ValueSummary {
  const owned = items.filter((i) => i.status !== 'disposed' && i.status !== 'lost');
  const by = new Map<InventoryCategory, number>();
  let totalCents = 0;
  let valuedItems = 0;
  for (const i of owned) {
    if (i.value_cents === null) continue;
    const cents = i.value_cents * Math.max(1, i.quantity);
    totalCents += cents;
    valuedItems += 1;
    by.set(i.category, (by.get(i.category) ?? 0) + cents);
  }
  const byCategory = [...by.entries()].map(([category, cents]) => ({ category, cents })).sort((a, b) => b.cents - a.cents).slice(0, 5);
  return { totalCents, valuedItems, byCategory };
}

export function inventorySummary(items: ItemLike[], locations: LocationLike[], today: Date): { items: number; located: number; unlocated: number; rooms: number; lent: number; overdueLoans: number; text: string } {
  const owned = items.filter((i) => i.status !== 'disposed');
  const located = owned.filter((i) => i.location_id && locations.some((l) => l.id === i.location_id)).length;
  const loans = lentOut(owned, today);
  const rooms = locationTree(locations).length;
  const text = owned.length === 0 ? 'Nothing catalogued yet' : `${owned.length} items · ${located} placed${loans.length ? ` · ${loans.length} lent out` : ''}`;
  return { items: owned.length, located, unlocated: owned.length - located, rooms, lent: loans.length, overdueLoans: loans.filter((l) => l.overdue).length, text };
}

// ── "Is it still there?" — the confirmation signal ─────────────────────────
// A catalogue is only as good as its last check. A move row whose from and to
// are the same place, tagged with `CONFIRM_REASON`, is the family saying "yes,
// it is still here" without pretending anything moved; the item card reads the
// latest such row back as "last confirmed", and never claims a check that was
// not recorded.

/** The `inventory_moves.reason` a confirmation is written with. */
export const CONFIRM_REASON = 'confirmed';

export type MoveLike = { id: string; item_id: string; from_location_id: string | null; to_location_id: string | null; moved_at: string; reason: string | null };

export type Confirmation = { moveId: string; at: string; locationId: string | null };

/** True for a move row that records a confirmation rather than a relocation. */
export function isConfirmation(move: Pick<MoveLike, 'from_location_id' | 'to_location_id' | 'reason'>): boolean {
  return move.reason === CONFIRM_REASON && move.from_location_id === move.to_location_id;
}

/** The latest confirmation on file for an item, or null when nobody has confirmed it yet. */
export function lastConfirmed(moves: MoveLike[], itemId: string): Confirmation | null {
  let latest: MoveLike | null = null;
  for (const move of moves) {
    if (move.item_id !== itemId || !isConfirmation(move)) continue;
    if (!latest || Date.parse(move.moved_at) > Date.parse(latest.moved_at)) latest = move;
  }
  return latest ? { moveId: latest.id, at: latest.moved_at, locationId: latest.to_location_id } : null;
}

/** The latest relocation (not a confirmation) for an item, or null. */
export function lastMoved(moves: MoveLike[], itemId: string): { moveId: string; at: string; fromLocationId: string | null; toLocationId: string | null } | null {
  let latest: MoveLike | null = null;
  for (const move of moves) {
    if (move.item_id !== itemId || isConfirmation(move)) continue;
    if (!latest || Date.parse(move.moved_at) > Date.parse(latest.moved_at)) latest = move;
  }
  return latest ? { moveId: latest.id, at: latest.moved_at, fromLocationId: latest.from_location_id, toLocationId: latest.to_location_id } : null;
}
