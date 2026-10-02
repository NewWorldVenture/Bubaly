/**
 * Loads the /blog typeahead index at most once per success, with a bounded,
 * interaction-driven retry when it cannot be loaded.
 *
 * The index used to be fetched once per mount, with any failure read as an
 * empty list — so an outage said "no articles found" for every query until the
 * page was reloaded (review 5372934636). A failure is now its own state, and a
 * later interaction may try again: not sooner than SEARCH_INDEX_RETRY_AFTER_MS
 * after the last failure, so typing through an outage is not a request per key,
 * and not more than SEARCH_INDEX_MAX_ATTEMPTS times per mount.
 *
 * Kept free of React and the DOM so it can be tested in the node test runner;
 * the component supplies fetch, the clock and a state setter.
 */
export type SearchIndexState = 'idle' | 'loading' | 'ready' | 'unavailable';

export const SEARCH_INDEX_RETRY_AFTER_MS = 5_000;
export const SEARCH_INDEX_MAX_ATTEMPTS = 3;

export function createSearchIndexLoader<T>(options: {
  fetchIndex: () => Promise<Response>;
  onChange: (state: SearchIndexState, posts: T[]) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let state: SearchIndexState = 'idle';
  let attempts = 0;
  let failedAt = 0;

  const set = (next: SearchIndexState, posts: T[] = []) => {
    state = next;
    options.onChange(next, posts);
  };

  return {
    get state() { return state; },
    load() {
      // Never two requests at once (focus fires before the first keystroke,
      // and both want the index), and never again after a success.
      if (state === 'loading' || state === 'ready') return;
      if (state === 'unavailable' && (attempts >= SEARCH_INDEX_MAX_ATTEMPTS || now() - failedAt < SEARCH_INDEX_RETRY_AFTER_MS)) return;
      attempts += 1;
      set('loading');
      options.fetchIndex()
        .then(async (response) => {
          if (!response.ok) throw new Error(`search index answered ${response.status}`);
          const data: unknown = await response.json();
          if (!Array.isArray(data)) throw new Error('search index was not a list');
          set('ready', data as T[]);
        })
        // A failed index must never break the page around it; it is reported
        // in the dropdown instead.
        .catch(() => {
          failedAt = now();
          set('unavailable');
        });
    },
  };
}
