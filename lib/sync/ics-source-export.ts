import {
  ImportedSourceValidationError, parseImportedSource,
  type ImportedSourceDocument,
} from '@/lib/calendar/imported-source';
import { parseICSSource } from '@/lib/sync/ics-source';

function fail(message: string): never {
  throw new ImportedSourceValidationError(`ICS export ${message}`);
}

// A missing terminal line break separates fragments; existing folds and line
// endings remain byte-for-byte intact. No temporal/property values are written.
function terminated(raw: string): string { return raw.endsWith('\n') ? raw : `${raw}\r\n`; }

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Export a single complete UID source group, without generating occurrences.
 * Typed-only records cannot be reconstructed faithfully. Every raw fragment is
 * reparsed, and the resulting complete document must agree with stored data.
 */
export function exportICSSource(value: unknown): string {
  const document = parseImportedSource(value);
  const expected: ImportedSourceDocument = document;
  const components = [document.master, ...document.overrides].filter(component => component !== null);
  for (const component of components) {
    if (component.raw === null) fail('requires original raw VEVENT for every component');
    component.raw = terminated(component.raw);
  }
  expected.rawProperties = document.rawProperties.map(terminated);
  for (const zone of expected.timezones) zone.raw = terminated(zone.raw);
  const output = 'BEGIN:VCALENDAR\r\n'
    + expected.rawProperties.join('')
    + expected.timezones.map(zone => zone.raw).join('')
    + components.map(component => component.raw).join('')
    + 'END:VCALENDAR\r\n';
  const reparsed = parseICSSource(output, { etag: document.revision.etag });
  if (reparsed.length !== 1 || stable(reparsed[0]) !== stable(expected)) fail('raw source conflicts with typed document');
  return output;
}
