// What still needs buying, what the pantry is short of or about to lose, and
// the shopping habits the family has recorded ("we shop Sunday", "Costco for
// bulk"). Grocery names are household text, so they are fenced like any
// other row-derived string — a list item can say anything.
import 'server-only';
import { fenceUntrusted, sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { listOpen, pantryList } from '@/lib/services/groceries';
import { recallFacts } from '@/lib/services/memory';
import { ok } from '@/lib/services/types';
import type { SliceDefinition } from '../policy';
import { dayKeyLabel, joinNatural } from '../render';

const MAX_OPEN_ITEMS = 60;
const MAX_PANTRY_FLAGS = 15;
const MAX_HABITS = 8;

/** A fact is a shopping habit when it talks about buying, stores or staples. */
const HABIT_RE = /\b(shop|shopping|grocer|store|market|costco|trader|whole foods|aldi|walmart|target|staple|always buy|brand|bulk|coupon|deliver)\b/i;

export type ShoppingSliceData = {
  listId: string | null;
  open: { id: string; name: string; quantity: string | null; category: string | null }[];
  lowPantry: { name: string; location: string | null }[];
  expiringPantry: { name: string; expiresOn: string | null }[];
  habits: { label: string; value: string }[];
};

export const shoppingSlice: SliceDefinition = {
  name: 'shopping',
  title: 'Shopping and pantry',
  async load(scope) {
    const [open, pantry, facts] = await Promise.all([
      listOpen(scope, { limit: MAX_OPEN_ITEMS }),
      pantryList(scope, { expiringWithinDays: 5 }),
      recallFacts(scope, { category: 'preference', limit: 200 }),
    ]);
    if (!open.ok) return open;
    if (!pantry.ok) return pantry;
    if (!facts.ok) return facts;

    const data: ShoppingSliceData = {
      listId: open.data.listId,
      open: open.data.items.map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, category: i.category })),
      lowPantry: pantry.data.low.slice(0, MAX_PANTRY_FLAGS).map((p) => ({ name: p.name, location: p.location })),
      expiringPantry: pantry.data.expiring.slice(0, MAX_PANTRY_FLAGS).map((p) => ({ name: p.name, expiresOn: p.expires_at })),
      habits: facts.data.filter((f) => HABIT_RE.test(`${f.label} ${f.value}`)).slice(0, MAX_HABITS).map((f) => ({ label: f.label, value: f.value })),
    };

    const lines: string[] = [];
    if (data.open.length) {
      const byCategory = new Map<string, string[]>();
      for (const item of data.open) {
        const key = item.category ? sanitizeUntrusted(item.category, 24) : 'other';
        const label = `${fenceUntrusted('grocery', item.name)}${item.quantity ? ` ×${sanitizeUntrusted(item.quantity, 12)}` : ''}`;
        byCategory.set(key, [...(byCategory.get(key) ?? []), label]);
      }
      lines.push(`- ${data.open.length} item${data.open.length === 1 ? '' : 's'} still to buy`);
      for (const [category, items] of byCategory) lines.push(`- ${category}: ${joinNatural(items, 12)}`);
    } else {
      lines.push('- The shopping list is empty.');
    }
    if (data.lowPantry.length) lines.push(`- Running low: ${joinNatural(data.lowPantry.map((p) => fenceUntrusted('pantry', p.name)), 10)}`);
    if (data.expiringPantry.length) {
      lines.push(`- Use soon: ${joinNatural(data.expiringPantry.map((p) => `${fenceUntrusted('pantry', p.name)}${p.expiresOn ? ` (by ${dayKeyLabel(p.expiresOn.slice(0, 10))})` : ''}`), 10)}`);
    }
    for (const h of data.habits) lines.push(`- Habit: ${fenceUntrusted('fact', `${h.label}: ${h.value}`)}`);

    return ok({ data, count: data.open.length + data.lowPantry.length + data.expiringPantry.length, lines });
  },
};
