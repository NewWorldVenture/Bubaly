import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CERTIFIED_DEVICES, DEVICE_SETUP_STEPS, DEVICE_TIERS, PROGRAM_DISCLAIMER_KEY,
  deviceCopyKeys, devicesInTier,
} from '@/lib/marketing/certified-devices';
import {
  BUBALY_NEEDS, COMPARE_FAIRNESS_KEY, DEDICATED_NEEDS, DISPLAY_COMPARE_ROWS, NEED_KINDS,
  compareCopyKeys, needsToBuy,
} from '@/lib/marketing/display-compare';

// The two catalogs behind the public family-display page. They are data, so the
// interesting tests are about what the data is allowed to SAY: it is a
// compatibility list, not a partnership; it prices nobody; it crowns nobody.

const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const catalogues = Object.fromEntries(
  LOCALES.map((code) => [code, JSON.parse(readFileSync(`lib/i18n/messages/${code}.json`, 'utf8')) as Record<string, string>]),
);

const ALL_KEYS = [...new Set([...deviceCopyKeys(), ...compareCopyKeys()])];

describe('the device catalog', () => {
  it('puts every device in exactly one published tier', () => {
    const counted = DEVICE_TIERS.flatMap((tier) => devicesInTier(tier));
    expect(counted).toHaveLength(CERTIFIED_DEVICES.length);
    expect(new Set(counted.map((d) => d.id)).size).toBe(CERTIFIED_DEVICES.length);
  });

  it('has both tiers populated — a list with an empty half says nothing', () => {
    for (const tier of DEVICE_TIERS) expect(devicesInTier(tier).length, tier).toBeGreaterThan(0);
  });

  it('keeps ids unique and list order stable inside a tier', () => {
    expect(new Set(CERTIFIED_DEVICES.map((d) => d.id)).size).toBe(CERTIFIED_DEVICES.length);
    expect(devicesInTier('recommended').map((d) => d.id))
      .toEqual(CERTIFIED_DEVICES.filter((d) => d.tier === 'recommended').map((d) => d.id));
  });

  it('gives every row an English label, a catalogue key, a minimum OS, a browser and a stand note', () => {
    for (const device of CERTIFIED_DEVICES) {
      expect(device.label.trim(), device.id).not.toBe('');
      expect(device.labelKey, device.id).toMatch(/^certifiedDevices\./);
      expect(device.standNoteKey, device.id).toMatch(/^certifiedDevices\./);
      expect(device.minOs.trim(), device.id).not.toBe('');
      expect(device.browser.trim(), device.id).not.toBe('');
    }
  });

  it('carries setup steps with both an English label and a key', () => {
    expect(DEVICE_SETUP_STEPS.length).toBeGreaterThanOrEqual(5);
    for (const step of DEVICE_SETUP_STEPS) {
      expect(step.label.trim(), step.id).not.toBe('');
      expect(step.labelKey, step.id).toMatch(/^certifiedDevices\./);
      expect(step.bodyKey, step.id).toMatch(/^certifiedDevices\./);
    }
    expect(new Set(DEVICE_SETUP_STEPS.map((s) => s.id)).size).toBe(DEVICE_SETUP_STEPS.length);
  });

  it('devicesInTier is pure: it filters what it is given and mutates nothing', () => {
    const before = JSON.stringify(CERTIFIED_DEVICES);
    const custom = [{ ...CERTIFIED_DEVICES[0], id: 'x', tier: 'compatible' as const }];
    expect(devicesInTier('compatible', custom).map((d) => d.id)).toEqual(['x']);
    expect(devicesInTier('recommended', custom)).toEqual([]);
    expect(JSON.stringify(CERTIFIED_DEVICES)).toBe(before);
  });
});

describe('the tiers are a compatibility list, and say so', () => {
  it('disclaims certification, partnership and payment, in every language', () => {
    for (const locale of LOCALES) {
      const text = catalogues[locale][PROGRAM_DISCLAIMER_KEY];
      expect(text, `${locale} disclaimer`).toBeTruthy();
      expect(text!.length, `${locale} disclaimer`).toBeGreaterThan(60);
    }
    const en = catalogues['en-US'][PROGRAM_DISCLAIMER_KEY]!;
    expect(en).toMatch(/compatibility list/i);
    expect(en).toMatch(/not a partnership/i);
    expect(en).toMatch(/certifies nothing/i);
    expect(en).toMatch(/takes no money/i);
  });

  it('never claims a certified partner anywhere in the copy', () => {
    for (const locale of LOCALES) {
      for (const key of ALL_KEYS) {
        const text = catalogues[locale][key] ?? '';
        expect(text, `${locale} ${key}`).not.toMatch(/certified partner|official partner|partner program/i);
      }
    }
  });
});

describe('the comparison', () => {
  it('lists what a family needs on both sides, using only the published kinds', () => {
    for (const need of [...BUBALY_NEEDS, ...DEDICATED_NEEDS]) {
      expect(NEED_KINDS, need.id).toContain(need.kind);
      expect(need.labelKey, need.id).toMatch(/^displayCompare\./);
    }
    expect(BUBALY_NEEDS.length).toBeGreaterThan(2);
    expect(DEDICATED_NEEDS.length).toBeGreaterThan(2);
  });

  it('is honest about the asymmetry it is making: Bubaly asks for no purchase, the device does', () => {
    expect(needsToBuy(BUBALY_NEEDS)).toEqual([]);
    expect(needsToBuy(DEDICATED_NEEDS).length).toBeGreaterThan(0);
  });

  it('needsToBuy is pure', () => {
    const before = JSON.stringify(DEDICATED_NEEDS);
    needsToBuy(DEDICATED_NEEDS);
    expect(JSON.stringify(DEDICATED_NEEDS)).toBe(before);
  });

  it('gives every row three keys and a unique id', () => {
    expect(new Set(DISPLAY_COMPARE_ROWS.map((r) => r.id)).size).toBe(DISPLAY_COMPARE_ROWS.length);
    for (const row of DISPLAY_COMPARE_ROWS) {
      for (const key of [row.aspectKey, row.bubalyKey, row.dedicatedKey]) {
        expect(key, row.id).toMatch(/^displayCompare\./);
      }
    }
  });

  it('closes with the line that keeps the table from reading as a verdict', () => {
    const en = catalogues['en-US'][COMPARE_FAIRNESS_KEY]!;
    expect(en).toMatch(/different product/i);
    expect(en).toMatch(/not which one is better/i);
  });
});

describe('what the copy may never contain', () => {
  const texts = LOCALES.flatMap((locale) => ALL_KEYS.map((key) => [`${locale} ${key}`, catalogues[locale][key] ?? ''] as const));

  it('quotes no price, in any currency', () => {
    for (const [where, text] of texts) {
      expect(text, where).not.toMatch(/[$£€]\s?\d/);
      expect(text, where).not.toMatch(/\d+\s?(?:USD|EUR|GBP|dollars?|euros?)/i);
    }
  });

  it('names no competing family-display product', () => {
    for (const [where, text] of texts) {
      // Whole words only: "cozinha" is Portuguese for kitchen, not a rival.
      expect(text, where).not.toMatch(/\b(?:skylight|hearth|cozi|familywall|ohai)\b/i);
    }
  });

  it('crowns nothing', () => {
    const superlatives = /\b(the best|world[- ]class|unbeatable|revolutionary|the ultimate|number one|#1|market[- ]leading|the only (?:way|one|display|product))\b/i;
    for (const [where, text] of texts) {
      expect(text, where).not.toMatch(superlatives);
    }
  });
});

describe('both catalogs are keyed in all seven languages', () => {
  it('collected the keys', () => {
    expect(ALL_KEYS.length).toBeGreaterThan(40);
  });

  it.each(LOCALES)('%s has every catalog key', (locale) => {
    const missing = ALL_KEYS.filter((key) => !catalogues[locale][key]);
    expect(missing, `missing in ${locale}`).toEqual([]);
  });
});
