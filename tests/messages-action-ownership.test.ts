import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { describe, expect, it } from 'vitest';
import { createThreadOwner } from '@/lib/messages/thread-state';

type Conversation = Tables<'family_conversations'>;
type Scope = { familyId: string; userId: string; role: string; memberId: string; active: boolean };
type Selection = { ticket: number; conversationId: string; origin: ReturnType<ReturnType<typeof createThreadOwner>['capture']>; scope: Scope; row: Conversation };
type Outcome = 'success' | 'denied' | 'zero' | 'wrong-id' | 'wrong-family' | 'wrong-state' | 'rejection';
const FAMILY = 'synthetic-family', USER = 'synthetic-user', A = 'thread-a', B = 'thread-b';
const conversation = (id: string, creator = 'other-user', archived = false) => ({ id, family_id: FAMILY, created_by: creator, is_archived: archived, is_family_chat: false } as Conversation);
const source = readFileSync('components/modules/messages-module.tsx', 'utf8');
const start = source.indexOf('  function sameArchiveRow(');
const end = source.indexOf('  // Quoted messages', start);
if (start < 0 || end <= start) throw new Error('Archive callback group was not found.');
const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

function fixture({ deferred = false, outcome = 'success' as Outcome, creator = 'other-user', role = 'parent', archived = false } = {}) {
  const owner = { current: createThreadOwner() }; owner.current.select(A);
  const alive = { current: true }, archiveCurrent = { current: null as number | null }, archiveFlight = { current: null as number | null }, archiveSequence = { current: 0 };
  let activeConv = conversation(A, creator, archived), scope: Scope = { familyId: FAMILY, userId: USER, role, memberId: 'member-a', active: true }, selection: Selection | null = null;
  const archiveScopeRef = { current: scope };
  const activeConversationRef = { current: activeConv };
  const effects: { kind: string; value?: unknown }[] = [], requests: { url: URL; patch: Record<string, unknown> }[] = [];
  const pending: (() => void)[] = [];
  const db = createClient<Database>('https://messages-actions-fixture.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input)), patch = JSON.parse(String(init?.body)); requests.push({ url, patch });
      const id = url.searchParams.get('id')?.replace(/^eq[.]/, '');
      const reply = { ...conversation(id ?? '', creator, Boolean(patch.is_archived)), family_id: url.searchParams.get('family_id')?.replace(/^eq[.]/, '') };
      if (deferred) await new Promise<void>(resolve => pending.push(resolve));
      if (outcome === 'rejection') throw new TypeError('Synthetic request rejected');
      if (outcome === 'denied') return Response.json({ code: '42501', message: 'Synthetic permission refusal' }, { status: 403 });
      if (outcome === 'zero') return Response.json(null);
      if (outcome === 'wrong-id') reply.id = 'other-thread';
      if (outcome === 'wrong-family') reply.family_id = 'other-family';
      if (outcome === 'wrong-state') reply.is_archived = !Boolean(patch.is_archived);
      return Response.json(reply);
    } },
  });
  function render() {
    const env = {
      owner, alive, activeConv, activeConversationRef, archiveScope: scope, archiveScopeRef, familyId: scope.familyId, userId: scope.userId, role: scope.role,
      jumpOrigin: owner.current.capture(), conversationAction: selection, archiveCurrent, archiveFlight, archiveSequence,
      setConversationAction: (value: Selection | null) => { selection = value; effects.push({ kind: 'modal', value: value?.ticket ?? null }); },
      setChangingConversation: (value: boolean) => effects.push({ kind: 'changing', value }), createClient: () => db,
      setActiveConv: (value: Conversation) => { activeConv = value; activeConversationRef.current = value; effects.push({ kind: 'active', value: value.id }); },
      setShowArchived: (value: boolean) => effects.push({ kind: 'archived', value }),
      loadConversations: () => effects.push({ kind: 'reload' }), toastError: (value: unknown) => effects.push({ kind: 'toast', value }),
      describeDbError: (value: { message: string }) => value.message, tr: (key: string) => key,
    };
    return new Function(...Object.keys(env), compiled + ';return {openArchiveAction,closeArchiveAction,archiveConversation,isCurrentArchiveAction,retireArchiveAction};')(...Object.values(env)) as {
      openArchiveAction: () => void; closeArchiveAction: () => void; archiveConversation: () => Promise<void>; isCurrentArchiveAction: () => boolean; retireArchiveAction: () => void;
    };
  }
  function open() { render().openArchiveAction(); return render(); }
  function switchThread(id: string) { render().retireArchiveAction(); owner.current.select(id); activeConv = conversation(id, creator, archived); activeConversationRef.current = activeConv; }
  function changeScope(patch: Partial<Scope>) { scope = { ...scope, ...patch }; archiveScopeRef.current = scope; }
  async function dispatched() { await expect.poll(() => requests.length).toBe(1); }
  return { owner, alive, activeConversationRef, archiveCurrent, archiveFlight, effects, requests, render, open, switchThread, changeScope, dispatched,
    adoptCurrentRow: () => { activeConv = activeConversationRef.current; }, clear: () => { effects.length = 0; }, resolve: () => pending.splice(0).forEach(resolve => resolve()), selection: () => selection };
}

describe('archive confirmation owns its rendered visit, authority and modal instance', () => {
  for (const retirement of ['thread', 'ABA', 'unmount', 'role', 'member', 'inactive', 'user', 'family', 'close-reopen', 'role-ABA', 'member-ABA', 'row-creator', 'row-archived', 'row-canonical']) it(`refuses retained callback before dispatch after ${retirement}`, async () => {
    const test = fixture(), old = test.open();
    if (retirement === 'thread') test.switchThread(B);
    if (retirement === 'ABA') { test.switchThread(B); test.switchThread(A); }
    if (retirement === 'unmount') test.alive.current = false;
    if (retirement === 'role') test.changeScope({ role: 'child' });
    if (retirement === 'role-ABA') { test.changeScope({ role: 'child' }); test.changeScope({ role: 'parent' }); }
    if (retirement === 'member-ABA') { test.changeScope({ memberId: 'other-member' }); test.changeScope({ memberId: 'member-a' }); }
    if (retirement === 'member') test.changeScope({ memberId: 'other-member' });
    if (retirement === 'inactive') test.changeScope({ active: false });
    if (retirement === 'user') test.changeScope({ userId: 'other-user' });
    if (retirement === 'family') test.changeScope({ familyId: 'other-family' });
    if (retirement === 'close-reopen') { old.closeArchiveAction(); test.open(); }
    if (retirement === 'row-creator') test.activeConversationRef.current = { ...test.activeConversationRef.current, created_by: 'new-creator' };
    if (retirement === 'row-archived') test.activeConversationRef.current = { ...test.activeConversationRef.current, is_archived: true };
    if (retirement === 'row-canonical') test.activeConversationRef.current = { ...test.activeConversationRef.current, is_family_chat: true };
    test.clear(); await old.archiveConversation();
    expect(test.requests).toHaveLength(0); expect(test.effects).toEqual([]);
  });
  for (const retirement of ['thread', 'ABA', 'unmount', 'role', 'inactive', 'close-reopen', 'row-creator', 'row-archived', 'row-canonical', 'role-ABA', 'member-ABA']) for (const outcome of ['success', 'denied', 'rejection'] as const) it(`suppresses retired ${outcome} completion after ${retirement}`, async () => {
    const test = fixture({ deferred: true, outcome }), old = test.open(), operation = old.archiveConversation();
    await test.dispatched();
    if (retirement === 'thread') test.switchThread(B);
    if (retirement === 'ABA') { test.switchThread(B); test.switchThread(A); }
    if (retirement === 'unmount') test.alive.current = false;
    if (retirement === 'role') test.changeScope({ role: 'child' });
    if (retirement === 'role-ABA') { test.changeScope({ role: 'child' }); test.changeScope({ role: 'parent' }); }
    if (retirement === 'member-ABA') { test.changeScope({ memberId: 'other-member' }); test.changeScope({ memberId: 'member-a' }); }
    if (retirement === 'inactive') test.changeScope({ active: false });
    if (retirement === 'close-reopen') { test.render().retireArchiveAction(); test.open(); }
    if (retirement === 'row-creator') test.activeConversationRef.current = { ...test.activeConversationRef.current, created_by: 'new-creator' };
    if (retirement === 'row-archived') test.activeConversationRef.current = { ...test.activeConversationRef.current, is_archived: true };
    if (retirement === 'row-canonical') test.activeConversationRef.current = { ...test.activeConversationRef.current, is_family_chat: true };
    test.clear(); test.resolve(); await operation;
    expect(test.requests).toHaveLength(1); expect(test.effects).toEqual([]);
  });
  it('dispatches once when two submits arrive before rerender', async () => {
    const test = fixture({ deferred: true }), action = test.open();
    const first = action.archiveConversation(), second = action.archiveConversation();
    await test.dispatched(); test.resolve(); await Promise.all([first, second]);
    expect(test.requests).toHaveLength(1); expect(test.effects.filter(e => e.kind === 'reload')).toHaveLength(1);
  });
  it('a retired completion cannot clear the newer modal flight or loading', async () => {
    const test = fixture({ deferred: true }), old = test.open(), first = old.archiveConversation();
    await test.dispatched(); test.switchThread(B); const fresh = test.open(), second = fresh.archiveConversation();
    await expect.poll(() => test.requests.length).toBe(2);
    test.clear(); test.resolve(); await first; await second;
    expect(test.effects.filter(e => e.kind === 'active').map(e => e.value)).toEqual([B]);
    expect(test.effects.filter(e => e.kind === 'reload')).toHaveLength(1);
  });
  for (const role of ['parent', 'adult']) for (const archived of [false, true]) it(`allows current ${role} ${archived ? 'restore' : 'archive'}`, async () => {
    const test = fixture({ role, archived }); await test.open().archiveConversation();
    expect(test.requests).toHaveLength(1);
    expect(test.requests[0].url.searchParams.get('id')).toBe(`eq.${A}`); expect(test.requests[0].url.searchParams.get('family_id')).toBe(`eq.${FAMILY}`);
    expect(test.requests[0].patch).toEqual({ is_archived: !archived }); expect(test.effects.filter(e => e.kind === 'reload')).toHaveLength(1);
    expect(test.selection()).toBeNull();
  });
  it('retains the private creator permission for a current child', async () => {
    const test = fixture({ creator: USER, role: 'child' }); await test.open().archiveConversation(); expect(test.requests).toHaveLength(1);
  });
  for (const scope of [{ role: 'child' }, { active: false }]) it(`refuses a fresh unauthorized or inactive confirmation ${JSON.stringify(scope)}`, async () => {
    const test = fixture(); test.changeScope(scope); test.open(); expect(test.selection()).toBeNull(); expect(test.requests).toHaveLength(0);
  });
  for (const outcome of ['denied', 'zero', 'wrong-id', 'wrong-family', 'wrong-state', 'rejection'] as const) it(`keeps the current confirmation retryable after ${outcome} without false success`, async () => {
    const test = fixture({ outcome }); await test.open().archiveConversation();
    expect(test.requests).toHaveLength(1); expect(test.effects.some(e => e.kind === 'toast')).toBe(true);
    expect(test.effects.filter(e => e.kind === 'active' || e.kind === 'reload' || e.kind === 'archived')).toEqual([]);
    expect(test.selection()).not.toBeNull(); expect(test.archiveFlight.current).toBeNull();
    expect(test.effects.at(-1)).toEqual({ kind: 'changing', value: false });
  });
  it('a retained opener cannot create a modal after role or visit retirement', () => {
    const test = fixture(), old = test.render(); test.changeScope({ role: 'child' }); test.clear(); old.openArchiveAction(); expect(test.effects).toEqual([]);
    test.changeScope({ role: 'parent' }); const visit = test.render(); test.switchThread(B); test.clear(); visit.openArchiveAction(); expect(test.effects).toEqual([]);
  });
  for (const opener of ['before-modal', 'current-modal']) it(`a ${opener} opener cannot retire a pending archive confirmation`, async () => {
    const test = fixture({ deferred: true }), before = test.render(), action = test.open();
    const retained = opener === 'before-modal' ? before : test.render();
    const operation = action.archiveConversation(); await test.dispatched();
    const ticket = test.selection()?.ticket;
    try {
      retained.openArchiveAction();
      expect(test.selection()?.ticket).toBe(ticket); expect(test.archiveFlight.current).toBe(ticket);
    } finally { test.resolve(); await operation; }
    expect(test.requests).toHaveLength(1); expect(test.effects.filter(e => e.kind === 'reload')).toHaveLength(1);
  });
  it('a fresh render can reopen after a pending confirmation row was retired', async () => {
    const test = fixture({ deferred: true }), action = test.open(), operation = action.archiveConversation();
    await test.dispatched();
    test.activeConversationRef.current = { ...test.activeConversationRef.current, is_archived: true };
    test.clear(); test.resolve(); await operation;
    expect(test.effects).toEqual([]);
    // Simulate the next real render adopting the refreshed row without changing
    // owner or authority; its stale modal snapshot must not block a new one.
    test.adoptCurrentRow();
    const oldTicket = test.selection()?.ticket; test.open();
    expect(test.selection()?.ticket).not.toBe(oldTicket); expect(test.archiveFlight.current).toBeNull();
  });
  it('a retained cancel cannot close the newly reopened modal', () => {
    const test = fixture(), old = test.open(); old.closeArchiveAction(); test.open(); const ticket = test.selection()?.ticket;
    test.clear(); old.closeArchiveAction(); expect(test.selection()?.ticket).toBe(ticket); expect(test.effects).toEqual([]);
  });
});
