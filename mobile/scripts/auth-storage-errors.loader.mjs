import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, sep } from 'node:path';

// Test-only loader: Node normally chooses auth-js's CJS entry, while Metro can
// select its module entry. Execute the copied ESM files without rewriting them.
const moduleRoot = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'node_modules/@supabase/auth-js/dist/module') + sep).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@supabase/auth-js') return { url: new URL('index.js', moduleRoot).href, shortCircuit: true };
  if (context.parentURL?.startsWith(moduleRoot) && specifier.startsWith('.')) {
    const url = new URL(specifier.endsWith('.js') ? specifier : `${specifier}.js`, context.parentURL).href;
    return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(moduleRoot)) return { format: 'module', source: await readFile(fileURLToPath(url), 'utf8'), shortCircuit: true };
  return nextLoad(url, context);
}
