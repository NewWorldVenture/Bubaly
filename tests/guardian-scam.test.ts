import { describe, it, expect } from 'vitest';
import { detectScamFromText, SCAM_TYPE_LABELS, type ScamType } from '@/lib/guardian/scam';

describe('detectScamFromText', () => {
  it('treats an ordinary message as safe', () => {
    const r = detectScamFromText('Hi Mom, running late for dinner — see you at 6.');
    expect(r.isScam).toBe(false);
    expect(r.scamType).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.recommendation).toBe('safe');
    expect(r.signals).toEqual([]);
  });

  it('flags a single warranty pattern as low-confidence monitor', () => {
    const r = detectScamFromText("We've been trying to reach you about your car warranty.");
    expect(r.scamType).toBe<ScamType>('warranty_scam');
    expect(r.confidence).toBe(20);
    expect(r.isScam).toBe(false);        // 20 < 50
    expect(r.recommendation).toBe('monitor');
    expect(r.signals).toHaveLength(1);
  });

  it('classifies an IRS/arrest threat', () => {
    const r = detectScamFromText('The IRS has filed a lawsuit and there is an arrest warrant in your name.');
    expect(r.scamType).toBe<ScamType>('irs_scam'); // IRS pattern matched before the arrest pattern
    expect(r.confidence).toBe(40);                 // two patterns × 20
    expect(r.recommendation).toBe('monitor');
  });

  it('blocks the urgency + payment combo (very high risk)', () => {
    const r = detectScamFromText('URGENT: your account was suspended. Send a $500 wire transfer immediately to avoid penalty.');
    // suspended (20) + wire transfer (20) + urgency×payment combo (40) = 80
    expect(r.confidence).toBe(80);
    expect(r.isScam).toBe(true);
    expect(r.recommendation).toBe('block');
    expect(r.signals.join(' ')).toMatch(/Urgency \+ payment/);
  });

  it('adds a signal for a suspicious toll-free caller number', () => {
    const r = detectScamFromText('your vehicle warranty is about to expire', '1-800-123-4567');
    expect(r.signals.join(' ')).toMatch(/Suspicious caller number/);
    expect(r.confidence).toBe(30); // warranty 20 + number 10
  });

  it('recognises a premium-rate (1900) number pattern', () => {
    const withNum = detectScamFromText('press 1 to claim', '1-900-555-0000');
    const withoutNum = detectScamFromText('press 1 to claim');
    expect(withNum.confidence).toBe(withoutNum.confidence + 10);
  });

  it('caps confidence at 100', () => {
    const loud = 'This is an urgent message. Press 1 to continue. Your car warranty expired. '
      + 'The IRS has an arrest warrant. Congratulations you are a winner of a prize! '
      + 'Pay immediately with a gift card and a bitcoin wire transfer right now.';
    const r = detectScamFromText(loud);
    expect(r.confidence).toBe(100);
    expect(r.recommendation).toBe('block');
    expect(r.isScam).toBe(true);
  });

  it('bucket thresholds: safe / monitor / flag / block', () => {
    // confidence 0 → safe; 20 → monitor; then combo pushes into flag/block
    expect(detectScamFromText('hello there').recommendation).toBe('safe');
    expect(detectScamFromText('your auto warranty').recommendation).toBe('monitor');
    // gift card (20, bank_scam) + urgency+payment combo (40) = 60 → flag
    const flag = detectScamFromText('claim your gift card immediately');
    expect(flag.confidence).toBe(60);
    expect(flag.recommendation).toBe('flag');
    expect(flag.scamType).toBe<ScamType>('bank_scam');
  });

  it('detects the grandparent scam', () => {
    const r = detectScamFromText('Grandma, I am in jail and need bail money right away.');
    expect(r.scamType).toBe<ScamType>('grandparent_scam');
    expect(r.confidence).toBeGreaterThanOrEqual(40);
  });

  it('every ScamType has a human label', () => {
    const types: ScamType[] = ['robocall', 'warranty_scam', 'irs_scam', 'grandparent_scam',
      'tech_support_scam', 'prize_scam', 'bank_scam', 'social_security_scam', 'medicare_scam',
      'utility_scam', 'charity_scam', 'romance_scam', 'phishing', 'spoofed_number'];
    for (const t of types) expect(SCAM_TYPE_LABELS[t]).toBeTruthy();
  });
});
