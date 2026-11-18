import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuredMediaTool } from './support/media-tools.mjs';

test('media regression runtime selection honors explicit tools and rejects relative executables', () => {
  assert.equal(configuredMediaTool('ffmpeg', { FFMPEG_PATH: '/runtime/bin/ffmpeg' }), '/runtime/bin/ffmpeg');
  assert.equal(configuredMediaTool('ffprobe', { FFPROBE_PATH: '/runtime/bin/ffprobe' }), '/runtime/bin/ffprobe');
  assert.throws(() => configuredMediaTool('ffmpeg', { FFMPEG_PATH: './ffmpeg' }), /absolute/);
});
