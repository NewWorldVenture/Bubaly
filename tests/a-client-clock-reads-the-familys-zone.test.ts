// TIME-003: every family surface shows its times in the FAMILY's zone.
//
// TIME-002 bound server pages to `families.timezone`. The client components did
// not follow, because the locale provider carried no zone: each one formatted
// with `toLocaleTimeString(locale, …)` or read `new Date().getHours()`, which
// answer in the DEVICE's zone — and `new Date().toISOString().slice(0, 10)`,
// which answers in Greenwich's. So one app showed a 15:00 Saturday game as
// 15:00 on a server-rendered page and 07:00 Sunday on a client-rendered one,
// to a parent reading on a business trip. The owner decided (2026-09-29) that
// every family surface reads in the family's zone.
//
// The zone now rides in the locale context (`FamilyTimeZoneProvider`, mounted
// by the (app) layout and by `AppProvider`), and the shared hooks carry it:
// `useFormat()` / `useHydrationSafeFormat()` for printing, `useFamilyClock()` for
// "today", "tomorrow" and the hour. This ratchet holds every 'use client' file
// to them. A file that needs the device's clock on purpose is named below with
// the reason, and an exemption that no longer matches anything fails too, so
// the list can only shrink.
//
// It is a line scan and it says what it can see: a direct call to a formatter
// that takes the runtime's zone, a date-fns day/format helper, and the shapes
// of "today" and "now" read off the device. It cannot see a Date handed to a
// helper in another module — the behaviour tests beside it cover the hooks.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    // Forward slashes on every OS, so EXEMPT's keys match on Windows too
    // (#688 comment 5922726657); readFileSync accepts them there.
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p.split('\\').join('/'));
  }
  return out;
}

/** What formats or buckets a clock in a zone the code did not choose. */
const DEVICE_CLOCK: { name: string; re: RegExp }[] = [
  { name: 'toLocaleDateString / toLocaleTimeString', re: /\.toLocale(?:Date|Time)String\(/ },
  // `n.toLocaleString(locale)` is a NUMBER and is fine; a date is recognised by
  // its options or its receiver.
  { name: 'toLocaleString on a date', re: /\.toLocaleString\([^)]*\b(?:month|weekday|hour|minute|year|timeZone)\b|new Date\([^)]*\)\.toLocaleString\(/ },
  // Reading the device's zone NAME (`…resolvedOptions().timeZone`) is not
  // formatting; constructing a date formatter is.
  { name: 'Intl.DateTimeFormat', re: /Intl\.DateTimeFormat\((?!\)\.resolvedOptions)/ },
  { name: 'date-fns clock helper', re: /\bimport\s*\{[^}]*\b(?:format|isToday|isTomorrow|isYesterday|isSameDay|formatDistance\w*|formatRelative|startOf\w+|endOf\w+|differenceInCalendarDays|getHours|getDay)\b[^}]*\}\s*from\s*'date-fns'/ },
  // "Now" and "today" off the device (or off Greenwich).
  { name: 'new Date() read in local fields', re: /new Date\(\)\.(?:get(?:Hours|Minutes|Day|Date|Month|FullYear)\(|toISOString\(\)\.(?:slice|split))/ },
  { name: 'an instant read in local fields', re: /new Date\([^(),]+\)\.get(?:Hours|Minutes|Day|Date)\(/ },
  { name: 'now/today read in local fields', re: /\b(?:now|today)\.(?:get(?:Hours|Minutes|Day|Date|Month|FullYear)\(|setHours\(|toISOString\(\)\.slice)/ },
  { name: 'local midnight', re: /\.setHours\(0,\s*0,\s*0,\s*0\)/ },
  // A "today" snapshot of the device's clock, handed on to day logic.
  // `new Date().toISOString()` is an absolute instant (a query bound) and is not
  // flagged; a Date snapshot is, because it is usually handed to day logic.
  { name: 'device-now snapshot', re: /useMemo\(\(\) => new Date\(\)(?!\.toISOString\(\)\s*,)/ },
  { name: 'device day of now', re: /\b(?:isoDate|ymd|localDateKey|toISODate|dayKey|localDayKey|isoWeekStart|weekParity|toYmd|startOfLocalDay)\(new Date\(\)\)/ },
  { name: 'device day of an instant', re: /\b(?:localDayKeyOf|shiftLocalDay)\(/ },
  // The shared formatter without the family's zone: the bare exports are bound
  // to en-US and the runtime's zone, and `createFormat` with no zone is too.
  { name: 'bare shared formatter', re: /\bimport\s*\{[^}]*\b(?:fmtDate|fmtTime|fmtDateTime|fmtRelative|fmtTimeAgo)\b[^}]*\}\s*from\s*'@\/lib\/utils\/format'/ },
  { name: 'createFormat in a client file', re: /\bcreateFormat\(/ },
  // Recurrence stepped on the runtime's zone.
  { name: 'expandEvents on the runtime zone', re: /\bexpandEvents\(/ },
];

/**
 * Files that read the device's clock ON PURPOSE. Each is keyed by path with the
 * reason, and none is a family surface's display of a family time.
 */
const EXEMPT: Record<string, string> = {
  // The shared hooks themselves: this is where the zone is chosen.
  'components/i18n/use-format.ts':
    'the hooks that choose the zone: `createFormat` is bound here to the family\'s zone, or the reader\'s where there is no family',
  // The kitchen display is handed the family's zone by its own server route
  // (`displayTimezone(data.timezone)`) and renders every time in it explicitly,
  // with the display's 12/24-hour setting — an option the shared formatter
  // does not carry. Same zone, stated at the call.
  'components/display/ambient-clock.tsx':
    'renders in the zone passed explicitly (`timeZone: zone`), the family\'s via displayTimezone, with the display\'s 12/24h setting',
  // Not family surfaces: the super-admin console spans every family, so there
  // is no one family's zone to render in, and the dates are Greenwich's or the
  // operator's own on purpose. Same for an ACCOUNT-level label.
  'app/(app)/admin/wallet/admin-wallet-client.tsx':
    'super-admin wallet audit across every family: no single family zone applies',
  'components/admin/feedback-admin.tsx':
    'super-admin feedback triage across every family: no single family zone applies',
  'components/admin/reports-toolbar.tsx':
    'super-admin report export filename and range: Greenwich\'s date, across every family',
  'components/admin/users-toolbar.tsx':
    'super-admin user export filename: Greenwich\'s date, across every family',
  'components/settings/security-panel.tsx':
    'names the ACCOUNT\'s authenticator factor with a date; an account label, not a family surface',
  'components/display/display-grid.tsx':
    'renders in the zone passed explicitly (`timeZone: timezone`), the family\'s via displayTimezone, with the display\'s 12/24h setting',
};

const INSTANT_ONLY = /\/\/ instant: \S/;
// A `datetime-local` box's default, read on the phone's clock: the disclosed
// TIME-003 remaining scope (those forms move with their save paths, separately).
const DEVICE_INPUT = /\/\/ device-input: \S/;
// `const d = new Date();` and then `d.getDate()` a line or two later: the same
// device read as `new Date().getDate()`, split across lines where a per-line
// scan cannot see it (review of #688, rides-module's todayKey).
const DEVICE_NOW_ALIAS = /(?:const|let)\s+(\w+)\s*=\s*new Date\(\)\s*;/g;
const FAMILY_ZONE_ARG = /timeZone: (?:clock|familyClock)\.timeZone\b/;

const ROOTS = ['app', 'components', 'lib'];
const isClient = (src: string) => /^\s*(?:\/\/[^\n]*\n\s*)*['"]use client['"]/.test(src);

function scan(path: string, src: string): string[] {
  const hits: string[] = [];
  let inBlock = false;
  src.split('\n').forEach((line, i) => {
    let code = line;
    if (inBlock) {
      const end = code.indexOf('*/');
      if (end < 0) return;
      code = code.slice(end + 2);
      inBlock = false;
    }
    code = code.replace(/\/\*.*?\*\//g, '');
    const open = code.indexOf('/*');
    if (open >= 0) { inBlock = true; code = code.slice(0, open); }
    code = code.replace(/(^|[^:'"`])\/\/.*$/, '$1');
    // A line that uses the moment only as an INSTANT (compared, sent as a bound)
    // says so, with its reason: `// instant: <why>`. Per line, so the rest of the
    // file stays held to the family's clock.
    if (INSTANT_ONLY.test(line)) return;
    // A formatter handed the family's zone explicitly is the family's clock.
    if (FAMILY_ZONE_ARG.test(code)) return;
    for (const { name, re } of DEVICE_CLOCK) {
      if (re.test(code)) hits.push(`${path}:${i + 1} [${name}] ${line.trim()}`);
    }
  });
  const lines = src.split('\n');
  for (const decl of src.matchAll(DEVICE_NOW_ALIAS)) {
    const after = src.slice(decl.index! + decl[0].length, decl.index! + decl[0].length + 400);
    const use = new RegExp(`\\b${decl[1]}\\.(?:get(?:FullYear|Month|Date|Day|Hours|Minutes)|set(?:Date|Hours))\\(`).exec(after);
    if (!use) continue;
    const declLine = src.slice(0, decl.index).split('\n').length;
    const useLine = src.slice(0, decl.index! + decl[0].length + use.index).split('\n').length;
    const marked = [declLine, useLine].some((n) => INSTANT_ONLY.test(lines[n - 1]) || DEVICE_INPUT.test(lines[n - 1]));
    if (!marked) hits.push(`${path}:${useLine} [new Date() alias read in local fields] ${lines[useLine - 1].trim()}`);
  }
  return hits;
}

function deviceClockHits(files: { path: string; src: string }[]): string[] {
  return files.flatMap(({ path, src }) => scan(path, src));
}

const clients = ROOTS.flatMap((r) => walk(r))
  .map((path) => ({ path, src: readFileSync(path, 'utf8') }))
  .filter(({ src }) => isClient(src));

describe('a client component reads the family\'s clock, not the device\'s (TIME-003)', () => {
  it('finds the client components (a scan that finds none proves nothing)', () => {
    expect(clients.length).toBeGreaterThan(400);
  });

  it('the scan recognises every shape it claims to', () => {
    const probe = [
      'd.toLocaleDateString(locale, { month: "short" })',
      'new Date(iso).toLocaleTimeString(locale.code, { hour: "numeric" })',
      'new Date(iso).toLocaleString(locale, { month: "short", hour: "numeric" })',
      'new Intl.DateTimeFormat(locale, { hour: "numeric" }).format(d)',
      "import { format, parseISO } from 'date-fns';",
      'const h = new Date().getHours();',
      'const today = new Date().toISOString().slice(0, 10);',
      'const hr = new Date(e.starts_at).getHours();',
      'const dow = now.getDay();',
      'start.setHours(0, 0, 0, 0);',
      'const today = useMemo(() => new Date(), []);',
      'const now = useMemo(() => new Date(), []); // instant:',
    ];
    for (const line of probe) {
      expect(deviceClockHits([{ path: 'probe.tsx', src: line }]), line).toHaveLength(1);
    }
    // Split across lines, as rides-module's todayKey() was.
    const alias = 'function todayKey() {\n  const d = new Date();\n  return `${d.getFullYear()}-${d.getMonth() + 1}`;\n}';
    expect(deviceClockHits([{ path: 'probe.tsx', src: alias }])).toHaveLength(1);
    expect(deviceClockHits([{ path: 'probe.tsx', src: alias.replace('new Date();', 'new Date(); // device-input: the form box default') }])).toEqual([]);
    // And what it must NOT flag: numbers, the device zone's name, a formatter
    // that was handed the family's zone, calendar arithmetic on wall dates.
    const clean = [
      'value.toLocaleString(locale)',
      'mins.toLocaleString(locale.code, { maximumFractionDigits: 0 })',
      'Intl.DateTimeFormat().resolvedOptions().timeZone',
      'const { fmtDate } = useFormat();',
      'const days = new Date(y, m + 1, 0).getDate();',
      "import { parseISO } from 'date-fns';",
      '// d.toLocaleDateString() in a comment',
      'const nowISO = useMemo(() => new Date().toISOString(), []);',
      'const now = useMemo(() => new Date(), []); // instant: compared with due_at only',
      "new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: clock.timeZone }).formatToParts(d)",
    ];
    for (const line of clean) {
      expect(deviceClockHits([{ path: 'probe.tsx', src: line }]), line).toEqual([]);
    }
  });

  it('no client file formats or buckets a clock outside the family\'s zone', () => {
    const offenders = deviceClockHits(clients.filter(({ path }) => !(path in EXEMPT)));
    expect(offenders, [
      'format through useFormat() / useHydrationSafeFormat(), and read "today" / the hour',
      'through useFamilyClock() — both carry the family\'s zone (components/i18n/use-format.ts).',
      'A file that genuinely needs the device clock goes in EXEMPT with its reason.',
    ].join(' ')).toEqual([]);
  });

  it('every exemption still exempts something (the list can only shrink)', () => {
    for (const path of Object.keys(EXEMPT)) {
      const file = clients.find((c) => c.path === path);
      expect(file, `${path} is exempt but is not a client file any more — remove it`).toBeTruthy();
      expect(deviceClockHits([file!]).length, `${path} no longer reads the device clock — remove its exemption`)
        .toBeGreaterThan(0);
    }
  });
});
