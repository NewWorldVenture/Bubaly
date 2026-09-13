import { describe, expect, it } from 'vitest';
import { shouldPersistOnUnmount, resumeFrom } from '@/lib/library/progress';

// "Carry on where you left off" is the whole reason a library beats a folder of
// mp3s, and it was being destroyed by the code meant to protect it.

describe('leaving the page must not cost you your place', () => {
  it('writes nothing for a row that was never played', () => {
    // The bug, exactly. lastSaved starts at the stored position; an <audio>
    // element nobody touched reports currentTime 0. The difference looked like
    // half an hour of progress running backwards, so unmount wrote a 0 over it
    // — for every part-listened episode on the page at once.
    expect(shouldPersistOnUnmount({ touched: false, currentTime: 0, lastSaved: 1800 })).toBe(false);
  });

  it('writes nothing for an untouched row even at position zero', () => {
    expect(shouldPersistOnUnmount({ touched: false, currentTime: 0, lastSaved: 0 })).toBe(false);
  });

  it('writes the last stretch of a row that WAS played', () => {
    // The case the unmount write exists for: closing the tab mid-episode.
    expect(shouldPersistOnUnmount({ touched: true, currentTime: 1850, lastSaved: 1800 })).toBe(true);
  });

  it('does not write a few seconds of drift', () => {
    expect(shouldPersistOnUnmount({ touched: true, currentTime: 1802, lastSaved: 1800 })).toBe(false);
  });

  it('writes when someone scrubs backwards and leaves', () => {
    expect(shouldPersistOnUnmount({ touched: true, currentTime: 60, lastSaved: 1800 })).toBe(true);
  });

  it('refuses a currentTime the element could not give it', () => {
    // A detached or errored <audio> can report NaN.
    expect(shouldPersistOnUnmount({ touched: true, currentTime: Number.NaN, lastSaved: 1800 })).toBe(false);
    expect(shouldPersistOnUnmount({ touched: true, currentTime: -1, lastSaved: 1800 })).toBe(false);
  });
});

describe('where playback starts', () => {
  it('resumes where the person got to', () => {
    expect(resumeFrom({ positionSeconds: 930, durationSeconds: 1961, completed: false })).toBe(930);
  });

  it('starts a finished episode from the beginning, not the credits', () => {
    expect(resumeFrom({ positionSeconds: 1955, durationSeconds: 1961, completed: true })).toBe(0);
    expect(resumeFrom({ positionSeconds: 1959, durationSeconds: 1961, completed: false })).toBe(0);
  });

  it('starts at zero when there is nothing sensible to resume from', () => {
    expect(resumeFrom({ positionSeconds: 0, durationSeconds: 1961, completed: false })).toBe(0);
    expect(resumeFrom({ positionSeconds: Number.NaN, durationSeconds: null, completed: false })).toBe(0);
    expect(resumeFrom({ positionSeconds: -5, durationSeconds: null, completed: false })).toBe(0);
  });

  it('resumes a feed with no declared duration', () => {
    expect(resumeFrom({ positionSeconds: 930, durationSeconds: null, completed: false })).toBe(930);
  });
});
