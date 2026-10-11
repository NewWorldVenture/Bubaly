import { createElement, type ComponentType, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { FAMILY, HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { byName, click, expand, form, nodes, settle, submit, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// HC1 — the closet and inventory item forms upload a photo before the row is
// saved, and H2 made closing the form remove that upload. But every way of
// closing it — Cancel, Escape, the X and the backdrop — stayed live while the
// save was in flight, and closing removed the photo AT ONCE. The request was
// already on its way, so it committed a row pointing at the deleted object
// (and an edit's continuation then released the item's previous photo as
// well, so the row kept neither), with "Item added" on screen. An upload
// still in flight when the form closed landed after that clean-up, and
// nothing ever removed it from the public bucket.
//
// The earlier tests settled every step before closing and stubbed the Modal,
// so they could not see either race. Here the REAL Modal and its REAL dialog
// behaviour (components/ui/modal.tsx, lib/a11y/use-dialog-behavior.ts) wire
// the four routes: the Cancel button, Escape through the focus trap's
// document listener, the X and the backdrop. The save and the upload are
// held in flight while the form is dismissed, then answered — committed,
// refused, or with the reply lost after it committed. Each route is shown to
// close the dialog, so none of them is assumed.
//
// HD1 — a confirmed save then removes the photos it superseded, and only
// after that removal called back to its parent. The form is still open during
// that storage round trip, and the save had decided BEFORE it whether the form
// had been dismissed: dismissed and another form opened meanwhile, the old
// save's onSaved closed the NEW form, discarding its draft and orphaning the
// photo that form had uploaded. Here the removal is held too.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

/** Requests held in flight, released by the test. */
const io = vi.hoisted(() => ({
  write: null as null | { table: string; until: Promise<void>; reply: 'database' | 'lost' },
  upload: null as null | Promise<void>,
  /** Storage removals wait on this while it is set. */
  remove: null as null | Promise<void>,
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
// The portal renders in place: the dialog is part of the tree the test reads.
vi.mock('react-dom', async (original) => ({ ...await original<object>(), createPortal: (node: unknown) => node }));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => {
  const harness = await import('./helpers/module-harness');
  return { createClient: () => inFlight(harness.clientFor(h)) };
});
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/media/family-media-img', async () => (await import('./helpers/module-harness')).ui);

type Client = { from(table: string): object; storage: { from(name: string): { upload(path: string): Promise<unknown>; remove(paths: string[]): Promise<unknown> } } };
type Reply = { data: unknown; error: unknown };

/**
 * The harness client, with the next insert or update of `io.write.table`
 * held until the test releases it. The in-memory database applies the write
 * only on release — the request is in flight until then — and `reply: 'lost'`
 * commits it and answers as supabase-js does when no reply came back.
 */
function inFlight(client: Client): Client {
  return {
    ...client,
    from(table: string) {
      const builder = client.from(table) as PromiseLike<Reply>;
      const hold = io.write;
      if (!hold || hold.table !== table) return builder;
      let writes = false;
      const proxy: object = new Proxy(builder, {
        get(target, property) {
          if (property === 'then') {
            return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
              if (!writes) return target.then(resolve, reject);
              io.write = null;
              return hold.until
                .then(() => new Promise<Reply>((done, fail) => { target.then(done, fail); }))
                .then((reply) => (hold.reply === 'lost'
                  ? { data: null, count: null, status: 0, statusText: '', error: { message: 'TypeError: fetch failed', details: '', hint: '', code: '' } }
                  : reply))
                .then(resolve, reject);
            };
          }
          const value = Reflect.get(target, property);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (property === 'insert' || property === 'update') writes = true;
            const result = Reflect.apply(value, target, args);
            return result === target ? proxy : result;
          };
        },
      });
      return proxy;
    },
    storage: {
      from(name: string) {
        const bucket = client.storage.from(name);
        return {
          ...bucket,
          upload: async (path: string) => { if (io.upload) await io.upload; return bucket.upload(path); },
          remove: async (paths: string[]) => { if (io.remove) await io.remove; return bucket.remove(paths); },
        };
      },
    },
  };
}

const { ClosetModule } = await import('@/components/modules/closet-module');
const { InventoryModule } = await import('@/components/modules/inventory-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;

/** Just enough `document` for the real dialog: its focus trap and Escape listener live here. */
function fakeDocument() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    body: { style: {} as Record<string, string> },
    activeElement: null as unknown,
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) { listeners.get(type)?.delete(listener); },
    getElementById: () => null,
    querySelector: () => null,
    press(key: string) {
      for (const listener of [...(listeners.get('keydown') ?? [])]) listener({ key, shiftKey: false, preventDefault() {} });
    },
  };
}
let doc: ReturnType<typeof fakeDocument>;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.storage = { objects: new Map(), refused: new Set() };
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  io.write = null; io.upload = null; io.remove = null;
  doc = fakeDocument();
  vi.stubGlobal('document', doc);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/**
 * Render the module as React commits it: the dialog's ref is attached BEFORE
 * the effects that read it run (the focus trap bails without its element, and
 * Escape would then do nothing), and a component that left the tree forgets
 * its state, so a form opened again starts as a fresh mount.
 */
function screen(Component: ComponentType): ReactNode {
  const s = h.hooks;
  for (let pass = 0; pass < 40; pass++) {
    s.pending = [];
    const visited = new Set<string>();
    const byPath = s.byPath;
    const record = byPath.set.bind(byPath);
    byPath.set = (key: string, value: unknown[]) => { visited.add(key); return record(key, value); };
    let tree: ReactNode;
    try {
      tree = expand(createElement(Component), s);
    } finally {
      delete (byPath as { set?: unknown }).set;
    }
    for (const key of [...byPath.keys()]) if (!visited.has(key)) byPath.delete(key);
    for (const node of nodes(tree)) {
      const ref = node.props.ref as { current: unknown } | undefined;
      if (node.props.role === 'dialog' && ref && ref.current == null) {
        ref.current = { querySelectorAll: () => [], focus() {}, contains: () => false, isConnected: true };
      }
    }
    const effects = s.pending;
    s.pending = [];
    if (!effects.length) return tree;
    for (const run of effects) run();
  }
  throw new Error('effects did not settle after 40 renders');
}

const dialogOpen = (Component: ComponentType) => nodes(screen(Component)).some((node) => node.props.role === 'dialog');
const bucket = () => [...(h.storage.objects.get('family-media') ?? [])].sort();
const store = (...paths: string[]) => { h.storage.objects.set('family-media', new Set(paths)); };

function deferred() {
  let open!: () => void;
  const until = new Promise<void>((resolve) => { open = resolve; });
  return { until, open };
}

/** Hold the next save to `table` in flight. */
function holdSave(table: string, reply: 'database' | 'lost' = 'database') {
  const gate = deferred();
  io.write = { table, until: gate.until, reply };
  return gate.open;
}

/** Hold every storage removal until the test lets them through. */
function holdRemoval() {
  const gate = deferred();
  io.remove = gate.until;
  return gate.open;
}

/** The photo the open form shows: its draft's own state, not a row's. */
const shownPhoto = (Component: ComponentType) =>
  nodes(form(screen(Component))).find((node) => node.type === 'img')?.props.src;

/** Choose a file in the open form's photo input, as the browser would. */
async function choosePhoto(Component: ComponentType, name: string) {
  const input = nodes(form(screen(Component))).find((node) => node.type === 'input' && node.props.type === 'file') as Node;
  (input.props.onChange as (event: unknown) => void)({ target: { files: [{ name, size: 2048 }] } });
  await settle();
}

const ROUTES = ['Cancel', 'Escape', 'the X', 'the backdrop'] as const;
type Route = (typeof ROUTES)[number];

/** Dismiss the open form the way a person would, and check that it closed. */
async function dismiss(Component: ComponentType, route: Route, cancelKey: string) {
  const tree = screen(Component);
  if (route === 'Cancel') {
    const cancel = byName(form(tree), t(cancelKey));
    expect(cancel.props.disabled, 'Cancel is live while the save is in flight').toBeFalsy();
    await click(cancel);
  } else if (route === 'Escape') {
    doc.press('Escape');
    await settle();
  } else if (route === 'the X') {
    await click(byName(tree, t('modal.closeDialog')));
  } else {
    await click(nodes(tree).find((node) => String(node.props.className ?? '').includes('overlay-scrim')) as Node);
  }
  expect(dialogOpen(Component), `${route} closes the form`).toBe(false);
}

const MODULES = [
  { name: 'closet', Component: ClosetModule, table: 'wardrobe_items', folder: 'closet', add: 'closet.addItem', cancel: 'closet.cancel' },
  { name: 'inventory', Component: InventoryModule, table: 'inventory_items', folder: 'inventory', add: 'inventory.addItem', cancel: 'inventory.cancel' },
] as const;

describe.each(MODULES)('$name: dismissing the item form never deletes a photo its save can still commit', (m) => {
  const C = m.Component;
  const old = `${FAMILY}/${m.folder}/11111111-1111-4111-8111-111111111111.jpg`;
  const refuseSave = () => {
    h.fault = (table, calls) => (table === m.table && (calls[0] === 'insert' || calls[0] === 'update')
      ? { code: '42501', message: 'new row violates row-level security policy' } : null);
  };

  /** A new item's form with a photo uploaded and its save in flight. */
  async function newItemSaving(reply: 'database' | 'lost' = 'database') {
    await click(byName(screen(C), t(m.add)));
    await choosePhoto(C, 'draft.jpg');
    const [uploaded] = bucket();
    expect(uploaded).toMatch(new RegExp(`^${FAMILY}/${m.folder}/`));
    const release = holdSave(m.table, reply);
    const saving = submit(form(screen(C)), { name: 'Swim shorts' });
    await settle();
    return { uploaded, release, saving };
  }

  /** An item's edit form with its photo replaced and the save in flight. */
  async function replacedPhotoSaving() {
    db.seed(m.table, [{ id: 'item-1', name: 'Swim shorts', photo_path: old }]);
    store(old);
    await click(byName(screen(C), t('itemAction.edit', { name: 'Swim shorts' })));
    await choosePhoto(C, 'new.jpg');
    const uploaded = bucket().find((path) => path !== old)!;
    const release = holdSave(m.table);
    const saving = submit(form(screen(C)));
    await settle();
    return { uploaded, release, saving };
  }

  for (const route of ROUTES) {
    describe(`dismissed with ${route}`, () => {
      it('a new item whose save then commits keeps its photo', async () => {
        const { uploaded, release, saving } = await newItemSaving();

        await dismiss(C, route, m.cancel);
        // Nothing is removed while the request that carries it can still commit.
        expect(bucket()).toEqual([uploaded]);

        release();
        await saving;
        await settle();

        expect(db.table(m.table)).toHaveLength(1);
        expect(db.table(m.table)[0].photo_path).toBe(uploaded);
        expect(bucket()).toEqual([uploaded]);
        expect(h.toasts.success).toEqual(['Item added']);
        expect(dialogOpen(C)).toBe(false);
      });

      it('a new item whose save is then refused leaves nothing behind', async () => {
        const { release, saving } = await newItemSaving();
        refuseSave();

        await dismiss(C, route, m.cancel);
        release();
        await saving;
        await settle();

        expect(db.table(m.table)).toEqual([]);
        expect(bucket()).toEqual([]);
        expect(h.toasts.error).toHaveLength(1);
        expect(h.toasts.success).toEqual([]);
      });

      it('a save whose reply was lost after it committed keeps the photo the row points at', async () => {
        const { uploaded, release, saving } = await newItemSaving('lost');

        await dismiss(C, route, m.cancel);
        release();
        await saving;
        await settle();

        expect(db.table(m.table)).toHaveLength(1);
        expect(db.table(m.table)[0].photo_path).toBe(uploaded);
        expect(bucket()).toEqual([uploaded]);
      });

      it('an edit that replaced the photo and then commits keeps the new photo, and only the old one goes', async () => {
        const { uploaded, release, saving } = await replacedPhotoSaving();

        await dismiss(C, route, m.cancel);
        expect(bucket()).toEqual([old, uploaded].sort());

        release();
        await saving;
        await settle();

        expect(db.table(m.table)[0].photo_path).toBe(uploaded);
        expect(bucket()).toEqual([uploaded]);
        expect(h.toasts.success).toEqual(['Item updated']);
      });

      it('an edit that replaced the photo and is then refused keeps the old photo, and the new one goes', async () => {
        const { release, saving } = await replacedPhotoSaving();
        refuseSave();

        await dismiss(C, route, m.cancel);
        release();
        await saving;
        await settle();

        expect(db.table(m.table)[0].photo_path).toBe(old);
        expect(bucket()).toEqual([old]);
      });

      it('an upload still in flight is removed when it lands after the form closed', async () => {
        await click(byName(screen(C), t(m.add)));
        const upload = deferred();
        io.upload = upload.until;
        await choosePhoto(C, 'late.jpg');
        expect(bucket()).toEqual([]);

        await dismiss(C, route, m.cancel);
        upload.open();
        await settle();
        await settle();

        expect(bucket()).toEqual([]);
        expect(db.table(m.table)).toEqual([]);
      });

      it('an ordinary close, with nothing in flight, removes what the form uploaded', async () => {
        await click(byName(screen(C), t(m.add)));
        await choosePhoto(C, 'draft.jpg');
        expect(bucket()).toHaveLength(1);

        await dismiss(C, route, m.cancel);
        await settle();

        expect(bucket()).toEqual([]);
        expect(db.table(m.table)).toEqual([]);
      });

      it('a save that commits after the form was dismissed does not close the form opened since', async () => {
        const { uploaded, release, saving } = await newItemSaving();
        await dismiss(C, route, m.cancel);

        await click(byName(screen(C), t(m.add)));
        expect(dialogOpen(C)).toBe(true);
        release();
        await saving;
        await settle();

        expect(dialogOpen(C), 'the form opened since is still open').toBe(true);
        expect(h.toasts.success).toEqual(['Item added']);
        expect(bucket()).toEqual([uploaded]);
      });

      it('an edit dismissed while its old photo is still being removed does not close the form opened since (HD1)', async () => {
        db.seed(m.table, [{ id: 'item-1', name: 'Swim shorts', photo_path: old }, { id: 'item-2', name: 'Rain coat' }]);
        store(old);
        await click(byName(screen(C), t('itemAction.edit', { name: 'Swim shorts' })));
        await choosePhoto(C, 'new.jpg');
        const uploaded = bucket().find((path) => path !== old)!;
        const release = holdRemoval();
        const saving = submit(form(screen(C)));
        await settle();
        // Saved and confirmed; the old photo's removal is still on its way,
        // and the form is still open meanwhile.
        expect(db.table(m.table).find((row) => row.id === 'item-1')!.photo_path).toBe(uploaded);
        expect(dialogOpen(C)).toBe(true);

        await dismiss(C, route, m.cancel);
        await click(byName(screen(C), t('itemAction.edit', { name: 'Rain coat' })));
        await choosePhoto(C, 'draft.jpg');
        const draft = bucket().find((path) => path !== old && path !== uploaded)!;
        release();
        await saving;
        await settle();

        expect(dialogOpen(C), 'the form opened since is still open').toBe(true);
        expect(shownPhoto(C), 'with its draft').toBe(draft);
        expect(h.toasts.success).toEqual(['Item updated']);
        expect(bucket()).toEqual([uploaded, draft].sort());
        // And the draft is still its own form's to clean up: nothing is orphaned.
        await dismiss(C, 'Cancel', m.cancel);
        await settle();
        expect(bucket()).toEqual([uploaded]);
      });

      it('a new item that uploaded twice, dismissed while the first upload is still being removed, does not close the form opened since (HD1)', async () => {
        await click(byName(screen(C), t(m.add)));
        await choosePhoto(C, 'first.jpg');
        const [first] = bucket();
        await choosePhoto(C, 'second.jpg');
        const second = bucket().find((path) => path !== first)!;
        const release = holdRemoval();
        const saving = submit(form(screen(C)), { name: 'Swim shorts' });
        await settle();
        expect(db.table(m.table)).toHaveLength(1);
        expect(db.table(m.table)[0].photo_path).toBe(second);
        expect(dialogOpen(C)).toBe(true);

        await dismiss(C, route, m.cancel);
        await click(byName(screen(C), t(m.add)));
        await choosePhoto(C, 'draft.jpg');
        const draft = bucket().find((path) => path !== first && path !== second)!;
        release();
        await saving;
        await settle();

        expect(dialogOpen(C), 'the form opened since is still open').toBe(true);
        expect(shownPhoto(C), 'with its draft').toBe(draft);
        expect(h.toasts.success).toEqual(['Item added']);
        expect(bucket()).toEqual([second, draft].sort());
        await dismiss(C, 'Cancel', m.cancel);
        await settle();
        expect(bucket()).toEqual([second]);
      });
    });
  }

  it('a save nobody dismissed still closes its own form, once its old photo is removed', async () => {
    db.seed(m.table, [{ id: 'item-1', name: 'Swim shorts', photo_path: old }]);
    store(old);
    await click(byName(screen(C), t('itemAction.edit', { name: 'Swim shorts' })));
    await choosePhoto(C, 'new.jpg');
    const uploaded = bucket().find((path) => path !== old)!;
    const release = holdRemoval();
    const saving = submit(form(screen(C)));
    await settle();
    expect(dialogOpen(C)).toBe(true);

    release();
    await saving;
    await settle();

    expect(dialogOpen(C)).toBe(false);
    expect(h.toasts.success).toEqual(['Item updated']);
    expect(bucket()).toEqual([uploaded]);
  });
});
