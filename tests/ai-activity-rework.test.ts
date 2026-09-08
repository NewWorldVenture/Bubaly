// X3 — the rework rate. "How often does Bubaly get it right the first time?"
import { describe, it, expect } from 'vitest';
import * as activity from '@/lib/ai/activity';
import {
  REWORK_EVENT_TYPES, summarizeRework,
  type ReworkEventRow, type ReworkRunRow,
} from '@/lib/ai/activity';
import { TERMINAL_RUN_STATES } from '@/lib/ai/runs/states';

const run = (id: string, state: string, requestId: string | null = null): ReworkRunRow =>
  ({ id, request_id: requestId, state });

describe('summarizeRework', () => {
  it('counts a clean completed run as right the first time', () => {
    const s = summarizeRework([run('r1', 'completed', 'q1')], { q1: 1 }, []);
    expect(s).toMatchObject({ terminal: 1, firstTimeRight: 1, reworked: 0, firstTimeRightRate: 1, reworkRate: 0 });
  });

  it('counts a run with a second plan version as rework', () => {
    const s = summarizeRework([run('r1', 'completed', 'q1')], { q1: 2 }, []);
    expect(s.firstTimeRight).toBe(0);
    expect(s.reworkRate).toBe(1);
  });

  it('counts a run with a retried step as rework', () => {
    const events: ReworkEventRow[] = [{ run_id: 'r1', event_type: 'step_retried' }];
    const s = summarizeRework([run('r1', 'completed', 'q1')], { q1: 1 }, events);
    expect(s.firstTimeRight).toBe(0);
    expect(s.reworked).toBe(1);
  });

  it('ignores events that are not rework', () => {
    const events: ReworkEventRow[] = [
      { run_id: 'r1', event_type: 'step_started' },
      { run_id: 'r1', event_type: 'step_completed' },
      { run_id: 'r1', event_type: 'run_completed' },
    ];
    const s = summarizeRework([run('r1', 'completed', 'q1')], { q1: 1 }, events);
    expect(s.firstTimeRight).toBe(1);
  });

  it('treats a run with no request as clean unless its events say otherwise', () => {
    // No request means no plan versions to compare — dropping such runs would
    // shrink the denominator toward the runs we happen to understand best.
    expect(summarizeRework([run('r1', 'completed')], {}, []).firstTimeRight).toBe(1);
    expect(summarizeRework([run('r1', 'completed')], {}, [{ run_id: 'r1', event_type: 'step_retried' }]).firstTimeRight).toBe(0);
  });

  it('never counts a partial, failed or cancelled run as right the first time', () => {
    const runs = [
      run('a', 'partially_completed', 'q1'), run('b', 'failed', 'q2'), run('d', 'cancelled', 'q4'),
    ];
    const s = summarizeRework(runs, { q1: 1, q2: 1, q4: 1 }, []);
    expect(s.terminal).toBe(3);
    expect(s.firstTimeRight).toBe(0);
    expect(s.reworkRate).toBe(1);
  });

  it('leaves a BLOCKED run out of the denominator entirely', () => {
    // `blocked` is waiting on a person — the state machine says so, and a
    // decision or an edit puts the run back in flight. Counting it made every
    // unanswered question look like rework and pushed the rate up with the
    // size of the human queue rather than with quality.
    const s = summarizeRework([run('waiting', 'blocked', 'q1')], { q1: 1 }, []);
    expect(s.terminal).toBe(0);
    expect(s.reworked).toBe(0);
    expect(s.reworkRate).toBeNull();
  });

  it('does not let a queue of blocked runs move a real rate', () => {
    const runs = [
      run('done', 'completed', 'q1'),
      run('w1', 'blocked', 'q2'), run('w2', 'blocked', 'q3'), run('w3', 'blocked', 'q4'),
    ];
    const s = summarizeRework(runs, { q1: 1, q2: 1, q3: 1, q4: 1 }, []);
    expect(s.terminal).toBe(1);
    expect(s.reworkRate).toBe(0);
  });

  it('excludes runs still in flight from the denominator', () => {
    const runs = [run('done', 'completed', 'q1'), run('going', 'executing', 'q2'), run('queued', 'queued', 'q3')];
    const s = summarizeRework(runs, { q1: 1, q2: 1, q3: 1 }, []);
    expect(s.terminal).toBe(1);
    expect(s.firstTimeRightRate).toBe(1);
  });

  it('is null — not 0% — when no run has ended yet', () => {
    const s = summarizeRework([run('going', 'executing', 'q1')], { q1: 1 }, []);
    expect(s.terminal).toBe(0);
    expect(s.reworkRate).toBeNull();
    expect(s.firstTimeRightRate).toBeNull();
  });

  it('mixes into a real rate', () => {
    const runs = [
      run('a', 'completed', 'qa'),                 // clean
      run('b', 'completed', 'qb'),                 // replanned
      run('c', 'completed', 'qc'),                 // retried
      run('d', 'failed', 'qd'),                    // failed
    ];
    const s = summarizeRework(runs, { qa: 1, qb: 3, qc: 1, qd: 1 }, [{ run_id: 'c', event_type: 'step_retried' }]);
    expect(s.terminal).toBe(4);
    expect(s.firstTimeRight).toBe(1);
    expect(s.reworkRate).toBe(0.75);
  });
});

describe('the vocabulary', () => {
  it('names the terminal states and the rework events', () => {
    expect([...TERMINAL_RUN_STATES]).toEqual(['completed', 'partially_completed', 'failed', 'cancelled']);
    expect(TERMINAL_RUN_STATES).not.toContain('blocked');
    expect([...REWORK_EVENT_TYPES]).toContain('step_retried');
    expect([...REWORK_EVENT_TYPES]).toContain('replanned');
  });

  it('has ONE definition of terminal — activity.ts does not redeclare it', () => {
    // A second exported constant of this name, disagreeing about `blocked`, is
    // how the rework rate came to count the human queue in the first place.
    expect(Object.keys(activity)).not.toContain('TERMINAL_RUN_STATES');
  });
});
