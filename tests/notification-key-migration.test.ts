import { describe, expect, it } from 'vitest';
import { assertDisposableTarget, assertExpectedDataDirectory, localPsqlEnvironment } from '../scripts/verify-notification-key-migration.mjs';

const target = { BUBALY_DISPOSABLE_PG: '1', PGPORT: '55450', BUBALY_EXPECTED_PG_DATA_DIR: '/tmp/owned-pg' };

describe('notification key verifier only admits an explicit local disposable target', () => {
  it('requires the disposable marker even for localhost', () => {
    expect(() => assertDisposableTarget({ PGHOST: 'localhost' })).toThrow('BUBALY_DISPOSABLE_PG=1');
  });
  it.each(['localhost', '127.0.0.1', '::1', '/tmp/disposable-pg'])('admits local target %s with the marker', (PGHOST) => {
    expect(() => assertDisposableTarget({ ...target, PGHOST })).not.toThrow();
  });
  it.each(['db.production.example', 'localhost.production.example', '127.0.0.1,db.production.example'])('refuses nonlocal or multi-host target %s', (PGHOST) => {
    expect(() => assertDisposableTarget({ ...target, PGHOST })).toThrow('Refusing non-local');
  });
  it('refuses an unspecified port before any server operation', () => {
    expect(() => assertDisposableTarget({ ...target, PGPORT: undefined })).toThrow('explicit valid PGPORT');
  });
  it('refuses an unspecified expected directory before any server operation', () => {
    expect(() => assertDisposableTarget({ ...target, BUBALY_EXPECTED_PG_DATA_DIR: undefined })).toThrow('BUBALY_EXPECTED_PG_DATA_DIR');
  });
  it('refuses a different local cluster even when its host and port were admitted', () => {
    expect(() => assertExpectedDataDirectory('/tmp/owned-pg', '/tmp/unrelated-pg')).toThrow('data_directory mismatch');
    expect(() => assertExpectedDataDirectory('/tmp/owned-pg', '')).toThrow('data_directory mismatch');
    expect(() => assertExpectedDataDirectory('/tmp/owned-pg', '/tmp/owned-pg/')).not.toThrow();
  });
  it('removes inherited libpq target aliases and options while preserving the local password', () => {
    const environment = localPsqlEnvironment({
      PATH: 'test-path', PGPASSWORD: 'disposable-password', PGHOSTADDR: '203.0.113.1',
      PGSERVICE: 'production', PGSERVICEFILE: '/production/services', PGOPTIONS: '-c search_path=unsafe',
      PGHOST: 'db.production.example', PGPORT: '5432', PGDATABASE: 'production',
    });
    expect(environment).toEqual({ PATH: 'test-path', PGPASSWORD: 'disposable-password', PGCONNECT_TIMEOUT: '5' });
  });
});
