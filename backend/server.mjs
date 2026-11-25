import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, appendFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { moduleDefinitions } from './modules.mjs';
import { identifyWorkbook } from './validate-workbook.mjs';
import { validationFingerprint } from './recognition/fingerprint.mjs';
import { uploadLimits, uploadSizeError } from './recognition/upload-limits.mjs';
import { openStore, atomicJson } from './store.mjs';
import { captureSourceSnapshot, verifyGenerationSnapshot } from './real-data/generate-dashboard.mjs';
import { createReviewService, emptyReview } from './review-service.mjs';
import { buildTargetTemplate, targetOrganizations } from './target-template.mjs';
import { AGGREGATE_VERSION, isFlowModule, isUpdatable, isWholeModule, lineageShas, modesFor, receipt as flowReceipt, suggestMode } from './incremental/flow.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
export const DEFAULT_DATA_DIR = resolve(project, '../本机后台数据');
export const APP_ID = 'theater-command-board-admin';
const MAX_BYTES = uploadLimits.fileBytes;
const knownModules = new Set(moduleDefinitions.map(m => m.id));
// How often each board is expected to be refreshed. Only used for reminders.
const CYCLES = ['daily', 'weekly', 'monthly', 'irregular'];
export const DEFAULT_CYCLES = { invoice: 'daily', movement: 'daily', opening: 'daily', terminal: 'weekly', inventory: 'monthly', banquet: 'irregular', target: 'monthly' };
const publicFiles = new Map([['/', ['board.html', 'text/html; charset=utf-8']], ['/board', ['board.html', 'text/html; charset=utf-8']], ['/admin', ['index.html', 'text/html; charset=utf-8']], ['/board.js', ['board.js', 'text/javascript; charset=utf-8']], ['/board.css', ['board.css', 'text/css; charset=utf-8']], ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']], ['/admin.css', ['admin.css', 'text/css; charset=utf-8']]]);
for (const [file, type] of [['review.js', 'text/javascript'], ['review.css', 'text/css']]) publicFiles.set(`/${file}`, [file, `${type}; charset=utf-8`]);

class RequestError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

function workerJob(data, onStage, log) {
  return new Promise((resolveJob, reject) => {
    const worker = new Worker(new URL('./job-worker.mjs', import.meta.url), { workerData: data, resourceLimits: { maxOldGenerationSizeMb: data.kind === 'upload' ? 512 : 1536 } });
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (error) reject(error); else resolveJob(result);
    };
    const timeout = ['generate', 'compose', 'analyze', 'aggregate', 'coverage'].includes(data.kind) ? 300_000 : 120_000;
    const timer = setTimeout(() => finish(new Error(`处理超过${timeout === 300_000 ? '五' : '两'}分钟，请检查文件大小或内容后重试。`)), timeout);
    worker.on('message', message => {
      if (message.stage) onStage(message.stage);
      else if (message.error) { log(message.detail); finish(new Error(message.error)); }
      else if ('result' in message) finish(null, message.result);
    });
    worker.on('error', error => { log(error.stack); finish(new Error('处理进程未能完成，请检查文件是否过大或损坏。')); });
    worker.on('exit', () => { if (!done) finish(new Error('处理进程意外退出，请重试。')); });
  });
}

function filenameFrom(request) {
  let name;
  try { name = decodeURIComponent(request.headers['x-filename'] || ''); }
  catch { throw new RequestError(400, '文件名编码无效。'); }
  if (!name || name.length > 200 || /[\x00-\x1f\x7f/\\]/.test(name) || !/\.xlsx$/i.test(name)) throw new RequestError(400, '请选择名称有效的 .xlsx 文件。暂不支持 .xls、宏或加密工作簿。');
  return name;
}

async function receiveFile(request, file) {
  if (Number(request.headers['content-length']) > MAX_BYTES) throw new RequestError(413, uploadSizeError(Number(request.headers['content-length'])));
  let bytes = 0;
  const hash = createHash('sha256');
  const counter = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) callback(new RequestError(413, uploadSizeError(bytes)));
    else { hash.update(chunk); callback(null, chunk); }
  } });
  await pipeline(request, counter, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  if (!bytes) throw new RequestError(400, '文件为空，请重新选择。');
  return { bytes, sha256: hash.digest('hex') };
}

async function readJson(request, maxBytes = 8 * 1048576) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new RequestError(413, '请求内容过大。');
    chunks.push(chunk);
  }
  try {
    const value = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new RequestError(400, '请求必须是有效的 JSON 对象。'); }
}

/**
 * Extra page origins allowed to embed this backend (DSH plugin mode only):
 * loopback http(s) origins (DSH Web) and exactly `dsh-app://app` (the DSH
 * desktop window). The default (none) keeps same-origin framing for source and
 * desktop launches.
 */
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/;
export const DSH_DESKTOP_ORIGIN = 'dsh-app://app';
const embedOrigin = origin => typeof origin === 'string' && (LOOPBACK_ORIGIN.test(origin) || origin === DSH_DESKTOP_ORIGIN);
export function frameAncestorList(extra = []) {
  const origins = typeof extra === 'function' ? extra() : extra;
  return ["'self'", ...new Set((origins || []).filter(embedOrigin))];
}

export async function createAdminServer({ port = 4180, dataDir = DEFAULT_DATA_DIR, frameAncestors = [] } = {}) {
  dataDir = resolve(dataDir);
  const embedded = typeof frameAncestors === 'function' || frameAncestors.length > 0;
  for (const origin of typeof frameAncestors === 'function' ? [] : frameAncestors) if (!embedOrigin(origin)) throw new Error(`嵌入来源只能是本机回环地址或 ${DSH_DESKTOP_ORIGIN}：${origin}`);
  const ancestors = () => frameAncestorList(frameAncestors).join(' ');
  const store = await openStore(dataDir);
  const token = randomBytes(32).toString('hex');
  let busy = null;
  let closing = false;
  const pending = new Set();
  let actualPort;
  const log = detail => { appendFile(resolve(dataDir, 'logs/backend.log'), `${new Date().toISOString()} ${detail}\n`, { mode: 0o600 }).catch(() => {}); };
  const track = promise => { pending.add(promise); promise.finally(() => pending.delete(promise)).catch(() => {}); return promise; };
  // Files received for review but never submitted do not survive a restart.
  for (const entry of await readdir(resolve(dataDir, 'temp')).catch(() => [])) if (/^(staged-|composed-)/.test(entry)) await rm(resolve(dataDir, 'temp', entry), { recursive: true, force: true }).catch(() => {});
  const review = createReviewService({ store, dataDir, scan: data => workerJob({ kind: 'inspect', ...data }, () => {}, log) });
  // Data start/end for uploads saved before coverage was recorded (§11.5). Cached
  // beside each upload; the upload records in state.json are not rewritten.
  const coverageCache = new Map();
  const COVERAGE_MODULES = new Set(['invoice', 'movement', 'opening', 'terminal', 'inventory']);
  const withCoverage = upload => !upload || upload.coverage?.start || !coverageCache.has(upload.id) ? upload : { ...upload, coverage: coverageCache.get(upload.id), coverageComputed: true };
  let coverageRun = null;
  async function fillCoverage() {
    const ids = new Set([...Object.values(store.state.active || {}), ...Object.values(store.state.candidates || {})]);
    for (const upload of store.state.uploads) {
      if (closing) return;
      if (!ids.has(upload.id) || upload.coverage?.start || coverageCache.has(upload.id) || !COVERAGE_MODULES.has(upload.moduleId)) continue;
      const directory = resolve(dataDir, 'uploads', upload.id);
      try {
        const cached = JSON.parse(await readFile(resolve(directory, 'coverage.json'), 'utf8'));
        if (cached.sha256 === upload.sha256) { coverageCache.set(upload.id, { start: cached.start, end: cached.end }); continue; }
      } catch {}
      try {
        const aggregate = JSON.parse(await readFile(resolve(directory, 'aggregate.json'), 'utf8'));
        if (aggregate.sha256 === upload.sha256 && aggregate.aggregate?.start) { coverageCache.set(upload.id, { start: aggregate.aggregate.start, end: aggregate.aggregate.end }); continue; }
      } catch {}
      try {
        const result = await workerJob({ kind: 'coverage', file: resolve(directory, 'source.xlsx'), validation: upload.validation, moduleId: upload.moduleId }, () => {}, log);
        coverageCache.set(upload.id, { start: result.start, end: result.end });
        await atomicJson(resolve(directory, 'coverage.json'), { sha256: upload.sha256, start: result.start, end: result.end }).catch(log);
      } catch (error) { log(error.stack); coverageCache.set(upload.id, { start: null, end: null }); }
    }
  }
  const refreshCoverage = () => { if (coverageRun || closing) return; coverageRun = track(fillCoverage().catch(log).finally(() => { coverageRun = null; })); };
  function view() {
    return {
      app: { id: APP_ID, name: '战区看板后台', version: '0.3.0', mode: 'real', dataDir },
      token,
      uploadLimits,
      modules: moduleDefinitions.map(m => ({ ...m, flow: isFlowModule(m.id), updatable: isUpdatable(m.id), modes: modesFor(m.id), activeUpload: withCoverage(store.state.uploads.find(u => u.id === store.state.active[m.id])) || null,
        candidateUpload: withCoverage(store.state.uploads.find(u => u.id === store.state.candidates?.[m.id])) || null,
        reviewStatus: store.state.uploads.find(u => u.id === (store.state.candidates?.[m.id] || store.state.active[m.id]))?.reviewStatus ?? 'unchecked' })),
      reviewRevision: store.state.review?.revision ?? 0,
      uploads: [...store.state.uploads].reverse().map(withCoverage),
      generations: [...store.state.generations].reverse().map(job => ({ ...job, ...(job.status === 'completed' ? { viewUrl: `/api/generations/${job.id}/view`, downloadUrl: `/api/generations/${job.id}/download` } : {}) })),
      busy,
      settings: { cycles: { ...DEFAULT_CYCLES, ...(store.state.settings?.cycles || {}) } },
    };
  }
  function guard(request, write = false) {
    const hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    if (!hosts.includes(request.headers.host)) throw new RequestError(403, '仅支持通过本机地址访问。');
    if (request.headers.origin && !hosts.map(host => `http://${host}`).includes(request.headers.origin)) throw new RequestError(403, '不接受其他网页发起的请求。');
    // Plugin mode: the DSH desktop window (dsh-app://app) is another site, so the
    // iframe's top-level page load arrives cross-site. Only that read-only GET
    // navigation of an HTML page into a frame is admitted; rendering is still limited by CSP
    // frame-ancestors, and every fetch/write from the page is same-origin.
    const pagePath = new URL(request.url, 'http://127.0.0.1').pathname;
    const framePage = ['/', '/board', '/admin'].includes(pagePath) || /^\/api\/generations\/[a-f0-9-]{36}\/view$/.test(pagePath);
    const frameNavigation = embedded && !write && framePage && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'iframe';
    if (request.headers['sec-fetch-site'] === 'cross-site' && !frameNavigation) throw new RequestError(403, '不接受跨站请求。');
    if (write && request.headers['x-local-token'] !== token) throw new RequestError(403, '页面会话已失效，请刷新后台后重试。');
    if (write && closing) throw new RequestError(503, '后台正在关闭，请稍后重新打开。');
  }
  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }
  function reserve(kind, moduleId) {
    if (busy) throw new RequestError(409, '另一项上传或生成正在进行，请等待完成后再试。');
    busy = { kind, ...(moduleId ? { moduleId } : {}), stage: kind === 'upload' ? '正在接收文件' : '正在锁定最新有效上传版本' };
  }

  const selectedUpload = (state, moduleId) => state.uploads.find(u => u.id === (state.candidates?.[moduleId] || state.active[moduleId]) && u.moduleId === moduleId) ?? null;

  /** Validate, inspect and install a received workbook as the module's newest source. */
  async function install({ moduleId, filename, temp, info, extra = {} }) {
    const id = randomUUID();
    let installed = false;
    try {
      const validationContract = await validationFingerprint(moduleId);
      const current = selectedUpload(store.state, moduleId);
      // Exact current bytes are idempotent; older versions may be chosen again as a fresh upload.
      if (current?.sha256 === info.sha256 && current.validationContract === validationContract) return { record: current, duplicate: true };
      busy.stage = '正在核对工作表、表头和数据行';
      let validation;
      try { validation = await workerJob({ kind: 'upload', file: temp, moduleId }, () => {}, log); }
      catch (error) { throw new RequestError(422, error.message); }
      if (!validation.ok) throw new RequestError(422, '文件结构校验未通过，原有效资料已保留。', { validation });
      const checkedContract = await validationFingerprint(moduleId);
      if (checkedContract !== validationContract) throw new RequestError(409, '校验期间规则发生修改，请重新上传。');
      busy.stage = '正在检查重复候选和来源组织';
      const inspection = await workerJob({ kind: 'inspect', file: temp, moduleId, sha256: info.sha256, validation }, () => {}, log);
      const directory = resolve(dataDir, 'uploads', id);
      await mkdir(directory, { mode: 0o700 });
      await rename(temp, resolve(directory, 'source.xlsx'));
      const record = { id, moduleId, filename, ...info, uploadedAt: new Date().toISOString(), validation, validationContract, coverage: inspection.coverage ?? null, ...extra };
      await atomicJson(resolve(directory, 'metadata.json'), record);
      await review.saveInspection(record, inspection);
      await store.update(async next => {
        next.uploads.push(record); next.candidates ??= {}; next.candidates[moduleId] = id;
        next.review ??= emptyReview(); next.review.revision++;
        await review.promote(next);
      });
      installed = true;
      refreshCoverage();
      return { record, duplicate: false };
    } finally {
      if (!installed) await rm(resolve(dataDir, 'uploads', id), { recursive: true, force: true }).catch(log);
    }
  }

  async function upload(request, response, moduleId) {
    if (!knownModules.has(moduleId)) throw new RequestError(404, '没有这个资料入口。');
    const filename = filenameFrom(request);
    if (request.headers['content-type'] !== 'application/octet-stream') throw new RequestError(415, '上传格式无效，请从后台选择文件。');
    reserve('upload', moduleId);
    const temp = resolve(dataDir, 'temp', `upload-${randomUUID()}.xlsx`);
    try {
      const info = await receiveFile(request, temp);
      const { record, duplicate } = await install({ moduleId, filename, temp, info, extra: isUpdatable(moduleId) ? { composition: { mode: 'full', step: 0, appliedAt: new Date().toISOString() } } : {} });
      busy = null;
      json(response, duplicate ? 200 : 201, { upload: record, ...(duplicate ? { duplicate: true } : {}), state: view() });
    } finally {
      busy = null;
      await rm(temp, { force: true }).catch(log);
    }
  }

  // ---- Incremental / range / full updates for invoice, movement and opening ----
  const stagedDir = id => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new RequestError(400, '待提交文件标识无效。');
    return resolve(dataDir, 'temp', `staged-${id}`);
  };
  async function readStaged(id) {
    try { return JSON.parse(await readFile(resolve(stagedDir(id), 'meta.json'), 'utf8')); }
    catch (error) { if (error instanceof RequestError) throw error; throw new RequestError(410, '待提交文件已过期，请重新选择文件。'); }
  }
  async function baseAggregate(upload) {
    if (!upload) return null;
    const file = resolve(dataDir, 'uploads', upload.id, 'aggregate.json');
    try {
      const cached = JSON.parse(await readFile(file, 'utf8'));
      if (cached.version === AGGREGATE_VERSION && cached.sha256 === upload.sha256) return cached.aggregate;
    } catch {}
    return null;
  }
  function alreadyApplied(state, moduleId, sha256) {
    const current = selectedUpload(state, moduleId);
    if (!current) return false;
    if (current.sha256 === sha256 || lineageShas(state, current.id).includes(sha256)) return true;
    for (let item = current, guard = 0; item && guard < 5000; guard++) {
      if (item.composition?.partSha256 === sha256) return true;
      item = state.uploads.find(upload => upload.id === item.composition?.baseUploadId);
    }
    return false;
  }
  const baseSummary = upload => upload ? { uploadId: upload.id, filename: upload.filename, coverage: withCoverage(upload).coverage ?? null, step: upload.composition?.step ?? 0 } : null;

  async function analyzeUpdate(request, response) {
    const moduleId = String(request.headers['x-module-id'] || '');
    if (!isUpdatable(moduleId)) throw new RequestError(400, '经营目标暂不支持核对更新，请按原方式整份上传。');
    const filename = filenameFrom(request);
    if (request.headers['content-type'] !== 'application/octet-stream') throw new RequestError(415, '上传格式无效，请从后台选择文件。');
    reserve('upload', moduleId); busy.stage = '正在读取文件日期';
    const id = randomUUID(), directory = resolve(dataDir, 'temp', `staged-${id}`);
    let kept = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      const file = resolve(directory, 'source.xlsx');
      const info = await receiveFile(request, file);
      if (alreadyApplied(store.state, moduleId, info.sha256)) { busy = null; return json(response, 200, { duplicate: true, moduleId, filename, message: '这份文件已经处理过，不会重复计入。' }); }
      let validation;
      try { validation = await workerJob({ kind: 'upload', file, moduleId }, () => {}, log); }
      catch (error) { throw new RequestError(422, error.message); }
      if (!validation.ok) throw new RequestError(422, '文件结构校验未通过，原有效资料已保留。', { validation });
      const base = selectedUpload(store.state, moduleId);
      const cached = isFlowModule(moduleId) ? await baseAggregate(base) : null;
      busy.stage = '正在对比现有数据';
      const analysis = await workerJob({ kind: 'analyze', moduleId, partFile: file, partValidation: validation,
        baseFile: base ? resolve(dataDir, 'uploads', base.id, 'source.xlsx') : null, baseValidation: base?.validation, baseAggregate: cached }, () => {}, log);
      if (base && !cached && analysis.base && isFlowModule(moduleId)) await atomicJson(resolve(dataDir, 'uploads', base.id, 'aggregate.json'), { version: AGGREGATE_VERSION, sha256: base.sha256, aggregate: analysis.base }).catch(log);
      const suggestion = suggestMode(analysis.base, analysis.part);
      const meta = { id, moduleId, filename, ...info, validation, createdAt: new Date().toISOString(), baseUploadId: base?.id ?? null, base: analysis.base, part: analysis.part, existingByDate: analysis.existingByDate, suggestion };
      await atomicJson(resolve(directory, 'meta.json'), meta);
      kept = true;
      busy = null;
      const preview = flowReceipt({ moduleId, base: analysis.base, part: analysis.part, mode: suggestion.mode, start: suggestion.start, end: suggestion.end, existingByDate: analysis.existingByDate });
      json(response, 200, { stagedId: id, moduleId, filename, file: { rows: analysis.part.rows, start: analysis.part.start, end: analysis.part.end }, base: baseSummary(base), suggestion, receipt: preview });
    } finally {
      busy = null;
      if (!kept) await rm(directory, { recursive: true, force: true }).catch(log);
    }
  }

  function updateOptions(body) {
    if (!['incremental', 'range', 'full'].includes(body.mode)) throw new RequestError(400, '更新方式无效。');
    return { mode: body.mode, start: typeof body.start === 'string' ? body.start : null, end: typeof body.end === 'string' ? body.end : null, confirmMissing: body.confirmMissing === true };
  }

  async function previewUpdate(body) {
    const meta = await readStaged(body.stagedId), options = updateOptions(body);
    if (!modesFor(meta.moduleId).includes(options.mode)) throw new RequestError(400, '这个板块只支持整份替换。');
    return flowReceipt({ moduleId: meta.moduleId, base: meta.base, part: meta.part, mode: options.mode, start: options.start, end: options.end, existingByDate: meta.existingByDate });
  }

  async function applyUpdate(body, response) {
    const meta = await readStaged(body.stagedId), options = updateOptions(body);
    reserve('upload', meta.moduleId); busy.stage = '正在核对更新内容';
    const directory = stagedDir(meta.id);
    const composedFile = resolve(dataDir, 'temp', `composed-${meta.id}.xlsx`);
    try {
      const base = selectedUpload(store.state, meta.moduleId);
      if ((base?.id ?? null) !== meta.baseUploadId) throw new RequestError(409, '这个板块的当前资料已经变化，请重新选择文件核对。');
      if (!modesFor(meta.moduleId).includes(options.mode)) throw new RequestError(400, '这个板块只支持整份替换。');
      const partFile = resolve(directory, 'source.xlsx');
      let checked = flowReceipt({ moduleId: meta.moduleId, base: meta.base, part: meta.part, mode: options.mode, start: options.start, end: options.end, existingByDate: meta.existingByDate });
      const refuse = result => {
        if (result.blocked.length) throw new RequestError(422, result.blocked.join(' '), { receipt: result });
        if (result.requiresConfirmation && !options.confirmMissing) throw new RequestError(422, isWholeModule(meta.moduleId) ? '有当前协议在新文件里找不到，请先核对并勾选确认。' : '有组织在新文件里缺失，请先核对并勾选确认。', { receipt: result });
      };
      refuse(checked);
      if (options.mode === 'full' || !base) {
        // Check again from the files themselves (the range / incremental path rechecks while composing).
        busy.stage = '正在重新核对文件';
        const cached = isFlowModule(meta.moduleId) ? await baseAggregate(base) : null;
        const fresh = await workerJob({ kind: 'analyze', moduleId: meta.moduleId, partFile, partValidation: meta.validation,
          baseFile: base ? resolve(dataDir, 'uploads', base.id, 'source.xlsx') : null, baseValidation: base?.validation, baseAggregate: cached }, () => {}, log);
        checked = flowReceipt({ moduleId: meta.moduleId, base: fresh.base, part: fresh.part, mode: options.mode, start: options.start, end: options.end, existingByDate: fresh.existingByDate });
        refuse(checked);
      }
      const appliedAt = new Date().toISOString();
      const partId = randomUUID();
      const partRecord = { id: partId, moduleId: meta.moduleId, filename: meta.filename, sha256: meta.sha256, bytes: meta.bytes, rows: meta.part.rows, start: meta.part.start, end: meta.part.end, mode: options.mode, rangeStart: checked.start, rangeEnd: checked.end, receivedAt: meta.createdAt, appliedAt };
      let result, warnings = checked.warnings;
      if (options.mode === 'full' || !base) {
        result = await install({ moduleId: meta.moduleId, filename: meta.filename, temp: partFile, info: { bytes: meta.bytes, sha256: meta.sha256 },
          extra: { composition: { mode: 'full', step: 0, partId, partSha256: meta.sha256, partFilename: meta.filename, partRows: meta.part.rows, appliedAt } } });
      } else {
        busy.stage = '正在合并为新版本';
        let composed;
        try {
          composed = await workerJob({ kind: 'compose', moduleId: meta.moduleId, mode: options.mode, start: checked.start, end: checked.end, confirmMissing: options.confirmMissing,
            baseFile: resolve(dataDir, 'uploads', base.id, 'source.xlsx'), baseValidation: base.validation, partFile, partValidation: meta.validation, outFile: composedFile }, () => {}, log);
        } catch (error) { throw new RequestError(422, error.message || '合并前复核未通过，当前资料保持不变。'); }
        warnings = composed.warnings;
        const bytes = await readFile(composedFile);
        const info = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        // Keep the received file for tracing before the composed source becomes current.
        const partDirectory = resolve(dataDir, 'parts', partId);
        await mkdir(partDirectory, { mode: 0o700 });
        await writeFile(resolve(partDirectory, 'source.xlsx'), await readFile(partFile), { flag: 'wx', mode: 0o600 });
        await atomicJson(resolve(partDirectory, 'metadata.json'), partRecord);
        result = await install({ moduleId: meta.moduleId, filename: meta.filename, temp: composedFile, info,
          extra: { composition: { mode: options.mode, start: checked.start, end: checked.end, step: (base.composition?.step ?? 0) + 1, baseUploadId: base.id, baseSha256: base.sha256,
            partId, partSha256: meta.sha256, partFilename: meta.filename, partRows: meta.part.rows, kept: composed.kept, appended: composed.appended, appliedAt } } });
      }
      busy = null;
      await rm(directory, { recursive: true, force: true }).catch(log);
      json(response, result.duplicate ? 200 : 201, { upload: result.record, duplicate: result.duplicate, receipt: checked, warnings, state: view() });
    } finally {
      busy = null;
      await rm(composedFile, { force: true }).catch(log);
    }
  }

  async function generate(job) {
    const scratch = resolve(dataDir, 'temp', `generation-${job.id}`);
    const directory = resolve(dataDir, 'generations', job.id);
    let published = false;
    try {
      await mkdir(scratch, { mode: 0o700 });
      const result = await workerJob({ kind: 'generate', project, dataDir, sourceVersions: job.sourceVersions, selection: job.selection, allowPending: job.allowPending, outputDir: scratch }, stage => {
        if (busy) busy.stage = stage;
        store.update(next => { const record = next.generations.find(g => g.id === job.id); record.stage = stage; }).catch(log);
      }, log);
      await verifyGenerationSnapshot({ project, dataDir, sourceVersions: job.sourceVersions, selection: job.selection, codeSha256: result.codeSha256, decisionsSha256: result.decisionsSha256, reviewSha256: result.reviewSha256 });
      const completed = { ...job, ...result, status: 'completed', stage: '生成完成', finishedAt: new Date().toISOString(), mode: 'real' };
      if (completed.needsReview) completed.filename = completed.filename.replace('_真实数据_', '_待确认_');
      await atomicJson(resolve(scratch, 'manifest.json'), { ...completed, note: '使用点击生成时最新校验通过的上传版本计算；待确认指标保持不可用。历史成品与原始上传未改写。' });
      await rename(scratch, directory);
      published = true;
      await store.update(next => { Object.assign(next.generations.find(g => g.id === job.id), completed); });
    } catch (error) {
      log(error.stack);
      if (published) await rm(directory, { recursive: true, force: true }).catch(log);
      await store.update(next => { Object.assign(next.generations.find(g => g.id === job.id), { status: 'failed', stage: '生成失败', finishedAt: new Date().toISOString(), error: error.message || '生成未完成，请重试。' }); });
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(log);
      busy = null;
    }
  }

  async function route(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    // Plugin mode relies on CSP frame-ancestors (which browsers prefer over XFO);
    // X-Frame-Options cannot list another origin.
    if (!embedded) response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    const write = !['GET', 'HEAD'].includes(request.method);
    guard(request, write);
    const path = new URL(request.url, `http://127.0.0.1:${actualPort}`).pathname;
    if (request.method === 'GET' && path === '/api/health') return json(response, 200, { appId: APP_ID, version: '0.3.0', mode: 'real', ready: !closing });
    if (request.method === 'GET' && path === '/api/state') return json(response, 200, view());
    if (request.method === 'GET' && path === '/api/review') return json(response, 200, await review.view());
    if (request.method === 'GET' && path === '/api/review/backup') {
      response.setHeader('Content-Disposition', 'attachment; filename="review-settings.json"');
      return json(response, 200, review.backup());
    }
    if (request.method === 'POST' && path.startsWith('/api/review/')) {
      const body = await readJson(request, path === '/api/review/restore' ? 32 * 1048576 + 1024 : 8 * 1048576);
      reserve('review'); busy.stage = '正在检查和保存处理结果';
      try {
        const action = path.slice('/api/review/'.length);
        const result = action === 'check' ? await review.check() : await review.mutate(action, body);
        busy = null;
        return json(response, 200, { review: result, state: view() });
      } finally { busy = null; }
    }
    if (request.method === 'POST' && path === '/api/identify') {
      if (request.headers['content-type'] !== 'application/octet-stream') throw new RequestError(415, '上传格式无效，请从后台选择文件。');
      const temp = resolve(dataDir, 'temp', `identify-${randomUUID()}.xlsx`);
      let result;
      try { await receiveFile(request, temp); result = await identifyWorkbook(temp); }
      finally { await rm(temp, { force: true }).catch(log); }
      return json(response, 200, result);
    }
    if (request.method === 'POST' && path === '/api/settings/cycle') {
      const body = await readJson(request, 1024);
      if (!knownModules.has(body.moduleId) || !CYCLES.includes(body.cycle)) throw new RequestError(400, '更新周期设置无效。');
      await store.update(next => { next.settings ??= {}; next.settings.cycles = { ...(next.settings.cycles || {}), [body.moduleId]: body.cycle }; });
      return json(response, 200, { state: view() });
    }
    if (request.method === 'POST' && path.startsWith('/api/uploads/')) return upload(request, response, path.slice('/api/uploads/'.length));
    if (request.method === 'POST' && path === '/api/updates/analyze') return analyzeUpdate(request, response);
    if (request.method === 'POST' && path === '/api/updates/preview') return json(response, 200, { receipt: await previewUpdate(await readJson(request, 4096)) });
    if (request.method === 'POST' && path === '/api/updates/apply') return applyUpdate(await readJson(request, 4096), response);
    if (request.method === 'POST' && path === '/api/updates/discard') {
      const body = await readJson(request, 1024);
      await rm(stagedDir(body.stagedId), { recursive: true, force: true }).catch(log);
      return json(response, 200, { ok: true });
    }
    if (request.method === 'POST' && path === '/api/generations') {
      const options = await readJson(request, 1024);
      if ('allowPending' in options && typeof options.allowPending !== 'boolean') throw new RequestError(400, '待确认生成选项无效。');
      reserve('generate');
      let sourceVersions;
      let reviewResult;
      try {
        reviewResult = await review.view();
        if (reviewResult.modules.some(module => module.status === 'unchecked')) reviewResult = await review.check();
        const unresolved = reviewResult.modules.filter(module => ['pending', 'error'].includes(module.status));
        if (unresolved.length && !options.allowPending) throw new Error(`还有 ${unresolved.length} 个板块需要处理，请在导入检查中确认后生成，或明确选择生成待确认版本。`);
        sourceVersions = captureSourceSnapshot(store.state, { includeCandidates: true });
        if (!Object.keys(sourceVersions).length) throw new Error('请先上传并校验至少一个板块的真实资料。');
      } catch (error) { busy = null; throw new RequestError(422, error.message); }
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const needsReview = reviewResult.modules.some(module => ['pending', 'error'].includes(module.status));
      const job = { id, createdAt, status: 'running', stage: busy.stage, mode: 'real', selection: 'review', allowPending: options.allowPending === true, needsReview, sourceVersions, sourceIds: Object.fromEntries(Object.entries(sourceVersions).map(([id, source]) => [id, source.uploadId])), filename: `战区经营看板_v10_${needsReview ? '待确认' : '真实数据'}_${createdAt.replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z')}_${id.slice(0, 6)}.html` };
      try { await store.update(next => { next.generations.push(job); }); }
      catch (error) { busy = null; throw error; }
      json(response, 202, { generation: job });
      track(generate(job)).catch(log);
      return;
    }
    const outputMatch = /^\/api\/generations\/([a-f0-9-]{36})\/(view|download)$/.exec(path);
    if (request.method === 'GET' && outputMatch) {
      const job = store.state.generations.find(g => g.id === outputMatch[1] && g.status === 'completed');
      if (!job) throw new RequestError(404, '成品不存在或尚未完成。');
      const file = resolve(dataDir, 'generations', job.id, 'dashboard.html');
      const info = await stat(file);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': info.size, 'Content-Disposition': `${outputMatch[2] === 'download' ? 'attachment' : 'inline'}; filename="dashboard.html"; filename*=UTF-8''${encodeURIComponent(job.filename)}`, 'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; frame-ancestors ${ancestors()}; form-action 'none'` });
      await pipeline(createReadStream(file), response);
      return;
    }
    if (request.method === 'GET' && path === '/api/target-template') {
      // Organization names come from source inspections; scan any active source
      // that has not been inspected yet so the template is not left blank.
      for (const id of ['invoice', 'movement', 'opening']) {
        const upload = store.state.uploads.find(item => item.id === store.state.active[id] && item.moduleId === id);
        if (upload && !(await review.inspection(upload).catch(() => null))) await review.inspect(upload).catch(log);
      }
      const content = await buildTargetTemplate({ organizations: await targetOrganizations(dataDir, store.state) });
      response.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Length': content.length,
        'Content-Disposition': `attachment; filename="target-template.xlsx"; filename*=UTF-8''${encodeURIComponent('经营目标模板.xlsx')}` });
      response.end(content);
      return;
    }
    if (request.method === 'GET' && publicFiles.has(path)) {
      const [file, type] = publicFiles.get(path);
      const content = await readFile(resolve(here, 'public', file));
      response.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors ${ancestors()}; form-action 'self'` });
      response.end(content);
      return;
    }
    if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    throw new RequestError(404, '没有这个页面或接口。');
  }

  const server = http.createServer((request, response) => {
    track(route(request, response)).catch(error => {
      if (response.headersSent || response.destroyed) return;
      if (!(error instanceof RequestError)) log(error.stack);
      json(response, error.status || 500, { error: error.status ? error.message : '本机操作未完成，请检查文件或存储空间后重试。', ...(error.extra || {}) });
    });
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 15_000;
  try {
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });
    actualPort = server.address().port;
  } catch (error) { await store.release(); throw error; }
  refreshCoverage();
  return {
    server, port: actualPort, url: `http://127.0.0.1:${actualPort}/`, dataDir,
    async close() {
      closing = true;
      const stopped = new Promise(ok => server.close(ok));
      server.closeIdleConnections();
      await Promise.allSettled([...pending]);
      await stopped;
      await store.release();
    },
  };
}
