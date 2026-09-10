import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const locales = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const source = JSON.parse(readFileSync(`${root}lib/i18n/messages/en-US.json`, 'utf8'));
const keys = Object.keys(source).filter((key) => key.startsWith('mobileAssistant.')).sort();
if (!keys.length) throw new Error('Mobile assistant source catalogue is empty');
const output = {};
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
for (const locale of locales) {
  const messages = JSON.parse(readFileSync(`${root}lib/i18n/messages/${locale}.json`, 'utf8'));
  output[locale] = Object.fromEntries(keys.map((key) => {
    if (typeof messages[key] !== 'string' || !messages[key]) throw new Error(`Missing ${locale} ${key}`);
    if (placeholders(messages[key]) !== placeholders(source[key])) throw new Error(`Placeholder mismatch ${locale} ${key}`);
    return [key, messages[key]];
  }));
}
const path = `${root}mobile/src/lib/assistant-messages.json`;
const content = `${JSON.stringify(output, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== content) throw new Error('Regenerate mobile assistant messages');
} else writeFileSync(path, content);
