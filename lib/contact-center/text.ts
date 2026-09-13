function boundedText(value: string, max: number, xml: boolean): string {
  if (!Number.isSafeInteger(max) || max < 0) throw new RangeError('Invalid text limit');
  let result = '';
  for (const scalar of value) {
    if (result.length === max) break;
    const point = scalar.codePointAt(0)!;
    const invalid = point === 0 || point >= 0xd800 && point <= 0xdfff
      || xml && !(point === 9 || point === 10 || point === 13 || point >= 32 && point <= 0xd7ff
        || point >= 0xe000 && point <= 0xfffd || point >= 0x10000 && point <= 0x10ffff);
    const next = invalid ? '\ufffd' : scalar;
    if (result.length + next.length > max) break;
    result += next;
  }
  return result;
}

/** PostgreSQL-safe text, bounded in UTF-16 units without splitting a scalar. */
export function safeContactText(value: string, max: number): string {
  return boundedText(value, max, false);
}

/** XML-safe SMS text with a default below Twilio's 1,600-character limit. */
export function safeSmsReplyText(value: string, max = 1599): string {
  return boundedText(value, max, true);
}
