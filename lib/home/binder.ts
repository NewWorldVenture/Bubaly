// lib/home/binder.ts — pure helpers for the Household Binder. Category grouping
// and sensitive-value masking. No Supabase/React.

export const BINDER_CATEGORIES = ['wifi', 'emergency', 'shutoff', 'code', 'insurance', 'contact', 'instruction', 'account', 'other'] as const;
export type BinderCategory = (typeof BINDER_CATEGORIES)[number];

const LABELS: Record<string, string> = {
  wifi: 'Wi-Fi & Network', emergency: 'Emergency', shutoff: 'Shutoffs & Valves', code: 'Codes & Access',
  insurance: 'Insurance', contact: 'Key Contacts', instruction: 'How-to & Instructions', account: 'Accounts', other: 'Other',
};

export function binderCategoryLabel(cat: string): string {
  return LABELS[cat] ?? cat;
}

/** Mask a sensitive value, revealing only the last `keep` characters. */
export function maskValue(value: string | null | undefined, keep = 2): string {
  const v = value ?? '';
  if (!v) return '';
  if (v.length <= keep) return '•'.repeat(v.length);
  return '•'.repeat(Math.max(4, v.length - keep)) + v.slice(-keep);
}

export type InfoLike = { category: string; sort?: number; label: string };

/** Group entries by category in the canonical category order; within a group by
 *  sort then label. */
export function groupByCategory<T extends InfoLike>(items: T[]): Array<{ category: BinderCategory; items: T[] }> {
  const map = new Map<string, T[]>();
  for (const i of items) { const a = map.get(i.category) ?? []; a.push(i); map.set(i.category, a); }
  const out: Array<{ category: BinderCategory; items: T[] }> = [];
  for (const cat of BINDER_CATEGORIES) {
    const list = map.get(cat);
    if (list && list.length) {
      out.push({ category: cat, items: [...list].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.label.localeCompare(b.label)) });
    }
  }
  return out;
}
