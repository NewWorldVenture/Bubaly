// Spoken requests do not outlive their turn.
//
// expo-audio writes each recording to a directory of its own under the app's
// cache — iOS `<cache>/ExpoAudio/recording-<uuid>.m4a` (ios/AudioUtils.swift),
// Android `<cache>/Audio/recording-<uuid>.m4a` (AudioRecorder.kt,
// `File(cacheDirectory, "Audio")`) — and nothing ever removed them:
// `stopAndSend` handed the uri to the transcriber and forgot it, and a device
// sign-out removed only the Keychain session. Every request a member ever
// spoke stayed on the device for whoever signed in next on the same install.
// A recording is deleted once its transcription has settled (success, failure
// or abort), and a sign-out sweeps the cache for any the app left behind (a
// crash mid-turn). The sweep looks INSIDE those two directories: a listing of
// the cache root names them, not what they hold, so a sweep that matched names
// at the root alone took the iOS directory whole and nothing at all on
// Android, where a recording a crash left behind outlived the sign-out.
// Pure — the file system is a parameter, unit-tested from the repo root.

/** iOS: the directory expo-audio makes under the cache. Removed whole, once its recordings have gone one by one. */
export const IOS_RECORDING_DIRECTORY = 'ExpoAudio';
/** Android: the directory expo-audio makes under the cache. The name is generic, so only the recordings in it go, never the directory. */
export const ANDROID_RECORDING_DIRECTORY = 'Audio';
/** The directories under the cache root the sweep descends into. */
export const RECORDING_DIRECTORIES: readonly string[] = [IOS_RECORDING_DIRECTORY, ANDROID_RECORDING_DIRECTORY];
/** Both platforms: the name expo-audio gives a recording. */
export const RECORDING_PREFIX = 'recording-';

export type CacheEntry = {
  name: string;
  directory: boolean;
  /** The directory under the cache root the entry sits in; absent for an entry of the root itself. */
  parent?: string;
  remove: () => Promise<void>;
};

export type RecordingFiles = {
  /** Delete one file by uri; a file that is already gone is not an error. */
  remove: (uri: string) => Promise<void>;
  /** The entries directly under the app's cache directory, and those of each RECORDING_DIRECTORIES member that exists. */
  cacheEntries: () => Promise<CacheEntry[]>;
};

/**
 * Whether a cache entry is a recording, or the iOS directory expo-audio keeps
 * them in. A recording is a `recording-*` file inside one of the recording
 * directories; one at the cache root is taken too (the name is expo-audio's,
 * and nothing else of the app's writes there). Anything else in those
 * directories, a `recording-*` file anywhere else, and the Android `Audio`
 * directory itself are not the sweep's to remove.
 */
export function isRecordingEntry(entry: Pick<CacheEntry, 'name' | 'directory' | 'parent'>): boolean {
  if (entry.directory) return entry.parent === undefined && entry.name === IOS_RECORDING_DIRECTORY;
  if (entry.parent !== undefined && !RECORDING_DIRECTORIES.includes(entry.parent)) return false;
  return entry.name.startsWith(RECORDING_PREFIX);
}

/** Delete a recording once its turn has settled. Never fails the turn: cleanup is best effort, and logged. */
export async function discardRecording(files: RecordingFiles, uri: string): Promise<void> {
  try {
    await files.remove(uri);
  } catch (error) {
    console.warn('[mobile-recordings] recording not removed', error);
  }
}

/** Remove every recording the app left in its cache. Resolves to how many entries were removed. */
export async function sweepRecordings(files: RecordingFiles): Promise<number> {
  let removed = 0;
  const entries = (await files.cacheEntries()).filter(isRecordingEntry);
  // Files before directories: the iOS directory is removed (with whatever is
  // still in it) only after its recordings went one by one, so each removal is
  // its own count and, when it fails, its own warning.
  entries.sort((a, b) => Number(a.directory) - Number(b.directory));
  for (const entry of entries) {
    try {
      await entry.remove();
      removed += 1;
    } catch (error) {
      console.warn('[mobile-recordings] cache entry not removed', entry.parent === undefined ? entry.name : `${entry.parent}/${entry.name}`, error);
    }
  }
  return removed;
}
