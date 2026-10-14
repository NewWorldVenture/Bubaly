import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

type NativeConfig = { port: number; pg: number; output: string; users: Record<string, string>; members: Record<string, string>; tokens: Record<string, string>; family: string; ids: Record<string, string>; cards: Record<string, string> };
const config = JSON.parse(fs.readFileSync(process.env.REMINDER_NATIVE_CONFIG!, 'utf8')) as NativeConfig;
const transport: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  expect(url.origin).toBe(`http://127.0.0.1:${config.port}`);
  expect(url.pathname.startsWith('/rest/v1/')).toBe(true);
  const original = url.pathname; url.pathname = url.pathname.slice('/rest/v1'.length);
  const response = await fetch(input instanceof Request ? new Request(url, input) : url, init);
  fs.appendFileSync(`${config.output}/transport.jsonl`, JSON.stringify({ original, forwarded: url.pathname, query: url.search, method: init?.method ?? (input instanceof Request ? input.method : 'GET'), status: response.status, mockedReply: false, headersChanged: false }) + '\n');
  return response;
};
const client = (actor: string) => createClient(`http://127.0.0.1:${config.port}`, 'synthetic-api-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport, headers: { Authorization: `Bearer ${config.tokens[actor]}` } } });
const teen = client('teen');
function owner(sql: string): unknown {
  return JSON.parse(execFileSync(process.execPath,[process.cwd()+'/scripts/run-reminder-card-privacy-runtime.mjs','--owned-psql',process.env.REMINDER_NATIVE_CONFIG!, '-X', '-h', '127.0.0.1', '-p', String(config.pg), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: sql, encoding: 'utf8', windowsHide: true }).trim());
}
function state() { return owner("select coalesce(json_agg(x order by x.id),'[]') from (select id,family_id,title,status,completed_at,snoozed_until from public.family_reminders) x;"); }
function capture(label: string, observation: unknown) { fs.writeFileSync(`${config.output}/${label}.json`, JSON.stringify(observation, null, 2) + '\n'); }
async function read(actor: string, table: string, id: string) { const result = await client(actor).from(table).select('id,title').eq('id', id); expect(result.error).toBeNull(); return result.data ?? []; }
async function prerequisites() {
  const membership = await teen.rpc('is_family_member', { p_family_id: config.family });
  const role = await teen.rpc('family_role', { p_family_id: config.family });
  const self = await teen.rpc('is_self_member', { p_member_id: config.members.teen });
  expect(membership.error).toBeNull(); expect(membership.data).toBe(true);
  expect(role.error).toBeNull(); expect(role.data).toBe('teen');
  expect(self.error).toBeNull(); expect(self.data).toBe(true);
  expect(await read('teen', 'autopilot_suggestions', config.cards.hidden)).toEqual([]);
  expect(await read('teen', 'autopilot_suggestions', config.cards.named)).toHaveLength(1);
  for (const actor of ['anon', 'inactive']) {
    expect(await read(actor, 'family_reminders', config.ids.own)).toEqual([]);
    const denied = await client(actor).from('family_reminders').update({ status: 'snoozed' }).eq('id', config.ids.own).select('id,status');
    expect(denied.error).toBeNull(); expect(denied.data).toEqual([]);
  }
  const untouched = await teen.from('family_reminders').select('status').eq('id', config.ids.own).single();
  expect(untouched.error).toBeNull(); expect(untouched.data?.status).toBe('active');
  capture('subject-prerequisites', { role: role.data, activeMembership: membership.data, ownMember: self.data, hiddenCardDenied: true, namedCardVisible: true, anonInactiveReadWriteDenied: true, authenticatedBypass: false });
}
beforeEach(async () => {
  execFileSync(process.execPath,[process.cwd()+'/scripts/run-reminder-card-privacy-runtime.mjs','--owned-psql',process.env.REMINDER_NATIVE_CONFIG!, '-X', '-h', '127.0.0.1', '-p', String(config.pg), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: "begin; set local role service_role; update public.family_reminders set status='active',completed_at=null,snoozed_until=null; commit;", encoding: 'utf8', windowsHide: true });
  await prerequisites();
});
async function selection(label: string, kind: string, allowed: boolean) {
  const before = state(); const result = await teen.from('family_reminders').select('id,title,status').eq('id', config.ids[kind]); const after = state();
  capture(label, { subject: 'authenticated teen', before, after, result });
  expect(result.error).toBeNull(); expect(result.data).toHaveLength(allowed ? 1 : 0); expect(after).toEqual(before);
  if (allowed) expect(result.data?.[0]?.id).toBe(config.ids[kind]);
}
async function mutation(label: string, kind: string, allowed: boolean) {
  const before = state(); const result = await teen.from('family_reminders').update({ status: 'completed' }, { count: 'exact' }).eq('id', config.ids[kind]).select('id,title,status'); const after = state();
  capture(label, { subject: 'authenticated teen', before, after, result });
  expect(result.error).toBeNull(); expect(result.count).toBe(allowed ? 1 : 0); expect(result.data).toHaveLength(allowed ? 1 : 0);
  if (allowed) expect(result.data?.[0]).toMatchObject({ id: config.ids[kind], status: 'completed' }); else expect(after).toEqual(before);
}
describe('genuine authenticated reminder direct-ID database contract', () => {
  it('reads own reminder', () => selection('own-select', 'own', true));
  it('does not read hidden card-derived reminder', () => selection('hidden-select', 'hidden', false));
  it('reads named insurance reminder', () => selection('named-select', 'named', true));
  it('does not read foreign family reminder', () => selection('foreign-select', 'foreign', false));
  it('updates own reminder', () => mutation('own-patch', 'own', true));
  it('does not update hidden card-derived reminder', () => mutation('hidden-patch', 'hidden', false));
  it('updates named insurance reminder', () => mutation('named-patch', 'named', true));
  it('does not update foreign family reminder', () => mutation('foreign-patch', 'foreign', false));
});
