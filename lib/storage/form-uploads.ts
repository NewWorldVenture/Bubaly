// lib/storage/form-uploads.ts — what an item form put in the bucket, and when
// it may go.
//
// The closet and inventory item forms upload a photo BEFORE the row is saved,
// so for a while the bucket holds an object no row points at, and H2 removes
// it when the form closes unsaved. But "closed" and "unsaved" are not the same
// moment. Cancel, Escape, the X and the backdrop all stayed live while a save
// was in flight, and closing removed the photo at once — then the request that
// was already on its way committed a row pointing at the deleted object (and
// an edit's continuation released the item's previous photo as well, so the
// row kept neither). An upload still in flight when the form closed landed
// after the clean-up and stayed in the public bucket for good (HC1).
//
// So the clean-up waits for the facts, and an object is removed only once no
// row can come to point at it:
//
//   - a confirmed save: the row's previous photo and every other upload go,
//     the saved one stays;
//   - a save the database refused: its photo goes once the form is closed
//     (an open form may still save it);
//   - a save whose reply was lost: it may have committed, so its photo is
//     never removed here — a stray object is the lesser harm than a row
//     pointing at nothing;
//   - a close while a save is in flight: what that save carries waits for its
//     answer; everything else goes now;
//   - an upload that lands after the form closed: removed as it lands.
//
// What a save's completion may do to the SCREEN is not decided here. Its
// clean-up is a storage round trip (or two) during which the form is still
// open, so the person can dismiss it and open another before the save calls
// back; a flag read before that await was stale by then, and closed the new
// form (HD1). The item forms' parents decide it, when the save calls back.

export type SaveOutcome = 'saved' | 'refused' | 'unanswered';

export class FormUploads {
  /** Objects this form uploaded that have not been removed. */
  private uploads: string[] = [];
  /** The photo each save still in flight carries. */
  private inFlight: (string | null)[] = [];
  /** Photos a save may have committed although its reply never came. */
  private unanswered = new Set<string>();
  /** The form was dismissed, or saved: nothing it uploads from here on will be. */
  private closed = false;

  /**
   * @param current The photo the row points at now (null for a new item).
   * @param release Removes objects nothing can point at; it reports its own failures.
   */
  constructor(private current: string | null, private readonly release: (paths: string[]) => Promise<void>) {}

  /** An upload landed. False when the form closed meanwhile: the object is removed, not shown. */
  landed(path: string): boolean {
    if (this.closed) {
      void this.release([path]);
      return false;
    }
    this.uploads.push(path);
    return true;
  }

  /** A save is sending `photo`. Call what this returns with how it ended. */
  send(photo: string | null): (outcome: SaveOutcome) => Promise<void> {
    this.inFlight.push(photo);
    let answered = false;
    return async (outcome) => {
      if (answered) return;
      answered = true;
      const at = this.inFlight.indexOf(photo);
      if (at >= 0) this.inFlight.splice(at, 1);
      if (outcome === 'saved') {
        // The row points at `photo` now; what it pointed at before is free.
        const previous = this.current;
        this.current = photo;
        this.closed = true;
        return this.sweep(previous);
      }
      if (outcome === 'unanswered' && photo) this.unanswered.add(photo);
      if (this.closed) return this.sweep(null);
    };
  }

  /** Cancel, Escape, the X or the backdrop. Safe to call while a save is in flight. */
  dismiss(): Promise<void> {
    this.closed = true;
    return this.sweep(null);
  }

  private sweep(previous: string | null): Promise<void> {
    const kept = new Set<string | null>([this.current, ...this.inFlight, ...this.unanswered]);
    const free = [...new Set([previous, ...this.uploads])].filter((path): path is string => !!path && !kept.has(path));
    this.uploads = this.uploads.filter((path) => kept.has(path));
    return free.length ? this.release(free) : Promise.resolve();
  }
}
