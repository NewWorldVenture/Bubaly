import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const probe = readFileSync('docs/audit/meal-plan-replacement-concurrency-check.sql', 'utf8');

describe('meal-plan replacement race observer', () => {
  it('waits for B to enter the RPC, then proves it waits on A’s exact advisory lock', () => {
    const dispatch = probe.indexOf('v_sent := dblink_send_query');
    const bPid = probe.indexOf("dblink('meal_replace_b', 'select pg_backend_pid()')");
    const activeRpc = probe.indexOf('v_b_rpc_started := v_b_pid_visible');
    const exactWait = probe.indexOf("sa.wait_event_type = 'Lock' and sa.wait_event = 'advisory'");
    const startupGate = probe.slice(activeRpc, exactWait);
    const detailStart = probe.indexOf('v_b_observer_detail := format(');
    const detailEnd = probe.indexOf(');', detailStart) + 2;
    const sanitizedDetail = probe.slice(detailStart, detailEnd);

    expect(bPid).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(bPid);
    expect(activeRpc).toBeGreaterThan(dispatch);
    expect(exactWait).toBeGreaterThan(activeRpc);
    expect(startupGate).toContain('v_b_pid_visible');
    expect(startupGate).toContain('v_b_application_matches');
    expect(startupGate).toContain("v_b_state = 'active'");
    expect(startupGate).not.toContain('v_b_query_prefix_matches');
    expect(probe).toContain("dblink('meal_replace_a', 'select pg_backend_pid()')");
    expect(probe).toContain('v_a_pid = any(pg_blocking_pids(v_b_pid))');
    expect(probe).toContain("v_observe_deadline := clock_timestamp() + interval '10 seconds'");
    expect(probe).toContain('B-not-started-within-window=%s');
    expect(probe).toContain('pid_visible=%s; app_matches=%s; state=%s; wait_event_type=%s; wait_event=%s; RPC-prefix-matched=%s');
    expect(probe).toContain("left(lower(coalesce(sa.query, '')), length('select public.meal_plan_replace_slots('))");
    expect(sanitizedDetail).toContain('v_b_query_prefix_matches');
    expect(sanitizedDetail).toContain('v_b_pid_visible');
    expect(sanitizedDetail).not.toMatch(/\bv_b_pid\b/);
    expect(sanitizedDetail).not.toMatch(/\bv_app_b\b/);
    expect(sanitizedDetail).not.toContain('sa.query');
    expect(probe).toMatch(/v_ok\s*:=\s*v_a_holds_slot\s+and v_b_rpc_started\s+and v_b_waited_on_slot/i);
  });
});
