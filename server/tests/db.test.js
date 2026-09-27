import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { redactUri } from '../src/services/db.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('database connection', () => {
  test('redactUri hides credentials in connection strings', () => {
    assert.equal(
      redactUri('mongodb+srv://user:s3cret@cluster0.example.mongodb.net/video-sharing?retryWrites=true'),
      'mongodb+srv://***@cluster0.example.mongodb.net/video-sharing?retryWrites=true',
    );
    assert.equal(redactUri('mongodb://127.0.0.1:27017/video-sharing'), 'mongodb://127.0.0.1:27017/video-sharing');
  });

  test('DNS_SERVERS is optional and parsed from a comma-separated list', () => {
    assert.deepEqual(loadConfig({}).dnsServers, []);
    assert.deepEqual(loadConfig({ DNS_SERVERS: '8.8.8.8, 1.1.1.1,' }).dnsServers, ['8.8.8.8', '1.1.1.1']);
  });

  test('a failed mongodb+srv connection exits cleanly without leaking the password', () => {
    // Starts the real server against an Atlas-style URI whose SRV lookup must fail.
    const result = spawnSync(process.execPath, ['src/server.js'], {
      cwd: serverRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: '5999', // never bound: the process exits before listening
        MONGODB_URI: 'mongodb+srv://someone:SuperSecretPw123@cluster0.nonexistent.invalid',
        DNS_SERVERS: '',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const output = result.stdout + result.stderr;

    assert.equal(result.status, 1, output);
    assert.match(output, /cannot connect to MongoDB at mongodb\+srv:\/\/\*\*\*@cluster0\.nonexistent\.invalid/);
    assert.doesNotMatch(output, /SuperSecretPw123/);
    assert.doesNotMatch(output, /someone:/);
  });
});
