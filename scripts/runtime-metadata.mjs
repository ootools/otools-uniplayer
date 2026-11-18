import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, sep, isAbsolute } from 'node:path';
import { digest } from './package-common.mjs';

export async function validateRuntimeMetadata(root, target, { formal = false } = {}) {
  const directory = resolve(root, 'resources/ffmpeg', target.suffix);
  const metadata = JSON.parse(await readFile(resolve(directory, 'runtime.json'), 'utf8'));
  if (metadata.platform !== target.suffix || !metadata.source || !metadata.configure || !metadata.license) throw new Error(`Runtime source/license record incomplete: ${target.suffix}`);
  if (!/GPL/.test(metadata.license) || /(?:^|\s)--enable-nonfree(?:\s|$)/.test(metadata.configure)) throw new Error(`Invalid runtime license/configuration: ${target.suffix}`);
  if (!metadata.sha256 || typeof metadata.sha256 !== 'object') throw new Error(`Missing runtime hashes: ${target.suffix}`);
  const extension = target.os === 'win32' ? '.exe' : '';
  for (const tool of ['ffmpeg', 'ffprobe']) if (!metadata.sha256[tool + extension]) throw new Error(`Missing runtime tool hash: ${tool}`);
  const canonicalRoot = await realpath(directory);
  for (const [file, hash] of Object.entries(metadata.sha256)) {
    if (typeof file !== 'string' || isAbsolute(file) || file.includes('\\') || file.split('/').some(segment => !segment || segment === '..' || segment === '.')) throw new Error('Unsafe runtime checksum path');
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Invalid runtime checksum');
    const path = resolve(directory, file);
    const info = await lstat(path);
    const canonical = await realpath(path);
    if (!info.isFile() || info.isSymbolicLink() || !canonical.startsWith(canonicalRoot + sep)) throw new Error('Runtime checksum path escapes its resources');
    if (digest(await readFile(path)) !== hash.toLowerCase()) throw new Error(`Runtime checksum mismatch: ${file}`);
  }
  if (formal && (metadata.redistributable !== true || metadata.selfContained !== true)) throw new Error(`Runtime is not a self-contained distribution: ${target.suffix}`);
  if (metadata.selfContained === true) {
    if (!Array.isArray(metadata.dynamicLibraries) || metadata.dynamicLibraries.some(entry => entry.system !== true)) throw new Error('Self-contained runtime has external dynamic dependencies');
  }
  if (metadata.redistributable === true) {
    if (!Array.isArray(metadata.sourceArchives) || metadata.sourceArchives.length < 2) throw new Error('Redistributable runtime must include corresponding source archives');
    for (const name of ['ffmpeg', 'x264']) {
      const source = metadata.source[name];
      const archive = metadata.sourceArchives.find(entry => entry.name === name);
      if (!source || !archive || !archive.path?.startsWith('sources/') || archive.path !== source.archive || archive.sha256 !== source.sha256 || metadata.sha256[archive.path] !== archive.sha256) throw new Error(`Corresponding source archive mismatch: ${name}`);
      if (!source.url || !source.commit || !source.license || !Array.isArray(source.configure)) throw new Error(`Corresponding source configuration missing: ${name}`);
    }
    if (!Object.keys(metadata.sha256).some(path => path.startsWith('licenses/') && /GPL/.test(path))) throw new Error('Corresponding runtime GPL license is missing');
  }
  return metadata;
}
