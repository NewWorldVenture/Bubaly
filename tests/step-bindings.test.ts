// Until now there was no data flow between steps at all: `runToolStep` called
// the tool with `step.input_json` verbatim, and a dependency's `result_json`
// was gathered only to evaluate conditions.
//
// The sharp cost was verification. `lib/ai/runs/verify.ts` implements the
// strong checks §13 asks for — `records_exist` with real ids, `fields_match` —
// and their builders had NO CALLERS, because nothing could supply an id. So
// every verify step the templates emitted was an unfiltered family-wide
// `count_at_least`, which a family that already had last week's rows satisfies
// whether or not this run wrote a single one. The check passed; it proved
// nothing.
import { describe, expect, it } from 'vitest';
import {
  BINDING_KEY, bindingSources, isBinding, remapBindings, resolveBindings,
} from '@/lib/ai/runs/bindings';

describe('recognising a binding', () => {
  it('is exactly the two keys, and nothing that merely looks like it', () => {
    expect(isBinding({ [BINDING_KEY]: 'trip', path: 'id' })).toBe(true);
    expect(isBinding({ [BINDING_KEY]: 'trip' })).toBe(false);
    expect(isBinding({ [BINDING_KEY]: 'trip', path: 'id', extra: 1 })).toBe(false);
    expect(isBinding({ [BINDING_KEY]: 1, path: 'id' })).toBe(false);
    expect(isBinding('trip.id')).toBe(false);
    expect(isBinding(null)).toBe(false);
    expect(isBinding([{ [BINDING_KEY]: 'trip', path: 'id' }])).toBe(false);
  });

  it('finds every step a value depends on, however deeply nested', () => {
    const input = {
      vacation_id: { [BINDING_KEY]: 'trip', path: 'id' },
      checks: [{ ids: [{ [BINDING_KEY]: 'calendar', path: 'id' }, { [BINDING_KEY]: 'trip', path: 'id' }] }],
      title: 'Packing',
    };
    expect(bindingSources(input).sort()).toEqual(['calendar', 'trip']);
    expect(bindingSources({ title: 'nothing here' })).toEqual([]);
  });
});

describe('planner keys become step ids', () => {
  it('rewrites every binding and leaves the rest of the input alone', () => {
    const out = remapBindings(
      { vacation_id: { [BINDING_KEY]: 'trip', path: 'id' }, title: 'Packing', days: [1, 2] },
      { trip: 'step-uuid-1' },
    ) as Record<string, unknown>;
    expect(out.vacation_id).toEqual({ [BINDING_KEY]: 'step-uuid-1', path: 'id' });
    expect(out.title).toBe('Packing');
    expect(out.days).toEqual([1, 2]);
  });

  it('leaves an unmapped name alone so the executor fails loudly rather than silently', () => {
    const out = remapBindings({ x: { [BINDING_KEY]: 'ghost', path: 'id' } }, { trip: 'u1' }) as Record<string, unknown>;
    expect(out.x).toEqual({ [BINDING_KEY]: 'ghost', path: 'id' });
  });
});

describe('resolving against what earlier steps produced', () => {
  const results = {
    'step-1': { id: 'trip-9', summary: 'Made the trip', members: [{ id: 'm1' }, { id: 'm2' }] },
    'step-2': null,
  };

  it('puts the real value where the binding was', () => {
    const out = resolveBindings(
      { vacation_id: { [BINDING_KEY]: 'step-1', path: 'id' }, who: { [BINDING_KEY]: 'step-1', path: 'members.1.id' } },
      results,
    );
    expect(out).toEqual({ ok: true, value: { vacation_id: 'trip-9', who: 'm2' } });
  });

  it('leaves an input with no bindings untouched', () => {
    expect(resolveBindings({ title: 'Packing', n: 3 }, results)).toEqual({ ok: true, value: { title: 'Packing', n: 3 } });
  });

  it('refuses rather than passing a hole to a database', () => {
    // A step that meant to reference a real row must not run against nothing:
    // that is how a run writes the wrong record and still reports success.
    expect(resolveBindings({ id: { [BINDING_KEY]: 'step-1', path: 'nope' } }, results)).toMatchObject({ ok: false });
    expect(resolveBindings({ id: { [BINDING_KEY]: 'step-2', path: 'id' } }, results)).toMatchObject({ ok: false });
    expect(resolveBindings({ id: { [BINDING_KEY]: 'missing', path: 'id' } }, results)).toMatchObject({ ok: false });
  });

  it('explains itself in words a person could act on', () => {
    const out = resolveBindings({ id: { [BINDING_KEY]: 'step-1', path: 'nope' } }, results);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain('"nope" was not in what the step it depends on produced');
  });
});
