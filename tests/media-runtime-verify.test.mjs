import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const loadVerifier = () => import('../scripts/verify-media-runtime.mjs').catch(() => ({}));

// Allowing a non-system load command reintroduces an undeclared installed runtime dependency.
test('dependency verification accepts only macOS system dylibs and rejects Homebrew or loader-relative paths', async () => {
  const { verifyDynamicDependencies } = await loadVerifier();
  assert.equal(typeof verifyDynamicDependencies, 'function', 'verifier must inspect real Mach-O dependencies');
  const system = '/tmp/ffmpeg:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)\n\t/System/Library/Frameworks/VideoToolbox.framework/Versions/A/VideoToolbox (compatibility version 1.0.0, current version 1.0.0)\n';
  assert.deepEqual(verifyDynamicDependencies(system), ['/System/Library/Frameworks/VideoToolbox.framework/Versions/A/VideoToolbox', '/usr/lib/libSystem.B.dylib']);
  for (const dependency of ['/opt/homebrew/opt/x264/lib/libx264.165.dylib', '/usr/local/lib/libavcodec.dylib', '@rpath/libavcodec.dylib', '@loader_path/libavcodec.dylib']) {
    assert.throws(() => verifyDynamicDependencies(`/tmp/ffmpeg:\n\t${dependency} (compatibility version 1.0.0, current version 1.0.0)\n`), /non-system|self-contained/i);
  }
});

// Raising an object's deployment version above the documented minimum silently breaks older macOS installs.
test('deployment verification rejects a binary with a higher minimum macOS version than the target', async () => {
  const { verifyMinimumMacOS } = await loadVerifier();
  assert.equal(typeof verifyMinimumMacOS, 'function', 'verifier must check Mach-O deployment load commands');
  const load = version => `Load command 10\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos ${version}\n      sdk 27.0\n`;
  assert.equal(verifyMinimumMacOS(load('12.0'), '12.0'), '12.0');
  assert.equal(verifyMinimumMacOS(load('11.0'), '12.0'), '11.0');
  assert.throws(() => verifyMinimumMacOS(load('27.0'), '12.0'), /minimum|deployment/i);
  assert.throws(() => verifyMinimumMacOS('Load command 0\ncmd LC_UUID\n', '12.0'), /minimum|deployment/i);
});

// LC_BUILD_VERSION also contains an ld tool version; it is not a deployment version.
test('deployment verification ignores linker/source versions in unrelated Mach-O fields', async () => {
  const { verifyMinimumMacOS } = await loadVerifier();
  const output = 'Load command 11\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos 12.0\n      sdk 27.2\n   ntools 1\n     tool 3\n  version 27106.1\nLoad command 12\n      cmd LC_SOURCE_VERSION\n  cmdsize 16\n  version 99.0\n';
  assert.equal(verifyMinimumMacOS(output, '12.0'), '12.0');
  assert.equal(verifyMinimumMacOS('Load command 1\n      cmd LC_VERSION_MIN_MACOSX\n  cmdsize 16\n  version 11.0\n      sdk 12.0\nLoad command 2\n      cmd LC_SOURCE_VERSION\n  version 99.0\n', '12.0'), '11.0');
});

// Device entries carry a separate lower-case d column; dropping lavfi would falsely reject a usable build.
test('capability verification reads lavfi device columns and refuses missing required codecs', async () => {
  const { verifyCapabilityList } = await loadVerifier();
  assert.equal(typeof verifyCapabilityList, 'function', 'verifier must parse FFmpeg device capability columns');
  assert.doesNotThrow(() => verifyCapabilityList(' D   mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV\n D d lavfi           Libavfilter virtual input device\n', ['lavfi', 'mov,mp4,m4a,3gp,3g2,mj2'], 'demuxer'));
  assert.doesNotThrow(() => verifyCapabilityList(' VFS..D h264 H.264\n A....D aac AAC\n', ['h264', 'aac'], 'decoder'));
  assert.doesNotThrow(() => verifyCapabilityList(' .. scale             V->V       Scale video\n .S tonemap           V->V       Tone map\n .. format            V->V       Pixel format\n', ['scale', 'tonemap', 'format'], 'filter'));
  assert.throws(() => verifyCapabilityList(' VFS..D h264 H.264\n', ['hevc'], 'decoder'), /unavailable.*hevc/i);
});

// Copying Homebrew ffmpeg and setting metadata.selfContained=true must never certify a distributable package.
test('real Homebrew ffmpeg is refused after relocation even if PATH no longer contains Homebrew', { skip: process.platform !== 'darwin' }, async () => {
  const { inspectMacOSExecutable } = await loadVerifier();
  assert.equal(typeof inspectMacOSExecutable, 'function', 'verifier must inspect binaries, not trust metadata claims');
  const dir = await mkdtemp(join(tmpdir(), 'uniplayer-linked-reject-'));
  try {
    await cp('/opt/homebrew/bin/ffmpeg', join(dir, 'ffmpeg'), { dereference: true });
    const dependencies = execFileSync('/usr/bin/otool', ['-L', join(dir, 'ffmpeg')], { encoding: 'utf8' });
    assert.match(dependencies, /\/opt\/homebrew\//);
    await assert.rejects(inspectMacOSExecutable(join(dir, 'ffmpeg'), '12.0'), /non-system|self-contained/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
