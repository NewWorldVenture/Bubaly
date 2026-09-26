// A class that styles nothing is invisible to everything except the user.
//
// CSS ignores an unknown class. Tailwind ignores a token it does not recognise.
// `next build` passes. The element renders without the background, border,
// spacing or animation the author asked for, and nothing anywhere says so.
//
// That is how 47 class names reached production here:
//
//   - `btn-primary` on an admin Save button, defined in no stylesheet, so the
//     button had no background, padding or colour at all;
//   - `no-scrollbar` on thirteen horizontal tab strips, defined nowhere;
//   - `bg-card`, `bg-primary`, `text-foreground`, `bg-background`, `bg-surface-2`
//     — shadcn's vocabulary, used as if the theme defined it. It names them
//     `surface`, `brand`, `fg`, `bg`, `elevated`. 28 cards had no background;
//   - `animate-in fade-in slide-in-from-bottom-2` and `zoom-in-95`, which come
//     from `tailwindcss-animate`, with `plugins: []` in the config — the
//     onboarding wizard's entry animation simply never ran;
//   - 23 colour-opacity modifiers that are not multiples of five. `bg-brand/10`
//     works and `bg-brand/12` resolves to nothing, one character apart, on the
//     public pricing page among others.
//
// The audit compiles the real stylesheet with the real config and asks which of
// the class tokens this app writes produce no rule. See
// scripts/audit-unstyled-classes.mjs for how it decides which string literals are
// class lists — the four corrections that took the count from a meaningless 157 to
// an exact 47 are recorded there, because each one is a way this kind of sweep
// lies.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditUnstyledClasses, bareClass } from '../scripts/audit-unstyled-classes.mjs';

describe('every class the app writes styles something', () => {
  it('finds no class name that compiles to nothing', async () => {
    const audit = await auditUnstyledClasses();
    expect(
      audit.offenders.map((o) => `${o.token} — ${o.file}:${o.line}`),
      'each of these renders nothing: fix the token, or define it in app/globals.css',
    ).toEqual([]);
    // The audit must actually have looked at the app. A glob that matched nothing
    // would report zero offenders and pass.
    expect(audit.files).toBeGreaterThan(800);
    expect(audit.classLists).toBeGreaterThan(10_000);
    expect(audit.recognised).toBeGreaterThan(1_000);
  }, 60_000);

  // The positive control, and the reason to trust the case above. Every offender
  // this repository actually had is now fixed, so "0 offenders" on its own is
  // equally consistent with a sweep that can no longer see anything.
  it.each([
    ['an opacity that is not a multiple of five', 'bg-brand/12'],
    ['a colour the theme never defines', 'bg-card'],
    ['a plugin class with no plugin installed', 'zoom-in-95'],
    ['a component class defined in no stylesheet', 'btn-primary'],
    ['a spacing step that does not exist', 'h-4.5'],
  ])('still catches %s', async (_why, token) => {
    const directory = mkdtempSync(join(tmpdir(), 'bubaly-classes-'));
    try {
      const file = join(directory, 'probe.tsx');
      writeFileSync(file, `export const P = () => <div className="rounded-xl p-4 ${token}" />;\n`);
      const audit = await auditUnstyledClasses([file]);
      expect(audit.offenders.map((o) => o.token)).toContain(token);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('passes a file whose classes are all real', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bubaly-classes-'));
    try {
      const file = join(directory, 'probe.tsx');
      writeFileSync(file, 'export const P = () => <div className="rounded-xl bg-surface/40 p-4 focus-ring" />;\n');
      expect((await auditUnstyledClasses([file])).offenders).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  // The variant stripper, which decides what token to look up. A wrong answer
  // here reports every `sm:` and `hover:` class in the app as unstyled, or hides
  // a broken arbitrary value.
  it('reads the class out of a variant without breaking an arbitrary value', () => {
    expect(bareClass('hover:bg-brand/10')).toBe('bg-brand/10');
    expect(bareClass('sm:focus-visible:ring-2')).toBe('ring-2');
    expect(bareClass('!p-0')).toBe('p-0');
    expect(bareClass('lg:grid-cols-[minmax(0,1fr)_320px]')).toBe('grid-cols-[minmax(0,1fr)_320px]');
    // The colon here belongs to the arbitrary value, not to a variant.
    expect(bareClass('[ai-context:home]')).toBe('[ai-context:home]');
    expect(bareClass('group/snooze')).toBe('group/snooze');
  });
});
