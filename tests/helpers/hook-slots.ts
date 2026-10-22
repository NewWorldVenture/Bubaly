// React hooks as numbered slots, for driving a real client component in a
// suite that has no DOM.
//
// Several tests here invoke a module component as a plain function and read
// the element tree it returns (see tests/a-rebuilt-graph-is-on-screen-before-
// the-toast-says-so.test.ts, which this generalises). With no React renderer
// there is no dispatcher, so the hooks are replaced: each call takes the next
// slot, in call order, exactly as React itself keys hooks. Each component in
// the tree has its own slots, keyed by where it sits (tests/helpers/
// module-harness.tsx `expand`), so a modal opening above a list does not shift
// the list's state.
//
// Effects RUN, with dependency comparison, after the render that scheduled
// them — a module that picks its first member or its live move in an effect
// behaves as it does in the browser. `useMemo` and `useCallback` honour their
// dependencies too, so an effect keyed on a callback does not fire on every
// render.
//
// This module must not import React at runtime: it is loaded from inside the
// `vi.mock('react', …)` factory, before React's mock exists.

export type HookSlots = {
  /** The slots of the component being rendered right now. */
  slots: unknown[];
  cursor: number;
  /** Every component's slots, by its position in the tree. */
  byPath: Map<string, unknown[]>;
  /** Effects scheduled by the render in progress. */
  pending: (() => unknown)[];
};

export function createHookSlots(): HookSlots {
  return { slots: [], cursor: 0, byPath: new Map(), pending: [] };
}

/** Forget every slot: the next render is a first mount. */
export function resetHookSlots(s: HookSlots): void {
  s.slots = [];
  s.cursor = 0;
  s.byPath = new Map();
  s.pending = [];
}

const sameDeps = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
  !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

type Memo = { deps: readonly unknown[] | undefined; value: unknown };

/** React with its hooks replaced by slots. Everything else is the real module. */
export function withHookSlots<R extends object>(react: R, s: HookSlots): R {
  // Each hook captures the slot array of the component calling it, so a setter
  // or an effect that runs later writes back to the right component.
  const next = () => ({ slots: s.slots, index: s.cursor++ });
  const memo = (compute: () => unknown, deps?: readonly unknown[]) => {
    const { slots, index } = next();
    const previous = slots[index] as Memo | undefined;
    if (previous && deps && sameDeps(previous.deps, deps)) return previous.value;
    const value = compute();
    slots[index] = { deps, value } satisfies Memo;
    return value;
  };
  const effect = (run: () => unknown, deps?: readonly unknown[]) => {
    const { slots, index } = next();
    const previous = slots[index] as { deps: readonly unknown[] | undefined } | undefined;
    if (previous && deps && sameDeps(previous.deps, deps)) return;
    slots[index] = { deps };
    s.pending.push(run);
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      const { slots, index } = next();
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [slots[index], (value: unknown) => {
        slots[index] = typeof value === 'function' ? (value as (p: unknown) => unknown)(slots[index]) : value;
      }];
    },
    useReducer: (reducer: (state: unknown, action: unknown) => unknown, initial: unknown, init?: (arg: unknown) => unknown) => {
      const { slots, index } = next();
      if (!(index in slots)) slots[index] = init ? init(initial) : initial;
      return [slots[index], (action: unknown) => { slots[index] = reducer(slots[index], action); }];
    },
    useRef: (initial: unknown) => {
      const { slots, index } = next();
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo: memo,
    useCallback: (fn: unknown, deps?: readonly unknown[]) => memo(() => fn, deps),
    useEffect: effect,
    useLayoutEffect: effect,
    useInsertionEffect: effect,
    useId: () => {
      const { slots, index } = next();
      if (!(index in slots)) slots[index] = `hook-id-${index}`;
      return slots[index];
    },
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useTransition: () => [false, (run: () => void) => run()],
    useDeferredValue: (value: unknown) => value,
  };
}
