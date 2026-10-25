// The device's file system, as recordings.ts needs it: expo-file-system's
// File / Directory / Paths behind the small RecordingFiles shape, so the
// cleanup logic stays pure and testable from the repo root. Everything here is
// best effort; a missing file is not an error.
import { Directory, File, Paths } from 'expo-file-system';
import { RECORDING_DIRECTORIES, type CacheEntry, type RecordingFiles } from './recordings';

const cacheEntry = (item: Directory | File, parent?: string): CacheEntry => ({
  name: item.name,
  directory: item instanceof Directory,
  ...(parent === undefined ? {} : { parent }),
  // A Directory's `delete()` takes what is inside it too.
  remove: async () => { if (item.exists) item.delete(); },
});

export const recordingFiles: RecordingFiles = {
  remove: async (uri) => {
    const file = new File(uri);
    if (file.exists) file.delete();
  },
  cacheEntries: async () => {
    const root = Paths.cache;
    const entries = root.list().map((item) => cacheEntry(item));
    // `list()` is one level deep: it names expo-audio's directories, not the
    // recordings in them, which are what the sweep is for. Each is listed when
    // it exists — `list()` on a directory that does not throws, and an iOS
    // cache has no `Audio`, an Android one no `ExpoAudio`.
    for (const name of RECORDING_DIRECTORIES) {
      const directory = new Directory(root, name);
      if (directory.exists) entries.push(...directory.list().map((item) => cacheEntry(item, name)));
    }
    return entries;
  },
};
