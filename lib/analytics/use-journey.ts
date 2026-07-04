'use client';

// useJourney — fire-and-forget product telemetry for the Experience Scorecard.
// A journey is one user flow (e.g. 'capture'); the hook stamps a session id,
// records the start time, and writes started/step/completed rows to
// journey_events. Telemetry must NEVER break the UX, so every write is wrapped
// and errors (incl. a missing table pre-migration) are swallowed silently.
import { useCallback, useRef } from 'react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';

function newSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export type Journey = {
  /** Begin a run: new session id + start clock, emits 'started'. */
  start: () => void;
  /** Note progress within the current run (increments the step counter). */
  step: () => void;
  /** Finish the run: emits 'completed' with elapsed ms + final step count. */
  complete: () => void;
  /** Explicitly mark the run abandoned (optional; e.g. modal dismissed). */
  abandon: () => void;
};

export function useJourney(journey: string): Journey {
  const { familyId, selfMember } = useApp();
  const sessionRef = useRef<string | null>(null);
  const startedAtRef = useRef<number>(0);
  const stepRef = useRef<number>(0);

  const emit = useCallback((phase: 'started' | 'step' | 'completed' | 'abandoned', durationMs?: number) => {
    const session_id = sessionRef.current;
    if (!session_id || !familyId) return;
    try {
      const sb = createClient();
      void sb.from('journey_events').insert({
        family_id: familyId,
        member_id: selfMember?.id ?? null,
        journey,
        phase,
        step: stepRef.current,
        session_id,
        duration_ms: durationMs ?? null,
      }).then(() => {}, () => {}); // swallow — telemetry never surfaces errors
    } catch { /* never throw from telemetry */ }
  }, [familyId, selfMember, journey]);

  const start = useCallback(() => {
    sessionRef.current = newSessionId();
    startedAtRef.current = Date.now();
    stepRef.current = 0;
    emit('started');
  }, [emit]);

  const step = useCallback(() => {
    if (!sessionRef.current) return;
    stepRef.current += 1;
    emit('step');
  }, [emit]);

  const complete = useCallback(() => {
    if (!sessionRef.current) return;
    emit('completed', Date.now() - startedAtRef.current);
    sessionRef.current = null;
  }, [emit]);

  const abandon = useCallback(() => {
    if (!sessionRef.current) return;
    emit('abandoned', Date.now() - startedAtRef.current);
    sessionRef.current = null;
  }, [emit]);

  return { start, step, complete, abandon };
}
