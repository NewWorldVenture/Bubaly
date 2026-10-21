// Spoken requests do not outlive their turn.
//
// expo-audio writes each recording to the app's cache directory — iOS under
// `<cache>/ExpoAudio/recording-<uuid>.m4a`, Android as
// `<cache>/recording-<uuid>.m4a` — and nothing ever removed them: `stopAndSend`
// handed the uri to the transcriber and forgot it, and a device sign-out removed
// only the Keychain session. Every request a member ever spoke stayed on the
// device for whoever signed in next on the same install. A recording is
// deleted once its transcription has settled (success, failure or abort), and
// a sign-out sweeps the cache for any the app left behind (a crash mid-turn).
// Pure — the file system is a parameter, unit-tested from the repo root.

/** iOS: the directory expo-audio makes under the cache. */
export const RECORDING_DIRECTORY = 'ExpoAudio';
/** Both platforms: the name expo-audio gives a recording. */
export const RECORDING_PREFIX = 'recording-';

export type CacheEntry = { name: string; directory: boolean; remove: () => Promise<void> };

export type RecordingFiles = {
  /** Delete one file by uri; a file that is already gone is not an error. */
  remove: (uri: string) => Promise<void>;
  /** The entries directly under the app's cache directory. */
  cacheEntries: () => Promise<CacheEntry[]>;
};

/** Whether a cache entry is a recording, or the directory expo-audio keeps them in. */
export function isRecordingEntry(entry: { name: string; directory: boolean }): boolean {
  return entry.directory ? entry.name === RECORDING_DIRECTORY : entry.name.startsWith(RECORDING_PREFIX);
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
  const entries = await files.cacheEntries();
  for (const entry of entries) {
    if (!isRecordingEntry(entry)) continue;
    try {
      await entry.remove();
      removed += 1;
    } catch (error) {
      console.warn('[mobile-recordings] cache entry not removed', entry.name, error);
    }
  }
  return removed;
}
