import { describe, expect, it } from 'vitest';
import { safeContactText, safeSmsReplyText } from '@/lib/contact-center/text';

describe('Contact Center text boundaries', () => {
  it.each(['plain text', '  keep spaces\r\n', '&<>"\'', '日本語 العربية café', 'a\u{1f600}b', '\u0001\u000b\u001f\u007f\ufffe\uffff'])
    ('preserves valid PostgreSQL scalar text exactly: %j', value => {
      expect(safeContactText(value, value.length)).toBe(value);
    });

  it.each(['plain text', '  keep spaces\r\n', '&<>"\'', '日本語 العربية café', '\t\n\r\u{1f600}\ufffd\u{10ffff}'])
    ('preserves valid XML scalar text exactly: %j', value => {
      expect(safeSmsReplyText(value)).toBe(value);
    });

  it.each(['\u0000', '\ud800', '\udbff', '\udc00', '\udfff'])('replaces a storage-invalid scalar %j', value => {
    expect(safeContactText(`a${value}b`, 3)).toBe('a\ufffdb');
    expect(safeSmsReplyText(`a${value}b`)).toBe('a\ufffdb');
  });

  it.each(['\u0001', '\u000b', '\u000c', '\u001f', '\ufffe', '\uffff'])('replaces only outbound XML-invalid scalar %j', value => {
    expect(safeContactText(value, 1)).toBe(value);
    expect(safeSmsReplyText(value)).toBe('\ufffd');
  });

  it.each([0, 1, 2, 3, 4, 5])('keeps complete scalar pairs within a %i-unit budget', max => {
    const expected = ['', 'a', 'a', 'a\u{1f600}', 'a\u{1f600}b', 'a\u{1f600}bc'][max];
    expect(safeContactText('a\u{1f600}bc', max)).toBe(expected);
    expect(safeSmsReplyText('a\u{1f600}bc', max)).toBe(expected);
  });

  it('never skips a truncated scalar to append later content', () => {
    expect(safeContactText('\u{1f600}a', 1)).toBe('');
    expect(safeContactText('\ud800\ud800\udc00\udc00', 5)).toBe('\ufffd\ud800\udc00\ufffd');
  });

  it.each([1598, 1599, 1600, 4096])('enforces the default SMS budget for %i ASCII units', length => {
    expect(safeSmsReplyText('a'.repeat(length))).toBe('a'.repeat(Math.min(length, 1599)));
  });

  it('keeps the final emoji only when its whole pair fits at the SMS boundary', () => {
    expect(safeSmsReplyText('a'.repeat(1597) + '\u{1f600}')).toBe('a'.repeat(1597) + '\u{1f600}');
    expect(safeSmsReplyText('a'.repeat(1598) + '\u{1f600}')).toBe('a'.repeat(1598));
  });

  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid developer budget %j', max => {
    expect(() => safeContactText('value', max)).toThrow(RangeError);
    expect(() => safeSmsReplyText('value', max)).toThrow(RangeError);
  });
});
