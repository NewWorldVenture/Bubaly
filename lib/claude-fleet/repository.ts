import 'server-only';
import { createClient } from '@libsql/client/http';
import { fleetDatabaseConfig } from './runtime-config';
import { ClaudeFleetStore } from './store';

/** Deployment uses a remote SQLite primary; handlers never initialize its schema. */
export function openFleetStore(env: NodeJS.ProcessEnv = process.env) {
  const client = createClient(fleetDatabaseConfig(env));
  return { store: new ClaudeFleetStore(client), close: () => client.close() };
}
