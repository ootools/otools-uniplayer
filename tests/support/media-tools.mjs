import { isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function configuredMediaTool(name, env = process.env) {
  if (name !== 'ffmpeg' && name !== 'ffprobe') throw new Error('Unknown media tool');
  const override = env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new Error('Media tool override must be absolute');
    return override;
  }
  const suffix = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'macos' : 'macos-intel') : process.platform === 'win32' ? (process.arch === 'arm64' ? 'windows-arm' : 'windows') : (process.arch === 'arm64' ? 'linux-arm' : 'linux');
  const extension = process.platform === 'win32' ? '.exe' : '';
  const packaged = fileURLToPath(new URL(`../../resources/ffmpeg/${suffix}/${name}${extension}`, import.meta.url));
  if (existsSync(packaged)) return packaged;
  return resolve('/opt/homebrew/bin', name);
}
