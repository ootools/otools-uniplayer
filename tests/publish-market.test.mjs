import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credential, marketPayload, productionManifest, releaseMeta, releasePlan, validateAuthConfig } from '../scripts/publish-market.mjs';

const manifest = { packid: 'otools-uniplayer', version: '0.1.0', entry: 'dist/index.html', minOtoolsVersion: '0.9.8', devUrl: 'http://127.0.0.1:6576', quickDev: true };

test('release tag follows the market contract and rejects mismatched tags', () => {
  assert.deepEqual(releaseMeta(manifest), { version: '0.1.0', packid: 'otools-uniplayer', release_tag: 'plugin-otools-uniplayer-v0.1.0' });
  assert.deepEqual(releaseMeta(manifest, '', 'v0.1.0').release_tag, 'v0.1.0');
  assert.throws(() => releaseMeta(manifest, '', 'v0.2.0'), /版本不一致/);
  assert.throws(() => releaseMeta({ packid: 'bad id', version: '0.1.0' }), /packid/);
});

test('production manifest strips dev-only fields and keeps the market version', () => {
  const result = productionManifest(manifest, '0.2.0');
  assert.equal(result.version, '0.2.0');
  assert.equal(result.devUrl, undefined);
  assert.equal(result.quickDev, undefined);
  assert.equal(result.entry, 'dist/index.html');
  assert.throws(() => productionManifest({ ...manifest, entry: '/abs/path' }), /entry/);
});

test('market payload reports only verified platforms with a single combined package', () => {
  const payload = marketPayload(manifest, 'ootools/otools-uniplayer', 'plugin-otools-uniplayer-v0.1.0', '0.1.0', ['macos']);
  assert.equal(payload.packageMode, 0);
  assert.equal(payload.packageUrl, 'https://github.com/ootools/otools-uniplayer/releases/download/plugin-otools-uniplayer-v0.1.0/otools-uniplayer-0.1.0.oplg');
  assert.equal(payload.supportMacos, true);
  assert.equal(payload.supportWindows, false);
  assert.equal(payload.supportLinux, false);
  assert.equal(payload.minOToolsVersion, '0.9.8');
  assert.equal(payload.minOtoolsVersion, undefined);
  assert.equal(payload.devUrl, undefined);
  assert.match(payload.logo, /raw\.githubusercontent\.com\/ootools\/otools-uniplayer\/plugin-otools-uniplayer-v0\.1\.0\/logo\.svg/);
  assert.throws(() => marketPayload(manifest, 'ootools/otools-uniplayer', 'plugin-x', '0.1.0', []), /至少需要一个已打包平台/);
});

test('auth config accepts the platform PAT and rejects other shapes', () => {
  validateAuthConfig('pat', { XYCLOUD_PAT: `xy_pat_${'a'.repeat(64)}` });
  assert.throws(() => validateAuthConfig('pat', { XYCLOUD_PAT: 'Bearer xyz' }), /格式无效/);
});

test('credential masks the secret and returns it for PAT mode', async () => {
  const masked = [];
  const pat = `xy_pat_${'b'.repeat(64)}`;
  const value = await credential('pat', { XYCLOUD_PAT: pat }, fetch, value => masked.push(value.slice(0, 7)));
  assert.equal(value, pat);
  assert.deepEqual(masked, ['xy_pat_']);
});
