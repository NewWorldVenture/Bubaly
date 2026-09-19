import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WidgetBoundary } from '../components/ui/widget-boundary';

// A composed page is only as reliable as its least reliable tile. Home renders
// thirteen independent widgets inline with no boundary between them, so one
// throwing on an unexpected data shape took the whole dashboard to error.tsx —
// twelve working widgets removed because the thirteenth met a malformed date.
//
// The kiosk had already hit this (its own header records a malformed date
// crashing the display into an endless recover loop) and fixed it locally. The
// behaviour is now shared rather than copied — the same lesson as the four
// duplicated escapeLike helpers.
//
// Tested through the class's own contract rather than by rendering: React does
// not invoke getDerivedStateFromError during server rendering, so a
// renderToStaticMarkup test here would prove nothing about the boundary and
// quietly pass for the wrong reason.

type Boundary = InstanceType<typeof WidgetBoundary>;

describe('one widget failing does not take the page down', () => {
  it('switches to the failed state when a child throws', () => {
    expect(WidgetBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it('renders the surface\'s own fallback once failed', () => {
    const fallback = createElement('span', null, 'degraded');
    const b = new WidgetBoundary({ label: 'x', children: createElement('p'), fallback }) as Boundary;
    b.state = { failed: true };
    expect(b.render()).toBe(fallback);
  });

  it('renders nothing by default, so an additive tile just disappears', () => {
    const b = new WidgetBoundary({ label: 'x', children: createElement('p') }) as Boundary;
    b.state = { failed: true };
    expect(b.render()).toBeNull();
  });

  it('renders its children while healthy', () => {
    const children = createElement('p', null, 'fine');
    const b = new WidgetBoundary({ label: 'x', children }) as Boundary;
    expect(b.render()).toBe(children);
  });

  it('names the widget when it logs, because the page carries on silently', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = new WidgetBoundary({ label: 'on-this-day', children: createElement('p') }) as Boundary;
    b.componentDidCatch(new Error('boom'));
    // Assert BEFORE restoring: mockRestore clears the recorded calls.
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('on-this-day'), expect.any(Error));
    spy.mockRestore();
  });

  it('recovers when fresh children arrive rather than staying dead', () => {
    const b = new WidgetBoundary({ label: 'x', children: createElement('p', null, 'new') }) as Boundary;
    b.state = { failed: true };
    const setState = vi.fn();
    (b as unknown as { setState: unknown }).setState = setState;
    b.componentDidUpdate({ children: createElement('p', null, 'old') });
    expect(setState).toHaveBeenCalledWith({ failed: false });
  });

  it('is defined once and shared, not copied per surface', () => {
    const kiosk = readFileSync('components/display/display-grid.tsx', 'utf8');
    expect(kiosk).not.toMatch(/class WidgetBoundary/);
    expect(kiosk).toContain("from '@/components/ui/widget-boundary'");
    // The kiosk keeps its own LOOK while sharing the behaviour.
    expect(kiosk).toMatch(/KIOSK_FALLBACK/);
  });

  it("Home's independent widgets each sit behind one", () => {
    const home = readFileSync('app/(app)/home/page.tsx', 'utf8');
    for (const label of ['moment', 'on-this-day', 'working-on', 'ask-bar', 'time-saved']) {
      expect(home, `Home's "${label}" widget is not behind a boundary`)
        .toContain(`<WidgetBoundary label="${label}">`);
    }
  });
});
