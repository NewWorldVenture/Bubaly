import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLAUDE_FLEET_SCHEMA } from '../lib/claude-fleet/schema.ts';
import { FleetCliError, validateFleetRemoteUrl } from './claude-fleet.mjs';

/**
 * Explicit remote schema initialization; never call from cron or manager request handlers.
 * @param {string[]} args
 * @param {{ env?: Readonly<Record<string, string | undefined>>, createClientImpl?: (config: import('@libsql/client').Config) => Pick<import('@libsql/client').Client, 'batch' | 'execute' | 'close'> }} options
 */
export async function initializeFleetDatabase(args, { env = process.env, createClientImpl } = {}) {
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== '--confirm') throw new FleetCliError('explicit_confirmation_required');
  const url = validateFleetRemoteUrl(env.CLAUDE_FLEET_DATABASE_URL, ['libsql:', 'https:']);
  const authToken = env.CLAUDE_FLEET_DATABASE_AUTH_TOKEN;
  if (typeof authToken !== 'string' || !authToken || authToken !== authToken.trim() || /[\r\n\u0000]/.test(authToken)) throw new FleetCliError('database_token_unconfigured');
  let client;
  try {
    const createClient = createClientImpl ?? (await import('@libsql/client/http')).createClient;
    client = createClient({ url, authToken });
    await client.batch([...CLAUDE_FLEET_SCHEMA], 'write');
    const result = await client.execute('SELECT schema_version, paused FROM claude_fleet_settings WHERE id = 1');
    if (Number(result.rows[0]?.schema_version) !== 1 || ![0, 1].includes(Number(result.rows[0]?.paused))) {
      throw new FleetCliError('schema_initialization_failed');
    }
    return { initialized: true, schemaVersion: 1, paused: Number(result.rows[0].paused) === 1 };
  } catch { throw new FleetCliError('schema_initialization_failed'); }
  finally {
    try { client?.close(); }
    catch { throw new FleetCliError('schema_initialization_failed'); }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(await initializeFleetDatabase(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof FleetCliError ? error.code : 'schema_initialization_failed'}\n`);
    process.exitCode = 1;
  }
}
