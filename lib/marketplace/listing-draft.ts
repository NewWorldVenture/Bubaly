// lib/marketplace/listing-draft.ts — the deterministic core of the AI Listing
// Assistant (pure, unit-tested). The spec's flow is: a user writes one sentence
// (or uploads media) and AI drafts the whole listing — title, category, modes,
// condition, price, rental price, deposit, tags, SEO — which the user edits and
// confirms before publishing.
//
// This module is the deterministic half: it (a) extracts structured hints from a
// free-text sentence, (b) computes sensible price/deposit baselines by category +
// condition, (c) assembles a complete, editable draft, and (d) gates publishing
// on completeness. The LLM layer refines the draft's prose; when AI is
// unconfigured, this alone still produces a usable listing. It NEVER publishes —
// it returns a draft + a readiness check for the UI's confirm step.

import type { ListingCategory, ListingCondition } from './listings';

export type ListingMode = 'buy' | 'rent' | 'borrow' | 'lend' | 'donate' | 'swap' | 'wanted';

export interface ListingHints {
  category?: ListingCategory;
  condition?: ListingCondition;
  modes: ListingMode[];
  color?: string;
  size?: string;
  brand?: string;
  keywords: string[];
}

export interface ListingDraft {
  title: string;
  description: string;
  category: ListingCategory;
  subcategory?: string;
  condition: ListingCondition;
  modes: ListingMode[];
  color?: string;
  size?: string;
  brand?: string;
  priceCents: number;       // buy price (0 for non-sale)
  rentDayCents: number;     // suggested daily rental rate (0 when not rentable)
  depositCents: number;     // suggested security deposit (0 when not applicable)
  tags: string[];
  seoDescription: string;
  safetyNotes: string[];
  aiSuggested: boolean;     // true when values came from heuristics, not the user
}

// ── keyword dictionaries (lowercase) ──
const CATEGORY_KEYWORDS: Record<ListingCategory, string[]> = {
  clothing: ['dress', 'shirt', 'jacket', 'coat', 'jeans', 'shoes', 'suit', 'outfit', 'sweater', 'costume'],
  toys: ['toy', 'lego', 'doll', 'puzzle', 'blocks', 'figure'],
  books: ['book', 'novel', 'textbook', 'comic'],
  electronics: ['phone', 'laptop', 'tablet', 'camera', 'tv', 'console', 'headphones', 'speaker', 'ipad'],
  furniture: ['sofa', 'couch', 'table', 'chair', 'desk', 'dresser', 'crib', 'bed', 'bookshelf'],
  sports: ['bike', 'bicycle', 'skis', 'snowboard', 'tent', 'kayak', 'cleats', 'racket', 'helmet', 'ball'],
  tools: ['drill', 'saw', 'ladder', 'mower', 'wrench', 'toolkit', 'sander'],
  baby: ['stroller', 'carseat', 'car', 'highchair', 'bassinet', 'monitor', 'diaper'],
  games: ['game', 'boardgame', 'nintendo', 'xbox', 'playstation', 'cards'],
  other: [],
};

// Order matters: firstKeyword() checks keys in insertion order, so the more
// specific phrases (e.g. "like new" before "new") must come first.
const CONDITION_KEYWORDS: Record<ListingCondition, string[]> = {
  like_new: ['like new', 'barely used', 'excellent'],
  new: ['brand new', 'new', 'unopened', 'sealed'],
  good: ['good', 'gently used', 'used'],
  fair: ['fair', 'some wear', 'worn but'],
  worn: ['worn', 'well used', 'heavily used'],
};

const MODE_KEYWORDS: [ListingMode, string[]][] = [
  ['wanted', ['looking for', 'looking to borrow', 'looking to rent', 'want to borrow', 'wanted', 'need to borrow', 'need a', 'in search of', 'iso ']],
  ['rent', ['for rent', 'to rent', 'renting', 'rent out']],
  ['borrow', ['to borrow', 'borrow', 'lend me']],
  ['lend', ['to lend', 'lending', 'happy to lend']],
  ['donate', ['free', 'giving away', 'give away', 'donate', 'donating']],
  ['swap', ['swap', 'trade', 'exchange for']],
  ['buy', ['for sale', 'selling', 'sell', 'buy']],
];

const COLORS = ['black', 'white', 'red', 'blue', 'green', 'yellow', 'pink', 'purple', 'orange', 'brown', 'gray', 'grey', 'navy', 'beige', 'gold', 'silver'];
const BRANDS = ['nike', 'adidas', 'zara', 'apple', 'samsung', 'sony', 'lego', 'ikea', 'graco', 'patagonia', 'north face', 'lululemon', 'h&m', 'gap'];
const SIZE_RE = /\b(xxl|xl|xs|small|medium|large|size\s?\d{1,2}|\d{1,2}(?:\.\d)?\s?(?:in|inch|")?)\b/;

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'my', 'me', 'i', 'is', 'this', 'that', 'need', 'want', 'looking']);

/** Baseline buy price (cents) by category, before the condition multiplier. */
const CATEGORY_BASE_CENTS: Record<ListingCategory, number> = {
  clothing: 2500, toys: 1500, books: 800, electronics: 8000, furniture: 6000,
  sports: 4000, tools: 3500, baby: 5000, games: 3000, other: 2000,
};
const CONDITION_MULTIPLIER: Record<ListingCondition, number> = {
  new: 1, like_new: 0.8, good: 0.6, fair: 0.4, worn: 0.25,
};

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

function firstKeyword<T extends string>(text: string, dict: Record<T, string[]>): T | undefined {
  for (const key of Object.keys(dict) as T[]) {
    for (const kw of dict[key]) if (text.includes(kw)) return key;
  }
  return undefined;
}

/** Extract structured hints from a free-text sentence (deterministic). */
export function parseListingHints(input: string): ListingHints {
  const text = ` ${input.toLowerCase().trim()} `;
  const modes: ListingMode[] = [];
  for (const [mode, kws] of MODE_KEYWORDS) {
    if (kws.some((k) => text.includes(k)) && !modes.includes(mode)) modes.push(mode);
  }
  const color = COLORS.find((c) => text.includes(` ${c} `));
  const brand = BRANDS.find((b) => text.includes(b));
  const size = SIZE_RE.exec(text)?.[0]?.trim();
  const keywords = Array.from(new Set(
    text.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)),
  ));
  return {
    category: firstKeyword(text, CATEGORY_KEYWORDS),
    condition: firstKeyword(text, CONDITION_KEYWORDS),
    modes,
    color,
    brand,
    size: size === 'grey' ? 'gray' : size,
    keywords,
  };
}

/** Suggested buy / daily-rent / deposit amounts (cents) for a category + condition. */
export function suggestPricing(category: ListingCategory, condition: ListingCondition): {
  priceCents: number; rentDayCents: number; depositCents: number;
} {
  const base = Math.round(CATEGORY_BASE_CENTS[category] * CONDITION_MULTIPLIER[condition]);
  const priceCents = Math.max(100, Math.round(base / 100) * 100);          // round to the dollar
  const rentDayCents = Math.max(100, Math.round((priceCents * 0.08) / 100) * 100);
  const depositCents = Math.max(0, Math.round((priceCents * 0.3) / 100) * 100);
  return { priceCents, rentDayCents, depositCents };
}

const MODE_NOUN: Partial<Record<ListingMode, string>> = {
  buy: 'for sale', rent: 'for rent', borrow: 'to borrow', lend: 'to lend',
  donate: 'free', swap: 'to swap', wanted: 'wanted',
};

function titleFrom(hints: ListingHints, fallback: string): string {
  const parts = [hints.color, hints.brand, hints.category].filter(Boolean).map((s) => cap(s as string));
  const base = parts.length ? parts.join(' ') : fallback.trim();
  return cap(base).slice(0, 80) || 'Untitled item';
}

/**
 * Assemble a complete, editable listing draft from a free-text sentence plus any
 * explicit overrides. Non-sale modes zero out the buy price; rentable modes get a
 * suggested daily rate + deposit. `aiSuggested` marks fields the user hasn't set.
 */
export function buildDraft(
  input: { text?: string } & Partial<Omit<ListingDraft, 'tags' | 'seoDescription' | 'safetyNotes' | 'aiSuggested'>>,
): ListingDraft {
  const hints = parseListingHints(input.text ?? '');
  const category = input.category ?? hints.category ?? 'other';
  const condition = input.condition ?? hints.condition ?? 'good';
  const modes: ListingMode[] = input.modes?.length ? input.modes : (hints.modes.length ? hints.modes : ['buy']);
  const color = input.color ?? hints.color;
  const size = input.size ?? hints.size;
  const brand = input.brand ?? hints.brand;

  const priced = suggestPricing(category, condition);
  const sellable = modes.includes('buy') || modes.includes('swap');
  const rentable = modes.includes('rent');
  const wanted = modes.includes('wanted');
  const depositable = rentable || modes.includes('borrow') || modes.includes('lend');

  const priceCents = input.priceCents ?? (sellable && !wanted ? priced.priceCents : 0);
  const rentDayCents = input.rentDayCents ?? (rentable ? priced.rentDayCents : 0);
  const depositCents = input.depositCents ?? (depositable ? priced.depositCents : 0);

  const title = input.title ?? titleFrom(hints, input.text ?? '');
  const draft: ListingDraft = {
    title,
    description: input.description ?? (input.text?.trim() ? cap(input.text.trim()) : `${title} — ${modes.map((m) => MODE_NOUN[m] ?? m).join(', ')}.`),
    category, subcategory: input.subcategory, condition, modes,
    color, size, brand, priceCents, rentDayCents, depositCents,
    tags: buildTags({ title, category, color, size, brand, modes, keywords: hints.keywords }),
    seoDescription: '',
    safetyNotes: safetyNotesFor(category, modes),
    aiSuggested: !(input.title && input.category && input.priceCents != null),
  };
  draft.seoDescription = buildSeoDescription(draft);
  return draft;
}

/** De-duplicated, slugged tag list for discovery. */
export function buildTags(d: {
  title?: string; category?: string; color?: string; size?: string; brand?: string;
  modes?: ListingMode[]; keywords?: string[];
}): string[] {
  const raw = [
    d.category, d.color, d.brand, d.size,
    ...(d.modes ?? []),
    ...(d.keywords ?? []),
  ].filter(Boolean) as string[];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug && !STOP.has(slug) && !seen.has(slug)) { seen.add(slug); out.push(slug); }
  }
  return out.slice(0, 12);
}

/** A concise, keyword-rich SEO/summary line. */
export function buildSeoDescription(d: ListingDraft): string {
  const bits = [
    cap(d.condition.replace('_', ' ')),
    d.color, d.brand, d.category,
  ].filter(Boolean).map((s) => s as string);
  const modeText = d.modes.map((m) => MODE_NOUN[m] ?? m).join(', ');
  return `${bits.join(' ')} ${modeText} on Bubaly Marketplace.`.replace(/\s+/g, ' ').trim();
}

function safetyNotesFor(category: ListingCategory, modes: ListingMode[]): string[] {
  const notes = ['Meet in a public place and inspect the item before paying.'];
  if (category === 'baby' || category === 'toys') notes.push('Check for recalls and confirm the item meets current safety standards.');
  if (category === 'electronics') notes.push('Test that the device powers on and functions before completing.');
  if (modes.includes('rent') || modes.includes('borrow')) notes.push('Agree on return date, condition, and any deposit up front.');
  return notes;
}

export interface DraftReadiness { ready: boolean; missing: string[] }

/**
 * The publish gate. A draft is publishable only when it has the essentials for
 * its modes — the UI shows `missing` and requires user confirmation (never
 * auto-publishes).
 */
export function draftReadiness(d: Partial<ListingDraft>): DraftReadiness {
  const missing: string[] = [];
  if (!d.title || d.title.trim().length < 3) missing.push('title');
  if (!d.category) missing.push('category');
  if (!d.modes || d.modes.length === 0) missing.push('at least one mode');
  const modes = d.modes ?? [];
  if ((modes.includes('buy') || modes.includes('swap')) && !modes.includes('wanted') && !(d.priceCents && d.priceCents > 0)) {
    missing.push('sale price');
  }
  if (modes.includes('rent') && !(d.rentDayCents && d.rentDayCents > 0)) missing.push('rental rate');
  return { ready: missing.length === 0, missing };
}
