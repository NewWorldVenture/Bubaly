// Drive a real client module — its handlers, its effects, its own reads and
// writes — without a DOM.
//
// A test using this:
//
//   const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
//   vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original(), h.hooks));
//   vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
//   vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
//   … app-context, toast, confirm, locale-provider and the UI stubs the same way.
//
// What is real: the component, every lib helper it calls, `useFamilyClock` and
// `useFormat` (fed the family zone through the locale-provider mock), and the
// database — an InMemorySupabase that applies the filters each write names.
//
// What is modelled: `useRealtimeQuery`. Its list is the SCREEN (`h.rows`), and
// it changes only when the component calls `refresh`, `refreshAndConfirm` or
// `setData` — never because a row changed in the database. That is exactly the
// real hook's behaviour for a table the realtime publication does not carry,
// and for a DELETE on a published table without REPLICA IDENTITY FULL, which is
// every case these tests are about. `refresh` re-reads with the component's OWN
// fetcher, against the in-memory database.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { pluralize, translate } from '@/lib/i18n/translate';
import type { HookSlots } from './hook-slots';
import type { InMemorySupabase } from './in-memory-supabase';
import type { HarnessRow, ModuleState } from './module-state';

// ── tree ─────────────────────────────────────────────────────────────────────

type Props = Record<string, unknown>;
export type Node = ReactElement<Props>;

/**
 * Call every function component in the tree, depth first, each with its own
 * slots keyed by where it sits, so conditional siblings do not shift its state.
 */
export function expand(node: ReactNode, s: HookSlots, path = 'root'): ReactNode {
  if (Array.isArray(node)) {
    return node.map((child, index) =>
      expand(child, s, `${path}[${isValidElement(child) && child.key != null ? `k:${child.key}` : index}]`));
  }
  if (!isValidElement<Props>(node)) return node;
  const type = node.type;
  if (typeof type === 'function') {
    const id = `${path}>${(type as { name?: string }).name || 'anonymous'}`;
    const saved = { slots: s.slots, cursor: s.cursor };
    s.slots = s.byPath.get(id) ?? [];
    s.cursor = 0;
    let out: ReactNode;
    try {
      out = (type as (props: Props) => ReactNode)(node.props);
    } finally {
      s.byPath.set(id, s.slots);
      s.slots = saved.slots;
      s.cursor = saved.cursor;
    }
    return expand(out, s, id);
  }
  const children = node.props.children as ReactNode;
  const props = { ...node.props, key: node.key };
  return children === undefined
    ? createElement(type as string, props)
    : createElement(type as string, props, expand(children, s, `${path}>${typeof type === 'string' ? type : 'el'}`));
}

/** Render until the effects settle, as a mount (or an update) would. */
export function render(s: HookSlots, element: ReactElement): ReactNode {
  for (let pass = 0; pass < 40; pass++) {
    s.pending = [];
    const tree = expand(element, s);
    const effects = s.pending;
    s.pending = [];
    if (!effects.length) return tree;
    for (const run of effects) run();
  }
  throw new Error('[module-harness] effects did not settle after 40 renders');
}

export function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Props>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
}

export function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}

/** A clickable element by its accessible name: aria-label, or its own text. */
export function byName(tree: ReactNode, name: string | RegExp, type?: string): Node {
  const found = allByName(tree, name, type);
  if (!found.length) throw new Error(`[module-harness] nothing named ${String(name)}`);
  return found[0];
}

export function allByName(tree: ReactNode, name: string | RegExp, type?: string): Node[] {
  const matches = (value: string) => (typeof name === 'string' ? value.trim() === name : name.test(value.trim()));
  return nodes(tree).filter((node) => {
    if (type && node.type !== type) return false;
    if (typeof node.type !== 'string') return false;
    const label = typeof node.props['aria-label'] === 'string' ? node.props['aria-label'] as string : null;
    return (label !== null && matches(label)) || (label === null && (node.type === 'button' || node.type === 'a') && matches(text(node)));
  });
}

export const has = (tree: ReactNode, value: string) => text(tree).includes(value);

/** Await what a click starts (and anything it left running). */
export async function click(node: Node): Promise<void> {
  const handler = node.props.onClick as ((event: unknown) => unknown) | undefined;
  if (!handler) throw new Error('[module-harness] that element has no onClick');
  await handler({ preventDefault() {}, stopPropagation() {} });
  await settle();
}

/** Let promises a handler did not await run to completion. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The open form (the last one in the tree, which is the topmost modal). */
export function form(tree: ReactNode): Node {
  const forms = nodes(tree).filter((node) => node.type === 'form');
  if (!forms.length) throw new Error('[module-harness] no form is open');
  return forms[forms.length - 1];
}

/**
 * Submit a form the way the browser would: `new FormData(form)` reads each
 * named field's current (or default) value.
 */
export async function submit(formNode: Node, overrides: Record<string, string> = {}): Promise<void> {
  const values = new Map<string, string>();
  for (const field of nodes(formNode.props.children as ReactNode)) {
    const name = field.props.name;
    if (typeof name !== 'string') continue;
    const value = field.props.value ?? field.props.defaultValue ?? '';
    values.set(name, String(value));
  }
  for (const [key, value] of Object.entries(overrides)) values.set(key, value);
  const fake = { get: (key: string) => (values.has(key) ? values.get(key)! : null) };
  const RealFormData = globalThis.FormData;
  // The handlers build `new FormData(e.currentTarget)`; hand them the values.
  globalThis.FormData = function FormData() { return fake; } as unknown as typeof globalThis.FormData;
  try {
    await (formNode.props.onSubmit as (event: unknown) => unknown)({ preventDefault() {}, currentTarget: {} });
  } finally {
    globalThis.FormData = RealFormData;
  }
  await settle();
}

/** Type into a controlled input or pick a select option. */
export function change(field: Node, value: unknown): void {
  const handler = field.props.onChange as ((event: unknown) => void) | undefined;
  if (!handler) throw new Error('[module-harness] that field has no onChange');
  handler({ target: { value, files: Array.isArray(value) ? value : undefined } });
}

// ── module mocks ─────────────────────────────────────────────────────────────

const clone = (rows: HarnessRow[]) => rows.map((row) => ({ ...row }));
const db = (h: ModuleState) => h.db as InMemorySupabase;

/** The family's rows of `table`, as a fresh read would return them. */
export function screenRows(h: ModuleState, table: string): HarnessRow[] {
  return clone(db(h).table(table).filter((row) => row.family_id === undefined || row.family_id === h.app.familyId));
}

/**
 * What a realtime INSERT or UPDATE on a published table does: the hook
 * re-reads. Tests call this where the real channel WOULD deliver an event, so
 * the screen is never helped past an event that does not exist.
 */
export function deliver(h: ModuleState, ...tables: string[]): void {
  for (const table of tables) h.rows[table] = screenRows(h, table);
}

type Fetcher = (client: unknown) => PromiseLike<{ data: HarnessRow[] | null; error: { message: string } | null }>;

export function realtimeQueryModule(h: ModuleState) {
  return {
    useRealtimeQuery: ({ table, fetcher }: { table: string; fetcher: Fetcher }) => {
      if (!(table in h.rows)) h.rows[table] = screenRows(h, table);
      const reread = async () => {
        h.refreshes.push(table);
        const { data, error } = await fetcher(clientFor(h));
        if (error) { h.readErrors[table] = error.message; return false; }
        delete h.readErrors[table];
        h.rows[table] = clone(data ?? []);
        return true;
      };
      return {
        data: h.rows[table],
        loading: false,
        error: h.readErrors[table] ?? null,
        stale: false,
        updatedAt: 0,
        refresh: async () => { await reread(); },
        refreshAndConfirm: async () => ((await reread()) ? { ok: true as const } : { ok: false as const, reason: 'error' as const }),
        setData: (update: HarnessRow[] | ((rows: HarnessRow[]) => HarnessRow[])) => {
          h.rows[table] = typeof update === 'function' ? update(h.rows[table] ?? []) : update;
        },
      };
    },
  };
}

/**
 * `useRealtimeQuery` for a test about WHAT a read returns — a capped, paged or
 * filtered read. `realtimeQueryModule` seeds the screen with the whole table,
 * which is right for writes and wrong here: a query the server cuts at 1,000
 * rows, or one that pages, would look complete. This one shows exactly what
 * the component's own fetcher answered for its current `deps`, as the real hook
 * does on mount and on every change of its key: the first render of a key
 * starts the read and reports `loading`, and a later render shows the result
 * (`settle()` between them). `refresh` re-reads the same key, and so does
 * `h.realtime[table]()`, which is the hook re-reading on its own.
 *
 * Like the real hook, only the LATEST request for a key lands: a read that a
 * later read, or a `setData`, started after is dropped when it answers
 * (lib/hooks/use-realtime-query.ts, `scope.request` and isCurrent()).
 */
export function fetchedQueryModule(h: ModuleState) {
  const inFlight = new Map<string, Promise<'ok' | 'error' | 'superseded'>>();
  const requests = new Map<string, number>();
  const begin = (key: string) => { const request = (requests.get(key) ?? 0) + 1; requests.set(key, request); return request; };
  // The real hook's `data` is state: the same array until a read replaces it.
  // A fresh `[]` per render would re-run every effect keyed on it, forever.
  const empty: HarnessRow[] = [];
  return {
    useRealtimeQuery: ({ table, fetcher, deps = [] }: { table: string; fetcher: Fetcher; deps?: unknown[] }) => {
      const key = `${table}:${JSON.stringify(deps)}`;
      const reread = () => {
        h.refreshes.push(table);
        const request = begin(key);
        const running = (async () => {
          let reply: Awaited<ReturnType<Fetcher>>;
          try {
            reply = await fetcher(clientFor(h));
          } catch (cause) {
            reply = { data: null, error: { message: cause instanceof Error ? cause.message : String(cause) } };
          }
          if (requests.get(key) !== request) return 'superseded' as const;
          if (reply.error) { h.readErrors[key] = reply.error.message; delete h.rows[key]; return 'error' as const; }
          delete h.readErrors[key];
          h.rows[key] = clone(reply.data ?? []);
          return 'ok' as const;
        })();
        // The newest read of a key is the one a first render waits on.
        inFlight.set(key, running);
        void running.finally(() => { if (inFlight.get(key) === running) inFlight.delete(key); });
        return running;
      };
      const known = key in h.rows || key in h.readErrors;
      if (!known && !inFlight.has(key)) void reread();
      h.realtime[table] = reread;
      return {
        data: h.rows[key] ?? empty,
        loading: !known,
        error: h.readErrors[key] ?? null,
        stale: false,
        updatedAt: 0,
        refresh: async () => { await reread(); },
        refreshAndConfirm: async () => {
          const outcome = await reread();
          return outcome === 'ok' ? { ok: true as const } : { ok: false as const, reason: outcome };
        },
        setData: (update: HarnessRow[] | ((rows: HarnessRow[]) => HarnessRow[])) => {
          begin(key);
          h.rows[key] = typeof update === 'function' ? update(h.rows[key] ?? []) : update;
        },
      };
    },
  };
}

/** A builder that records its calls and lets `h.fault` answer for the database. */
function recorded(h: ModuleState, table: string, target: object): object {
  const calls: string[] = [];
  h.calls.push({ table, calls });
  const proxy: object = new Proxy(target, {
    get(object, property) {
      if (property === 'then') {
        return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
          const fault = h.fault?.(table, calls) ?? null;
          if (fault) return Promise.resolve({ data: null, count: null, error: { details: null, hint: null, code: fault.code ?? 'XX000', message: fault.message } }).then(resolve, reject);
          return (object as PromiseLike<unknown>).then(resolve, reject);
        };
      }
      const value = Reflect.get(object, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        const result = Reflect.apply(value, object, args);
        return result === object ? proxy : result;
      };
    },
  });
  return proxy;
}

function bucket(h: ModuleState, name: string) {
  const objects = h.storage.objects.get(name) ?? new Set<string>();
  h.storage.objects.set(name, objects);
  return {
    upload: async (path: string) => {
      objects.add(path);
      return { data: { id: path, path, fullPath: `${name}/${path}` }, error: null };
    },
    // Storage answers a refused delete with `error: null` and an empty list,
    // the case removeConfirmed exists for (SEC-015).
    remove: async (paths: string[]) => {
      const gone = paths.filter((path) => !h.storage.refused.has(path) && objects.delete(path));
      return { data: gone.map((path) => ({ name: path })), error: null };
    },
    // A private bucket's read: a URL for an object the bucket holds, an error otherwise.
    createSignedUrl: async (path: string) => (objects.has(path)
      ? { data: { signedUrl: `https://signed.invalid/${name}/${path}` }, error: null }
      : { data: null, error: { message: 'Object not found' } }),
    // What a public bucket hands out: a URL derived from the path, whether or not the object exists.
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://project.supabase.invalid/storage/v1/object/public/${name}/${path}` } }),
    list: async (folder: string, options?: { search?: string }) => {
      const inFolder = [...objects].filter((path) => path.startsWith(`${folder}/`)).map((path) => path.slice(folder.length + 1));
      return { data: inFolder.filter((n) => !options?.search || n.startsWith(options.search)).map((n) => ({ name: n })), error: null };
    },
  };
}

export function clientFor(h: ModuleState) {
  return {
    from: (table: string) => recorded(h, table, db(h).from(table)),
    rpc: (name: string, args?: Record<string, unknown>) => db(h).rpc(name, args),
    storage: { from: (name: string) => bucket(h, name) },
  };
}

export function supabaseClientModule(h: ModuleState) {
  return { createClient: () => clientFor(h) };
}

export function appContextModule(h: ModuleState) {
  return { useApp: () => h.app };
}

export function toastModule(h: ModuleState) {
  const api = {
    success: (message: string) => { h.toasts.success.push(message); },
    error: (message: string) => { h.toasts.error.push(message); },
    info: (message: string) => { h.toasts.success.push(message); },
    toast: (message: string, tone?: 'success' | 'error' | 'info') => { (tone === 'error' ? h.toasts.error : h.toasts.success).push(message); },
  };
  return { useToast: () => api };
}

export function confirmModule(h: ModuleState) {
  const ask = async () => h.confirmAnswer;
  return { useConfirm: () => ask };
}

// The REAL en-US catalogue with production's lookup, so a missing key renders
// as its key and an assertion on the English sentence catches it.
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const plural = (key: string, count: number, params?: Record<string, string | number>) =>
  pluralize(SOURCE_MESSAGES, 'en-US', key, count, params);
const LOCALE = { code: 'en-US', label: 'English (United States)', dir: 'ltr' };

export function localeProviderModule(h: ModuleState) {
  return {
    useTranslations: () => t,
    usePlural: () => plural,
    useLocale: () => LOCALE,
    useLocaleSource: () => 'default',
    useFamilyTimeZone: () => h.timeZone,
  };
}

// ── UI stubs ─────────────────────────────────────────────────────────────────
// Plain host elements carrying the props a test reads (onClick, aria-label,
// disabled, value). None of them holds state.

const omit = (props: Props, ...keys: string[]) => {
  const out = { ...props };
  for (const key of keys) delete out[key];
  return out;
};

export const ui = {
  Button: (props: Props) => createElement('button', {
    type: 'button', ...omit(props, 'loading', 'variant', 'size'),
    disabled: Boolean(props.disabled) || Boolean(props.loading), 'data-loading': Boolean(props.loading),
  }),
  Modal: (props: Props) => (props.open === false ? null : createElement('div', {
    role: 'dialog', 'aria-label': typeof props.title === 'string' ? props.title : undefined, onClose: props.onClose,
  }, props.children as ReactNode)),
  Input: (props: Props) => createElement('input', props),
  Select: (props: Props) => createElement('select', props),
  Textarea: (props: Props) => createElement('textarea', props),
  Field: ({ label, children }: Props) => createElement('label', null, label as ReactNode,
    typeof children === 'function' ? (children as (id: string) => ReactNode)('field') : (children as ReactNode)),
  SkeletonList: () => null,
  ErrorState: ({ message }: Props) => createElement('div', { role: 'alert' }, message as ReactNode),
  EmptyState: ({ title, description, action }: Props) => createElement('div', null, title as ReactNode, description as ReactNode, action as ReactNode),
  PageHeader: ({ title, description, action }: Props) => createElement('header', null, title as ReactNode, description as ReactNode, action as ReactNode),
  AiInsight: () => null,
  FamilyMediaImg: ({ src, alt }: Props) => createElement('img', { src, alt }),
  Avatar: ({ name }: Props) => createElement('span', null, name as ReactNode),
  Badge: ({ children }: Props) => createElement('span', null, children as ReactNode),
  Link: ({ href, children, ...rest }: Props) => createElement('a', { href, ...rest }, children as ReactNode),
};
