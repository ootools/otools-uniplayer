import test from 'node:test';
import assert from 'node:assert/strict';
import { startCollector, createProfile } from '../scripts/test-host-playback.mjs';
import { rm, realpath, readFile, stat } from 'node:fs/promises';

test('collector refuses unauthenticated results and takes each native command only once', async () => {
  const collector = await startCollector();
  try {
    const denied = await fetch(`${collector.url}/report`, { method: 'POST', body: JSON.stringify({ event: 'passed' }) });
    assert.equal(denied.status, 403);
    const command = collector.queue('host', { action: 'snapshot' });
    const headers = { Authorization: `Bearer ${collector.token}` };
    assert.deepEqual(await (await fetch(`${collector.url}/command/host`, { headers })).json(), command);
    assert.equal(await (await fetch(`${collector.url}/command/host`, { headers })).json(), null);
    assert.equal(collector.entries.length, 0);
  } finally { await collector.close(); }
});

test('creates a unique canonical 0700 profile without copying any user settings', async () => {
  const profile = await createProfile();
  try {
    assert.equal(await realpath(profile.root), profile.root);
    assert.match(profile.identifier, /^net\.lingyun\.otools\.integration\.[0-9a-f]{32}$/);
    assert.equal((await stat(profile.root)).mode & 0o777, 0o700);
    assert.equal(profile.home, `${profile.root}/home`);
    const state = JSON.parse(await readFile(`${profile.home}/.otools/config.json`, 'utf8'));
    assert.deepEqual(state.fileBindings, [{ ext: 'mp4', pluginUuid: 'otools-uniplayer' }, { ext: 'mkv', pluginUuid: 'otools-uniplayer' }]);
    assert.equal(state.mcp_settings.enabled, false);
    assert.equal(state.basic_settings.globalShortcuts.length, 0);
  } finally { await rm(profile.root, { recursive: true }); }
});
