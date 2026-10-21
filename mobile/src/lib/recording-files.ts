// The device's file system, as recordings.ts needs it: expo-file-system's
// File / Directory / Paths behind the small RecordingFiles shape, so the
// cleanup logic stays pure and testable from the repo root. Everything here is
// best effort; a missing file is not an error.
import { Directory, File, Paths } from 'expo-file-system';
import type { RecordingFiles } from './recordings';

export const recordingFiles: RecordingFiles = {
  remove: async (uri) => {
    const file = new File(uri);
    if (file.exists) file.delete();
  },
  cacheEntries: async () => Paths.cache.list().map((entry) => ({
    name: entry.name,
    directory: entry instanceof Directory,
    remove: async () => { if (entry.exists) entry.delete(); },
  })),
};
