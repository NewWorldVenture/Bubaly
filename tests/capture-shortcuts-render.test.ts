import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, getRawMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';

const harness = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0,
  load: vi.fn(), save: vi.fn(), toast: vi.fn(), setItem: vi.fn(),
}));
vi.mock('@/app/(app)/capture/shortcuts-actions', () => ({
  loadCaptureShortcuts: harness.load, saveCaptureShortcutsAction: harness.save,
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ error: harness.toast }) }));
vi.mock('next/link', () => ({ default: 'a' }));
// Keep actual shortcut markup and callbacks. Portal focus management is a
// separate browser concern; the picker title and children still render here.
vi.mock('@/components/ui/modal', () => ({
  Modal: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) => open
    ? createElement('section', { role: 'dialog', 'aria-label': title }, createElement('h2', null, title), children)
    : null,
}));
// Persist only the component's hook state between server renders, so invoking
// its real event handlers can be followed by real markup in a LocaleProvider.
// No DOM package is installed; this intentionally does not emulate a browser.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [harness.slots[index], (next: unknown) => {
      harness.slots[index] = typeof next === 'function' ? next(harness.slots[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { current: initial };
    return harness.slots[index];
  },
  useEffect: () => {},
}));

const { CaptureShortcuts, SHORTCUT_CATALOG } = await import('@/components/capture/capture-shortcuts');
type Props = Parameters<typeof CaptureShortcuts>[0];
type ElementProps = { children?: ReactNode; href?: string; title?: string; 'aria-label'?: string; onClick?: () => void };
const locales: LocaleCode[] = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const byKey = new Map(SHORTCUT_CATALOG.map((shortcut) => [shortcut.key, shortcut]));
// Public destinations and saved IDs are independent of display translations.
const destinations = {
  calendar: '/dashboard/calendar', tasks: '/dashboard/chores', grocery: '/dashboard/grocery',
  home: '/dashboard/home', health: '/dashboard/health', trip: '/dashboard/trips', notes: '/dashboard/notes',
  meals: '/dashboard/meals', reminders: '/dashboard/reminders', documents: '/dashboard/documents',
  wallet: '/wallet', pets: '/dashboard/pets', closet: '/dashboard/closet', watchlist: '/dashboard/watchlist',
  inventory: '/dashboard/inventory', sleep: '/dashboard/sleep', declutter: '/dashboard/declutter',
  moving: '/dashboard/moving', projects: '/dashboard/projects', career: '/dashboard/career',
  language: '/dashboard/language', goals: '/dashboard/goals', finances: '/dashboard/billing',
  contacts: '/dashboard/contacts', photos: '/dashboard/photos', school: '/dashboard/school',
  wishlists: '/dashboard/wishlists', messages: '/dashboard/messages', memories: '/dashboard/memories',
  budgets: '/dashboard/budgets', bills: '/dashboard/bills', subscriptions: '/dashboard/subscriptions',
  locator: '/dashboard/locator', journal: '/dashboard/journal', habits: '/dashboard/habits',
  weather: '/dashboard/weather', celebrations: '/dashboard/celebrations', announcements: '/dashboard/announcements',
  recipes: '/dashboard/recipes', todos: '/dashboard/todos',
};

function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<ElementProps>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function button(tree: ReactNode, text: string) {
  const result = elements(tree).find((node) => node.type === 'button' && textOf(node).trim() === text.trim());
  expect(result, `button ${JSON.stringify(text)} exists`).toBeDefined();
  return result!;
}
function escaped(text: string): string {
  return renderToStaticMarkup(createElement('span', null, text)).replace(/^<span>|<\/span>$/g, '');
}
function t(locale: LocaleCode, key: string, params?: Record<string, string | number>) {
  return translate(getMessages(locale), key, params);
}
function render(locale: LocaleCode, props: Props) {
  let tree: ReactNode;
  function Subject() {
    harness.cursor = 0;
    tree = CaptureShortcuts(props);
    return tree;
  }
  const html = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: localeOrDefault(locale), source: 'cookie', messages: getMessages(locale),
  } as Parameters<typeof LocaleProvider>[0], createElement(Subject)));
  return { html, tree: tree! };
}
function fresh() { harness.slots = []; harness.cursor = 0; }

beforeEach(() => {
  fresh();
  harness.load.mockReset().mockResolvedValue(null);
  harness.save.mockReset().mockResolvedValue({ ok: true });
  harness.toast.mockReset();
  harness.setItem.mockReset();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: harness.setItem });
});
afterEach(() => vi.unstubAllGlobals());

describe.each(locales)('Capture shortcuts in %s', (locale) => {
  it('renders every destination with its localized label and hint and unchanged href', () => {
    const keys = Object.keys(destinations);
    expect(SHORTCUT_CATALOG.map((s) => s.key)).toEqual(keys);
    for (let start = 0; start < keys.length; start += 10) {
      fresh();
      const selected = keys.slice(start, start + 10);
      const { html } = render(locale, { initialKeys: selected });
      const links = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) ?? [];
      expect(links).toHaveLength(selected.length);
      selected.forEach((key, index) => {
        const shortcut = byKey.get(key)!;
        for (const messageKey of [shortcut.labelKey, shortcut.hintKey]) {
          expect(getRawMessages(locale)[messageKey], `${locale} owns ${messageKey}`).toBeTruthy();
          expect(links[index]).toContain(escaped(t(locale, messageKey)));
        }
        expect(links[index]).toContain(`href="${destinations[key as keyof typeof destinations]}"`);
      });
      expect(html).toContain(escaped(t(locale, 'captureShortcuts.heading')));
      expect(html).toContain(escaped(t(locale, 'captureShortcuts.customize')));
      expect(html).not.toContain('captureShortcuts.');
    }
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.load).not.toHaveBeenCalled();
  });

  it('localizes remove labels, edit hints and counts for every selected destination', () => {
    for (let start = 0; start < SHORTCUT_CATALOG.length; start += 10) {
      fresh();
      const selected = SHORTCUT_CATALOG.slice(start, start + 10);
      const { html } = render(locale, { initialKeys: selected.map((s) => s.key), editing: true });
      for (const shortcut of selected) {
        const remove = t(locale, 'captureShortcuts.removeNamed', { name: t(locale, shortcut.labelKey) });
        expect(html).toContain(`aria-label="${escaped(remove)}"`);
      }
      expect(html).toContain(escaped(t(locale, 'captureShortcuts.tapToChange')));
      expect(html).toContain(escaped(t(locale, 'captureShortcuts.done')));
      expect(html).toContain(escaped(t(locale, 'captureShortcuts.countOfLimit', { count: selected.length.toLocaleString(locale), max: (10).toLocaleString(locale) })));
      expect(html).not.toContain('{name}');
    }
  });

  it('opens an empty layout picker, translates its entire catalog, and saves the selected stable ID', async () => {
    const props = { initialKeys: [] };
    let view = render(locale, props);
    const empty = t(locale, 'captureShortcuts.emptyWithLimit', { max: (10).toLocaleString(locale) });
    button(view.tree, empty).props.onClick!();
    view = render(locale, props);
    expect(view.html).not.toContain(escaped(empty));
    const count = t(locale, 'captureShortcuts.countOfLimit', { count: '0', max: '10' });
    button(view.tree, t(locale, 'captureShortcuts.addShortcut') + count).props.onClick!();
    view = render(locale, props);
    expect(view.html).toContain(`aria-label="${escaped(t(locale, 'captureShortcuts.addPickerTitle'))}"`);
    for (const shortcut of SHORTCUT_CATALOG) button(view.tree, t(locale, shortcut.labelKey));
    button(view.tree, t(locale, 'calendar.calendar')).props.onClick!();
    await Promise.resolve();
    view = render(locale, props);
    expect(view.html).not.toContain('role="dialog"');
    expect(harness.save).toHaveBeenLastCalledWith({ keys: ['calendar'] });
    expect(harness.setItem).toHaveBeenLastCalledWith('bubaly.capture.shortcuts', '["calendar"]');
    expect(view.html).toContain(escaped(t(locale, 'captureShortcuts.countOfLimit', { count: '1', max: '10' })));
  });

  it('reports a failed save in the active language while retaining the optimistic edit', async () => {
    harness.save.mockResolvedValue({ ok: false, error: 'internal database failure' });
    const props = { initialKeys: ['calendar'], editing: true };
    const view = render(locale, props);
    const remove = t(locale, 'captureShortcuts.removeNamed', { name: t(locale, 'calendar.calendar') });
    elements(view.tree).find((node) => node.props['aria-label'] === remove)!.props.onClick!();
    await Promise.resolve();
    expect(harness.toast).toHaveBeenCalledExactlyOnceWith(t(locale, 'captureShortcuts.saveFailed'));
    expect(harness.toast).not.toHaveBeenCalledWith('internal database failure');
    expect(harness.save).toHaveBeenCalledWith({ keys: [] });
    expect(render(locale, props).html).not.toContain(`aria-label="${escaped(remove)}"`);
  });
});

describe('shortcut editing and navigation contracts', () => {
  it('reports a rejected save in German without exposing the transport error or changing saved IDs', async () => {
    harness.save.mockRejectedValueOnce(new Error('private transport host: database.internal'));
    const locale = 'de-DE';
    const props = { initialKeys: ['calendar', 'tasks'], editing: true };
    const view = render(locale, props);
    const remove = t(locale, 'captureShortcuts.removeNamed', { name: t(locale, 'calendar.calendar') });
    elements(view.tree).find((node) => node.props['aria-label'] === remove)!.props.onClick!();

    await vi.waitFor(() => expect(harness.toast).toHaveBeenCalledExactlyOnceWith(t(locale, 'captureShortcuts.saveFailed')));
    expect(harness.toast.mock.calls.flat().join(' ')).not.toContain('database.internal');
    expect(harness.save).toHaveBeenCalledExactlyOnceWith({ keys: ['tasks'] });
    expect(harness.setItem).toHaveBeenLastCalledWith('bubaly.capture.shortcuts', '["tasks"]');
    const updated = render(locale, props);
    expect(updated.html).not.toContain(`aria-label="${escaped(remove)}"`);
    expect(updated.html).toContain(escaped(t(locale, 'dashboardPlanning.tasks')));
  });

  it('replaces and removes without changing other IDs, then navigates only outside edit mode', async () => {
    const locale = 'de-DE';
    const onNavigate = vi.fn();
    const props = { initialKeys: ['calendar', 'tasks'], onNavigate };
    let view = render(locale, props);
    elements(view.tree).find((node) => node.props.href === '/dashboard/calendar')!.props.onClick!();
    expect(onNavigate).toHaveBeenCalledOnce();
    button(view.tree, t(locale, 'captureShortcuts.customize')).props.onClick!();
    view = render(locale, props);
    expect(elements(view.tree).filter((node) => node.props.href)).toHaveLength(0);
    button(view.tree, t(locale, 'calendar.calendar') + t(locale, 'captureShortcuts.tapToChange')).props.onClick!();
    view = render(locale, props);
    expect(view.html).toContain(escaped(t(locale, 'captureShortcuts.changeShortcut')));
    button(view.tree, t(locale, 'calendar.calendar')); // current choice remains selectable
    expect(elements(view.tree).filter((node) => node.type === 'button' && textOf(node) === t(locale, 'dashboardPlanning.tasks'))).toHaveLength(0);
    button(view.tree, t(locale, 'dashboardPlanning.notes')).props.onClick!();
    await Promise.resolve();
    expect(harness.save).toHaveBeenLastCalledWith({ keys: ['notes', 'tasks'] });
    view = render(locale, props);
    const remove = t(locale, 'captureShortcuts.removeNamed', { name: t(locale, 'dashboardPlanning.tasks') });
    elements(view.tree).find((node) => node.props['aria-label'] === remove)!.props.onClick!();
    await Promise.resolve();
    expect(harness.save).toHaveBeenLastCalledWith({ keys: ['notes'] });
    expect(onNavigate).toHaveBeenCalledOnce();
    view = render(locale, props);
    const done = elements(view.tree).find((node) => node.type === 'button' && textOf(node).endsWith(t(locale, 'captureShortcuts.done')))!;
    done.props.onClick!();
    view = render(locale, props);
    elements(view.tree).find((node) => node.props.href === '/dashboard/notes')!.props.onClick!();
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it('enforces the ten-shortcut limit and offers one add control after removal', () => {
    const initialKeys = Object.keys(destinations).slice(0, 10);
    const props = { initialKeys: [...initialKeys, 'wallet'], editing: true };
    let view = render('en-US', props);
    expect(view.html).not.toContain('Add shortcut');
    expect(elements(view.tree).filter((node) => node.props['aria-label']?.startsWith('Remove '))).toHaveLength(10);
    elements(view.tree).find((node) => node.props['aria-label'] === 'Remove Calendar')!.props.onClick!();
    view = render('en-US', props);
    expect(elements(view.tree).filter((node) => node.type === 'button' && textOf(node).startsWith('Add shortcut'))).toHaveLength(1);
    expect(harness.save).toHaveBeenLastCalledWith({ keys: initialKeys.slice(1) });
  });

  it('preserves caller headings, intentionally hidden headers and controlled edit mode', () => {
    const onEditingChange = vi.fn();
    let view = render('fr-FR', { initialKeys: [], heading: 'My personal destinations', editing: false, onEditingChange });
    expect(view.html).toContain('My personal destinations');
    expect(view.html).not.toContain(escaped(t('fr-FR', 'captureShortcuts.heading')));
    button(view.tree, t('fr-FR', 'captureShortcuts.customize')).props.onClick!();
    expect(onEditingChange).toHaveBeenCalledExactlyOnceWith(true);
    view = render('fr-FR', { initialKeys: [], heading: '', editing: true, showCustomizeButton: false });
    expect(view.html).not.toContain(escaped(t('fr-FR', 'captureShortcuts.customize')));
    expect(view.html).not.toContain(escaped(t('fr-FR', 'captureShortcuts.heading')));
    expect(view.html).toContain(escaped(t('fr-FR', 'captureShortcuts.addShortcut')));
  });
});
