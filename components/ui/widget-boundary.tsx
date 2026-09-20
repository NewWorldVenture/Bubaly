'use client';

import { Component, type ReactNode } from 'react';

/**
 * Per-widget error boundary.
 *
 * A composed page is only as reliable as its least reliable tile. Without a
 * boundary between them, one widget throwing on an unexpected data shape takes
 * the whole page to the route-level `error.tsx` — on Home that means thirteen
 * working widgets disappear because the fourteenth met a malformed date. The
 * kiosk learned this the hard way (see the header this was extracted from: a
 * malformed date once crashed the display into an endless recover loop), and
 * the fix stayed local to the kiosk until now.
 *
 * `fallback` lets each surface degrade in its own idiom — the kiosk shows a
 * dash on dark glass, an app page shows nothing at all — while the behaviour
 * (catch, log with a label, recover on fresh props) is defined once.
 *
 * Recovers itself when new children arrive, so a widget that failed on one
 * render gets another chance on the next server render or data refresh rather
 * than staying dead until a reload.
 */
export class WidgetBoundary extends Component<
  { label?: string; children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Named, because "a widget crashed" is not actionable and this is the only
    // record — the page around it carries on as if nothing happened.
    console.error(`[widget] "${this.props.label ?? 'section'}" crashed:`, error);
  }

  componentDidUpdate(prev: { children: ReactNode }) {
    if (this.state.failed && prev.children !== this.props.children) this.setState({ failed: false });
  }

  render() {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}
