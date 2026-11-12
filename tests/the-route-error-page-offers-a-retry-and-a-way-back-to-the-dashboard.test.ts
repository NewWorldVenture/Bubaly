// app/error.tsx — the route error boundary every signed-in and signed-out
// visitor can land on. It has two controls: "Try again" (the boundary's own
// reset) and a link back to the dashboard. Neither writes anything, so there is
// no role to refuse: the boundary takes no role or plan and shows both to
// whoever hit the error.
//
// The real GlobalError, rendered with tests/helpers/module-harness.tsx.
import { existsSync } from 'node:fs';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allByName, byName, click, nodes, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));

const { default: GlobalError } = await import('@/app/error');

const failure = Object.assign(new Error('boom'), { digest: 'digest-123' });
const logged = vi.spyOn(console, 'error');

function page(reset: () => void) {
  return render(h.hooks, createElement(GlobalError, { error: failure, reset }));
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  logged.mockReset().mockImplementation(() => {});
});
afterEach(() => { logged.mockReset(); });

describe('the route error page', () => {
  it('CONTROL-5EBAB817000F the Try again button is named and calls the boundary reset once', async () => {
    const reset = vi.fn();
    const tree = page(reset);
    // Reachable: the page a thrown route error renders, with its heading.
    expect(text(tree)).toContain('Something went wrong');
    expect(logged).toHaveBeenCalledWith('[Bubaly] route error:', failure);

    const buttons = nodes(tree).filter((node) => node.type === 'button');
    expect(buttons).toHaveLength(1);
    const retry = byName(tree, 'Try again', 'button');
    expect(retry).toBe(buttons[0]);
    expect(retry.props.disabled).toBe(false);

    expect(reset).not.toHaveBeenCalled();
    await click(retry);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('CONTROL-3FEFCD63FD8B CONTROL-6961786A61B2 the Go to dashboard control is one named link to the dashboard route, not a button inside a link', () => {
    const tree = page(() => {});
    const links = nodes(tree).filter((node) => node.type === 'a');
    expect(links).toHaveLength(1);
    const dashboard = byName(tree, 'Go to dashboard', 'a');
    expect(dashboard).toBe(links[0]);
    expect(dashboard.props.href).toBe('/dashboard');
    expect(existsSync('app/(app)/dashboard/page.tsx')).toBe(true);
    // The old Link-around-a-Button pair is one element now: the link carries
    // the button look itself and holds no second tab stop.
    expect(nodes(dashboard).filter((node) => node.type === 'button')).toHaveLength(0);
    expect(allByName(tree, 'Go to dashboard')).toHaveLength(1);
    expect(String(dashboard.props.className)).toContain('border-border');
  });
});
