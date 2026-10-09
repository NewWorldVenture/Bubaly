import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { describe, expect, it } from 'vitest';
import { clearConfirmedDraft, createThreadOwner, mergeThreadRows } from '@/lib/messages/thread-state';
import { settle } from '@/lib/supabase/settle';
import { toggleMessageReaction } from '@/lib/messages/workspace-paths';

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

// Execute the exact current helper/action bodies against the installed SDK.
// React render scheduling is explicit here; browser controls below use React.
const sendAst = ts.createSourceFile('messages.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const sendNames = new Set(['sameArchiveRow', 'isCurrentMessageOrigin', 'isCurrentMessageOperation', 'beginMessageOperation', 'confirmsMessage', 'insertMessage', 'sendMessage', 'sendGif', 'sendFile', 'rememberAttachment', 'discardAttachment']);
const sendBodies: string[] = [];
function collectSendBodies(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name && sendNames.has(node.name.text)) sendBodies.push(node.getText(sendAst)); ts.forEachChild(node, collectSendBodies); }
collectSendBodies(sendAst);
if (sendBodies.length !== sendNames.size) throw new Error('The finite send helper graph changed.');
const sendCompiled = ts.transpileModule(sendBodies.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
type SendRow = Record<string, unknown>;
type SendDraft = { text: string; reply: SendRow | null; edit: SendRow | null };
function sendFixture({ defer = '' as 'message' | 'upload' | 'check' | 'remove' | '', fail = '' as 'denied' | 'lost' | 'zero' | 'wrong' | '', edit = false } = {}) {
  const owner = { current: createThreadOwner() }; owner.current.select(A);
  let scope: Scope = { familyId: FAMILY, userId: USER, role: 'parent', memberId: 'member-a', active: true };
  let activeConv = conversation(A, USER), renderedDraft: SendDraft = { text: 'Original draft', reply: null, edit: edit ? { id: 'edited', family_id: FAMILY, conversation_id: A, sender_id: USER } : null };
  const archiveScopeRef = { current: scope }, activeConversationRef = { current: activeConv }, draftRef = { current: renderedDraft }, alive = { current: true };
  const sendFlight = { current: null as unknown }, uploadFlight = { current: null as unknown }, sendRequest = { current: 0 }, sendIds = { current: new Map<string, string>() }, drafts = { current: new Map() };
  const attachmentAttempts = { current: new Map<string, any>() }, failedAttachmentRef = { current: null as any }, uploadLock = { current: false };
  const requests: { method: string; path: string; body: SendRow | null; url: URL }[] = [], effects: { kind: string; value?: unknown }[] = [], saved = new Map<string, SendRow>();
  const pending: { kind: string; resolve: () => void }[] = [];
  let failMode = fail, deferMode = defer;
  async function hold(kind: string) { if (deferMode === kind) await new Promise<void>(resolve => pending.push({ kind, resolve })); }
  const db = createClient<Database>('https://send-sdk-fixture.invalid', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null; requests.push({ method, path: url.pathname, body, url });
    if (url.pathname.includes('/storage/')) {
      await hold(method === 'DELETE' ? 'remove' : 'upload');
      return Response.json(method === 'DELETE' ? [] : { Id: 'synthetic-object', Key: 'family-media/' + url.pathname.split('/family-media/')[1] });
    }
    if (method === 'GET') {
      await hold('check');
      const id = url.searchParams.get('id')?.replace(/^eq[.]/, ''); return Response.json(saved.get(id ?? '') ?? null);
    }
    const id = method === 'PATCH' ? url.searchParams.get('id')?.replace(/^eq[.]/, '') : body?.id;
    const message: SendRow = { id, family_id: FAMILY, conversation_id: A, sender_id: USER, sender_name: 'Synthetic', kind: 'text', reply_to_id: null, attachment_url: null, deleted_at: null, created_at: '2026-10-08T12:00:00Z', ...body };
    if (failMode !== 'denied' && failMode !== 'zero') saved.set(String(id), message);
    await hold('message');
    if (failMode === 'denied' || failMode === 'lost') return Response.json({ code: failMode === 'denied' ? '42501' : '23505', message: 'Synthetic send refusal or response loss' }, { status: 403 });
    if (failMode === 'zero') return Response.json(null);
    if (failMode === 'wrong') return Response.json({ ...message, family_id: 'other-family' });
    return Response.json(message);
  } } });
  function render() {
    const env = { owner, alive, archiveScope: scope, archiveScopeRef, activeConv, activeConversationRef, familyId: scope.familyId, userId: scope.userId, messageOrigin: owner.current.capture(), renderedDraft, draftRef,
      sending: false, editMessage: renderedDraft.edit, sendFlight, uploadFlight, sendRequest, sendIds, drafts, myName: 'Synthetic', createClient: () => db,
      tr: (key: string) => key, describeDbError: (error: { message: string }) => error.message, toastError: (value: unknown) => effects.push({ kind: 'toast', value }),
      setSending: (value: unknown) => effects.push({ kind: 'sending', value }), acceptMessage: (value: unknown) => effects.push({ kind: 'accept', value }),
      clearConfirmedDraft,
      setText: (value: string) => effects.push({ kind: 'draft', value }), setReplyTo: (value: unknown) => effects.push({ kind: 'reply', value }), setEditMessage: (value: unknown) => effects.push({ kind: 'edit', value }),
      inputRef: { current: null }, bottomRef: { current: null }, requestAnimationFrame: () => {}, setShowGifPicker: () => effects.push({ kind: 'gif' }),
      failedAttachment: failedAttachmentRef.current, failedAttachmentRef, attachmentAttempts, uploadLock, uploadingFile: false, recording: false, requestingMic: { current: false },
      familyMediaPath: (family: string, stem: string, name: string) => `${family}/${stem}/${name}`,
      setFailedAttachment: (value: any) => effects.push({ kind: 'attempt', value }), setUploadingFile: (value: unknown) => effects.push({ kind: 'uploading', value }),
      settle: async (query: PromiseLike<unknown>) => query, removeFamilyMedia: (client: typeof db, filePath: string) => client.storage.from('family-media').remove([filePath]),
    };
    return new Function(...Object.keys(env), sendCompiled + ';return {sendMessage,sendGif,sendFile,discardAttachment};')(...Object.values(env)) as { sendMessage: (event: { preventDefault: () => void }) => Promise<void>; sendGif: (url: string, title: string) => Promise<void>; sendFile: (file: File) => Promise<void>; discardAttachment: () => Promise<void> };
  }
  function retire(kind: string) {
    if (kind === 'thread' || kind === 'ABA') { owner.current.select(B); activeConv = conversation(B, USER); activeConversationRef.current = activeConv; if (kind === 'ABA') { owner.current.select(A); activeConv = conversation(A, USER); activeConversationRef.current = activeConv; } }
    if (kind === 'unmount') alive.current = false;
    if (kind === 'scope' || kind === 'inactive') { scope = { ...scope, role: kind === 'scope' ? 'adult' : scope.role, active: kind !== 'inactive' }; archiveScopeRef.current = scope; }
    if (kind === 'draft') { renderedDraft = { ...renderedDraft, text: 'New draft' }; draftRef.current = renderedDraft; }
  }
  async function started(kind: string) { await expect.poll(() => pending.filter(p => p.kind === kind).length).toBe(1); }
  return { render, retire, effects, requests, pending, saved, sendIds, attachmentAttempts, failedAttachmentRef, draftRef,
    started, resolve: () => pending.splice(0).forEach(p => p.resolve()), clear: () => { effects.length = 0; },
    configure: (next: { fail?: typeof fail; defer?: typeof defer }) => { if (next.fail !== undefined) failMode = next.fail; if (next.defer !== undefined) deferMode = next.defer; },
  };
}
const submit = { preventDefault() {} };

describe('render-owned text/edit/GIF/attachment sends through the actual SDK', () => {
  for (const action of ['text', 'edit', 'gif', 'file'] as const) for (const retirement of ['thread', 'ABA', 'unmount', 'scope', 'inactive']) it(`${action} refuses retained ${retirement} origin before dispatch`, async () => {
    const test = sendFixture({ edit: action === 'edit' }), old = test.render(); test.retire(retirement); test.clear();
    if (action === 'gif') await old.sendGif('https://giphy.invalid/synthetic.gif', 'Synthetic GIF');
    else if (action === 'file') await old.sendFile(new File(['synthetic'], 'note.txt', { type: 'text/plain' }));
    else await old.sendMessage(submit);
    expect(test.requests).toEqual([]); expect(test.effects).toEqual([]);
  });
  it('refuses an old rendered draft before dispatch, including a queued pre-render text change', async () => {
    const test = sendFixture(), old = test.render(); test.retire('draft'); await old.sendMessage(submit); expect(test.requests).toEqual([]);
  });
  for (const action of ['text', 'edit', 'gif'] as const) for (const retirement of ['thread', 'ABA', 'unmount', 'scope']) it(`${action} suppresses retired ${retirement} completion and reconciliation`, async () => {
    const test = sendFixture({ defer: 'message', fail: 'lost', edit: action === 'edit' }), old = test.render();
    const operation = action === 'gif' ? old.sendGif('https://giphy.invalid/synthetic.gif', 'Synthetic GIF') : old.sendMessage(submit);
    await test.started('message'); test.retire(retirement); test.clear(); test.resolve(); await operation;
    expect(test.requests).toHaveLength(1); expect(test.effects).toEqual([]);
    if (action !== 'edit') expect(test.sendIds.current.size).toBe(1);
  });
  for (const action of ['text', 'edit', 'gif', 'file'] as const) it(`preserves current ${action} confirmation`, async () => {
    const test = sendFixture({ edit: action === 'edit' }), current = test.render();
    if (action === 'gif') await current.sendGif('https://giphy.invalid/synthetic.gif', 'Synthetic GIF');
    else if (action === 'file') await current.sendFile(new File(['synthetic'], 'note.txt', { type: 'text/plain' }));
    else await current.sendMessage(submit);
    expect(test.effects.filter(e => e.kind === 'accept')).toHaveLength(1); expect(test.effects.some(e => e.kind === 'toast')).toBe(false);
  });
  it('blocks two text submissions before rerender', async () => {
    const test = sendFixture({ defer: 'message' }), current = test.render(), first = current.sendMessage(submit), second = current.sendMessage(submit);
    await test.started('message'); test.resolve(); await Promise.all([first, second]); expect(test.requests).toHaveLength(1);
  });
  it('does not erase a fresh draft when an issued current-visit send finishes', async () => {
    const test = sendFixture({ defer: 'message' }), current = test.render(), operation = current.sendMessage(submit);
    await test.started('message'); test.retire('draft'); test.clear(); test.resolve(); await operation;
    expect(test.effects.filter(e => e.kind === 'accept')).toHaveLength(1); expect(test.effects.filter(e => e.kind === 'draft')).toEqual([]); expect(test.draftRef.current.text).toBe('New draft');
  });
  for (const fail of ['denied', 'zero'] as const) it(`refuses current ${fail} without false confirmation or draft clearing`, async () => {
    const test = sendFixture({ fail }); await test.render().sendMessage(submit);
    expect(test.effects.filter(e => e.kind === 'accept' || e.kind === 'draft')).toEqual([]); expect(test.effects.some(e => e.kind === 'toast')).toBe(true);
  });
  it('reconciles a committed send by exact original ID and expected payload after response loss', async () => {
    const test = sendFixture({ fail: 'lost' }); await test.render().sendMessage(submit);
    expect(test.requests.map(r => r.method)).toEqual(['POST', 'GET']); expect(test.effects.filter(e => e.kind === 'accept')).toHaveLength(1);
    const check = test.requests[1].url; expect(check.searchParams.get('conversation_id')).toBe(`eq.${A}`); expect(check.searchParams.get('sender_id')).toBe(`eq.${USER}`);
  });
  it('does not confirm a mismatched reconciliation payload', async () => {
    const test = sendFixture({ defer: 'check', fail: 'lost' }), operation = test.render().sendMessage(submit);
    await test.started('check'); for (const [id, message] of test.saved) test.saved.set(id, { ...message, content: 'Different saved text' });
    test.resolve(); await operation; expect(test.effects.filter(e => e.kind === 'accept')).toEqual([]); expect(test.effects.some(e => e.kind === 'toast')).toBe(true);
  });
  for (const retirement of ['thread', 'ABA', 'scope', 'unmount']) it(`an upload completed after ${retirement} makes no message dispatch and retains its retry ID`, async () => {
    const test = sendFixture({ defer: 'upload' }), operation = test.render().sendFile(new File(['synthetic'], 'note.txt', { type: 'text/plain' }));
    await test.started('upload'); const attempt = test.attachmentAttempts.current.get(A); test.retire(retirement); test.clear(); test.resolve(); await operation;
    expect(test.requests).toHaveLength(1); expect(test.effects).toEqual([]); expect(test.attachmentAttempts.current.get(A)).toBe(attempt); expect(attempt.uploaded).toBe(true);
  });
  it('a current return to the same chat reuses the uploaded attempt and original message ID', async () => {
    const file = new File(['synthetic'], 'note.txt', { type: 'text/plain' });
    const test = sendFixture({ defer: 'upload' }), operation = test.render().sendFile(file); await test.started('upload');
    const attempt = test.attachmentAttempts.current.get(A); test.retire('ABA'); test.resolve(); await operation;
    test.configure({ defer: '' }); await test.render().sendFile(file);
    expect(test.requests.filter(r => r.path.includes('/storage/'))).toHaveLength(1);
    expect(test.requests.find(r => r.method === 'POST' && r.path.includes('/rest/'))?.body?.id).toBe(attempt.id);
    expect(test.effects.filter(e => e.kind === 'accept')).toHaveLength(1);
  });
  it('a retained discard resolved after selection changes cannot remove an uploaded object or clear a new attempt', async () => {
    const file = new File(['synthetic'], 'note.txt', { type: 'text/plain' }), test = sendFixture({ fail: 'denied' });
    await test.render().sendFile(file); test.configure({ defer: 'check' });
    const operation = test.render().discardAttachment(); await test.started('check'); test.retire('thread'); test.clear(); test.resolve(); await operation;
    expect(test.requests.filter(r => r.method === 'DELETE')).toHaveLength(0); expect(test.effects).toEqual([]);
  });
  it('serializes destructive discard against same-attempt retry and duplicate discard', async () => {
    const file = new File(['synthetic'], 'note.txt', { type: 'text/plain' }), test = sendFixture({ fail: 'denied' });
    await test.render().sendFile(file); const attempt = test.attachmentAttempts.current.get(A);
    test.configure({ fail: '', defer: 'remove' });
    const discard = test.render().discardAttachment(); await test.started('remove');
    await test.render().sendFile(file); await test.render().discardAttachment();
    expect(test.requests.filter(r => r.method === 'POST' && r.path.includes('/rest/'))).toHaveLength(1);
    expect(test.requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
    test.resolve(); await discard;
    expect(test.effects.filter(e => e.kind === 'accept')).toHaveLength(0); expect(attempt.uploaded).toBe(false);
  });
  it('locks cleanup across ABA and reuploads a removed object before the next current send', async () => {
    const file = new File(['synthetic'], 'note.txt', { type: 'text/plain' }), test = sendFixture({ fail: 'denied' });
    await test.render().sendFile(file); test.configure({ fail: '', defer: 'remove' });
    const discard = test.render().discardAttachment(); await test.started('remove'); test.retire('ABA'); test.clear();
    await test.render().sendFile(file);
    expect(test.requests.filter(r => r.method === 'POST' && r.path.includes('/rest/'))).toHaveLength(1);
    test.resolve(); await discard; expect(test.effects).toEqual([]);
    test.configure({ defer: '' }); await test.render().sendFile(file);
    expect(test.requests.filter(r => r.method === 'POST' && r.path.includes('/storage/'))).toHaveLength(2);
    expect(test.effects.filter(e => e.kind === 'accept')).toHaveLength(1);
  });
});

// Finite real callback graph: scope/visit ownership and actual acceptance are
// included; only React state setters and the synthetic transport are boundaries.
const actionNames = new Set(['sameArchiveRow', 'isCurrentMessageOrigin', 'isCurrentMessageOperation', 'beginMessageOperation', 'sameMessageActionRow', 'beginMessageAction', 'currentMessageAction', 'matchesMessageActionResult', 'reactTo', 'deleteMessage', 'pinMessage', 'acceptMessage']);
const actionBodies: string[] = [];
function collectActionBodies(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name && actionNames.has(node.name.text)) actionBodies.push(node.getText(sendAst)); ts.forEachChild(node, collectActionBodies); }
collectActionBodies(sendAst);
if (actionBodies.length !== actionNames.size) throw new Error('The finite message action graph changed.');
const actionCompiled = ts.transpileModule(actionBodies.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
type MessageAction = 'delete' | 'pin' | 'reaction';
type ActionFailure = '' | 'denied' | 'zero' | 'wrong-scope' | 'wrong-result' | 'rejected' | 'missing-rpc';
function messageActionFixture({ deferred = false, failure = '' as ActionFailure, sender = USER, role = 'parent' } = {}) {
  const owner = { current: createThreadOwner() }; owner.current.select(A);
  let scope = { familyId: FAMILY, userId: USER, role, memberId: 'self-member', active: true }, activeConv = conversation(A, USER);
  const message = { id: 'message-a', family_id: FAMILY, conversation_id: A, sender_id: sender, content: 'Original text', edited_at: null, deleted_at: null, is_pinned: false, reactions: {}, created_at: '2026-10-08T12:00:00Z' };
  const alive = { current: true }, archiveScopeRef = { current: scope }, activeConversationRef = { current: activeConv }, messagesRef = { current: [{ ...message }] };
  const messageActionFlight = { current: new Map() }, sendRequest = { current: 0 }, liveRows = { current: new Map() };
  const requests: { url: URL; method: string; body: Record<string, unknown> }[] = [], effects: { kind: string; value?: unknown }[] = [];
  const pending: (() => void)[] = [];
  const db = createClient<Database>('https://message-actions-sdk.invalid', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input)), body = JSON.parse(String(init?.body ?? '{}')); requests.push({ url, method: init?.method ?? 'GET', body });
    if (deferred) await new Promise<void>(resolve => pending.push(resolve));
    if (failure === 'rejected') throw new Error('Synthetic transport rejected');
    if (failure === 'denied') return Response.json({ code: '42501', message: 'Synthetic authorization refusal' }, { status: 403 });
    const reaction = url.pathname.includes('/rpc/');
    // PostgREST before 0475: the reaction RPC is not in the schema cache.
    if (failure === 'missing-rpc' && reaction) return Response.json({ code: 'PGRST202', message: 'Could not find the function public.toggle_family_message_reaction(p_emoji, p_message_id) in the schema cache', details: null, hint: null }, { status: 404 });
    if (failure === 'zero') return Response.json(reaction ? null : []);
    const result = { ...message, ...(!reaction ? body : { reactions: { '👍': [USER] } }), ...(failure === 'wrong-scope' ? { conversation_id: B } : {}), ...(failure === 'wrong-result' ? { deleted_at: null, is_pinned: false } : {}) };
    return Response.json(reaction ? result : [result]);
  } } });
  function render() {
    const env = { owner, alive, archiveScope: scope, archiveScopeRef, activeConv, activeConversationRef, familyId: scope.familyId, userId: scope.userId, messageOrigin: owner.current.capture(), sendRequest, messageActionFlight, messagesRef, liveRows,
      createClient: () => db, settle, mergeThreadRows, toggleMessageReaction, setLegacy0475: () => effects.push({ kind: 'legacy0475' }), setMessages: (update: (rows: typeof messagesRef.current) => unknown) => effects.push({ kind: 'messages', value: update(messagesRef.current) }),
      loadSummaries: async () => { effects.push({ kind: 'summaries' }); }, loadConversations: async () => { effects.push({ kind: 'inbox' }); },
      setMsgMenu: (value: unknown) => effects.push({ kind: 'menu', value }), toastError: (value: unknown) => effects.push({ kind: 'toast', value }), describeDbError: (error: { message: string }) => error.message, tr: (key: string) => key,
    };
    return new Function(...Object.keys(env), actionCompiled + ';return{reactTo,deleteMessage,pinMessage};')(...Object.values(env)) as { reactTo: (message: any, emoji: string) => Promise<void>; deleteMessage: (message: any) => Promise<void>; pinMessage: (message: any) => Promise<void> };
  }
  function retire(kind: string) {
    if (kind === 'thread' || kind === 'ABA') { owner.current.select(B); activeConv = conversation(B, USER); activeConversationRef.current = activeConv; if (kind === 'ABA') { owner.current.select(A); activeConv = conversation(A, USER); activeConversationRef.current = activeConv; } }
    if (kind === 'unmount') alive.current = false;
    if (kind === 'role' || kind === 'inactive') { scope = { ...scope, role: kind === 'role' ? 'child' : scope.role, active: kind !== 'inactive' }; archiveScopeRef.current = scope; }
    if (kind === 'row') messagesRef.current = [{ ...message, sender_id: 'different-sender' }];
  }
  return { render, retire, message, messagesRef, requests, effects, messageActionFlight, pending, resolve: () => pending.splice(0).forEach(resolve => resolve()), started: async () => { await expect.poll(() => pending.length).toBe(1); }, clear: () => { effects.length = 0; } };
}
function invokeMessageAction(callbacks: ReturnType<ReturnType<typeof messageActionFixture>['render']>, action: MessageAction, message: unknown) {
  return action === 'delete' ? callbacks.deleteMessage(message) : action === 'pin' ? callbacks.pinMessage(message) : callbacks.reactTo(message, '👍');
}
describe('render-owned delete, pin and reactions through actual SDK and acceptance', () => {
  for (const action of ['delete', 'pin', 'reaction'] as const) {
    for (const retirement of ['thread', 'ABA', 'unmount', 'role', 'inactive', 'row']) it(`${action} refuses retired ${retirement} before any dispatch or menu effect`, async () => {
      const probe = messageActionFixture(), old = probe.render(); probe.retire(retirement); await invokeMessageAction(old, action, probe.message);
      expect(probe.requests).toEqual([]); expect(probe.effects).toEqual([]);
    });
    for (const retirement of ['thread', 'ABA', 'unmount', 'role', 'row']) it(`${action} suppresses retired ${retirement} completion and reloads`, async () => {
      const probe = messageActionFixture({ deferred: true }), operation = invokeMessageAction(probe.render(), action, probe.message);
      await probe.started(); probe.retire(retirement); probe.clear(); probe.resolve(); await operation;
      expect(probe.requests).toHaveLength(1); expect(probe.effects).toEqual([]);
    });
    it(`${action} preserves current authorized positive and scoped request`, async () => {
      const probe = messageActionFixture(); await invokeMessageAction(probe.render(), action, probe.message);
      expect(probe.requests).toHaveLength(1); expect(probe.effects.filter(effect => effect.kind === 'messages')).toHaveLength(1);
      expect(probe.effects.filter(effect => effect.kind === 'toast')).toEqual([]);
      if (action !== 'reaction') expect(probe.requests[0].url.searchParams.get('conversation_id')).toBe(`eq.${A}`);
      else expect(probe.requests[0].body).toEqual({ p_message_id: probe.message.id, p_emoji: '👍' });
      expect(probe.messageActionFlight.current.size).toBe(0);
    });
    it(`${action} refuses a duplicate queued dispatch before React commits`, async () => {
      const probe = messageActionFixture({ deferred: true }), callbacks = probe.render();
      const first = invokeMessageAction(callbacks, action, probe.message), second = invokeMessageAction(callbacks, action, probe.message);
      await probe.started(); probe.resolve(); await Promise.all([first, second]); expect(probe.requests).toHaveLength(1);
    });
    for (const failure of ['denied', 'zero', 'wrong-scope', 'rejected'] as const) it(`${action} refuses ${failure} without publishing or reloading and remains retryable`, async () => {
      const probe = messageActionFixture({ failure }); await invokeMessageAction(probe.render(), action, probe.message);
      expect(probe.effects.filter(effect => ['messages', 'summaries', 'inbox'].includes(effect.kind))).toEqual([]);
      expect(probe.effects.filter(effect => effect.kind === 'toast')).toHaveLength(1); expect(probe.messageActionFlight.current.size).toBe(0);
    });
  }
  for (const action of ['delete', 'pin'] as const) it(`${action} refuses a response that did not apply its intended change`, async () => {
    const probe = messageActionFixture({ failure: 'wrong-result' }); await invokeMessageAction(probe.render(), action, probe.message);
    expect(probe.effects.filter(effect => effect.kind === 'messages')).toEqual([]); expect(probe.effects.filter(effect => effect.kind === 'toast')).toHaveLength(1);
  });
  it('reaction without 0475 updates the message as before the build-out and accepts the saved row', async () => {
    const probe = messageActionFixture({ failure: 'missing-rpc' }); await invokeMessageAction(probe.render(), 'reaction', probe.message);
    expect(probe.requests.map(request => request.method)).toEqual(['POST', 'PATCH']);
    expect(probe.requests[1].url.pathname).toBe('/rest/v1/family_messages');
    expect(probe.requests[1].body).toEqual({ reactions: { '👍': [USER] } });
    expect(probe.effects.filter(effect => effect.kind === 'toast')).toEqual([]);
    expect(probe.effects.filter(effect => effect.kind === 'messages')).toHaveLength(1);
    expect(probe.effects.filter(effect => effect.kind === 'legacy0475')).toHaveLength(1);
  });
  it('delete cannot dispatch a message owned by someone else, while pin and reaction keep participant semantics', async () => {
    const probe = messageActionFixture({ sender: 'other-user', role: 'child' }); await invokeMessageAction(probe.render(), 'delete', probe.message); expect(probe.requests).toEqual([]);
    await invokeMessageAction(probe.render(), 'pin', probe.message); await invokeMessageAction(probe.render(), 'reaction', probe.message); expect(probe.requests).toHaveLength(2);
  });
});
