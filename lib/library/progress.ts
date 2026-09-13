// lib/library/progress.ts
//
// Pure rules about a person's place in an episode. Small, but the one below was
// wrong in a way that quietly destroyed the feature's whole promise, so it is
// stated here as a rule with a name rather than as a condition inside an effect.

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
