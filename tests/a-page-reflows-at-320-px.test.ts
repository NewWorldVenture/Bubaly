import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from './helpers/hover-reveals';

// A11Y-001, WCAG 1.4.10 (reflow). At 320 CSS px wide, 21 of the 246 member
// routes of a seeded household scrolled sideways (a scratch sweep measured
// document.scrollWidth against the viewport and named the elements past it).
//
// Most were one shape: a grid with columns only from a breakpoint up
// (`grid gap-4 lg:grid-cols-2`). Below the breakpoint its single implicit
// column is sized `auto`, which grows to its widest child's min-content (a
// truncated title, a row that does not wrap), so the whole card ran past the
// screen. `grid-cols-1` is `minmax(0, 1fr)`: the column is the grid's width,
// and the children wrap or truncate inside it.
// The rest were rows: a flex row that never wraps, or a flex-1 input whose
// min-width is its intrinsic size.
//
// The admin console was swept the same way later: 5 of its 79 routes scrolled
// sideways at 320 px (/admin, /admin/admins, /admin/feedback,
// /admin/marketing/settings and /admin/subscriptions), from the same two shapes.
//
// UI-001 swept every member, admin and public route again at six widths, on a
// phone's viewport (isMobile, where the layout viewport grows with the content).
// At 320 px four member routes scrolled sideways (/dashboard/agents,
// /dashboard/journeys, /dashboard/social/content-studio/new, by 177 px and
// still 107 px at 390, and /dashboard/social/media-library), and the phone
// number field ran past its own box everywhere it is used.
//
// A second UI-001 pass opened every dialog, menu and disclosure, and the forms
// behind Add/New/Edit buttons, at 320x568 and on a phone held sideways (568x320).
// Three forms that open in place scrolled the page sideways at 320 px (family
// emergency's Add plan, weather's Add city, the voice command's Run row), and
// the guardian contact editor ran off the top of the screen with its first
// fields out of reach. The PIN lock screen and the exit-intent offer, which no
// button opens, had the same shape: taller than a sideways phone, and no scroll.

/** Each class string in a file that makes a grid with breakpoint columns and no base column count. */
function unboundedGrids(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(["'`])((?:(?!\1)[^\n])*)\1/g)) {
    const classes = m[2].split(/\s+/);
    if (!classes.includes('grid')) continue;
    if (!classes.some((c) => /^(sm|md|lg|xl|2xl):grid-cols-/.test(c))) continue;
    if (classes.some((c) => /^grid-cols-/.test(c))) continue;
    out.push(m[2]);
  }
  return out;
}

const files = [...sourceFiles('components'), ...sourceFiles('app')];

describe('a page reflows at 320 px', () => {
  it('the grids the sweep found have a base column that cannot outgrow them', () => {
    const fixed: [string, string][] = [
      ['app/(app)/dashboard/assistants/page.tsx', 'grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]'],
      ['components/modules/contact-center-module.tsx', 'grid grid-cols-1 gap-4 lg:grid-cols-2'],
      ['components/modules/family-module.tsx', 'grid grid-cols-1 gap-5 lg:grid-cols-2'],
      ['app/(app)/dashboard/family-coo/page.tsx', 'grid grid-cols-1 gap-5 md:grid-cols-2'],
      ['app/(app)/dashboard/family-health/page.tsx', 'grid grid-cols-1 gap-5 md:grid-cols-2'],
      ['components/modules/goals-module.tsx', 'grid grid-cols-1 gap-4 sm:grid-cols-2'],
      ['components/moments/moments-view.tsx', 'grid grid-cols-1 gap-4 lg:grid-cols-2'],
      ['components/modules/school-module.tsx', 'grid grid-cols-1 gap-5 lg:grid-cols-2'],
      ['components/modules/settings-module.tsx', 'grid grid-cols-1 gap-4 sm:grid-cols-2'],
      ['app/(app)/admin/page.tsx', 'grid grid-cols-1 gap-4 lg:grid-cols-3'],
      ['app/(app)/admin/subscriptions/page.tsx', 'grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]'],
      ['app/(app)/admin/marketing/settings/page.tsx', 'grid grid-cols-1 gap-5 lg:grid-cols-2'],
      ['components/modules/agents-module.tsx', 'grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_1.3fr]'],
      // A fieldset's min-width is its content's by default, so it also needs min-w-0.
      ['components/social/studio-form.tsx', 'grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3'],
      ['components/family/quick-add.tsx', 'grid grid-cols-1 gap-3 sm:grid-cols-2'],
      ['app/(app)/dashboard/family-emergency/page.tsx', 'grid grid-cols-1 gap-5 md:grid-cols-2'],
    ];
    for (const [file, cls] of fixed) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).toContain(`"${cls}`);
      expect(unboundedGrids(src).filter((g) => g.startsWith(cls.replace('grid-cols-1 ', ''))), file).toEqual([]);
    }
  });

  it('the count of grids with no base column only goes down', () => {
    // 330 on main c95b118; the nine files above held 11 of them. Most fit
    // their content at 320 px, as the sweep showed; this keeps new ones from
    // being added without a base column. 319 to 316 with the three admin grids,
    // 314 with UI-001's two, and 312 with its second pass's two.
    const count = files.reduce((n, f) => n + unboundedGrids(readFileSync(f, 'utf8')).length, 0);
    expect(count).toBeLessThanOrEqual(312);
    expect(count).toBeGreaterThan(100); // non-vacuity: the scanner finds them
  });

  it('the rows the sweep found wrap, and their inputs can shrink', () => {
    const src = (f: string) => readFileSync(f, 'utf8');
    expect(src('components/dashboard/ai-home-dashboard.tsx')).toContain('<div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">');
    expect(src('components/modules/health-visits-module.tsx')).toContain('<div className="flex flex-wrap items-center justify-between gap-3">');
    expect(src('components/modules/focus-module.tsx')).toContain('<div className="flex flex-wrap items-center justify-center gap-1.5">');
    expect(src('components/modules/shopping-module.tsx').match(/<div className="ml-auto flex flex-wrap items-center gap-2">/g)).toHaveLength(2);
    expect(src('components/modules/shopping-module.tsx')).toContain('className="min-w-0 flex-1 rounded-xl border border-dashed');
    expect(src('app/(app)/dashboard/social/feed/page.tsx')).toContain('className="min-w-0 flex-1 rounded-lg border');
    expect(src('app/(app)/dashboard/social/analytics/page.tsx')).toContain('className="flex flex-wrap items-center gap-3 text-sm"');
    expect(src('app/(app)/dashboard/social/settings/page.tsx')).toContain('className="flex flex-wrap items-center gap-2 rounded-lg border');
    expect(src('components/guardian/call-history.tsx')).toContain('<div className="flex flex-wrap gap-1.5">');
    expect(src('components/referrals/referral-panel.tsx')).toContain('className="h-11 min-w-0 flex-1 rounded-xl');
    expect(src('components/modules/immunizations-module.tsx')).toContain('<div className="flex flex-wrap items-center justify-between gap-3">');
    // Their member filter and Add: the row wraps and the filter, as wide as its
    // longest name, is capped at the row (rendered: tests/e2e/a-health-header-reflows-at-320-px.spec.ts).
    for (const f of ['components/modules/health-visits-module.tsx', 'components/modules/immunizations-module.tsx']) {
      expect(src(f), f).toContain('<div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">');
      expect(src(f), f).toContain('className="h-9 min-w-0 max-w-full rounded-lg border border-border bg-surface px-2 text-sm">');
    }
    // Two more member filters a long name widened past the screen, capped at their row.
    expect(src('app/(app)/dashboard/activity/activity-feed.tsx')).toContain('className="ml-auto min-w-0 max-w-full rounded-lg border');
    expect(src('components/modules/timetable-module.tsx')).toContain('className="h-9 w-auto min-w-0 max-w-full">');
    // A full URL is one word: it breaks anywhere rather than push the card past the screen.
    expect(src('app/(app)/dashboard/assistants/page.tsx').match(/<code className="break-all text-xs">https:\/\//g)).toHaveLength(2);
  });

  it('the admin rows the sweep found wrap, and their search can shrink', () => {
    const src = (f: string) => readFileSync(f, 'utf8');
    // A donut's legend goes under the 112 px donut when the card cannot hold both.
    for (const f of ['components/admin/role-donut.tsx', 'components/admin/status-donut.tsx', 'app/(app)/admin/subscriptions/page.tsx']) {
      expect(src(f), f).toContain('<div className="flex flex-wrap items-center gap-5">\n      <div className="relative h-28 w-28 shrink-0">');
    }
    // The feedback board's category and search wrap below lg, where the search
    // takes the row; from lg they sit side by side as before.
    const feedback = src('components/admin/feedback-admin.tsx');
    expect(feedback).toContain('<div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">');
    expect(feedback).toContain('<div className="relative min-w-[10rem] flex-1 sm:flex-none">');
    expect(feedback).toContain('className="h-9 w-full rounded-lg border border-border bg-bg pl-8 pr-2 text-sm outline-none focus:border-brand sm:w-40"');
    // A provider's status goes under its name, and an environment variable's
    // name (one word, such as GOOGLE_SEARCH_CONSOLE_KEY) breaks anywhere.
    const settings = src('app/(app)/admin/marketing/settings/page.tsx');
    expect(settings).toContain('className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2 text-sm"');
    expect(settings).toContain('<span className="inline-flex min-w-0 items-center gap-1 text-muted [overflow-wrap:anywhere]"><XCircle className="h-4 w-4 shrink-0" /> Set {p.env}</span>');
  });

  it('the rows the UI-001 sweep found wrap, stack or shrink', () => {
    const src = (f: string) => readFileSync(f, 'utf8');
    // Three stat tiles side by side left 51 px for "Completion" at 320 px; they stack below sm.
    expect(src('app/(app)/dashboard/journeys/page.tsx')).toContain('className="grid grid-cols-1 gap-3 sm:grid-cols-3"');
    expect(src('app/(app)/dashboard/journeys/page.tsx')).not.toContain('className="grid grid-cols-3 gap-3"');
    // A media card's kind and status badges wrap rather than push the card past the screen.
    expect(src('app/(app)/dashboard/social/media-library/page.tsx')).toContain('<div className="flex flex-wrap items-center gap-1">\n                    <Badge tone="neutral">{a.kind}</Badge>');
    // The number field could not shrink below its own width inside a box that hides
    // overflow: its end was cut off, and with focus in it the box scrolled the country
    // button out of view (rendered: the phone sign-in form tests in
    // tests/e2e/a-popup-opens-closes-and-keeps-its-targets-apart.spec.ts).
    expect(src('components/ui/phone-input.tsx')).toContain('className="min-w-0 flex-1 bg-transparent px-3 text-sm text-fg placeholder:text-muted outline-none"');
  });

  it('what opens on a small screen stays on it: forms in place wrap and shrink, dialogs scroll', () => {
    const src = (f: string) => readFileSync(f, 'utf8');
    // A card action that opens into a form (QuickAdd) takes a row of its own, filled by the form.
    const card = src('components/family/shell.tsx');
    expect(card).toContain('<div className="mb-4 flex items-start justify-between gap-3 has-[form]:flex-wrap">');
    expect(card).toContain('<div className="flex shrink-0 items-center gap-3 has-[form]:basis-full">');
    expect(src('components/family/quick-add.tsx')).toContain('className="w-full rounded-2xl border border-border bg-surface/60 p-4 space-y-3"');
    // Weather's city search beside its Search and close buttons.
    expect(src('components/modules/weather-module.tsx')).toContain('<div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl');
    // The voice command's routing preview and its Clear / Run command buttons.
    expect(src('components/modules/voice-module.tsx')).toContain('<div className="mt-3 flex flex-wrap items-center justify-between gap-2">\n          <div className="min-h-[1.75rem] min-w-0">');
    // The guardian contact editor caps its height and scrolls, as the rules editor beside it does.
    for (const f of ['components/guardian/contact-list.tsx', 'components/guardian/rules-editor.tsx']) {
      expect(src(f), f).toMatch(/role="dialog"[\s\S]{0,120}className="relative z-10 w-full max-w-(md|lg) max-h-\[85dvh\] overflow-y-auto /);
    }
    // The exit-intent offer is never taller than the screen.
    expect(src('components/marketing/exit-intent.tsx')).toContain('className="relative z-10 max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl');
    // The PIN lock screen scrolls from its top on a short screen: centred with my-auto,
    // because justify-center on a scroller cuts off the top, where no scroll reaches.
    const lock = src('components/app/app-lock-gate.tsx');
    expect(lock).toContain('className="fixed inset-0 z-[200] flex flex-col items-center overflow-y-auto bg-bg px-6 py-6"');
    expect(lock).toContain('<div className="my-auto flex w-full max-w-xs flex-col items-center">');
    expect(lock).not.toContain('items-center justify-center bg-bg px-6');
  });

  it('the scanner: breakpoint columns without a base count; a base count or no breakpoint is fine', () => {
    expect(unboundedGrids(`<div className="grid gap-4 lg:grid-cols-2">`)).toHaveLength(1);
    expect(unboundedGrids(`<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">`)).toHaveLength(0);
    expect(unboundedGrids(`<div className="grid gap-4">`)).toHaveLength(0);
    expect(unboundedGrids(`cn('grid gap-3 sm:grid-cols-3', x)`)).toHaveLength(1);
  });
});
