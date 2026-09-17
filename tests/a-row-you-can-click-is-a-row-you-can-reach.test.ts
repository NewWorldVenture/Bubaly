import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { activatable } from '@/lib/ui/a11y';

// Two halves of one problem: a thing you can click but cannot reach.

describe('activatable', () => {
  const press = (key: string) => {
    const preventDefault = vi.fn();
    return { event: { key, preventDefault }, preventDefault };
  };

  it('makes the element a tab stop and announces it as a button', () => {
    const props = activatable(() => {});
    expect(props.role).toBe('button');
    expect(props.tabIndex).toBe(0);
  });

  it('activates on click, Enter and Space', () => {
    for (const fire of [
      (p: ReturnType<typeof activatable>) => p.onClick(),
      (p: ReturnType<typeof activatable>) => p.onKeyDown(press('Enter').event),
      (p: ReturnType<typeof activatable>) => p.onKeyDown(press(' ').event),
    ]) {
      const onActivate = vi.fn();
      fire(activatable(onActivate));
      expect(onActivate).toHaveBeenCalledTimes(1);
    }
  });

  it('ignores every other key', () => {
    const onActivate = vi.fn();
    const props = activatable(onActivate);
    for (const key of ['Tab', 'Escape', 'a', 'ArrowDown', 'Shift', 'PageDown']) {
      const { event, preventDefault } = press(key);
      props.onKeyDown(event);
      expect(preventDefault, `${key} was consumed`).not.toHaveBeenCalled();
    }
    expect(onActivate).not.toHaveBeenCalled();
  });

  // A control that answers a key must consume it. Space scrolls the page on
  // anything that is not a real button, and Enter submits an enclosing form, so
  // handling the key while letting the default run turns "it works" into "it
  // works and the page jumps".
  it('consumes the keys it handles, and only those', () => {
    const props = activatable(() => {});
    for (const key of ['Enter', ' ']) {
      const { event, preventDefault } = press(key);
      props.onKeyDown(event);
      expect(preventDefault, `${key} was not consumed`).toHaveBeenCalledTimes(1);
    }
  });
});

// ── The exemption that hides the defect ─────────────────────────────────────
//
// A click-outside scrim — `<div className="fixed inset-0" onClick={close} />` —
// is a mouse affordance with nothing to activate, so `aria-hidden` is the
// honest description of it. It is ALSO the thing that silences
// `click-events-have-key-events` and `no-static-element-interactions`, the two
// rules pointing at the menu's missing keyboard dismissal.
//
// Four scrims in this repo already carried `aria-hidden tabIndex={-1}` and NONE
// of their files handled Escape: a keyboard user could open those menus and had
// no way out but to pick something. The exemption was doing the hiding.
//
// This was very nearly a fifth: the calendar scrims were marked `aria-hidden`
// with a comment reading "the keyboard equivalent is Escape, handled on the
// menu itself" — and no Escape handler existed. The comment was the only
// occurrence of the word in the file. So the rule is not "don't use
// aria-hidden"; it is "if you silence the rules this way, the keyboard path has
// to be real".
//
// Scrims WITHOUT `aria-hidden` are deliberately not covered: those are still
// flagged by the two lint rules and counted against `next lint --max-warnings`,
// so they are visible. Thirteen remain, and they are backlog, not a hole.
describe('an aria-hidden scrim does not hide a menu with no way out', () => {
  const SCRIM = /className="fixed inset-0[^"]*"/;

  /**
   * An Escape path is either written here, or provided by one of the two hooks
   * that exist to provide it.
   *
   * This started as `/['"]Escape['"]/` — the key compared inline — and that
   * heuristic broke the moment the handling was factored into a hook, which is
   * the better shape: `useDismissOnEscape` for a popover (Escape only; a
   * dropdown must NOT trap focus or lock scroll) and `useDialogBehavior` for a
   * real dialog (Escape, focus trap, focus restore). Six overlays across four
   * modules moved onto them at once.
   *
   * Deliberately a CLOSED list of two names rather than anything matching
   * /escape/i: a guard that accepts any plausible-looking identifier is a guard
   * that accepts `const escapeHatch = true`. Adding a third hook here should be
   * a deliberate act, and the compiler will not do it for you.
   */
  const ESCAPE_HOOKS = ['useDismissOnEscape', 'useDialogBehavior'];
  const hasEscapePath = (source: string): boolean =>
    /['"]Escape['"]/.test(source) || ESCAPE_HOOKS.some((hook) => source.includes(`${hook}(`));

  const files = execSync("git ls-files 'components/*.tsx' 'app/*.tsx'", { encoding: 'utf8' })
    .split('\n').filter(Boolean);

  it('is looking at the components (guards the guard)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith('calendar-module.tsx'))).toBe(true);
  });

  it('every aria-hidden click-outside scrim has an Escape path in its file', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(`${process.cwd()}/${file}`, 'utf8');
      const scrims = source.split('\n').filter(
        (line) => SCRIM.test(line) && line.includes('onClick') && line.includes('aria-hidden'),
      );
      if (scrims.length === 0) continue;
      if (!hasEscapePath(source)) offenders.push(`${file} (${scrims.length} scrim(s))`);
    }
    expect(
      offenders,
      'An aria-hidden scrim silences the two jsx-a11y rules for that element. '
      + 'Give the menu a keydown handler that closes it on Escape, or drop the '
      + 'aria-hidden and let the rules count it.',
    ).toEqual([]);
  });
});
