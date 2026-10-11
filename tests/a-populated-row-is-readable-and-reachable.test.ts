import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getMessages } from '@/lib/i18n/messages';

// A11Y-001: found by an axe sweep of a seeded local household, after every
// signed-in sweep before it had used an empty one. These only render with
// rows: a checked grocery item, an inactive medication, a reminder, a bucket
// count, a note card, the meals sidebar's grocery list and its recently-cooked
// row. Each was a serious axe finding on the populated page.

const src = (file: string) => readFileSync(file, 'utf8');

describe('a done or inactive row is still readable', () => {
  it('a checked grocery item is struck through and muted, not faded to 3.3:1', () => {
    const shopping = src('components/modules/shopping-module.tsx');
    expect(shopping).not.toMatch(/item\.is_checked && 'opacity-\d+'/);
    expect(shopping).toContain("item.is_checked && 'line-through text-muted'");
  });

  it('an inactive medication says "Inactive" and is not faded to 4.2:1', () => {
    expect(src('components/modules/medications-module.tsx')).not.toMatch(/'bg-surface\/20 border-border\/50[^']*opacity-\d+/);
  });

  it('a count beside a heading or tab is not faded below contrast', () => {
    for (const [file, count] of [
      ['components/modules/next-actions-module.tsx', '· {items.length}'],
      ['components/modules/knowledge-base-module.tsx', '· {items.length}'],
      ['app/(app)/admin/marketplace/reports/page.tsx', '{filterCount[f.key]}'],
    ] as const) {
      const at = src(file).indexOf(count);
      expect(at, file).toBeGreaterThan(0);
      expect(src(file).slice(at - 60, at), file).not.toMatch(/opacity-\d+/);
    }
    const notes = src('components/modules/notes-module.tsx');
    expect(notes).toContain('<span className="ml-1 text-xs font-normal">');
  });

  it('the reminders AI tag is at full brand-text contrast', () => {
    expect(src('components/modules/reminders-module.tsx')).not.toContain('text-brand-text/70');
  });
});

describe('a row control has a name, a role and a 24px target', () => {
  it('each reminder’s snooze disclosure is named, in every full catalogue', () => {
    expect(src('components/modules/reminders-module.tsx')).toMatch(/<summary aria-label=\{tr\('reminders\.snoozeReminder'\)\}/);
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const) {
      const raw = JSON.parse(src(`lib/i18n/messages/${locale}.json`)) as Record<string, string>;
      expect(raw['reminders.snoozeReminder'], locale).toBeTruthy();
      if (locale !== 'en-US') expect(raw['reminders.snoozeReminder'], locale).not.toBe('Snooze reminder');
    }
    expect(getMessages('de-DE')['reminders.snoozeReminder']).toBe('Erinnerung zurückstellen');
  });

  it('a meals grocery toggle is a checkbox that says whether it is checked; the sidebar one is named by its item, with a 24px target', () => {
    const meals = src('components/modules/meals-module.tsx');
    const toggles = meals.split('onClick={() => toggleGrocery(item)}').slice(0, -1).map((before) => before.slice(before.lastIndexOf('<button')));
    expect(toggles).toHaveLength(2);
    for (const tag of toggles) {
      expect(tag).toContain('role="checkbox"');
      expect(tag).toContain('aria-checked={!!item.is_checked}');
    }
    // The sidebar's: a bare 16px box named "Toggle", six times over.
    expect(toggles[1]).toContain('aria-label={item.name}');
    expect(meals).not.toContain("tr('meals.toggle')");
    const sidebar = meals.indexOf('aria-label={item.name} onClick={() => toggleGrocery(item)}');
    expect(meals.slice(sidebar, sidebar + 200)).toContain('h-6 w-6');
  });

  it('the recently-cooked row scrolls from the keyboard: a named, focusable region', () => {
    expect(src('components/modules/meals-module.tsx')).toContain(
      `<div role="region" aria-label={tr('meals.recentlyCooked')} tabIndex={0} className="flex gap-3 overflow-x-auto`,
    );
  });
});
