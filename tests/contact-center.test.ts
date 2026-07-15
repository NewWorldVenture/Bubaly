import { describe, it, expect } from 'vitest';
import {
  BUBALY_DOMAIN, normalizeEmailLocal, isValidEmailLocal, suggestEmailLocal,
  buildBubalyAddress, channelAddress, parseRecipientLocal,
} from '@/lib/contact-center/address';
import { toE164, isE164, formatPhone } from '@/lib/contact-center/phone';
import {
  classifyIntent, routeInbound, shouldNotifyFamily, summarizeInbound,
  autoReplyText, intentMeta,
} from '@/lib/contact-center/routing';

describe('bubaly address', () => {
  it('normalizes free text to a valid local-part', () => {
    expect(normalizeEmailLocal('The  Smith Family!!')).toBe('thesmithfamily');
    expect(normalizeEmailLocal('a__b--c')).toBe('a.b.c');
    expect(normalizeEmailLocal('.leading.')).toBe('leading');
    expect(normalizeEmailLocal('José García')).toBe('josgarca');
  });
  it('validates length + shape', () => {
    expect(isValidEmailLocal('smith')).toBe(true);
    expect(isValidEmailLocal('a.b-c_d')).toBe(true);
    expect(isValidEmailLocal('ab')).toBe(false);          // too short
    expect(isValidEmailLocal('.bad')).toBe(false);         // leading sep
    expect(isValidEmailLocal('bad.')).toBe(false);         // trailing sep
    expect(isValidEmailLocal('a..b')).toBe(false);         // doubled sep
    expect(isValidEmailLocal('x'.repeat(31))).toBe(false); // too long
  });
  it('suggests a usable local-part from a family name', () => {
    expect(suggestEmailLocal('The Smith Family')).toBe('smith');
    expect(suggestEmailLocal('Los García')).toBe('losgarca');
    const s = suggestEmailLocal('');
    expect(isValidEmailLocal(s)).toBe(true);               // never returns junk
  });
  it('builds full addresses', () => {
    expect(buildBubalyAddress('smith')).toBe(`smith@${BUBALY_DOMAIN}`);
    expect(channelAddress('smith')).toBe('smith@bubaly.com');
    expect(channelAddress(null)).toBeNull();
  });
  it('parses the bubaly recipient from a To header', () => {
    expect(parseRecipientLocal('smith@bubaly.com')).toBe('smith');
    expect(parseRecipientLocal('The Smiths <Smith-Family@Bubaly.com>')).toBe('smith-family');
    expect(parseRecipientLocal('someone@gmail.com, smith@bubaly.com')).toBe('smith');
    expect(parseRecipientLocal('nobody@example.com')).toBeNull();
    expect(parseRecipientLocal('')).toBeNull();
    expect(parseRecipientLocal(null)).toBeNull();
  });
});

describe('phone', () => {
  it('normalizes to E.164', () => {
    expect(toE164('(555) 123-4567')).toBe('+15551234567');
    expect(toE164('555-123-4567')).toBe('+15551234567');
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
    expect(toE164('15551234567')).toBe('+15551234567');
    expect(toE164('123')).toBeNull();
    expect(toE164('')).toBeNull();
    expect(toE164(null)).toBeNull();
  });
  it('validates E.164', () => {
    expect(isE164('+15551234567')).toBe(true);
    expect(isE164('5551234567')).toBe(false);
    expect(isE164('+0123')).toBe(false);
  });
  it('re-exports the display formatter', () => {
    expect(formatPhone('+15551234567')).toBe('(555) 123-4567');
  });
});

describe('concierge routing', () => {
  it('classifies by strongest signal first', () => {
    expect(classifyIntent('This is an emergency, call me ASAP')).toBe('urgent');
    expect(classifyIntent('Can we reschedule the dentist appointment?')).toBe('appointment');
    expect(classifyIntent('Your package is out for delivery')).toBe('delivery');
    expect(classifyIntent('Limited time offer — save $50 on your warranty')).toBe('sales');
    expect(classifyIntent('You have won a gift card, click this link')).toBe('spam');
    expect(classifyIntent('Hey, are we still on for dinner Saturday?')).toBe('personal');
    expect(classifyIntent('')).toBe('other');
  });
  it('routes and decides notification', () => {
    expect(routeInbound('urgent')).toBe('escalate');
    expect(routeInbound('spam')).toBe('file');
    expect(routeInbound('personal')).toBe('auto_reply');
    expect(shouldNotifyFamily('urgent')).toBe(true);
    expect(shouldNotifyFamily('delivery')).toBe(false);
  });
  it('summarizes and truncates', () => {
    expect(summarizeInbound('  hello   world  ')).toBe('hello world');
    expect(summarizeInbound('')).toBe('No message content.');
    const long = 'x'.repeat(200);
    expect(summarizeInbound(long).length).toBe(140);
    expect(summarizeInbound(long).endsWith('…')).toBe(true);
  });
  it('gives an intent-appropriate auto-reply and meta', () => {
    expect(autoReplyText('urgent', 'the Smiths')).toMatch(/urgent/i);
    expect(autoReplyText('sales', 'the Smiths')).toMatch(/sales/i);
    expect(intentMeta('urgent').label).toBe('Urgent');
    expect(intentMeta('nonsense').label).toBe('General');
  });
});
