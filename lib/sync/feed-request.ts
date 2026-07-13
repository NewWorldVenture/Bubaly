/** Feed tokens are generated as URL-safe base64 and should stay compact. */
export function isValidFeedToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 16
    && value.length <= 200
    && /^[A-Za-z0-9_-]+$/.test(value);
}
