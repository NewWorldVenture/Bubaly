// Spoken requests do not outlive their turn (N14).
//
// expo-audio wrote each recording to the app's cache and nothing removed it:
// `stopAndSend` handed the uri to the transcriber and forgot it, `release` and
// `invalidate` stopped the recorder but kept the file, and a device sign-out
// removed only the Keychain session. Every request a member ever spoke stayed
// on the device for whoever signed in next on the same install. The turn
// controller now discards the file once the transcriber has settled — success,
// failure or Stop — and a stopped-but-never-sent recording on release; a device
// sign-out sweeps the cache for anything left behind.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { VoiceSession, type VoiceContext, type VoiceSessionDependencies } from '../mobile/src/lib/voice-session';
import { discardRecording, isRecordingEntry, sweepRecordings, type CacheEntry, type RecordingFiles } from '../mobile/src/lib/recordings';
import { signOutAndSweep } from '../mobile/src/lib/sign-out';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const URI = 'file:///data/user/0/com.bubaly.companion/cache/recording-7f3a.m4a';
const reply = { conversationId: 'conversation-1', content: 'Saved', actions: [], cards: [], persisted: true };
function setup() {
  const context: VoiceContext = { userId: 'user-1', familyId: 'family-1', memberId: 'member-1', role: 'parent', conversationId: 'conversation-1', token: 'token-1', locale: 'en-US' };
  const deps = {
    context: () => context,
    freshFamily: vi.fn<VoiceSessionDependencies['freshFamily']>(async () => ({ ok: true as const, family: context })),
    permission: vi.fn(async () => true), audioMode: vi.fn(async (_recording: boolean): Promise<void> => undefined),
    prepare: vi.fn(async (): Promise<void> => undefined), record: vi.fn(), stop: vi.fn(async (): Promise<void> => undefined),
    recordingUri: vi.fn(() => URI),
    transcribe: vi.fn(async (_context: VoiceContext, _uri: string, _signal: AbortSignal) => 'Buy milk'),
    discard: vi.fn(async (_uri: string): Promise<void> => undefined),
    ask: vi.fn(async (_context: VoiceContext, _text: string, _signal: AbortSignal) => reply),
    phase: vi.fn(), user: vi.fn(), reply: vi.fn(), error: vi.fn(),
  } satisfies VoiceSessionDependencies;
  return { flow: new VoiceSession(deps), deps };
}

describe('the turn controller discards the recording', () => {
  it('after a transcription that succeeded, before the answer is asked for', async () => {
    const { flow, deps } = setup();
    await flow.startRecording(); await flow.stopAndSend();
    expect(deps.discard).toHaveBeenCalledTimes(1);
    expect(deps.discard).toHaveBeenCalledWith(URI);
    expect(deps.discard.mock.invocationCallOrder[0]).toBeGreaterThan(deps.transcribe.mock.invocationCallOrder[0]);
    expect(deps.discard.mock.invocationCallOrder[0]).toBeLessThan(deps.ask.mock.invocationCallOrder[0]);
    expect(deps.reply).toHaveBeenCalledWith(reply);
  });

  it('after a transcription that failed, and the failure is still reported', async () => {
    const { flow, deps } = setup();
    deps.transcribe.mockRejectedValueOnce(new Error('413'));
    await flow.startRecording(); await flow.stopAndSend(); await flow.settled();
    expect(deps.discard).toHaveBeenCalledWith(URI);
    expect(deps.error).toHaveBeenCalledTimes(1);
    expect(flow.phase).toBe('idle');
  });

  it('after Stop during the upload, once the aborted transcriber settles', async () => {
    const { flow, deps } = setup();
    const upload = deferred<string>();
    deps.transcribe.mockReturnValueOnce(upload.promise);
    await flow.startRecording();
    const sending = flow.stopAndSend();
    await vi.waitFor(() => expect(deps.transcribe).toHaveBeenCalledTimes(1));
    expect(deps.discard).not.toHaveBeenCalled();
    flow.invalidate();
    upload.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    await sending; await flow.settled();
    expect(deps.discard).toHaveBeenCalledWith(URI);
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it('when a recording in progress is invalidated: stopped, then removed, never sent', async () => {
    const { flow, deps } = setup();
    await flow.startRecording();
    expect(flow.phase).toBe('recording');
    flow.invalidate(); await flow.settled();
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(deps.discard).toHaveBeenCalledWith(URI);
    expect(deps.transcribe).not.toHaveBeenCalled();
  });

  it('never lets cleanup fail the turn', async () => {
    const { flow, deps } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.discard.mockRejectedValue(new Error('EACCES'));
    await flow.startRecording(); await flow.stopAndSend();
    expect(deps.reply).toHaveBeenCalledWith(reply);
    expect(deps.error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is wired on the assistant screen through expo-file-system', () => {
    const screen = readFileSync('mobile/app/(tabs)/assistant.tsx', 'utf8');
    expect(screen).toMatch(/discard: \(uri\) => discardRecording\(recordingFiles, uri\)/);
    const files = readFileSync('mobile/src/lib/recording-files.ts', 'utf8');
    expect(files).toMatch(/from 'expo-file-system'/);
    expect(files).toMatch(/\.delete\(\)/);
    const pkg = JSON.parse(readFileSync('mobile/package.json', 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['expo-file-system']).toMatch(/^~57\./);
  });
});

describe('the cache sweep', () => {
  const entry = (name: string, directory = false): CacheEntry & { removed: () => boolean } => {
    let removed = false;
    return { name, directory, remove: async () => { removed = true; }, removed: () => removed };
  };

  it('recognises expo-audio’s recordings on both platforms and nothing else', () => {
    expect(isRecordingEntry({ name: 'recording-7f3a.m4a', directory: false })).toBe(true);
    expect(isRecordingEntry({ name: 'ExpoAudio', directory: true })).toBe(true);
    expect(isRecordingEntry({ name: 'ExpoAudio', directory: false })).toBe(false);
    expect(isRecordingEntry({ name: 'recording-7f3a.m4a', directory: true })).toBe(false);
    expect(isRecordingEntry({ name: 'image-cache', directory: true })).toBe(false);
    expect(isRecordingEntry({ name: 'ExponentAsset-abc.png', directory: false })).toBe(false);
  });

  it('removes the recordings and the ExpoAudio directory, leaves the rest, and counts what it removed', async () => {
    const entries = [entry('recording-1.m4a'), entry('ExpoAudio', true), entry('image-cache', true), entry('ExponentAsset-abc.png')];
    const files: RecordingFiles = { remove: vi.fn(), cacheEntries: async () => entries };
    expect(await sweepRecordings(files)).toBe(2);
    expect(entries.map((e) => e.removed())).toEqual([true, true, false, false]);
  });

  it('keeps going past an entry that cannot be removed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stubborn = { name: 'recording-locked.m4a', directory: false, remove: async () => { throw new Error('EBUSY'); } };
    const other = entry('recording-2.m4a');
    expect(await sweepRecordings({ remove: vi.fn(), cacheEntries: async () => [stubborn, other] })).toBe(1);
    expect(other.removed()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('discardRecording removes the file and swallows a failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const remove = vi.fn(async () => {});
    await discardRecording({ remove, cacheEntries: async () => [] }, URI);
    expect(remove).toHaveBeenCalledWith(URI);
    await expect(discardRecording({ remove: async () => { throw new Error('ENOENT'); }, cacheEntries: async () => [] }, URI)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('a device sign-out sweeps the recordings', () => {
  it('runs the sign-out first, then the sweep, and a sweep that fails does not fail the sign-out', async () => {
    const order: string[] = [];
    const signOut = vi.fn(async () => { order.push('sign-out'); });
    const sweep = vi.fn(async () => { order.push('sweep'); return 2; });
    await signOutAndSweep(signOut, sweep)();
    expect(order).toEqual(['sign-out', 'sweep']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(signOutAndSweep(signOut, async () => { throw new Error('EBUSY'); })()).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('does not sweep when the sign-out itself failed — the session is still this person’s', async () => {
    const sweep = vi.fn();
    await expect(signOutAndSweep(async () => { throw new Error('offline'); }, sweep)()).rejects.toThrow('offline');
    expect(sweep).not.toHaveBeenCalled();
  });

  it('is what the device sign-out is composed of', () => {
    const source = readFileSync('mobile/src/lib/supabase.ts', 'utf8');
    expect(source).toMatch(/signOutThisDevice = signOutAndSweep\(createDeviceSignOut\(/);
    expect(source).toMatch(/sweepRecordings\(recordingFiles\)/);
  });
});
