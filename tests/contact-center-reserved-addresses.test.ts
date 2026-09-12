import { describe, expect, it } from 'vitest';
import {
  isValidEmailLocal, isReservedEmailLocal, isClaimableEmailLocal,
  suggestEmailLocal, normalizeEmailLocal, buildBubalyAddress, parseRecipientLocal,
} from '@/lib/contact-center/address';

// Family addresses live in ONE namespace with the company: every family address
// is <local>@bubaly.com, the same domain the product sends and receives on. So
// an unclaimable-name rule is not cosmetic — without it the first family to ask
// receives the mail meant for Bubaly. Uniqueness cannot substitute: a unique
// index happily grants support@bubaly.com to whoever asks first.

describe('reserved local-parts cannot be claimed', () => {
  it.each([
    // operator role addresses — customer and vendor mail
    'admin', 'support', 'billing', 'security', 'legal', 'info', 'help',
    // RFC 2142 / RFC 2821 — the domain must answer these itself
    'postmaster', 'abuse', 'hostmaster', 'webmaster',
    // the product's own sending identities; EMAIL_FROM is on this domain
    'noreply', 'notifications', 'alerts', 'concierge', 'bubaly',
  ])('refuses %s', (local) => {
    expect(isReservedEmailLocal(local)).toBe(true);
    expect(isClaimableEmailLocal(local)).toBe(false);
  });

  it('still treats a reserved name as a VALID local-part', () => {
    // Inbound routing has to recognise support@bubaly.com so the message can be
    // handled at all. It simply must never resolve to a family.
    expect(isValidEmailLocal('support')).toBe(true);
    expect(parseRecipientLocal('Bubaly Support <support@bubaly.com>')).toBe('support');
  });

  // Separators are decoration: the mailbox that receives the mail is what counts.
  it.each(['s-u-p-p-o-r-t', 's.upport', 'sup-port', 'no.reply', 'no-reply', 'post.master'])(
    'cannot be walked around by punctuating it as %s',
    (attempt) => {
      expect(isReservedEmailLocal(attempt)).toBe(true);
      expect(isClaimableEmailLocal(attempt)).toBe(false);
    },
  );

  it.each(['SUPPORT', 'Admin', 'NoReply', '  billing  '])('is case- and whitespace-insensitive for %s', (attempt) => {
    expect(isReservedEmailLocal(attempt)).toBe(true);
  });

  it('leaves ordinary family names claimable', () => {
    for (const local of ['smith', 'the-garcias', 'okonkwo.family', 'nguyen2', 'admin-smith', 'supporters']) {
      expect(isClaimableEmailLocal(local)).toBe(true);
      expect(isReservedEmailLocal(local)).toBe(false);
    }
  });

  it('does not reserve so much that real surnames are lost', () => {
    // A blanket substring rule would eat these; membership is exact-after-strip.
    for (const local of ['helpman', 'newsome', 'rootes', 'legalizo', 'infante']) {
      expect(isClaimableEmailLocal(local)).toBe(true);
    }
  });
});

describe('the suggestion never hands out a reserved name', () => {
  it.each([
    ['The Support Family', 'support'],
    ['Admin Family', 'admin'],
    ['The Legal Family', 'legal'],
  ])('%s is not suggested as %s', (familyName, forbidden) => {
    const suggested = suggestEmailLocal(familyName);
    expect(suggested).not.toBe(forbidden);
    expect(isReservedEmailLocal(suggested)).toBe(false);
    expect(isClaimableEmailLocal(suggested)).toBe(true);
  });

  it('still suggests something usable for ordinary names', () => {
    for (const name of ['The Smith Family', 'Garcia', 'Okonkwo Family', '', null, undefined]) {
      const suggested = suggestEmailLocal(name as string);
      expect(isClaimableEmailLocal(suggested)).toBe(true);
      expect(buildBubalyAddress(suggested)).toMatch(/^[a-z0-9][a-z0-9._-]*@bubaly\.com$/);
    }
  });

  it('normalises before judging, so raw input cannot smuggle a reserved name', () => {
    expect(normalizeEmailLocal('  S U P P O R T  ')).toBe('support');
    expect(isReservedEmailLocal('  S U P P O R T  ')).toBe(true);
  });
});
