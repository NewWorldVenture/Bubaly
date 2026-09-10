import { describe, expect, it, vi } from 'vitest';
import { VoiceSession, VoiceSessionError, type VoiceContext, type VoiceSessionDependencies } from '../mobile/src/lib/voice-session';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const reply = { conversationId: 'conversation-1', content: 'Saved', actions: [], cards: [], persisted: true };
function setup() {
  let context: VoiceContext | null = { userId: 'user-1', familyId: 'family-1', memberId: 'member-1', role: 'parent', conversationId: 'conversation-1', token: 'token-1', locale: 'de-DE' };
  const deps = {
    context: () => context,
    freshFamily: vi.fn<VoiceSessionDependencies['freshFamily']>(async () => ({ ok: true as const, family: context })),
    permission: vi.fn(async () => true), audioMode: vi.fn(async (_recording: boolean): Promise<void> => undefined),
    prepare: vi.fn(async (): Promise<void> => undefined), record: vi.fn(), stop: vi.fn(async (): Promise<void> => undefined),
    recordingUri: vi.fn(() => 'file:///voice.m4a'),
    transcribe: vi.fn(async (_context: VoiceContext, _uri: string, _signal: AbortSignal) => 'Buy milk'),
    ask: vi.fn(async (_context: VoiceContext, _text: string, _signal: AbortSignal) => reply),
    phase: vi.fn(), user: vi.fn(), reply: vi.fn(), error: vi.fn(),
  } satisfies VoiceSessionDependencies;
  const flow = new VoiceSession(deps);
  return { flow, deps, setContext: (value: VoiceContext | null) => { context = value; }, context: () => context! };
}

describe('phone turn ownership', () => {
  it('takes the lock before permission resolves; recording excludes text, suggestions, and a second start', async () => {
    const { flow, deps } = setup(); const permission = deferred<boolean>();
    deps.permission.mockReturnValueOnce(permission.promise);
    const start = flow.startRecording();
    await flow.startRecording(); await flow.send('another request');
    await vi.waitFor(() => expect(deps.permission).toHaveBeenCalledTimes(1));
    expect(flow.phase).toBe('preparing'); expect(deps.ask).not.toHaveBeenCalled();
    permission.resolve(true); await start;
    await flow.send('typed while recording'); await flow.startRecording();
    expect(deps.record).toHaveBeenCalledTimes(1); expect(deps.ask).not.toHaveBeenCalled();
    await flow.stopAndSend();
    expect(deps.transcribe).toHaveBeenCalledTimes(1); expect(deps.ask).toHaveBeenCalledTimes(1);
    expect(deps.user).toHaveBeenCalledWith('Buy milk'); expect(deps.reply).toHaveBeenCalledWith(reply);
    expect(deps.audioMode.mock.calls).toEqual([[true], [false]]);
    expect(flow.phase).toBe('idle');
  });

  it.each(['permission', 'audio', 'prepare'] as const)('reset during %s releases native resources and never records or sends', async (stage) => {
    const { flow, deps } = setup(); const pause = deferred<never>();
    if (stage === 'permission') deps.permission.mockReturnValueOnce(pause.promise);
    if (stage === 'audio') deps.audioMode.mockReturnValueOnce(pause.promise);
    if (stage === 'prepare') deps.prepare.mockReturnValueOnce(pause.promise);
    const start = flow.startRecording();
    await vi.waitFor(() => expect(stage === 'permission' ? deps.permission : stage === 'audio' ? deps.audioMode : deps.prepare).toHaveBeenCalled());
    flow.invalidate(); pause.resolve((stage === 'permission' ? true : undefined) as never);
    await start; await flow.settled();
    expect(deps.record).not.toHaveBeenCalled(); expect(deps.ask).not.toHaveBeenCalled();
    expect(deps.error).not.toHaveBeenCalled(); expect(flow.phase).toBe('idle');
    if (stage !== 'permission') expect(deps.audioMode).toHaveBeenLastCalledWith(false);
    if (stage === 'prepare') expect(deps.stop).toHaveBeenCalledTimes(1);
  });

  it('serializes a new recording behind old preparation cleanup without the old failure stopping the new recorder', async () => {
    const { flow, deps, context, setContext } = setup(); const prepare = deferred<void>();
    deps.prepare.mockReturnValueOnce(prepare.promise);
    const oldStart = flow.startRecording();
    await vi.waitFor(() => expect(deps.prepare).toHaveBeenCalledTimes(1));
    flow.invalidate(); setContext({ ...context(), conversationId: 'new-conversation' });
    const newStart = flow.startRecording();
    prepare.resolve(); await Promise.all([oldStart, newStart]); await flow.settled();
    expect(deps.stop).toHaveBeenCalledTimes(1); expect(deps.record).toHaveBeenCalledTimes(1);
    expect(deps.audioMode.mock.calls).toEqual([[true], [false], [true]]);
    expect(flow.phase).toBe('recording');
    await flow.stopAndSend(); expect(deps.ask.mock.calls[0][0].conversationId).toBe('new-conversation');
  });

  it.each(['reset', 'family', 'role', 'signout', 'background', 'unmount'] as const)('invalidates a deferred transcript on %s before it can become an assistant request', async (reason) => {
    const { flow, deps, context, setContext } = setup(); const transcript = deferred<string>();
    deps.transcribe.mockReturnValueOnce(transcript.promise);
    await flow.startRecording(); const stop = flow.stopAndSend();
    await vi.waitFor(() => expect(deps.transcribe).toHaveBeenCalledTimes(1));
    if (reason === 'family') setContext({ ...context(), familyId: 'family-2' });
    if (reason === 'role') setContext({ ...context(), role: 'child' });
    if (reason === 'signout') setContext(null);
    if (reason === 'background' || reason === 'unmount') flow.suspend(); else flow.invalidate();
    expect(deps.transcribe.mock.calls[0][2].aborted).toBe(true);
    transcript.resolve('Do not submit this'); await stop;
    expect(deps.ask).not.toHaveBeenCalled(); expect(deps.user).not.toHaveBeenCalled();
    expect(deps.reply).not.toHaveBeenCalled(); expect(deps.error).not.toHaveBeenCalled();
  });

  it.each(['reset', 'family', 'signout', 'background'] as const)('discards a server reply that completes after %s, even if the transport ignores abort', async (reason) => {
    const { flow, deps, context, setContext } = setup(); const response = deferred<typeof reply>();
    deps.ask.mockReturnValueOnce(response.promise);
    const send = flow.send('Save this');
    await vi.waitFor(() => expect(deps.ask).toHaveBeenCalledTimes(1));
    if (reason === 'family') setContext({ ...context(), familyId: 'family-2' });
    if (reason === 'signout') setContext(null);
    if (reason === 'background') flow.suspend(); else flow.invalidate();
    response.resolve(reply); await send;
    expect(deps.ask.mock.calls[0][2].aborted).toBe(true);
    expect(deps.reply).not.toHaveBeenCalled(); expect(deps.error).not.toHaveBeenCalled();
    // A sent request may already have executed; invalidation only clears the local turn.
    expect(deps.user).toHaveBeenCalledTimes(1);
  });

  it('backgrounding stops an active recording and requires resume before a new turn', async () => {
    const { flow, deps } = setup(); await flow.startRecording();
    flow.suspend(); await flow.settled(); await flow.startRecording(); await flow.send('background');
    expect(deps.stop).toHaveBeenCalledTimes(1); expect(deps.audioMode).toHaveBeenLastCalledWith(false);
    expect(deps.record).toHaveBeenCalledTimes(1); expect(deps.ask).not.toHaveBeenCalled();
    flow.resume(); await flow.send('foreground'); expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it('takes the stop lock synchronously and reset during a deferred stop prevents transcription', async () => {
    const { flow, deps } = setup(); const stopped = deferred<void>();
    await flow.startRecording(); deps.stop.mockReturnValueOnce(stopped.promise);
    const first = flow.stopAndSend(); await flow.stopAndSend(); await flow.send('typed');
    await vi.waitFor(() => expect(deps.stop).toHaveBeenCalledTimes(1));
    flow.invalidate(); stopped.resolve(); await first; await flow.settled();
    expect(deps.transcribe).not.toHaveBeenCalled(); expect(deps.ask).not.toHaveBeenCalled();
    expect(deps.audioMode).toHaveBeenLastCalledWith(false);
  });

  it('restores audio mode after a failed stop, reports failure, and permits a later turn', async () => {
    const { flow, deps } = setup(); const failure = new Error('native stop failed');
    await flow.startRecording(); deps.stop.mockRejectedValueOnce(failure);
    await flow.stopAndSend();
    expect(deps.audioMode).toHaveBeenLastCalledWith(false); expect(deps.error).toHaveBeenCalledWith(failure);
    expect(deps.transcribe).not.toHaveBeenCalled(); expect(flow.phase).toBe('idle');
    await flow.startRecording(); await flow.stopAndSend(); expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it('does not start a new recorder while earlier native cleanup keeps failing', async () => {
    const { flow, deps } = setup(); await flow.startRecording();
    deps.stop.mockRejectedValue(new Error('native stop failed'));
    flow.invalidate(); await flow.settled(); await flow.startRecording();
    expect(deps.record).toHaveBeenCalledTimes(1); expect(deps.audioMode).toHaveBeenLastCalledWith(false);
    expect(deps.error).toHaveBeenCalled(); expect(flow.phase).toBe('idle');
  });

  it('refreshes the family before recording and before transcription; a changed family never reaches either API', async () => {
    const { flow, deps, context } = setup(); await flow.startRecording();
    deps.freshFamily.mockResolvedValueOnce({ ok: true, family: { ...context(), familyId: 'other-family' } });
    await flow.stopAndSend();
    expect(deps.freshFamily).toHaveBeenCalledTimes(2); expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(new VoiceSessionError('mobileAssistant.contextChanged'));
  });

  it('requires a successful current family read before a typed request and remains retryable on failure', async () => {
    const { flow, deps } = setup(); deps.freshFamily.mockResolvedValueOnce({ ok: false, code: 'unavailable' });
    await flow.send('typed'); expect(deps.ask).not.toHaveBeenCalled(); expect(deps.error).toHaveBeenCalled();
    await flow.send('retry'); expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it('rejects a context change before the owner effect runs without getting stuck', async () => {
    const { flow, deps, context, setContext } = setup(); const permission = deferred<boolean>();
    deps.permission.mockReturnValueOnce(permission.promise); const start = flow.startRecording();
    await vi.waitFor(() => expect(deps.permission).toHaveBeenCalled());
    setContext({ ...context(), familyId: 'other-family' }); permission.resolve(true); await start;
    expect(deps.record).not.toHaveBeenCalled(); expect(flow.phase).toBe('idle');
    expect(deps.error).toHaveBeenCalledWith(new VoiceSessionError('mobileAssistant.contextChanged'));
  });

  it('uses the renewed token while retaining the captured family, locale, and conversation', async () => {
    const { flow, deps, context, setContext } = setup(); await flow.startRecording();
    setContext({ ...context(), token: 'renewed-token' }); await flow.stopAndSend();
    expect(deps.transcribe.mock.calls[0][0]).toMatchObject({ token: 'renewed-token', familyId: 'family-1', locale: 'de-DE' });
    expect(deps.ask.mock.calls[0][0]).toMatchObject({ token: 'renewed-token', familyId: 'family-1', conversationId: 'conversation-1' });
  });

  it('allows only one typed request while the assistant response is deferred', async () => {
    const { flow, deps } = setup(); const response = deferred<typeof reply>(); deps.ask.mockReturnValueOnce(response.promise);
    const first = flow.send('first'); await flow.send('second'); await flow.startRecording();
    await vi.waitFor(() => expect(deps.ask).toHaveBeenCalledTimes(1));
    expect(deps.permission).not.toHaveBeenCalled(); response.resolve(reply); await first;
  });

  it('reset during the initial family read prevents microphone permission and typed work', async () => {
    const { flow, deps, context } = setup(); const read = deferred<Awaited<ReturnType<VoiceSessionDependencies['freshFamily']>>>();
    deps.freshFamily.mockReturnValueOnce(read.promise); const start = flow.startRecording();
    expect(flow.phase).toBe('checking'); flow.invalidate(); read.resolve({ ok: true, family: context() }); await start;
    expect(deps.permission).not.toHaveBeenCalled(); expect(deps.ask).not.toHaveBeenCalled(); expect(deps.error).not.toHaveBeenCalled();
  });

  it('permission denial is visible and never acquires audio', async () => {
    const { flow, deps } = setup(); deps.permission.mockResolvedValueOnce(false); await flow.startRecording();
    expect(deps.error).toHaveBeenCalledWith(new VoiceSessionError('mobileAssistant.microphoneDenied'));
    expect(deps.audioMode).not.toHaveBeenCalled(); expect(deps.record).not.toHaveBeenCalled(); expect(flow.phase).toBe('idle');
  });

  it('a failed transcript does not become a request and allows retry', async () => {
    const { flow, deps } = setup(); const error = new Error('transcriber unavailable'); deps.transcribe.mockRejectedValueOnce(error);
    await flow.startRecording(); await flow.stopAndSend(); expect(deps.ask).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(error); expect(flow.phase).toBe('idle');
    await flow.startRecording(); await flow.stopAndSend(); expect(deps.ask).toHaveBeenCalledTimes(1);
  });
});
