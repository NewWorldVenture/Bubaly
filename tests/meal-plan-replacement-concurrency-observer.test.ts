import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const probe = readFileSync('docs/audit/meal-plan-replacement-concurrency-check.sql', 'utf8');

describe('meal-plan replacement race observer', () => {
  it('waits for B to enter the RPC, then proves it waits on A’s exact advisory lock', () => {
    const dispatch = probe.indexOf('v_sent := dblink_send_query');
    const bPid = probe.indexOf("dblink('meal_replace_b', 'select pg_backend_pid()')");
    const activeRpc = probe.indexOf("sa.query ~* '^\\s*select\\s+public\\.meal_plan_replace_slots\\s*\\('");
    const exactWait = probe.indexOf("sa.wait_event_type = 'Lock' and sa.wait_event = 'advisory'");

    expect(bPid).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(bPid);
    expect(activeRpc).toBeGreaterThan(dispatch);
    expect(exactWait).toBeGreaterThan(activeRpc);
    expect(probe).toContain("dblink('meal_replace_a', 'select pg_backend_pid()')");
    expect(probe).toContain('v_a_pid = any(pg_blocking_pids(v_b_pid))');
    expect(probe).toContain("v_observe_deadline := clock_timestamp() + interval '10 seconds'");
    expect(probe).toContain('B-not-started before A commit');
    expect(probe).toMatch(/v_ok\s*:=\s*v_a_holds_slot\s+and v_b_rpc_started\s+and v_b_waited_on_slot/i);
  });
});
