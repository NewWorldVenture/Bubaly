import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DB_ERROR_ENGLISH } from '@/lib/supabase/errors';
import { getMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault } from '@/lib/i18n/locales';

// I18N-011, the toast's half. A server action that is refused answers with
// describeDbError's sentence, written on the server and so in English, and
// about 240 call sites hand that `res.error` straight to `toastError`. The
// toast is mounted under the root LocaleProvider, so it holds the reader's
// language; it puts each of the five sentences into it.
//
// The component is invoked as a plain function, the way
// tests/a-toast-you-can-still-reach-waits.test.ts drives it: useState and
// useRef hold slots, the context is the reader's, and effects run only where a
// test says the component has committed.

const mocks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, context: null as unknown, runEffects: false }));

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.slots)) mocks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [mocks.slots[index], (value: unknown) => {
      mocks.slots[index] = typeof value === 'function' ? value(mocks.slots[index]) : value;
    }];
  },
  useRef: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.slots)) mocks.slots[index] = { current: initial };
    return mocks.slots[index];
  },
  useCallback: (fn: unknown) => fn,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => void) => { if (mocks.runEffects) effect(); },
  useContext: () => mocks.context,
}));

const { ToastProvider } = await import('@/components/ui/toast');
const { LocaleProvider } = await import('@/components/i18n/locale-provider');
const { describeDbError, rememberDbErrorText } = await import('@/lib/supabase/errors');

type Props = Record<string, unknown> & { children?: ReactNode };
const propsOf = (el: ReactElement): Props => el.props as Props;

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((c) => textOf(c as ReactNode)).join('');
  if (isValidElement(node)) return textOf(propsOf(node).children ?? null);
  return '';
}

function toastsOf(node: ReactNode, out: string[] = []): string[] {
  if (Array.isArray(node)) { for (const c of node) toastsOf(c as ReactNode, out); return out; }
  if (!isValidElement(node)) return out;
  const role = propsOf(node).role;
  if (role === 'status' || role === 'alert') out.push(textOf(node));
  else toastsOf(propsOf(node).children ?? null, out);
  return out;
}

function readerOf(locale: string) {
  const messages = getMessages(localeOrDefault(locale).code);
  return { locale: localeOrDefault(locale), source: 'default' as const, t: (key: string) => translate(messages, key) };
}

/** Push one error toast as a reader of `locale`, and read what the stack shows. */
function shown(locale: string, message: string): string[] {
  mocks.slots.length = 0;
  mocks.context = readerOf(locale);
  const render = () => { mocks.cursor = 0; return (ToastProvider as unknown as (p: { children: ReactNode }) => ReactElement)({ children: null }); };
  (propsOf(render()).value as { error: (m: string) => void }).error(message);
  return toastsOf(render());
}

describe('a refused server action’s toast', () => {
  const english = DB_ERROR_ENGLISH['dbError.permission'];
  const german = getMessages('de-DE')['dbError.permission'];

  it('reads in German for a German reader', () => {
    const toasts = shown('de-DE', english);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain(german);
    expect(toasts[0]).not.toContain(english);
  });

  it('reads in English for an English reader, and any other message is left as written', () => {
    expect(shown('en-US', english)[0]).toContain(english);
    expect(shown('de-DE', 'Rezept gespeichert.')[0]).toContain('Rezept gespeichert.');
  });
});

// The browser's half: LocaleProvider tells describeDbError the reader's
// sentences, and does it AFTER it commits. A server-rendered error is English
// (the server serves every reader at once and remembers none), so the client's
// hydrating render has to say the same English or React throws the page away.
describe('LocaleProvider gives describeDbError the reader’s sentences once it has committed', () => {
  const refused = { code: '42501', message: 'new row violates row-level security policy' };
  const german = getMessages('de-DE')['dbError.permission'];
  const provide = () => (LocaleProvider as unknown as (p: Record<string, unknown>) => ReactElement)({
    locale: localeOrDefault('de-DE'), source: 'default', messages: getMessages('de-DE'), children: null,
  });

  afterEach(() => {
    mocks.runEffects = false;
    rememberDbErrorText(getMessages('en-US'));
    delete (globalThis as { window?: unknown }).window;
  });

  it('not while it renders: the hydrating render still says what the server said', () => {
    (globalThis as { window?: unknown }).window = globalThis;
    mocks.context = null;
    provide();
    expect(describeDbError(refused)).toBe(DB_ERROR_ENGLISH['dbError.permission']);
  });

  it('after it commits, in the browser: German', () => {
    (globalThis as { window?: unknown }).window = globalThis;
    mocks.context = null;
    mocks.runEffects = true;
    provide();
    expect(describeDbError(refused)).toBe(german);
  });

  it('never on the server, where it would be whichever request rendered last', () => {
    mocks.context = null;
    mocks.runEffects = true;
    provide();
    expect(describeDbError(refused)).toBe(DB_ERROR_ENGLISH['dbError.permission']);
  });
});
