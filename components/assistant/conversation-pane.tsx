'use client';

// The conversation pane: the thread and composer the module renders, framed
// by a header that switches between saved conversations. The list is a
// disclosure rather than a permanent sidebar because on a 320px column (and
// on a phone) the conversation itself is what needs the room.
//
// Reads and writes stay in the module (it owns the Supabase calls and their
// keep-prior-state rules); this component only shows what it is given and
// reports what was tapped.
import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, History, MessageSquare, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ErrorState, SkeletonText } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

export type ConversationSummary = { id: string; title: string; updated_at: string };

export type ConversationPaneProps = {
  conversations: ConversationSummary[];
  activeId: string;
  /** True while the list is loading for the first time; null error once it has loaded. */
  loading?: boolean;
  error?: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, current: string) => void;
  onDelete: (id: string) => void;
  onRetry?: () => void;
  /** The thread (with the module's pinned scroller) and the composer. */
  children?: ReactNode;
  className?: string;
};

export function ConversationPane({ conversations, activeId, loading = false, error = null, onSelect, onNew, onRename, onDelete, onRetry, children, className }: ConversationPaneProps) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const active = conversations.find((c) => c.id === activeId);

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="assistant-conversation-list"
          className="focus-ring coarse:min-h-11 inline-flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-surface/40 px-3 py-2 text-left text-sm font-semibold text-fg hover:bg-elevated"
        >
          <History className="h-4 w-4 shrink-0 text-brand-text" aria-hidden />
          <span className="truncate">{active?.title || 'New conversation'}</span>
          <span className="ml-auto shrink-0 text-xs font-medium text-muted">{conversations.length > 0 ? `${conversations.length} saved` : ''}</span>
          {open ? <ChevronUp className="h-4 w-4 shrink-0 text-muted" aria-hidden /> : <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden />}
        </button>
        <Button type="button" variant="outline" size="sm" onClick={onNew} className="coarse:min-h-11 shrink-0" aria-label={t('conversationPane.newChat')}>
          <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">New</span>
        </Button>
      </div>

      <div id="assistant-conversation-list" hidden={!open} className="mt-2 rounded-xl border border-border bg-surface/40 p-2">
        {loading ? (
          <SkeletonText lines={3} />
        ) : error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : conversations.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted">{t('conversationPane.noSavedChatsYet')}</p>
        ) : (
          <ul className="max-h-64 space-y-0.5 overflow-y-auto overscroll-contain">
            {conversations.map((c) => (
              <li key={c.id} className={cn('group flex items-center gap-1 rounded-lg px-1', c.id === activeId ? 'bg-brand/10' : 'hover:bg-elevated')}>
                <button
                  type="button"
                  onClick={() => { onSelect(c.id); setOpen(false); }}
                  aria-current={c.id === activeId ? 'true' : undefined}
                  className="focus-ring coarse:min-h-11 flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-left"
                >
                  <MessageSquare className={cn('h-4 w-4 shrink-0', c.id === activeId ? 'text-brand-text' : 'text-muted')} aria-hidden />
                  <span className="truncate text-xs text-fg/80">{c.title || 'New conversation'}</span>
                </button>
                <button type="button" onClick={() => onRename(c.id, c.title)} aria-label={`Rename: ${c.title || 'New conversation'}`} className="focus-ring coarse:min-h-11 coarse:min-w-11 shrink-0 rounded-lg p-1.5 text-muted/60 hover:text-fg">
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button type="button" onClick={() => onDelete(c.id)} aria-label={`Delete: ${c.title || 'New conversation'}`} className="focus-ring coarse:min-h-11 coarse:min-w-11 shrink-0 rounded-lg p-1.5 text-muted/60 hover:text-danger">
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {children}
    </div>
  );
}
