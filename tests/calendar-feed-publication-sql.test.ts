import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {describe,it,expect} from 'vitest';

const migration='supabase/reserved/0490_a_calendar_feed_sync_writes_only_while_it_holds_its_claim.sql';
describe('held feed publication SQL boundary',()=>{
  it('keeps publication distinct from the legacy unsettled chunk',()=>{
    const sql=readFileSync(migration,'utf8');
    const chunk=sql.split('create or replace function public.calendar_feed_apply_sync')[1].split('create or replace function public.calendar_feed_publish_snapshot')[0];
    expect(chunk).not.toContain("last_status='ok'");
    expect(sql).toContain('event_count=(select count(*) from public.calendar_events where feed_id=p_feed_id)');
    expect(sql).toContain('Source write requires complete verified projection');
    expect(sql).toContain('Source metadata write refused at conflict');
    expect(sql).toContain('nullable JSONB without default required');
  });
  it.each([
    [],['--bin'],['--bin','relative'],['--bin','/tmp/bin','--bin','/tmp/bin'],
    ['--bin','/tmp/bin','--port','55443'],
    ['--postgres-bin','/tmp/bin','--port','55443','--expected-data-dir','/tmp/data'],
    ['--postgres-bin','/tmp/bin','--port','0','--expected-server-port','0','--expected-data-dir','/tmp/data'],
  ])('refuses malformed fixture CLI before invoking a database: %j',(...args)=>{
    const result=spawnSync(process.execPath,['scripts/verify-calendar-feed-publication.mjs',...args],{encoding:'utf8',timeout:5000});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('AssertionError');
    expect(result.stdout).not.toContain('PASS');
  });
});
