import { z } from 'zod';
import type { AppContextValue } from '@/components/app/app-context';
import { BriefDecisionsSchema } from '@/lib/briefing/response-schema';

export type BriefingType = 'morning' | 'evening' | 'weekly';

const strings = z.array(z.string());
const conflict = z.object({ description: z.string(), suggestion: z.string() });
const score = z.number().finite().min(0).max(100);
const count = z.number().int().nonnegative();
const domain = z.enum(['bill', 'medication', 'maintenance', 'warranty', 'trip', 'pantry']);

const briefingSchema = z.object({
  greeting: z.string(),
  subtitle: z.string(),
  familySummary: strings,
  schedule: z.array(z.object({
    time: z.string(), title: z.string(), member: z.string(), emoji: z.string(), color: z.string(),
  })),
  conflicts: z.array(conflict),
  kidsNeeds: z.array(z.object({ name: z.string(), age: count.optional(), items: strings })),
  meals: z.array(z.object({
    meal: z.string(), name: z.string().nullable(), status: z.string(), missing: strings.optional(),
  })),
  reminders: z.array(z.object({ text: z.string(), urgency: z.enum(['high', 'medium', 'low']) })),
  operationsScore: z.object({
    overall: score,
    categories: z.array(z.object({ label: z.string(), score, icon: z.string() })),
    stressLevel: z.enum(['low', 'moderate', 'high']),
    stressReason: z.string().nullable(),
    recommendation: z.string(),
  }),
  completed: strings.optional(),
  outstanding: z.array(z.object({ text: z.string(), urgency: z.enum(['high', 'medium']) })).optional(),
  tomorrowPreview: z.object({ events: count, notes: strings }).optional(),
  weeklyHighlights: z.array(z.object({ category: z.string(), emoji: z.string(), items: strings })).optional(),
  weeklyConflicts: z.array(conflict).optional(),
}).passthrough();

const responseSchema = z.object({
  briefing: briefingSchema,
  generatedAt: z.string().datetime({ offset: true }),
  digest: z.object({
    items: z.array(z.object({
      domain,
      urgency: z.enum(['overdue', 'today', 'soon']),
      title: z.string(), detail: z.string(), member: z.string().optional(),
      dueLabel: z.string(), dayOffset: z.number().int(),
    })),
    counts: z.object({ overdue: count, today: count, soon: count, total: count }),
    byDomain: z.array(z.object({ domain, count })),
    headline: z.string(),
  }).optional(),
  // Present only when something is waiting on a person. The route fails the
  // whole request when the decisions read fails, so an absent slice means
  // "nothing to decide", never "could not tell".
  decisions: BriefDecisionsSchema.optional(),
  // The quiet notifications the brief folded in. Optional because a cached or
  // older response predates the section, and `alsoTodayUnavailable` is what
  // keeps a failed read from rendering as "nothing else today".
  alsoToday: z.array(z.object({
    id: z.string(), title: z.string(), detail: z.string().nullable(),
    href: z.string(), at: z.string().nullable(),
  })).optional(),
  alsoTodayUnavailable: z.boolean().optional(),
}).passthrough();

export type BriefingData = z.infer<typeof briefingSchema>;
export type BriefingResponse = z.infer<typeof responseSchema>;

export function parseBriefingResponse(value: unknown): BriefingResponse | null {
  const result = responseSchema.safeParse(value);
  return result.success ? result.data : null;
}

type BriefingContext = Pick<AppContextValue,
  'familyId' | 'userId' | 'selfMember' | 'role' | 'isSuperAdmin' | 'planLevel' | 'featureTiers'>;

/**
 * An in-memory UI boundary, not an authoritative permission revision. The app
 * does not expose revisions for all source permissions, so sensitive briefs
 * must never be restored from browser storage (BRIEF-CACHE-ISOLATION, 3.28/34.49).
 */
export function briefingContextKey(context: BriefingContext, day: string): string | null {
  const { familyId, userId, selfMember: member } = context;
  if (!familyId || !userId || !member?.id || !member.is_active
    || member.family_id !== familyId || member.user_id !== userId) return null;

  return JSON.stringify([
    familyId, userId, member.id, context.role, member.role, member.updated_at,
    context.isSuperAdmin, context.planLevel,
    Object.entries(context.featureTiers).sort(([a], [b]) => a.localeCompare(b)), day,
  ]);
}

/** Remove every old day/type entry without ever parsing or trusting its contents. */
export function purgeLegacyBriefingCache(storage: Pick<Storage, 'length' | 'key' | 'removeItem'>): void {
  try {
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key?.startsWith('fos_briefing_')) storage.removeItem(key);
    }
  } catch { /* Storage can be blocked. It is never used to load or save briefs. */ }
}

interface BriefingTabState {
  data: BriefingResponse | null;
  loading: boolean;
  error: string | null;
  attempted: boolean;
}

const emptyTab = (): BriefingTabState => ({ data: null, loading: false, error: null, attempted: false });
const emptyState = (): Record<BriefingType, BriefingTabState> => ({
  morning: emptyTab(), evening: emptyTab(), weekly: emptyTab(),
});

/** One mounted context owns one session. Nothing survives its boundary. */
export function createBriefingSession(fetcher: typeof fetch = fetch) {
  let state = emptyState();
  const listeners = new Set<() => void>();
  const requests = new Map<BriefingType, AbortController>();
  const notify = () => listeners.forEach(listener => listener());
  const publish = (type: BriefingType, next: BriefingTabState) => {
    state = { ...state, [type]: next };
    notify();
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    clear: () => {
      for (const request of requests.values()) request.abort();
      requests.clear();
      state = emptyState();
      notify();
    },
    generate: async (type: BriefingType) => {
      if (requests.has(type)) return;
      const controller = new AbortController();
      requests.set(type, controller);
      const isCurrent = () => !controller.signal.aborted && requests.get(type) === controller;
      publish(type, { data: null, loading: true, error: null, attempted: true });
      try {
        const response = await fetcher('/api/ai/briefing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type }),
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!isCurrent()) return;
        if (!response.ok) throw new Error('Failed to generate briefing');
        const value: unknown = await response.json();
        if (!isCurrent()) return;
        const data = parseBriefingResponse(value);
        if (!data) throw new Error('Could not read the generated briefing. Please try again.');
        publish(type, { data, loading: false, error: null, attempted: true });
      } catch (error) {
        if (isCurrent()) {
          publish(type, {
            data: null, loading: false, attempted: true,
            error: error instanceof Error ? error.message : 'Something went wrong',
          });
        }
      } finally {
        if (isCurrent()) requests.delete(type);
      }
    },
  };
}
