// Every useRealtimeQuery read has to be able to fail out loud.
//
// The hook returns { data, loading, error, refresh }. A call site that takes
// only `data` cannot tell "this family has nothing" from "the query did not
// come back", and every one of them resolved that the same way: render the
// empty state. That produced "No bills yet" on a failed bills read, a rewards
// balance computed from reads that failed, and "Nothing on the horizon" from
// the page whose whole job is to say what is coming.
//
// Eighteen call sites across fourteen files were fixed by hand. This is what
// keeps the nineteenth from being written: a call site must either surface its
// error, or its file must be named below with a reason.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

// Files where dropping the read error is the right answer. A name here is a
// claim a reviewer can check, which is the only reason the list is allowed to
// exist at all.
const EXEMPT: Record<string, string> = {
  'components/concierge/run-timeline.tsx':
    'Both queries are liveness stamps that schedule a router.refresh(); the timeline content comes from server props, so a failed stamp read costs an auto-refresh, not correctness.',
  'components/memories/on-this-day-card.tsx':
    'Renders null when it has nothing, so a failed read costs an additive Home card rather than asserting anything false. An error box here would be the worse answer.',
  'components/moments/home-moment-card.tsx':
    'Same shape: returns null with no moment to show, so a failed read hides an optional card instead of making a claim.',
};

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', '.git', '.claude', 'mobile'].includes(entry.name)) continue;
    if (entry.isDirectory()) sources(`${dir}/${entry.name}`, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(`${dir}/${entry.name}`);
  }
  return out;
}

/** Call sites in one file that never read the error the hook handed them. */
function droppedIn(file: string): number[] {
  const src = readFileSync(file, 'utf8');
  if (!/=\s*useRealtimeQuery/.test(src)) return [];
  // Several pages collect their queries into one array and test the group:
  //   const readError = readQueries.some((query) => query.error)
  // which reads every error without naming any of them.
  if (/readQueries[\s\S]{0,200}?\.some\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.error\s*\)/.test(src)) return [];

  const dropped: number[] = [];
  src.split('\n').forEach((line, index) => {
    if (!/=\s*useRealtimeQuery/.test(line)) return;
    const destructured = /const\s*\{([^}]*)\}\s*=\s*useRealtimeQuery/.exec(line);
    if (destructured) {
      const fields = destructured[1];
      const aliased = /\berror\s*:\s*(\w+)/.exec(fields);
      const shorthand = /(^|[,{\s])error\s*(,|$|\})/.test(fields);
      if (!aliased && !shorthand) { dropped.push(index + 1); return; }
      const name = aliased ? aliased[1] : 'error';
      // One occurrence is the binding itself; a second means something reads it.
      if ((src.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length < 2) dropped.push(index + 1);
      return;
    }
    const whole = /const\s+(\w+)\s*=\s*useRealtimeQuery/.exec(line);
    if (whole && !new RegExp(`\\b${whole[1]}\\.error\\b`).test(src)) dropped.push(index + 1);
  });
  return dropped;
}

const FILES = [...sources('components'), ...sources('app'), ...sources('lib')]
  .filter((file) => /=\s*useRealtimeQuery/.test(readFileSync(file, 'utf8')));

describe('a read that fails can say so', () => {
  it('found the call sites it is supposed to be checking', () => {
    // A walk that quietly found nothing would pass every case below.
    const calls = FILES.reduce(
      (n, file) => n + (readFileSync(file, 'utf8').match(/=\s*useRealtimeQuery/g) ?? []).length, 0);
    expect(FILES.length).toBeGreaterThan(80);
    expect(calls).toBeGreaterThan(200);
  });

  it.each(FILES)('%s surfaces every read error it takes', (file) => {
    const dropped = droppedIn(file);
    if (EXEMPT[file]) return;
    expect(dropped, [
      `${file} drops the read error at line(s) ${dropped.join(', ')}.`,
      'Take `error` (and `refresh`) from useRealtimeQuery and fold them into the',
      "page's existing readError, or add the file to EXEMPT with a reason.",
    ].join(' ')).toEqual([]);
  });

  it('keeps the exemption list honest', () => {
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(FILES, `${file} no longer calls useRealtimeQuery; drop the exemption`).toContain(file);
      expect(reason.length, `${file} needs a real reason`).toBeGreaterThan(60);
      // An exemption that is no longer needed is a licence nobody is using.
      expect(droppedIn(file).length, `${file} surfaces its errors now; drop the exemption`)
        .toBeGreaterThan(0);
    }
  });
});
