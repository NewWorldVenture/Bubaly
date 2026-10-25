// PR #1087's E2E sweep: /admin/notifications failed to render with
// "NOTIFICATION_KIND_ORDER.map is not a function" (and React #441 in the
// browser). The server page imported a plain array from a 'use client' module.
// In a Next build a server component that imports from a 'use client' module
// gets a client reference for each export, which renders as a component and is
// nothing else: not an array to map, not a function to call. Unit tests import
// the module directly and see the real value, so only a build ever showed it.
// This holds every server entry point (pages, layouts, routes, 'use server'
// actions and 'server-only' modules) to taking only components from one.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const CLIENT = /^\s*(?:\/\/[^\n]*\n\s*)*['"]use client['"]/;
const SERVER_DIRECTIVE = /^\s*(?:\/\/[^\n]*\n\s*)*['"]use server['"]/;
const ENTRY = /(?:^|\/)(?:page|layout|template|default|not-found|loading|route)\.(?:ts|tsx)$/;

function isClient(file: string): boolean {
  return CLIENT.test(readFileSync(file, 'utf8'));
}

function isServerEntry(file: string): boolean {
  const src = readFileSync(file, 'utf8');
  if (CLIENT.test(src)) return false;
  return ENTRY.test(file.split('\\').join('/'))
    || SERVER_DIRECTIVE.test(src)
    || /^\s*import\s+['"]server-only['"]/m.test(src);
}

function resolve(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = normalize(join(dirname(from), spec));
  else return null;
  for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
    if (existsSync(base + ext)) return base + ext;
  }
  return null;
}

// A component is a PascalCase name (AIEngineForm and FAQAccordion included);
// SCREAMING_CASE constants and camelCase functions are not.
const isComponentName = (name: string) => /^[A-Z]/.test(name) && /[a-z]/.test(name);

/** The values a server source takes by name from 'use client' modules. */
function clientValuesTaken(src: string, from: string, clientModule: (file: string) => boolean): string[] {
  const taken: string[] = [];
  for (const m of src.matchAll(/import\s+(type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) continue;
    const target = resolve(m[3], from);
    if (!target || !clientModule(target)) continue;
    for (const raw of m[2].split(',')) {
      const name = raw.trim();
      if (!name || name.startsWith('type ')) continue;
      const imported = name.split(/\s+as\s+/)[0].trim();
      if (!isComponentName(imported)) taken.push(`${target} :: ${imported}`);
    }
  }
  return taken;
}

describe('a server entry point takes only components from a client module', () => {
  const entries = [...walk('app'), ...walk('components'), ...walk('lib')].filter(isServerEntry);

  it('finds the server entry points (a scan that finds none proves nothing)', () => {
    expect(entries.length).toBeGreaterThan(300);
  });

  it('catches a plain value taken from a client module, as /admin/notifications once did', () => {
    const src = "import { AdminNotificationsList, NOTIFICATION_KIND_ORDER } from '@/components/admin/admin-notifications-list';";
    const taken = clientValuesTaken(src, 'app/(app)/admin/notifications/page.tsx', () => true);
    expect(taken).toEqual(['components/admin/admin-notifications-list.tsx :: NOTIFICATION_KIND_ORDER']);
    expect(clientValuesTaken("import type { Row } from '@/components/admin/admin-notifications-list';", 'app/x/page.tsx', () => true)).toEqual([]);
  });

  it('no server entry point imports a non-component value from a \'use client\' module', () => {
    const offenders = entries.flatMap((f) => clientValuesTaken(readFileSync(f, 'utf8'), f, isClient).map((t) => `${f} <- ${t}`));
    expect(offenders).toEqual([]);
  });
});
