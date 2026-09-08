// scripts/crawl-authenticated-routes.mjs
//
// Renders every authenticated page against a running app and reports the ones
// that fail. Static analysis cannot see a render-time crash — a null deref in
// JSX, a throw in a helper, a read that errors only for a particular role — so
// this actually asks the server for each route and looks at what comes back.
//
// A page "fails" when the server answers 5xx, or when the HTML contains the
// authenticated error boundary ("This page hit a snag" / "Something went
// wrong"), which is how a thrown Server Component surfaces with a 200.
//
// Run scripts/crawl-login.mjs first to produce the cookie file:
//
//   BASE_URL=http://127.0.0.1:3000 COOKIE_FILE=cookies.json \
//   node scripts/crawl-authenticated-routes.mjs \
//     [--ids ids.json] [--json out.json] [--filter /dashboard] [--server-log server.log]
//
// Dynamic segments are filled from --ids, a JSON file keyed by ROUTE PATTERN
// ({ "/dashboard/vacations/[id]": "<uuid>" }), and skipped when no value is
// known — so the report never counts a 404 from a made-up UUID as a broken page.
//
// Reading the report: a 200 on a role-gated route is not a leak. `redirect()`
// thrown from a layout after the shell has been flushed cannot change the HTTP
// status, so Next sends the redirect in the RSC payload and the browser follows
// it. Check the rendered body (or drive it with a browser) before concluding a
// gate is open.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = join(ROOT, 'app');
const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3000';

// Route groups "(app)" and parallel/intercepted segments never appear in a URL.
const isGroup = (segment) => /^\(.*\)$/.test(segment);
const isDynamic = (segment) => /^\[.*\]$/.test(segment);

/** Every page route under app/, with its source path. */
export function listRoutes(dir = APP_DIR, segments = []) {
  const routes = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      routes.push(...listRoutes(path, isGroup(entry) ? segments : [...segments, entry]));
    } else if (/^page\.(tsx|ts|jsx|js)$/.test(entry)) {
      routes.push({
        url: `/${segments.join('/')}`.replace(/\/+/g, '/') || '/',
        segments,
        file: relative(ROOT, path),
      });
    }
  }
  return routes;
}

/**
 * The session cookie header, taken from a real sign-in.
 *
 * COOKIE_FILE is a Playwright cookie dump: the session is produced by driving
 * the actual login form, so the cookie name, chunking and encoding are whatever
 * @supabase/ssr really writes rather than this script's guess at them.
 */
function sessionCookie(file) {
  const jar = JSON.parse(readFileSync(file, 'utf8'));
  const header = jar.map((c) => `${c.name}=${c.value}`).join('; ');
  if (!jar.some((c) => c.name.includes('auth-token'))) {
    throw new Error(`no Supabase auth cookie in ${file} — the sign-in did not take`);
  }
  return header;
}

// The boundary copy has to be matched as RENDERED ELEMENT TEXT (`>copy<`), not
// as a substring. Every page embeds the whole i18n catalogue for the client
// provider, so the same strings appear as JSON values (`"key":"copy"`) in the
// HTML of pages that rendered perfectly — matching loosely marks all 365 routes
// as broken.
const ERROR_MARKERS = [
  'This page hit a snag',
  'Something went wrong',
  'Bubaly hit an unexpected error',
];

function classify(status, html) {
  if (status >= 500) return { ok: false, reason: `HTTP ${status}` };
  const marker = ERROR_MARKERS.find((text) => html.includes(`>${text}<`));
  if (marker) {
    const digest = /Reference:\s*(?:<code[^>]*>)?([0-9a-f]+)/i.exec(html)?.[1];
    return { ok: false, reason: `error boundary: "${marker}"${digest ? ` (digest ${digest})` : ''}` };
  }
  return { ok: true };
}

/**
 * Server-side failures the HTTP response does not show.
 *
 * A Server Component that throws AFTER the shell has been flushed still answers
 * 200 with no error boundary in the markup — the crash only exists in the
 * server log. `/dashboard/concierge/runs/[id]` failed exactly that way, so a
 * crawl that trusts the response alone reports it as healthy.
 */
function serverErrors(logFile, since) {
  const text = readFileSync(logFile, 'utf8').slice(since);
  const found = [];
  for (const line of text.split('\n')) {
    const nextError = /\[server-error\][^\n]*?route=(\S+)/.exec(line);
    if (nextError) { found.push({ route: nextError[1], line: line.trim().slice(0, 300) }); continue; }
    if (/unhandledRejection|^\s*⨯ /.test(line)) found.push({ route: null, line: line.trim().slice(0, 300) });
  }
  return found;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };
  const filter = flag('--filter');
  const jsonOut = flag('--json');
  const idsFile = flag('--ids');
  const ids = idsFile ? JSON.parse(readFileSync(idsFile, 'utf8')) : {};

  const cookie = sessionCookie(process.env.COOKIE_FILE ?? 'cookies.json');
  const serverLog = flag('--server-log');
  // Only errors logged from THIS crawl count; the file usually has history.
  const logOffset = serverLog ? readFileSync(serverLog, 'utf8').length : 0;

  const all = listRoutes();
  const skipped = [];
  const targets = [];
  for (const route of all) {
    if (filter && !route.url.startsWith(filter)) continue;
    if (route.segments.some(isDynamic)) {
      // Keyed by ROUTE PATTERN, not by segment name: `[id]` means a vacation on
      // one route and a marketplace item on another, so one value per segment
      // name would send most of them a foreign key and report a false 404.
      const value = ids[route.url];
      const filled = route.segments.map((segment) => (isDynamic(segment) ? value : segment));
      if (value === undefined) {
        skipped.push({ ...route, why: 'no seeded id for this route pattern' });
        continue;
      }
      targets.push({ ...route, url: `/${filled.join('/')}`, pattern: route.url });
      continue;
    }
    targets.push(route);
  }

  const results = [];
  let done = 0;
  const QUEUE = [...targets];
  const worker = async () => {
    for (;;) {
      const route = QUEUE.shift();
      if (!route) return;
      let entry;
      try {
        const res = await fetch(BASE_URL + route.url, {
          headers: { cookie, 'user-agent': 'bubaly-route-crawler' },
          redirect: 'manual',
        });
        const html = res.status >= 300 && res.status < 400 ? '' : await res.text();
        const verdict = classify(res.status, html);
        entry = {
          url: route.url,
          file: route.file,
          status: res.status,
          location: res.headers.get('location') ?? undefined,
          ...verdict,
        };
      } catch (error) {
        entry = { url: route.url, file: route.file, status: 0, ok: false, reason: `request failed: ${error.message}` };
      }
      results.push(entry);
      done += 1;
      if (done % 25 === 0) process.stderr.write(`  …${done}/${targets.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  results.sort((a, b) => a.url.localeCompare(b.url));
  const failures = results.filter((r) => !r.ok);
  const redirects = results.filter((r) => r.ok && r.status >= 300 && r.status < 400);

  console.log(`\ncrawled ${results.length} routes (${skipped.length} skipped for missing ids)`);
  console.log(`  ok:        ${results.filter((r) => r.ok && r.status === 200).length}`);
  console.log(`  redirects: ${redirects.length}`);
  console.log(`  FAILED:    ${failures.length}`);

  if (redirects.length) {
    console.log('\nredirects (gates, not errors):');
    for (const r of redirects) console.log(`  ${r.status} ${r.url} -> ${r.location ?? '?'}`);
  }
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`  ${f.url}\n      ${f.reason}\n      ${f.file}`);
  }
  const logged = serverLog ? serverErrors(serverLog, logOffset) : [];
  if (logged.length) {
    console.log(`\nSERVER-SIDE ERRORS LOGGED DURING THE CRAWL: ${logged.length}`);
    for (const entry of logged) console.log(`  ${entry.route ?? '(unattributed)'}\n      ${entry.line}`);
  }

  if (skipped.length) {
    console.log('\nskipped:');
    for (const s of skipped) console.log(`  ${s.url}  (${s.why})`);
  }
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ results, skipped }, null, 2));
    console.log(`\nwrote ${jsonOut}`);
  }
  process.exitCode = failures.length || logged.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
