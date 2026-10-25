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
//
// Where expo-audio puts a recording differs by platform — iOS
// `<cache>/ExpoAudio/recording-*`, Android `<cache>/Audio/recording-*` — and a
// listing of the cache root names those directories, not what they hold. The
// first sweep matched names at the root alone, so on Android it removed
// nothing and a recording a crash left behind outlived the sign-out. The sweep
// now lists inside both directories, removes the recordings it finds there and
// leaves anything else alone.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { VoiceSession, type VoiceContext, type VoiceSessionDependencies } from '../mobile/src/lib/voice-session';
import { discardRecording, isRecordingEntry, sweepRecordings, type CacheEntry, type RecordingFiles } from '../mobile/src/lib/recordings';
import { signOutAndSweep } from '../mobile/src/lib/sign-out';

// ── expo-file-system, in memory ─────────────────────────────────────────────
// The Directory / File / Paths surface recording-files.ts uses, over a set of
// paths. A Directory's `delete()` takes what is inside it and `list()` on a
// missing directory throws, as the real ones do.
const CACHE = 'file:///data/user/0/com.bubaly.companion/cache';
function inMemoryFileSystem() {
  const directories = new Set<string>();
  const files = new Set<string>();
  type Part = string | { path: string };
  const join = (parts: Part[]) => parts.map((part) => typeof part === 'string' ? part : part.path).join('/');
  const childrenOf = (path: string, set: Set<string>) => [...set].filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'));
  class File {
    readonly path: string;
    constructor(...parts: Part[]) { this.path = join(parts); }
    get name() { return this.path.slice(this.path.lastIndexOf('/') + 1); }
    get exists() { return files.has(this.path); }
    delete() { if (!files.delete(this.path)) throw new Error(`no file ${this.path}`); }
  }
  class Directory {
    readonly path: string;
    constructor(...parts: Part[]) { this.path = join(parts); }
    get name() { return this.path.slice(this.path.lastIndexOf('/') + 1); }
    get exists() { return directories.has(this.path); }
    list() {
      if (!directories.has(this.path)) throw new Error(`no directory ${this.path}`);
      return [...childrenOf(this.path, directories).map((p) => new Directory(p)), ...childrenOf(this.path, files).map((p) => new File(p))];
    }
    delete() {
      if (!directories.has(this.path)) throw new Error(`no directory ${this.path}`);
      for (const p of [...directories]) if (p === this.path || p.startsWith(`${this.path}/`)) directories.delete(p);
      for (const p of [...files]) if (p.startsWith(`${this.path}/`)) files.delete(p);
    }
  }
  const Paths = { get cache() { return new Directory(CACHE); } };
  const seed = (tree: { directories: string[]; files: string[] }) => {
    directories.clear(); files.clear();
    for (const d of tree.directories) directories.add(d);
    for (const f of tree.files) files.add(f);
  };
  return { Directory, File, Paths, seed, paths: () => [...directories, ...files].sort() };
}
const device = inMemoryFileSystem();
const requireMobile = createRequire(new URL('../mobile/package.json', import.meta.url));
const resolveNative = (name: string) => { try { return requireMobile.resolve(name); } catch { return name; } };
vi.doMock(resolveNative('expo-file-system'), () => ({ Directory: device.Directory, File: device.File, Paths: device.Paths }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const URI = `${CACHE}/Audio/recording-7f3a.m4a`;
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
  const entry = (name: string, directory = false, parent?: string): CacheEntry & { removed: () => boolean } => {
    let removed = false;
    return { name, directory, ...(parent === undefined ? {} : { parent }), remove: async () => { removed = true; }, removed: () => removed };
  };

  it('recognises expo-audio’s recordings on both platforms and nothing else', () => {
    // iOS: <cache>/ExpoAudio/recording-*, and the directory itself.
    expect(isRecordingEntry({ name: 'recording-7f3a.m4a', directory: false, parent: 'ExpoAudio' })).toBe(true);
    expect(isRecordingEntry({ name: 'ExpoAudio', directory: true })).toBe(true);
    // Android: <cache>/Audio/recording-* (AudioRecorder.kt), and only that — the
    // directory's name is generic, so neither it nor anything else in it goes.
    expect(isRecordingEntry({ name: 'recording-7f3a.m4a', directory: false, parent: 'Audio' })).toBe(true);
    expect(isRecordingEntry({ name: 'other.mp3', directory: false, parent: 'Audio' })).toBe(false);
    expect(isRecordingEntry({ name: 'Audio', directory: true })).toBe(false);
    // A recording-* file at the cache root is taken too; one anywhere else is not.
    expect(isRecordingEntry({ name: 'recording-7f3a.m4a', directory: false })).toBe(true);
    expect(isRecordingEntry({ name: 'recording-7f3a.m4a', directory: false, parent: 'image-cache' })).toBe(false);
    expect(isRecordingEntry({ name: 'ExpoAudio', directory: false })).toBe(false);
    expect(isRecordingEntry({ name: 'ExpoAudio', directory: true, parent: 'Audio' })).toBe(false);
    expect(isRecordingEntry({ name: 'recording-7f3a.m4a', directory: true })).toBe(false);
    expect(isRecordingEntry({ name: 'image-cache', directory: true })).toBe(false);
    expect(isRecordingEntry({ name: 'ExponentAsset-abc.png', directory: false })).toBe(false);
  });

  it('removes the recordings in both directories and then the ExpoAudio directory, leaves the rest, and counts what it removed', async () => {
    const order: string[] = [];
    const tracked = (name: string, directory = false, parent?: string) => {
      const e = entry(name, directory, parent);
      const remove = e.remove;
      e.remove = async () => { order.push(parent === undefined ? name : `${parent}/${name}`); await remove(); };
      return e;
    };
    const entries = [
      tracked('ExpoAudio', true), tracked('Audio', true), tracked('image-cache', true), tracked('ExponentAsset-abc.png'),
      tracked('recording-1.m4a', false, 'ExpoAudio'), tracked('recording-2.m4a', false, 'Audio'), tracked('other.mp3', false, 'Audio'),
    ];
    const files: RecordingFiles = { remove: vi.fn(), cacheEntries: async () => entries };
    expect(await sweepRecordings(files)).toBe(3);
    expect(entries.map((e) => e.removed())).toEqual([true, false, false, false, true, true, false]);
    // The directory goes last, after each recording in it was removed on its own.
    expect(order).toEqual(['ExpoAudio/recording-1.m4a', 'Audio/recording-2.m4a', 'ExpoAudio']);
  });

  it('keeps going past an entry that cannot be removed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stubborn = { name: 'recording-locked.m4a', directory: false, parent: 'Audio', remove: async () => { throw new Error('EBUSY'); } };
    const other = entry('recording-2.m4a', false, 'Audio');
    expect(await sweepRecordings({ remove: vi.fn(), cacheEntries: async () => [stubborn, other] })).toBe(1);
    expect(other.removed()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toContain('Audio/recording-locked.m4a');
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

describe('the sweep on the device, through expo-file-system', () => {
  // Web CI has no native dependencies; the import is dynamic so the web
  // typecheck does not absorb the mobile TS project (mobile CI checks it).
  const filesModule = '../mobile/src/lib/recording-files';
  const load = async () => (await import(filesModule) as { recordingFiles: RecordingFiles }).recordingFiles;

  it('lists inside ExpoAudio and Audio, removes the recordings there and leaves everything else where it is', async () => {
    device.seed({
      directories: [CACHE, `${CACHE}/ExpoAudio`, `${CACHE}/Audio`, `${CACHE}/image-cache`],
      files: [`${CACHE}/ExpoAudio/recording-a.m4a`, `${CACHE}/Audio/recording-b.m4a`, `${CACHE}/Audio/recording-c.m4a`, `${CACHE}/Audio/other.mp3`, `${CACHE}/image-cache/thumb.png`, `${CACHE}/ExponentAsset-abc.png`],
    });
    const recordingFiles = await load();
    const listed = await recordingFiles.cacheEntries();
    expect(listed.map((e) => (e.parent === undefined ? '' : `${e.parent}/`) + e.name).sort()).toEqual([
      'Audio', 'Audio/other.mp3', 'Audio/recording-b.m4a', 'Audio/recording-c.m4a', 'ExpoAudio', 'ExpoAudio/recording-a.m4a', 'ExponentAsset-abc.png', 'image-cache',
    ]);
    expect(await sweepRecordings(recordingFiles)).toBe(4);
    expect(device.paths()).toEqual([CACHE, `${CACHE}/Audio`, `${CACHE}/Audio/other.mp3`, `${CACHE}/ExponentAsset-abc.png`, `${CACHE}/image-cache`, `${CACHE}/image-cache/thumb.png`].sort());
  });

  it('an iOS cache has no Audio directory and a fresh install has neither: only what exists is listed, and the sweep removes nothing', async () => {
    const recordingFiles = await load();
    device.seed({ directories: [CACHE, `${CACHE}/ExpoAudio`], files: [`${CACHE}/ExpoAudio/recording-a.m4a`] });
    expect(await sweepRecordings(recordingFiles)).toBe(2);
    expect(device.paths()).toEqual([CACHE]);
    device.seed({ directories: [CACHE], files: [`${CACHE}/ExponentAsset-abc.png`] });
    expect(await sweepRecordings(recordingFiles)).toBe(0);
    expect(device.paths()).toEqual([CACHE, `${CACHE}/ExponentAsset-abc.png`]);
  });

  it('remove(uri) deletes that file and is a no-op once it is gone', async () => {
    const recordingFiles = await load();
    device.seed({ directories: [CACHE, `${CACHE}/Audio`], files: [URI, `${CACHE}/Audio/other.mp3`] });
    await recordingFiles.remove(URI);
    expect(device.paths()).toEqual([CACHE, `${CACHE}/Audio`, `${CACHE}/Audio/other.mp3`]);
    await expect(recordingFiles.remove(URI)).resolves.toBeUndefined();
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
