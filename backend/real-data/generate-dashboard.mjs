import { readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { buildSourcePayload } from './source-payload.mjs';
import { moduleDefinitions } from '../modules.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const ids = moduleDefinitions.map(module => module.id);
const titles = Object.fromEntries(moduleDefinitions.map(module => [module.id, module.title]));

export function captureSourceSnapshot(state, { includeCandidates = false } = {}) {
  if (!state?.active || Array.isArray(state.active) || !Array.isArray(state.uploads)) throw new Error('后台上传版本记录格式无效。');
  if (Object.keys(state.active).some(id => !ids.includes(id))) throw new Error('后台存在未知板块的有效版本记录。');
  const selected = includeCandidates ? { ...state.active, ...state.candidates } : state.active;
  return Object.fromEntries(ids.filter(id => selected[id]).map(id => {
    const uploadId = selected[id];
    const source = state.uploads.find(item => item.id === uploadId && item.moduleId === id);
    if (typeof uploadId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(uploadId) || !source || !/^[a-f0-9]{64}$/i.test(source.sha256 ?? '')) throw new Error(`${titles[id]}的有效上传版本记录不完整，请重新上传。`);
    return [id, { uploadId, sha256: source.sha256.toLowerCase(), validationContract: source.validationContract ?? null }];
  }));
}

export async function verifySourceSnapshot(dataDir, snapshot, { verifyFiles = true, selection = 'active' } = {}) {
  const checkState = async () => {
    const state = JSON.parse(await readFile(resolve(dataDir, 'state.json'), 'utf8'));
    if (JSON.stringify(captureSourceSnapshot(state, { includeCandidates: selection === 'review' })) !== JSON.stringify(snapshot)) throw new Error('生成期间有效上传版本发生变化，请重新生成；未发布混合版本成品。');
  };
  await checkState();
  if (verifyFiles) {
    const uploads = await realpath(resolve(dataDir, 'uploads'));
    for (const [id, source] of Object.entries(snapshot)) {
      const file = await realpath(resolve(uploads, source.uploadId, 'source.xlsx'));
      if (!file.startsWith(`${uploads}${sep}`) || sha(await readFile(file)) !== source.sha256) throw new Error(`${titles[id]}的上传文件与锁定来源不一致，请重新上传后生成。`);
    }
  }
  await checkState();
}

async function fingerprint(project) {
  const files = ['package.json', 'package-lock.json'];
  async function walk(dir) {
    for (const entry of await readdir(resolve(project, dir), { withFileTypes: true })) {
      const name = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.push(name);
    }
  }
  await walk('backend');
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    let bytes;
    // npm packages (DSH plugin tarball) never carry package-lock.json; the hash is unchanged when it exists.
    try { bytes = await readFile(resolve(project, file)); }
    catch (error) { if (error.code === 'ENOENT' && file === 'package-lock.json') continue; throw error; }
    hash.update(relative(project, resolve(project, file))).update('\0').update(bytes).update('\0');
  }
  return hash.digest('hex');
}

async function decisionBytes(file) {
  try { return await readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function verifyGenerationSnapshot({ project, dataDir, sourceVersions, selection = 'active', codeSha256, decisionsSha256, reviewSha256 }) {
  await verifySourceSnapshot(dataDir, sourceVersions, { selection });
  const current = await decisionBytes(resolve(dataDir, 'generation-decisions.json'));
  if ((current ? sha(current) : null) !== decisionsSha256) throw new Error('生成期间业务决定文件发生变化，请重新生成。');
  if (reviewSha256 !== undefined) {
    const state = JSON.parse(await readFile(resolve(dataDir, 'state.json'), 'utf8'));
    if (sha(JSON.stringify(state.review ?? null)) !== reviewSha256) throw new Error('生成期间检查处理设置发生变化，请重新生成。');
  }
  if (await fingerprint(project) !== codeSha256) throw new Error('生成期间源码发生变化，请等待修改完成后重试。');
}

/** Build a source-bound artifact in the server's private staging directory.
 * The server publishes this directory atomically only after all checks pass.
 */
export async function generateDashboard({ project, dataDir, sourceVersions, outputDir, selection = 'active', allowPending = false, onStage = () => {} }, dependencies = {}) {
  const codeSha256 = await fingerprint(project);
  const decisionsFile = resolve(dataDir, 'generation-decisions.json');
  const decisionBefore = await decisionBytes(decisionsFile);
  if (decisionBefore) {
    try { const parsed = JSON.parse(decisionBefore); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); }
    catch { throw new Error('本机业务决定文件格式无效，请修复后重新生成。'); }
  }
  const decisionsSha256 = decisionBefore ? sha(decisionBefore) : null;
  const initialState = JSON.parse(await readFile(resolve(dataDir, 'state.json'), 'utf8'));
  const reviewSha256 = sha(JSON.stringify(initialState.review ?? null));
  const verifyInputs = () => verifyGenerationSnapshot({ project, dataDir, sourceVersions, selection, codeSha256, decisionsSha256, reviewSha256 });
  if (!Object.keys(sourceVersions).length) throw new Error('请先上传并校验至少一个板块的真实资料。');
  await verifyInputs();
  onStage('正在读取最新有效上传并计算真实数据');
  const build = dependencies.buildSourcePayload ?? buildSourcePayload;
  const { payload, report } = await build({ dataDir, decisionsFile: decisionBefore ? decisionsFile : undefined, sourceVersions, allowPending, rowCache: true });
  if (!payload?.sources || !payload?.modules || report?.activeChangedDuringRead) throw new Error('有效上传版本读取不完整或已发生变化，请重新生成。');
  if (report.decisionError) throw new Error(report.decisionError);
  for (const [id, expected] of Object.entries(sourceVersions)) {
    const source = payload.sources[id], module = payload.modules[id];
    if (!source || source.uploadId !== expected.uploadId || source.sha256 !== expected.sha256) throw new Error(`${titles[id]}未使用锁定的有效上传版本：${module?.reason || '请重新上传并检查来源。'}`);
    if (!['ready', 'partial'].includes(module?.state) && !(allowPending && report.modules?.[id]?.reviewPending)) throw new Error(`${titles[id]}无法计算：${module?.reason || '请核对该板块资料及已确认规则。'}`);
  }
  if (Object.keys(payload.sources).some(id => !sourceVersions[id])) throw new Error('计算结果出现未锁定来源，已停止生成。');
  const pendingModules = Object.keys(sourceVersions).filter(id => report.modules?.[id]?.reviewPending);
  if (!Object.entries(payload.modules).some(([id, module]) => sourceVersions[id] && module.records?.length) && !(allowPending && pendingModules.length)) throw new Error('没有可呈现的真实记录，请检查已上传资料。');
  payload.mode = 'real';
  onStage('正在生成 v10 真实数据离线看板');
  const render = dependencies.renderV10Dashboard ?? (await import('./v10-template.mjs')).renderV10Dashboard;
  const rendered = await render(payload);
  if (typeof rendered?.html !== 'string' || !rendered.html.includes('</html>')) throw new Error('未生成有效的离线 HTML。');
  const reviewSummary = { pendingCount: pendingModules.reduce((count, id) => count + (report.modules[id].review?.pendingCount || 1), 0), modules: pendingModules,
    sources: Object.entries(sourceVersions).map(([id]) => ({ moduleId: id, filename: payload.sources[id].originalName, sha256: payload.sources[id].sha256, groups: report.modules[id].review?.groups ?? [], reason: payload.modules[id].reason ?? null })), organizations: report.reviewOrganizations ?? null };
  if (initialState.review) {
    const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    const label = pendingModules.length ? `待确认版本 · ${pendingModules.length} 个板块尚未处理` : '本次来源与处理记录';
    const entries = reviewSummary.sources.map(source => `<li><strong>${escape(titles[source.moduleId])}</strong>：${escape(source.filename)}${source.reason ? ` · ${escape(source.reason)}` : ''}${source.groups.map(group => `<p>${group.status === 'resolved' ? `计入原表第 ${escape(group.keptRows.join('、'))} 行；不计入 ${escape(group.excludedRows.join('、') || '无')}。` : '重复候选待确认。'}</p>`).join('')}</li>`).join('');
    const notes = `<details class="import-review"${pendingModules.length ? ' open' : ''}><summary>${escape(label)}</summary><div><p>本文件保留生成时的处理结果。调整决定需返回本机应用重新生成；受影响汇总和依赖指标保持不可用。</p><ul>${entries}</ul><p>组织对应已应用 ${report.reviewOrganizations?.appliedRows ?? 0} 行。原始 Excel 和历史看板未改写。</p></div></details>`;
    rendered.html = rendered.html.replace('</head>', '<style>.import-review{position:fixed;right:12px;bottom:12px;z-index:99999;max-width:min(540px,90vw);font:13px/1.6 sans-serif;background:#fffaf0;color:#45351d;border:1px solid #b89349;border-radius:8px;box-shadow:0 3px 16px #0002}.import-review summary{padding:8px 14px;cursor:pointer;font-weight:600}.import-review>div{padding:0 16px 12px;max-height:42vh;overflow:auto}.import-review p{margin:6px 0}</style></head>').replace('</body>', `${notes}</body>`);
    if (pendingModules.length) rendered.html = rendered.html.replace('<title>', '<title>待确认 · ');
  }
  await verifyInputs();
  onStage('正在保存成品并核对来源版本');
  await writeFile(resolve(outputDir, 'dashboard.html'), rendered.html, { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(outputDir, 'diagnostics.json'), JSON.stringify(report), { flag: 'wx', mode: 0o600 });
  await verifyInputs();
  return {
    bytes: Buffer.byteLength(rendered.html), sha256: sha(rendered.html), templateSha256: rendered.templateSha256,
    codeSha256, decisionsSha256, reviewSha256, needsReview: pendingModules.length > 0, reviewSummary, payloadSha256: rendered.payloadSha256,
    processingVersion: payload.processingVersion, payloadVersion: payload.schemaVersion, rendererVersion: rendered.rendererVersion,
    sources: payload.sources, moduleStates: rendered.moduleStates,
    processors: Object.fromEntries(ids.map(id => [id, { version: payload.processingVersion, state: payload.modules[id].state }])),
    moduleSummaries: Object.fromEntries(ids.map(id => [id, { state: payload.modules[id].state, records: payload.modules[id].records.length, metrics: payload.modules[id].metrics, warnings: payload.modules[id].warnings || [], unavailable: payload.modules[id].unavailable || [] }])),
    pendingDecisions: payload.pendingDecisions,
  };
}
