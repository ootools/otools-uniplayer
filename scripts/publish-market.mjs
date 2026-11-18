/** 独立插件发布：显式选择认证方式，秘密仅在当前进程使用，不写入 artifact/job outputs。
 *
 * 与姐妹仓（zitext/linuxdo）的差异：本插件含六平台 sidecar + 各平台媒体运行时，
 * 首版仅 macOS arm64 资产经实机验证，因此固定单合包，并按 dist-pack meta.json
 * 的真实平台列表上报 support 标志——没有的平台如实报 false，不做占位发布。
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('发布服务必须使用 HTTPS');
  return url;
}
function token(value) {
  const result = String(value || '').replace(/^Bearer\s+/i, '');
  if (!result || /\s/.test(result)) throw new Error('认证凭证缺失或格式无效');
  return result;
}
async function jsonRequest(fetcher, url, options = {}) {
  const res = await fetcher(httpsUrl(url), { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`授权或发布请求失败（HTTP ${res.status}）`);
  const data = await res.json();
  if (data.code !== undefined && Number(data.code) !== 200) throw new Error(`授权或发布被拒绝（业务码 ${data.code}）`);
  return data;
}
export async function credential(mode, env, fetcher = fetch, mask = value => console.log(`::add-mask::${value}`)) {
  const keys = { pat: 'XYCLOUD_PAT', login: 'XYCLOUD_LOGIN_TOKEN', shared: 'OTOOLS_MARKET_TOKEN' };
  if (keys[mode]) { const value = token(env[keys[mode]]); mask(value); return value; }
  if (mode !== 'oidc') throw new Error('未知发布认证方式');
  if (!env.XYCLOUD_OIDC_ISSUER || !env.XYCLOUD_PUBLISHER_ID) throw new Error('请先配置 OIDC 兑换地址和可信发布绑定 ID');
  const url = httpsUrl(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience', env.XYCLOUD_OIDC_AUDIENCE || 'otools-ci');
  const github = await jsonRequest(fetcher, url, { headers: { Authorization: `Bearer ${token(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)}` } });
  const jwt = token(github.value); mask(jwt);
  const result = await jsonRequest(fetcher, env.XYCLOUD_OIDC_ISSUER, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publisherId: env.XYCLOUD_PUBLISHER_ID, scope: 'otools:plugin:publish' }) });
  const access = token(result.data?.access_token); mask(access); return access;
}
export function releaseMeta(manifest, override = '', tag = '') {
  const version = override || manifest.version;
  if (typeof version !== 'string' || /\s/.test(version) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('版本号无效');
  const packid = manifest.packid;
  if (typeof packid !== 'string' || packid.length > 128 || /\s/.test(packid) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(packid)) throw new Error('packid 无效');
  if (tag && tag !== `v${version}`) throw new Error('tag 与 plugin.json 版本不一致');
  return { version, packid, release_tag: tag || `plugin-${packid}-v${version}` };
}
/** 同一份生产清单用于包内文件及市场元数据，开发配置保留在源文件中。 */
export function productionManifest(manifest, version = '') {
  const meta = releaseMeta(manifest, version);
  const entry = manifest.entry;
  if (typeof entry !== 'string' || !entry || entry.startsWith('/') || entry.includes('\\') || entry.includes(':') || entry.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('插件 entry 必须是包内相对路径');
  const result = { ...manifest, version: meta.version };
  delete result.devUrl;
  delete result.quickDev;
  return result;
}
export function booleanInput(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw new Error('发布开关必须为 true 或 false');
}
export function releasePlan(env) {
  const event = env.EVENT_NAME || 'workflow_dispatch';
  if (!['push', 'workflow_dispatch'].includes(event)) throw new Error('不允许此事件发布插件');
  if (event === 'push' && !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(env.RELEASE_SOURCE_TAG || '')) throw new Error('只允许版本标签触发自动发布');
  const publish = event === 'push' || !booleanInput(env.DRY_RUN, true);
  const market = event === 'push' ? booleanInput(env.AUTO_PUBLISH_MARKET, false) : booleanInput(env.PUBLISH_MARKET, false);
  return { publish_enabled: publish, market_requested: market, market_enabled: publish && market, validate_release: publish || market };
}
export function validateAuthConfig(mode, env) {
  if (mode === 'pat') {
    if (!/^xy_pat_[0-9a-fA-F]{64}$/.test(token(env.XYCLOUD_PAT))) throw new Error('XYCLOUD_PAT 格式无效，请使用平台个人访问令牌');
  } else if (mode === 'login') token(env.XYCLOUD_LOGIN_TOKEN);
  else if (mode === 'shared') token(env.OTOOLS_MARKET_TOKEN);
  else if (mode === 'oidc') {
    httpsUrl(env.XYCLOUD_OIDC_ISSUER);
    token(env.XYCLOUD_PUBLISHER_ID);
  } else throw new Error('未知发布认证方式');
  if (env.OTOOLS_MARKET_API) httpsUrl(env.OTOOLS_MARKET_API);
}
export function marketPayload(manifest, repo, tag, version, platforms = ['macos']) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')) throw new Error('GitHub 仓库名称无效');
  const list = Array.isArray(platforms) ? platforms : [];
  if (!list.length) throw new Error('至少需要一个已打包平台');
  const base = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;
  // logo 不能用 Release 资产下载链：GitHub 会 302 到 application/octet-stream +
  // Content-Disposition: attachment，Chromium（OTools 的 WebView2）的 <img> 直接
  // 拒载，市场上显示不出图标。改用 raw.githubusercontent.com 上同一 tag 的仓库
  // 文件：返回 image/svg+xml，可直接渲染，且随 tag 固定不会漂移。
  const logo = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(tag)}/logo.svg`;
  const payload = { ...productionManifest(manifest, version), logo,
    supportMacos: list.includes('macos') || list.includes('macos-intel'),
    supportWindows: list.includes('windows') || list.includes('windows-arm'),
    supportLinux: list.includes('linux') || list.includes('linux-arm'),
  };
  const minVersion = String(manifest.minOToolsVersion || manifest.minOtoolsVersion || '').trim();
  delete payload.minOtoolsVersion;
  if (minVersion) payload.minOToolsVersion = minVersion;
  // 本插件 sidecar 逐平台二进制 + 各平台媒体运行时，只有全部六平台资产齐全
  // 才允许分包模式；首版仅 macOS 资产，走单合包。
  payload.packageMode = 0;
  payload.packageUrl = `${base}/${manifest.packid}-${version}.oplg`;
  return payload;
}
export async function publishMarket(url, access, payload, fetcher = fetch) {
  const result = await jsonRequest(fetcher, url, { method: 'POST', headers: { Authorization: `Bearer ${token(access)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (Number(result.code) !== 200) throw new Error('市场未返回明确的成功状态');
  return result;
}
export async function main(env = process.env, fetcher = fetch) {
  if (env[1] === 'preflight') { validateAuthConfig(env.AUTH_MODE, env); console.log('市场认证配置格式检查通过（未请求市场、未发布）'); return; }
  const manifest = JSON.parse(fs.readFileSync(env.PLUGIN_MANIFEST || 'plugin.json', 'utf8'));
  validateAuthConfig(env.AUTH_MODE, env);
  const access = await credential(env.AUTH_MODE, env);
  const packMeta = JSON.parse(fs.readFileSync('dist-pack/meta.json', 'utf8'));
  await publishMarket(env.OTOOLS_MARKET_API || 'https://otools-api.lingyun.net/api/v1/otools/plugin/publish', access,
    marketPayload(manifest, env.GITHUB_REPOSITORY, env.RELEASE_TAG, env.RELEASE_VERSION, packMeta.platforms));
  console.log('插件市场已确认发布成功');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
