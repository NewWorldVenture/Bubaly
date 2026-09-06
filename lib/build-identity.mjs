/**
 * Accept only a complete SHA-1 revision, never an abbreviated ref or metadata.
 * @param {unknown} value
 * @returns {string | null}
 */
export function parseBuildRevision(value) {
  return typeof value === 'string'
    && value.length === 40
    && /^[0-9a-f]{40}$/i.test(value)
    ? value.toLowerCase()
    : null;
}
