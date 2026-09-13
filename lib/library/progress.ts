// lib/library/progress.ts
//
// Pure rules about a person's place in an episode. Small, but the one below was
// wrong in a way that quietly destroyed the feature's whole promise, so it is
// stated here as a rule with a name rather than as a condition inside an effect.

/**
 * The Cache Storage bucket offline episodes live in.
 *
 * Named here because two files have to agree on it and one of them is
 * `public/sw.js`, which cannot import: the worker's activate handler deletes
 * every cache it does not recognise, and this one was not on the list, so a
 * deploy quietly destroyed every download a family had made.
 */
export const LIBRARY_CACHE = 'bubaly-library-v1';

/** How far playback must move before another write is worth making. */
export const SAVE_EVERY_SECONDS = 15;

/** The smallest drift worth persisting when a row goes away. */
const UNMOUNT_DRIFT_SECONDS = 5;

/**
 * Should the player write this person's position as the row unmounts?
 *
 * `touched` is the whole question. A row that was never played reports
 * `currentTime` 0, while `lastSaved` starts at the position the person had
 * already reached — so for every part-listened episode on the page the
 * difference looked like real progress backwards, and leaving the page wrote a
 * 0 over each one. Opening the library and navigating away was enough to lose
 * every bookmark in the household, with nothing shown and nothing logged.
 *
 * So: only write what this visit actually played.
 */
export function shouldPersistOnUnmount(
  { touched, currentTime, lastSaved }: { touched: boolean; currentTime: number; lastSaved: number },
): boolean {
  if (!touched) return false;
  if (!Number.isFinite(currentTime) || currentTime < 0) return false;
  return Math.abs(currentTime - lastSaved) >= UNMOUNT_DRIFT_SECONDS;
}

/**
 * Where playback should start.
 *
 * Zero rather than a stored position when the episode was finished, so
 * "play again" does not drop the person at the credits.
 */
export function resumeFrom(
  { positionSeconds, durationSeconds, completed }:
  { positionSeconds: number; durationSeconds: number | null; completed: boolean },
): number {
  if (completed) return 0;
  if (!Number.isFinite(positionSeconds) || positionSeconds <= 0) return 0;
  // Within the last few seconds is the end, and restarting there is no use.
  if (durationSeconds && positionSeconds >= durationSeconds - 5) return 0;
  return Math.floor(positionSeconds);
}

/**
 * Anything that can be told to stop. `HTMLAudioElement` is one; a test's
 * stand-in is another, and that is the point of naming the shape.
 */
export type Pausable = { pause: () => void };

/**
 * The one thing allowed to be making noise.
 *
 * Every row in the library renders its own `<audio>`, so pressing Play on a
 * second episode while the first was going gave you both at once — two voices
 * over each other, and two rows writing a position every fifteen seconds.
 * Module scope rather than React state because the rows are siblings with no
 * shared parent to hold it, and because what is being coordinated is a DOM
 * element rather than a render.
 */
let nowPlaying: Pausable | null = null;

/** Take playback, stopping whatever held it. */
export function claimPlayback(next: Pausable): void {
  if (nowPlaying && nowPlaying !== next) nowPlaying.pause();
  nowPlaying = next;
}

/**
 * Give it up — but only if it is still yours.
 *
 * The guard matters: pausing the outgoing element inside `claimPlayback` fires
 * its `pause` event, which calls this. Releasing unconditionally would then
 * clear the registry the incoming element had just been written into, and the
 * next row to start would find nothing to stop.
 */
export function releasePlayback(current: Pausable): void {
  if (nowPlaying === current) nowPlaying = null;
}

/** Who holds it. Exported for tests; nothing in the app needs to ask. */
export function playbackHolder(): Pausable | null {
  return nowPlaying;
}
