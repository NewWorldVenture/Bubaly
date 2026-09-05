// lib/ai/context/render.ts — turns loaded slices into the prompt text, under
// a character budget, deterministically.
//
// WHY a budget with a stable priority instead of "whatever fits": §27 says to
// optimise context size, and a planner's behaviour must be reproducible — the
// same household on the same day must produce the same prompt, or an eval that
// passed yesterday fails today for no reason a person can see. So trimming is
// a pure function of (slice order, line order, budget): every slice first gets
// a floor so a late slice is never starved by an early verbose one, then the
// leftover is handed out in priority order. What was cut is recorded in
// `stats` so a reviewer can tell "the model did not know" from "the model was
// not told".
//
// Formatting helpers live here too, because every slice needs to say "10:00 AM
// Saturday" in the family's zone and none of them should own a date formatter.
import 'server-only';
import { describeDay, describeWhen } from '@/lib/ai/tools/types';
import { dayKeyInTz, zonedDayBoundsMs } from '@/lib/services/scope';

/** Default prompt budget, in characters (≈1.5k tokens). Callers may raise it. */
export const DEFAULT_CONTEXT_BUDGET_CHARS = 6000;

/** No slice gets more than this in the first pass, however small the set. */
const FLOOR_MAX_CHARS = 900;

/** Cheapest budget a caller may ask for; below it only the header fits. */
const MIN_BUDGET_CHARS = 400;

export type RenderSection = {
  name: string;
  title: string;
  lines: string[];
};

export type RenderInput = {
  /** Lines always included, never trimmed: the family header and the content rule. */
  preamble: string[];
  sections: RenderSection[];
  budgetChars?: number;
};

export type RenderOutput = {
  text: string;
  /** `<slice>_lines`, `<slice>_chars`, `<slice>_trimmed` per section plus totals. */
  stats: Record<string, number>;
};

function heading(section: RenderSection): string {
  return `## ${section.title}`;
}

function moreLine(n: number): string {
  return `… ${n} more not shown`;
}

/** Characters a line costs once it is joined with a newline. */
function cost(line: string): number {
  return line.length + 1;
}

/** What a section costs when its first `n` lines are shown (0 = section dropped). */
function blockCost(section: RenderSection, n: number): number {
  if (n === 0) return 0;
  let total = cost(heading(section));
  for (let i = 0; i < n; i += 1) total += cost(section.lines[i]);
  if (n < section.lines.length) total += cost(moreLine(section.lines.length - n));
  return total;
}

/**
 * Trim and join. Two passes, both walking `sections` in the given order:
 *   1. each section takes lines up to `floor` characters;
 *   2. what remains of the budget is handed out in order until it is gone.
 * A section that lost lines ends with a "… N more not shown" marker so the
 * model knows the list is incomplete rather than short.
 */
export function renderContext(input: RenderInput): RenderOutput {
  const budget = Math.max(MIN_BUDGET_CHARS, Math.floor(input.budgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS));
  const stats: Record<string, number> = {};

  const preambleChars = input.preamble.reduce((sum, line) => sum + cost(line), 0);
  let remaining = Math.max(0, budget - preambleChars);

  const sections = input.sections.filter((s) => s.lines.length > 0);
  const kept = new Map<string, number>();

  // Pass 1: floors. A section that fits nothing but its heading is dropped
  // rather than shown as an empty title the model would read as "nothing here".
  const floor = sections.length ? Math.min(FLOOR_MAX_CHARS, Math.floor(remaining / sections.length)) : 0;
  for (const section of sections) {
    let n = 0;
    while (n < section.lines.length && blockCost(section, n + 1) <= floor) n += 1;
    kept.set(section.name, n);
    remaining -= blockCost(section, n);
  }

  // Pass 2: leftovers, in priority order. The marginal cost of one more line
  // includes the change to the "more" marker, so the total never exceeds the budget.
  for (const section of sections) {
    let n = kept.get(section.name) ?? 0;
    while (n < section.lines.length) {
      const delta = blockCost(section, n + 1) - blockCost(section, n);
      if (delta > remaining) break;
      remaining -= delta;
      n += 1;
    }
    kept.set(section.name, n);
  }

  const out: string[] = [...input.preamble];
  let totalChars = preambleChars;
  for (const section of sections) {
    const n = kept.get(section.name) ?? 0;
    const trimmed = section.lines.length - n;
    stats[`${section.name}_lines`] = n;
    stats[`${section.name}_trimmed`] = trimmed;
    stats[`${section.name}_chars`] = blockCost(section, n);
    if (n === 0) continue;
    const block = [heading(section), ...section.lines.slice(0, n)];
    if (trimmed > 0) block.push(moreLine(trimmed));
    totalChars += blockCost(section, n);
    out.push('', ...block);
  }

  stats.budget_chars = budget;
  stats.total_chars = totalChars;
  stats.sections = sections.length;
  return { text: out.join('\n'), stats };
}

// ── Formatting helpers shared by slices ─────────────────────────────────────

/** "10:00 AM Saturday" / "10:00 AM Sat, Sep 20" in the family's zone. */
export function when(iso: string | null | undefined, tz: string, now: Date): string {
  return describeWhen(iso, tz, now);
}

/** "Saturday" / "Sat, Sep 20" for all-day things. */
export function day(iso: string | null | undefined, tz: string, now: Date): string {
  return describeDay(iso, tz, now);
}

/**
 * The day key `days` after (or before) `dayKey` in the family's zone. Walks
 * through local noon so a DST change never lands on the wrong day.
 */
export function shiftDayKey(dayKey: string, days: number, tz: string): string {
  const { start } = zonedDayBoundsMs(dayKey, tz);
  return dayKeyInTz(new Date(start + days * 86_400_000 + 12 * 3600_000), tz);
}

/** A YYYY-MM-DD day key as "Sat, Sep 20"; the key is a family-local date already, so no zone shift. */
export function dayKeyLabel(dayKey: string | null | undefined): string {
  if (!dayKey) return 'no set day';
  const ms = Date.parse(`${dayKey}T12:00:00Z`);
  if (!Number.isFinite(ms)) return String(dayKey);
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(ms));
  } catch {
    return dayKey;
  }
}

/** Whole-currency amounts read better in a prompt than cents; two decimals only when needed. */
export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** "a, b and c" — lists in prose, capped so one long list cannot eat the budget. */
export function joinNatural(items: string[], max = 8): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  const base = shown.length <= 1 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return rest > 0 ? `${base} (+${rest} more)` : base;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** days_of_week integers (0 = Sunday) → "Mon, Wed, Fri". */
export function weekdays(days: number[] | null | undefined): string {
  if (!days?.length) return 'any day';
  const names = [...new Set(days)].filter((d) => d >= 0 && d < 7).sort((a, b) => a - b).map((d) => WEEKDAYS[d]);
  return names.length === 7 ? 'every day' : names.join(', ');
}
