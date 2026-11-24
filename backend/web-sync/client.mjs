import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export function websiteOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('网站地址只能填写网站首页地址。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('网站必须使用 HTTPS；本机测试可以使用 loopback 地址。');
  return url.origin;
}

export async function websiteRequest(config, path, { method = 'GET', body, binary = false, fetchImpl = fetch } = {}) {
  const origin = websiteOrigin(config.siteUrl);
  if (typeof config.syncKey !== 'string' || config.syncKey.length < 32) throw new Error('请先配置有效的网站同步凭据。');
  const response = await fetchImpl(`${origin}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${config.syncKey}`, ...(body !== undefined ? { 'Content-Type': binary ? 'application/gzip' : 'application/json' } : {}) },
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let result; try { result = JSON.parse(text); } catch { throw new Error(`网站返回了非数据响应（${response.status}），请检查网站地址和部署状态。`); }
  if (!response.ok) {
    const error = new Error(result.error?.message || result.message || `网站请求失败（${response.status}）。`);
    error.code = result.error?.code || result.code; error.status = response.status; throw error;
  }
  return result;
}

/** One accepted local release owns one immutable remote manifest. A retry never
 * silently rebases an older release over a newer remote publication. */
export async function syncWebsiteRelease({ release, config, onStage = () => {}, fetchImpl = fetch }) {
  const request = (path, options = {}) => websiteRequest(config, path, { ...options, fetchImpl });
  const directory = resolve(release.releasePath, '..');
  const syncPath = resolve(directory, 'sync-manifest.json');
  let manifest;
  try { manifest = JSON.parse(await readFile(syncPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const current = await request('/api/sync/state');
    manifest = { ...release.manifest, baseRevision: current.revision };
    await writeFile(syncPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  }
  const accepted = { ...release.manifest, baseRevision: manifest.baseRevision };
  if (JSON.stringify(manifest) !== JSON.stringify(accepted)
      || !Array.isArray(manifest.scopes) || manifest.scopes.some(scope => !/^[a-f0-9]{64}$/.test(scope.id))) throw new Error('本地同步清单与验收版本不一致。');
  onStage('正在核对线上版本');
  const started = await request('/api/sync/start', { method: 'POST', body: manifest });
  if (started.status !== 'committed') {
    const uploaded = new Set(started.uploaded || []);
    for (let i = 0; i < manifest.scopes.length; i++) {
      const scope = manifest.scopes[i];
      onStage(`正在同步授权数据 ${i + 1} / ${manifest.scopes.length}`);
      if (uploaded.has(scope.id)) continue;
      const bytes = await readFile(resolve(directory, 'objects', `${scope.id}.json.gz`));
      if (bytes.length !== scope.bytes || createHash('sha256').update(bytes).digest('hex') !== scope.sha256) throw new Error('本地验收后的数据包已变化，请重新准备并验收。');
      await request(`/api/sync/objects/${manifest.revision}/${scope.id}`, { method: 'PUT', body: bytes, binary: true });
    }
  }
  onStage('正在启用新版本');
  const committed = await request('/api/sync/commit', { method: 'POST', body: { revision: manifest.revision } });
  if (!committed.active) throw new Error('这个版本曾同步成功，但目前网站已使用其他版本；本次未覆盖线上数据。');
  return { revision: manifest.revision, syncedAt: new Date().toISOString(), siteUrl: websiteOrigin(config.siteUrl) };
}
