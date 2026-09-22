import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The signed-in app had two buttons whose only effect was an ERROR toast saying
// the feature does not exist (F-F10): "Start video call" and "Start voice
// call", rendered unconditionally in the message header, styled exactly like
// the working "About this chat" button beside them.
//
// That contradicted a rule this repo states about itself twice —
//
//   lib/constants/navigation.ts:  No "coming soon" stubs: if a console section
//                                isn't built yet, it isn't listed.
//   components/marketing/social-proof-band.tsx:  no invented names, no "coming soon".
//
// — and the surfaces that get it right simply do not offer the control:
// /wallet/cards reads getMoneyCapabilities and passes caps.issuing and
// caps.physicalCards down, rather than rendering a button that apologises.
//
// So: a control whose handler's ONLY job is to report its own absence is not a
// control. This finds that shape — an onClick that does nothing but raise an
// error — rather than trying to judge copy.
const APOLOGY = /onClick=\{\(\)\s*=>\s*toastError\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx') && !full.includes('.test.')) out.push(full);
  }
  return out;
}

const blankComments = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

/** Controls whose entire handler is an error toast. */
export function apologeticControls(source: string): number[] {
  return blankComments(source).split('\n')
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => APOLOGY.test(line))
    .map(([n]) => n);
}

describe('no control exists only to apologise for itself', () => {
  const files = [...walk('components'), ...walk('app')];

  it('finds the interactive surface (non-vacuity)', () => {
    const withClicks = files.filter((f) => /onClick=/.test(readFileSync(f, 'utf8')));
    expect(withClicks.length).toBeGreaterThan(80);
  });

  it('reads a handler that only raises, not one that does work first (sanity)', () => {
    expect(apologeticControls("<button onClick={() => toastError(tr('x.notAvailable'))}>Call</button>")).toEqual([1]);
    // A handler that tries something and reports failure is the correct shape.
    expect(apologeticControls('<button onClick={() => void save()}>Save</button>')).toEqual([]);
    expect(apologeticControls('<button onClick={async () => { const r = await go(); if (!r.ok) toastError(r.error); }}>Go</button>')).toEqual([]);
    // Prose about it is not it.
    expect(apologeticControls("{/* onClick={() => toastError('gone')} used to be here */}\n<div />")).toEqual([]);
  });

  it('has none', () => {
    const offenders = files.flatMap((f) => apologeticControls(readFileSync(f, 'utf8')).map((n) => `${f}:${n}`));
    expect(
      offenders,
      'A control whose only effect is an error toast advertises a capability the app does not have.\n'
      + 'Read the capability and do not render the control — /wallet/cards is the pattern:\n'
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('the message header no longer offers calls it cannot place', () => {
    const src = blankComments(readFileSync('components/modules/messages-module.tsx', 'utf8'));
    expect(src).not.toMatch(/videoCallingIsnTAvailable/);
    expect(src).not.toMatch(/voiceCallingIsnTAvailable/);
    // …and "About this chat", which works, is still there beside where they were.
    expect(src).toMatch(/setShowAbout\(true\)/);
  });
});
