'use client';

// The assistant workspace (§54): on a desktop, three columns — the
// conversation on the left, Bubaly's plan and results in the centre, the
// household context on the right. On a phone the same three surfaces are
// progressive screens behind a segmented control (Chat | Plan | Context)
// instead of three cramped columns.
//
// The panes are passed in as nodes so this component owns layout only: what
// goes in each column, and the data behind it, stays with the module.
import { useEffect, useState, type ReactNode } from 'react';
import { LayoutList, MessageSquare, PanelRight } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export type WorkspacePane = 'chat' | 'plan' | 'context';

export const WORKSPACE_PANES: { key: WorkspacePane; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'chat', label: 'Chat', icon: MessageSquare },
  { key: 'plan', label: 'Plan', icon: LayoutList },
  { key: 'context', label: 'Context', icon: PanelRight },
];

export function isWorkspacePane(value: unknown): value is WorkspacePane {
  return value === 'chat' || value === 'plan' || value === 'context';
}

/** The desktop breakpoint, matching Tailwind's `lg`, so JS and CSS agree on which layout is showing. */
export const DESKTOP_QUERY = '(min-width: 1024px)';

/** True on a desktop-width viewport; false on the server and on phones, so the mobile layout is the default. */
export function useDesktop(): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(DESKTOP_QUERY);
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return desktop;
}

export type SegmentedControlProps = {
  value: WorkspacePane;
  onChange: (pane: WorkspacePane) => void;
  /** Per-pane badge counts (new cards on Plan, say); zero hides the badge. */
  counts?: Partial<Record<WorkspacePane, number>>;
  className?: string;
};

/** Chat | Plan | Context — a tablist, 44px targets, the brand pill on the active tab. */
export function SegmentedControl({ value, onChange, counts, className }: SegmentedControlProps) {
  return (
    <div role="tablist" aria-label="Assistant workspace" className={cn('grid grid-cols-3 gap-1 rounded-xl border border-border bg-surface/60 p-1', className)}>
      {WORKSPACE_PANES.map(({ key, label, icon: Icon }) => {
        const active = key === value;
        const count = counts?.[key] ?? 0;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            id={`assistant-tab-${key}`}
            aria-selected={active}
            aria-controls={`assistant-pane-${key}`}
            onClick={() => onChange(key)}
            className={cn(
              'focus-ring coarse:min-h-11 inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-semibold transition',
              active ? 'bg-brand text-brand-fg shadow-glow' : 'text-muted hover:bg-elevated hover:text-fg',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
            {count > 0 && (
              <span className={cn('rounded-full px-1.5 text-[11px] font-bold tabular-nums', active ? 'bg-brand-fg/20 text-brand-fg' : 'bg-brand/15 text-brand-text')} aria-label={`${count} new`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export type AssistantWorkspaceProps = {
  pane: WorkspacePane;
  onPaneChange: (pane: WorkspacePane) => void;
  /** Left column: the conversation (thread + composer). */
  conversation: ReactNode;
  /** Centre column: cards, runs, approvals. */
  plan: ReactNode;
  /** Right column: household context, suggestions, activity. */
  context: ReactNode;
  /**
   * The welcome surface before a conversation exists. When set it takes the
   * centre on a desktop and the Chat tab on a phone, so a first visit opens on
   * the big composer rather than on an empty results pane.
   */
  hero?: ReactNode;
  counts?: Partial<Record<WorkspacePane, number>>;
  className?: string;
};

export function AssistantWorkspace({ pane, onPaneChange, conversation, plan, context, hero, counts, className }: AssistantWorkspaceProps) {
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {/* Phone / tablet: one pane at a time. */}
      <div className="lg:hidden">
        <SegmentedControl value={pane} onChange={onPaneChange} counts={counts} className="sticky top-0 z-10 mb-4" />
        <section id="assistant-pane-chat" role="tabpanel" aria-labelledby="assistant-tab-chat" hidden={pane !== 'chat'} className="min-h-0">
          {hero ?? conversation}
        </section>
        <section id="assistant-pane-plan" role="tabpanel" aria-labelledby="assistant-tab-plan" hidden={pane !== 'plan'} className="min-h-0">
          {plan}
        </section>
        <section id="assistant-pane-context" role="tabpanel" aria-labelledby="assistant-tab-context" hidden={pane !== 'context'} className="min-h-0">
          {context}
        </section>
      </div>

      {/* Desktop: three columns, all visible. */}
      <div className="hidden min-h-0 flex-1 gap-6 lg:grid lg:grid-cols-[320px_1fr_330px]">
        <aside className="flex min-h-0 min-w-0 flex-col" aria-label="Conversation">{conversation}</aside>
        <section className="min-h-0 min-w-0" aria-label="Plan and results">{hero ?? plan}</section>
        <aside className="min-h-0 min-w-0 space-y-5" aria-label="Context">{context}</aside>
      </div>
    </div>
  );
}
