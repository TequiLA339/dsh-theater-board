import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicJson } from '../store.mjs';
import { uploadLimits, uploadSizeError } from '../recognition/upload-limits.mjs';
import { moduleDefinitions } from '../modules.mjs';
import { renderV10Dashboard } from '../real-data/v10-template.mjs';
import { prepareWebsiteRelease } from './exporter.mjs';
import { syncWebsiteRelease, websiteOrigin, websiteRequest } from './client.mjs';

const PROJECT = fileURLToPath(new URL('../../../', import.meta.url));
const IDS = new Set(moduleDefinitions.map(item => item.id));
const jsonRead = async (path, fallback) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } };
async function readBody(request, limit = 32_768, limitMessage = () => '上传内容超过允许大小。') {
  if (Number(request.headers['content-length']) > limit) throw new Error(limitMessage(Number(request.headers['content-length'])));
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error(limitMessage(size)); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export async function createWebsiteSyncServer({ port = 4188, dataDir = resolve(PROJECT, '本机后台数据'), workDir = resolve(PROJECT, '本机后台数据/website-sync'), uploadOrigin = 'http://127.0.0.1:4180', prepare = prepareWebsiteRelease, render = renderV10Dashboard, synchronize = syncWebsiteRelease, fetchImpl = fetch } = {}) {
  dataDir = resolve(dataDir); workDir = resolve(workDir);
  const uploadURL = new URL(uploadOrigin);
  if (!['127.0.0.1', 'localhost'].includes(uploadURL.hostname) || uploadURL.protocol !== 'http:') throw new Error('上传后台必须位于本机。');
  await mkdir(resolve(workDir, 'releases'), { recursive: true, mode: 0o700 });
  const stateFile = resolve(workDir, 'state.json'), configFile = resolve(workDir, 'settings.json');
  let state = await jsonRead(stateFile, { schemaVersion: 1, candidate: null, approvedRelease: null, published: null, uploadAttempts: {}, events: [] });
  if (state.schemaVersion !== 1 || !Array.isArray(state.events)) throw new Error('网站同步记录损坏，已停止以保护原数据。');
  let config = await jsonRead(configFile, {}), busy = null, candidate = null, actualPort, activeTask = null, writing = false, closing = false;
  const token = randomBytes(32).toString('hex');
  const save = () => atomicJson(stateFile, state);
  const event = (kind, ok, message, revision) => { state.events.unshift({ id: randomUUID(), at: new Date().toISOString(), kind, ok, message, ...(revision ? { revision } : {}) }); state.events = state.events.slice(0, 100); };
  const loadCandidate = async () => {
    if (!state.candidate) throw new Error('请先准备数据并完成本地验收。');
    if (!candidate || candidate.manifest.revision !== state.candidate.revision) {
      const local = await jsonRead(state.candidate.releasePath);
      if (!local) throw new Error('候选资料不存在，请重新准备。');
      if (local.manifest?.revision !== state.candidate.revision
          || local.payloadSha256 !== createHash('sha256').update(JSON.stringify(local.payload)).digest('hex')
          || state.candidate.manifestSha256 && state.candidate.manifestSha256 !== createHash('sha256').update(JSON.stringify(local.manifest)).digest('hex')) throw new Error('候选资料校验失败，请重新准备并验收。');
      candidate = { ...local, releasePath: state.candidate.releasePath };
    }
    return candidate;
  };
  const view = async () => {
    const source = await jsonRead(resolve(dataDir, 'state.json'), { active: {}, uploads: [] });
    return { token, busy, uploadLimits, candidate: state.candidate, published: state.published, events: state.events, uploadAttempts: state.uploadAttempts,
      settings: { siteUrl: config.siteUrl || '', configured: Boolean(config.siteUrl && config.syncKey) },
      modules: moduleDefinitions.map(({ id, title }) => ({ id, title, active: (source.uploads || []).find(item => item.id === source.active?.[id]) || null })), uploadOrigin };
  };
  const json = (response, value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); };
  const guard = (request, write = false) => {
    const origins = [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`];
    if (!origins.some(value => new URL(value).host === request.headers.host) || request.headers['sec-fetch-site'] === 'cross-site') throw new Error('只允许本机访问。');
    if (request.headers.origin && !origins.includes(request.headers.origin)) throw new Error('不接受其他网站发起的请求。');
    if (write && request.headers['x-local-token'] !== token) throw new Error('页面会话已失效，请刷新后重试。');
  };
  const startTask = (kind, run) => {
    if (busy) throw new Error('当前任务尚未结束，请稍后重试。');
    busy = { kind, stage: '正在准备', startedAt: new Date().toISOString() };
    activeTask = Promise.resolve().then(() => run(stage => { busy.stage = stage; })).catch(async error => {
      event(kind, false, error.message); await save();
    }).catch(error => { event(kind, false, `同步记录保存失败：${error.message}`); }).finally(() => { busy = null; activeTask = null; });
  };
  const server = http.createServer(async (request, response) => {
    let ownsWrite = false;
    try {
      const path = new URL(request.url, 'http://localhost').pathname, write = !['GET', 'HEAD'].includes(request.method);
      guard(request, write);
      if (write) {
        if (closing || busy || writing) return json(response, { error: '当前任务尚未结束，请稍后重试。' }, 409);
        writing = true; ownsWrite = true;
      }
      if (path === '/' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'self'" });
        response.end(await readFile(new URL('./local.html', import.meta.url))); return;
      }
      if (path === '/local/state' && request.method === 'GET') return json(response, await view());
      if (path === '/local/preview' && request.method === 'GET') {
        await loadCandidate();
        const filename = resolve(state.candidate.releasePath, '../preview.html');
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN' });
        createReadStream(filename).on('error', () => response.destroy()).pipe(response); return;
      }
      const uploadMatch = /^\/local\/upload\/([^/]+)$/.exec(path);
      if (uploadMatch && request.method === 'POST') {
        const id = uploadMatch[1]; if (!IDS.has(id)) throw new Error('未知板块。');
        busy = { kind: 'upload', stage: '正在上传并校验', startedAt: new Date().toISOString() };
        try {
          const backendResponse = await fetchImpl(`${uploadURL.origin}/api/state`, { signal: AbortSignal.timeout(5000) });
          const backend = await backendResponse.json();
          if (backend.app?.id !== 'theater-command-board-admin' || resolve(backend.app?.dataDir || '') !== dataDir) throw new Error('本机上传后台的数据目录不匹配，请检查启动位置。');
          const bytes = await readBody(request, uploadLimits.fileBytes, uploadSizeError);
          const result = await fetchImpl(`${uploadURL.origin}/api/uploads/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': request.headers['x-filename'] || '', 'X-Local-Token': backend.token }, body: bytes, signal: AbortSignal.timeout(180_000) });
          const outcome = await result.json();
          if (!result.ok) throw new Error([...new Set([outcome.error || outcome.message, ...(outcome.validation?.errors || [])].filter(Boolean))].join('；') || '上传校验失败。');
          state.uploadAttempts[id] = { status: 'success', attemptAt: new Date().toISOString() }; event('upload', true, `${id} 上传校验成功`); await save();
          return json(response, { ok: true });
        } catch (error) {
          state.uploadAttempts[id] = { status: 'failed', attemptAt: new Date().toISOString(), error: error.message }; event('upload', false, error.message); await save(); throw error;
        } finally { busy = null; }
      }
      const body = write ? JSON.parse((await readBody(request)).toString() || '{}') : {};
      if (path === '/local/config' && request.method === 'POST') {
        const siteUrl = websiteOrigin(body.siteUrl);
        const syncKey = body.syncKey || config.syncKey;
        if (typeof syncKey !== 'string' || syncKey.length < 32) throw new Error('请填写网站同步凭据。');
        config = { siteUrl, syncKey }; await atomicJson(configFile, config); return json(response, { ok: true });
      }
      if (path === '/local/bootstrap' && request.method === 'POST') {
        await websiteRequest(config, '/api/bootstrap', { method: 'POST', body: { username: body.username, password: body.password }, fetchImpl });
        event('account', true, '网站管理员已初始化'); await save(); return json(response, { ok: true });
      }
      if (path === '/local/prepare' && request.method === 'POST') {
        startTask('prepare', async onStage => {
          const outputDir = resolve(workDir, 'releases', randomUUID());
          const prepared = await prepare({ dataDir, outputDir, previousRelease: state.approvedRelease || undefined, uploadAttempts: state.uploadAttempts, onStage });
          onStage('正在生成本地验收看板');
          const rendered = await render(prepared.payload);
          await writeFile(resolve(outputDir, 'preview.html'), rendered.html, { flag: 'wx', mode: 0o600 });
          candidate = prepared;
          state.candidate = { revision: prepared.manifest.revision, generatedAt: prepared.manifest.generatedAt, modules: prepared.manifest.modules, scopes: prepared.manifest.scopes.length, releasePath: prepared.releasePath,
            manifestSha256: createHash('sha256').update(JSON.stringify(prepared.manifest)).digest('hex') };
          event('prepare', true, '本地候选已准备，可预览验收', prepared.manifest.revision); await save();
        }); return json(response, { started: true }, 202);
      }
      if (path === '/local/sync' && request.method === 'POST') {
        if (!config.siteUrl || !config.syncKey) throw new Error('请先配置网站地址和同步凭据。');
        const release = await loadCandidate();
        if (body.revision !== release.manifest.revision) throw new Error('验收版本已经变化，请重新查看后同步。');
        state.approvedRelease = release.releasePath; await save();
        startTask('sync', async onStage => {
          const result = await synchronize({ release, config, onStage, fetchImpl });
          state.published = result; event('sync', true, '网站已启用本次验收版本', result.revision); await save();
        }); return json(response, { started: true }, 202);
      }
      return json(response, { error: '接口不存在。' }, 404);
    } catch (error) { if (!response.headersSent) json(response, { error: error.message }, /只允许|会话|其他网站/.test(error.message) ? 403 : 400); else response.destroy(); }
    finally { if (ownsWrite) writing = false; }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  actualPort = server.address().port;
  return { url: `http://127.0.0.1:${actualPort}`, close: async () => { closing = true; if (activeTask) await activeTask; await new Promise(resolveClose => server.close(resolveClose)); } };
}
