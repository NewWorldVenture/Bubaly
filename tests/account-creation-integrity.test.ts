import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { autoFamilyName, autoOwnerName, DEFAULT_OWNER_DISPLAY_NAME } from '@/lib/onboarding/family';

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'supabase']);

function walk(dir: string, match: (path: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, match, out);
    else if (match(full)) out.push(full);
  }
  return out;
}

/**
 * The lines of a source file that are actually code.
 *
 * A guard that scans raw text cannot tell a defect from a description of one:
 * the comment explaining this very bug re-created it as far as the regex was
 * concerned, and so did the fixture below. Whole-line comments are dropped —
 * not a trailing `// note` after code, which is deliberate: the two real
 * defects were code, and a heuristic that tried to parse mid-line comments
 * would mangle the `https://` in an ordinary URL.
 */
export function codeLines(source: string): string[] {
  return source.split('\n').filter((line) => {
    const trimmed = line.trim();
    return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
  });
}

describe('a translation call inside a template literal is not a translation call', () => {
  // The onboarding wizard's invite email shipped this for months, as the body
  // of every invite a brand-new family sent:
  //
  //   html: [backtick]<p>{t('actions.youVeBeenInvitedTo')}</p>...
  //
  // In JSX those braces call the function. In a template literal they are
  // TEXT, so the recipient read the key name verbatim and the accept link was
  // labelled with another one. Nothing caught it: it typechecks, it sends, and
  // the i18n gate only asks whether a key EXISTS — never whether it is called.
  //
  // .ts only. In .tsx that form is correct JSX everywhere except inside a
  // template literal, and telling those apart needs a parser; both real
  // defects were in .ts, where the form is always wrong.
  const OFFENDER = /`[^`]*(?<!\$)\{t\(\s*['"][\w.]+['"]/;
  const FIXTURE_FILE = 'account-creation-integrity.test.ts';

  it('no .ts source builds a string with an uninterpolated translation call', () => {
    const offenders: string[] = [];
    for (const file of walk(process.cwd(), (p) => p.endsWith('.ts') && !p.endsWith('.d.ts'))) {
      if (file.endsWith(FIXTURE_FILE)) continue; // its fixtures are the shape, on purpose
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        if (codeLines(line).length === 0) continue;
        if (OFFENDER.test(line)) offenders.push(`${file.replace(process.cwd() + '/', '')}:${index + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the pattern actually recognises the shape it is policing', () => {
    // A guard that matches nothing would pass the assertion above forever.
    const broken = ['html: ', '`<p>{t(', "'actions.youVeBeenInvitedTo'", ')}</p>`'].join('');
    const fixed = broken.replace('{t(', '${t(');
    expect(OFFENDER.test(broken)).toBe(true);
    expect(OFFENDER.test(fixed)).toBe(false);
    expect(OFFENDER.test("const label = t('actions.acceptYourInvite');")).toBe(false);
  });

  it('ignores whole-line comments, which is why it can be trusted', () => {
    const broken = ['html: ', '`<p>{t(', "'a.b'", ')}</p>`'].join('');
    expect(codeLines(`  // ${broken}`)).toEqual([]);
    expect(codeLines(`   * ${broken}`)).toEqual([]);
    expect(codeLines(`  ${broken}`)).toHaveLength(1);
  });
});

describe('every onboarding server action is reachable from the app', () => {
  // In a 'use server' module each export is an HTTP endpoint with its own
  // action id, so an export with no caller is not dead code — it is an
  // unreferenced, untested, still-callable writer. Five of them survived here
  // after the wizard moved to one atomic finalize, quietly contradicting its
  // own guarantee that abandoning the wizard writes NOTHING.
  //
  // Scoped to the account-creation surface on purpose, and the scope is
  // measured rather than assumed: across the repo's 109 'use server' modules
  // and 426 exported actions, 15 were unreferenced — and a THIRD of them were
  // in this one file. The remaining ten sit in ten unrelated modules and each
  // needs its own judgement (some are staged for a UI that is still landing),
  // so widening this list is a separate change, not a bigger regex here.
  const ACTION_FILES = ['app/onboarding/actions.ts', 'app/onboarding/calendar-actions.ts', 'app/(auth)/actions.ts'];

  const callers = walk(process.cwd(), (p) => (p.endsWith('.ts') || p.endsWith('.tsx')));

  it.each(ACTION_FILES)('%s exports nothing the UI never calls', (relative) => {
    const source = readFileSync(join(process.cwd(), relative), 'utf8');
    expect(source.split('\n')[0]).toContain("'use server'");
    const exported = [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
    expect(exported.length).toBeGreaterThan(0);

    const orphans = exported.filter((name) => !callers.some((file) => {
      if (file.endsWith(relative)) return false;
      return new RegExp(`\\b${name}\\b`).test(readFileSync(file, 'utf8'));
    }));
    expect(orphans).toEqual([]);
  });
});

describe('a family space provisioned without the wizard gets a usable name', () => {
  // A phone signup collects a number and nothing else — no name field exists
  // anywhere in that flow — so profiles.full_name is '', user_metadata is
  // empty, and auth.users.email is null. The old fallback put the literal
  // string 'My' where the person's name goes and then made it possessive.
  it('names a nameless account "My Family", not "My\'s Family"', () => {
    const ownerName = autoOwnerName([null, undefined, '   ']);
    expect(ownerName).toBeNull();
    expect(autoFamilyName(ownerName)).toBe('My Family');
  });

  it('gives that account a member name instead of calling them "My"', () => {
    expect(DEFAULT_OWNER_DISPLAY_NAME).toBe('Parent');
    // The provisioning RPC (migration 0212) coalesces a blank display name to
    // the same literal, so the two provisioning paths agree on the answer.
    const rpc = readFileSync(join(process.cwd(), 'supabase/migrations/0212_atomic_family_provisioning.sql'), 'utf8');
    expect(rpc).toContain(`'${DEFAULT_OWNER_DISPLAY_NAME}'`);
  });

  it('still uses a real name when the account has one', () => {
    expect(autoFamilyName(autoOwnerName([null, 'Ada Lovelace']))).toBe("Ada Lovelace's Family");
    expect(autoFamilyName(autoOwnerName(['  Ada  ']))).toBe("Ada's Family");
  });

  it('does not double the possessive on a name already ending in s', () => {
    expect(autoFamilyName('Jonas')).toBe("Jonas' Family");
  });

  it('prefers the profile name over auth metadata over the email local-part', () => {
    expect(autoOwnerName(['Profile', 'Meta', 'local'])).toBe('Profile');
    expect(autoOwnerName([null, 'Meta', 'local'])).toBe('Meta');
    expect(autoOwnerName([null, '', 'local'])).toBe('local');
  });
});

describe('the wizard sends the same invite email as the rest of the product', () => {
  it('uses the branded template, not a hand-built HTML string', () => {
    const source = readFileSync(join(process.cwd(), 'app/onboarding/actions.ts'), 'utf8');
    expect(source).toContain('InviteEmail');
    // The settings path (app/api/email/invite) has always used this template;
    // the wizard building its own raw HTML is what let the defect exist. Read
    // from the CODE lines only — the comment above the fix quotes the old
    // string, and a guard that cannot tell those apart polices nothing.
    const code = codeLines(source).join('\n');
    expect(code).not.toMatch(/html:\s*`/);
    expect(code).not.toContain('sendEmail(');
  });

  it('the invite template is what app/api/email/invite sends too', () => {
    const route = readFileSync(join(process.cwd(), 'app/api/email/invite/route.ts'), 'utf8');
    expect(route).toContain('InviteEmail');
  });
});

describe('the account-creation tables a new signup writes still exist', () => {
  // handle_new_user (migration 0003) fires on every auth.users insert. If it
  // raises, Supabase answers the signup itself with "Database error saving new
  // user" and no account is created at all — so what it touches is load-bearing
  // for every avenue: email, phone and OAuth alike.
  const trigger = readFileSync(join(process.cwd(), 'supabase/migrations/0003_functions_triggers.sql'), 'utf8');
  const tables = readFileSync(join(process.cwd(), 'supabase/migrations/0002_tables.sql'), 'utf8');

  it('inserts only into columns that are nullable or defaulted', () => {
    expect(trigger).toContain('insert into public.profiles (id, email, full_name)');
    // A phone signup has no email. `profiles.email` must stay nullable or the
    // trigger raises and the whole signup fails.
    expect(tables).toMatch(/create table if not exists public\.profiles \([\s\S]*?\n\s*email\s+text,\n/);
  });

  it('is idempotent, so a replayed insert cannot fail the signup', () => {
    expect(trigger).toContain('on conflict (id) do nothing');
    expect(trigger).toContain('on conflict (user_id) do nothing');
  });
});
