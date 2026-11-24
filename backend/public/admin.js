'use strict';

if (new URLSearchParams(location.search).has('embed')) document.documentElement.classList.add('embedded');

const $ = selector => document.querySelector(selector);
const rows = new Map();
const preferredOrder = ['invoice', 'movement', 'opening', 'terminal', 'inventory', 'banquet', 'target'];
let state = null;
let working = null;
let connected = false;
let polling = false;
let historySignature = '';
let trackedGeneration = null;
// A running pre-upgrade server may serve the new page before it is restarted.
const currentUploadLimits = () => state?.uploadLimits ?? { fileBytes: 50 * 1048576, entryBytes: 128 * 1048576, totalBytes: 256 * 1048576 };

const iconPaths = {
  invoice: '<path d="M4 3h16v18l-3-2-3 2-3-2-3 2-4-2zM8 8h8m-8 4h8"/>',
  movement: '<path d="M4 3v17h17M7 15l4-5 4 2 5-7m-5 0h5v5"/>',
  opening: '<path d="M12 2S5 9 5 15a7 7 0 0 0 14 0c0-6-7-13-7-13zm4 13a4 4 0 0 1-4 4"/>',
  terminal: '<path d="m3 10 4-6 5 2 5-2 4 6-4 3-4-4-4 4-3-1M3 10l-2 4 4 3 3-5m0 3 6 5 7-6-2-3m-8 5 3 3m0-6 3 3"/>',
  inventory: '<path d="m12 2 9 5v10l-9 5-9-5V7zm-9 5 9 5 9-5M12 12v10M7 4.8l10 5.5v6"/>',
  banquet: '<path d="m3 21 4-14 10 10zm4-14 10 10M13 3l1 4m4-2 2-2m-2 7 4 1m-1 5 2 1M8 13l3 3"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = iconPaths[id] || iconPaths.invoice;
  return svg;
}

function readableSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function readableTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false}).format(date);
}

const cycleLabels = [['daily', '每日'], ['weekly', '每周'], ['monthly', '每月'], ['irregular', '不定期']];
const cycleDays = { daily: 1, weekly: 7, monthly: 31, irregular: Infinity };
const localDay = value => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? null : new Date(date.getFullYear(), date.getMonth(), date.getDate()); };
const pad2 = value => String(value).padStart(2, '0');
function sourceAge(uploadedAt, cycle) {
  const day = uploadedAt ? localDay(uploadedAt) : null;
  if (!day) return { text: '—', today: false, overdue: false };
  const days = Math.round((localDay(Date.now()) - day) / 86400000);
  const date = `${pad2(day.getMonth() + 1)}/${pad2(day.getDate())}`;
  return { text: days <= 0 ? '今日' : date, today: days <= 0, overdue: days >= (cycleDays[cycle] ?? Infinity), days };
}
async function saveCycle(moduleId, cycle) {
  if (!state?.token) return;
  try { const result = await request('/api/settings/cycle', { method:'POST', headers:{'Content-Type':'application/json', 'X-Local-Token':state.token}, body:JSON.stringify({ moduleId, cycle }) }); applyState(result.state); }
  catch (error) { setNotice(`提醒周期未保存：${error.message}`, true); }
}

function setNotice(message, error = false) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.className = `notice${error ? ' error' : ''}`;
  notice.hidden = !message;
}

function fileErrorMessage(data) {
  const messages = [data.error];
  if (data.validation?.errors?.length) messages.push(...data.validation.errors);
  if (data.validation?.missingHeaders?.length && !data.validation.errors?.some(message => data.validation.missingHeaders.every(header => message.includes(header)))) messages.push(`缺少表头：${data.validation.missingHeaders.join('、')}`);
  return [...new Set(messages.filter(Boolean))].join('\n') || '操作未完成，请重试。';
}

async function request(path, options = {}) {
  const response = await fetch(path, {cache:'no-store', credentials:'same-origin', ...options});
  let data;
  try { data = await response.json(); }
  catch { throw new Error('后台返回了无法识别的结果，请刷新状态后重试。'); }
  if (!response.ok) {
    const error = new Error(fileErrorMessage(data));
    error.data = data;
    throw error;
  }
  return data;
}

function connectionStatus(online) {
  connected = online;
  const connection = $('#connection');
  connection.className = `connection ${online ? 'online' : 'offline'}`;
  connection.replaceChildren(element('i'), document.createTextNode(online ? '本机运行中' : '后台连接中断'));
}

function currentBusy() { return state?.busy || working; }

function busyLabel(busy) {
  if (!busy) return '等待手动生成';
  if (busy.stage) return busy.stage;
  return busy.kind === 'upload' ? '正在更新资料' : '正在生成真实数据看板';
}

function renderControls() {
  const busy = currentBusy();
  const realMode = state?.app?.mode === 'real';
  const hasSources = state?.modules?.some(module => module.activeUpload || module.candidateUpload);
  $('#generate-button').disabled = !connected || Boolean(busy) || !realMode || !hasSources;
  $('#generate-button').firstChild.textContent = busy?.kind === 'generate' ? '正在生成，请稍候' : '生成真实数据看板';
  $('#task-status').textContent = !connected ? '后台未连接' : busy ? busyLabel(busy) : '空闲';
  $('#generation-progress').textContent = !connected ? '连接后台后可生成' : busy ? busyLabel(busy) : !realMode ? '当前后台尚未启用真实数据生成，请刷新状态' : !hasSources ? '请先在上方更新至少一类资料' : '使用本次选择的来源 · 每次保存为新文件';
  for (const row of rows.values()) row.cycle.disabled = !connected;
  if (typeof renderBatch === 'function') renderBatch();
  window.ReviewUI?.controls();
}

// ---- 当前使用的资料: read-only status table (design ⑩) ----
const shortDay = value => value ? `${String(value).slice(5, 7)}/${String(value).slice(8, 10)}` : '—';
const dayRange = (a, b) => !a ? '—' : !b || a === b ? shortDay(a) : `${shortDay(a)} ~ ${shortDay(b)}`;
const selectedUpload = module => module?.candidateUpload || module?.activeUpload || null;

function rangeText(module, upload) {
  if (!upload) return '尚未上传';
  const count = `${Number(upload.validation?.rowCount || 0).toLocaleString('zh-CN')} 行`;
  if (module.id === 'banquet') return `无日期列 · ${count}`;
  if (module.id === 'target') return count;
  if (!upload.coverage) return '正在计算数据起止日…';
  if (!upload.coverage.start) return '—';
  const prefix = { terminal: '签约日期 ', inventory: '提交时间 ' }[module.id] || '';
  return `${prefix}${upload.coverage.start} ~ ${upload.coverage.end}`;
}
function versionText(upload) {
  if (!upload) return '—';
  const composition = upload.composition;
  return composition?.step ? `基线 + ${composition.step} 次更新` : composition?.partId ? '新基线' : '基线';
}
function operationText(upload) {
  if (!upload) return '—';
  const composition = upload.composition, when = sourceAge(upload.uploadedAt, 'irregular').text;
  const op = composition?.mode === 'range' ? `范围 ${dayRange(composition.start, composition.end)}` : composition?.mode === 'incremental' ? `增量 ${dayRange(composition.start, composition.end)}` : '整份替换';
  return `${when} ${op}`;
}
function statusOf(module, upload, cycle) {
  if (!upload) return { text: '未上传', tone: 'muted' };
  const review = module.reviewStatus?.status || module.reviewStatus;
  if (module.candidateUpload || review === 'pending') return { text: '待确认', tone: 'warn' };
  if (review === 'error') return { text: '需要核对', tone: 'bad' };
  if (sourceAge(upload.uploadedAt, cycle).overdue) return { text: '待更新', tone: 'warn' };
  if (review === 'unchecked') return { text: '尚未检查', tone: 'muted' };
  return { text: '可使用', tone: 'ok' };
}

function createStatusRow(module) {
  const root = element('div', 'status-row');
  root.setAttribute('role', 'row');
  root.dataset.module = module.id;
  const name = element('span', 'status-name'); name.setAttribute('role', 'cell');
  const symbol = element('span', 'module-icon'); symbol.append(icon(module.id));
  const title = element('b', '', module.title); title.title = module.description || '';
  name.append(symbol, title);
  if (module.id === 'target') {
    const template = element('a', 'text-link target-template', '下载模板 ↓');
    template.href = '/api/target-template'; template.setAttribute('download', '经营目标模板.xlsx');
    template.title = '预填当前已上传来源中的组织名称；目标值需自行填写';
    name.append(template);
  }
  const cells = ['range', 'version', 'last'].map(() => { const cell = element('span', 'status-cell'); cell.setAttribute('role', 'cell'); return cell; });
  const cycleCell = element('span', 'status-cell'); cycleCell.setAttribute('role', 'cell');
  const cycle = element('select', 'source-cycle');
  cycle.setAttribute('aria-label', `${module.title}提醒周期`);
  for (const [value, label] of cycleLabels) { const option = element('option', '', label); option.value = value; cycle.append(option); }
  cycle.addEventListener('change', () => saveCycle(module.id, cycle.value));
  cycleCell.append(cycle);
  const status = element('span', 'status-state'); status.setAttribute('role', 'cell');
  root.append(name, ...cells, cycleCell, status);
  const row = { root, range: cells[0], version: cells[1], last: cells[2], cycle, status };
  rows.set(module.id, row);
  return row;
}
function updateStatusRow(module) {
  const row = rows.get(module.id), upload = selectedUpload(module);
  row.range.textContent = rangeText(module, upload);
  row.range.title = upload?.filename ? `当前文件：${upload.filename}` : '';
  row.version.textContent = versionText(upload);
  row.version.title = upload?.composition?.partFilename && upload.composition.step ? `最近一次由“${upload.composition.partFilename}”生成；收到的原文件保存在本机` : '';
  row.last.textContent = operationText(upload);
  const cycleValue = state?.settings?.cycles?.[module.id] || 'irregular';
  if (document.activeElement !== row.cycle) row.cycle.value = cycleValue;
  const status = statusOf(module, upload, cycleValue);
  row.status.textContent = status.text;
  row.status.className = `status-state is-${status.tone}`;
  row.root.classList.toggle('is-today', sourceAge(upload?.uploadedAt, cycleValue).today);
}

function localLink(href, label, download = false) {
  if (typeof href !== 'string') return null;
  let url;
  try { url = new URL(href, location.origin); } catch { return null; }
  if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol)) return null;
  const link = element('a', '', label); link.href = url.pathname + url.search;
  if (!download) { link.target = '_blank'; link.rel = 'noopener'; }
  else link.setAttribute('download', '');
  return link;
}

function renderHistory() {
  const generations = [...(state?.generations || [])].sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  $('#history-count').textContent = `${generations.length} 条记录`;
  $('#generation-count').textContent = generations.filter(item => item.status === 'completed').length;
  const latest = generations.find(item => item.status === 'completed' && !item.needsReview && !item.reviewPending && localLink(item.viewUrl, ''));
  const latestLink = $('#latest-output'); latestLink.hidden = !latest;
  if (latest) {
    latestLink.href = localLink(latest.viewUrl, '').href;
    latestLink.textContent = latest.mode === 'real' ? '打开最新生成的真实数据看板 ↗' : latest.mode === 'demo' ? '打开最近的历史演示看板 ↗' : '打开最近生成的看板 ↗';
  }
  const signature = JSON.stringify(generations);
  if (signature === historySignature) return;
  historySignature = signature;
  const host = $('#generation-history'); host.replaceChildren();
  if (!generations.length) {
    const empty = element('div', 'empty-state');
    empty.append(element('strong', '', '还没有生成记录'), element('p', '', '更新资料并通过检查后，点击上方按钮生成真实数据看板。'));
    host.append(empty);
    return;
  }
  const wrapper = element('div', 'history-table-wrap');
  const table = element('table', 'history-table');
  const thead = element('thead'); const tr = element('tr');
  for (const label of ['成品 / 任务', '生成时间', '状态', '操作']) { const th = element('th','',label); th.scope = 'col'; tr.append(th); }
  thead.append(tr); const tbody = element('tbody');
  for (const generation of generations) {
    const row = element('tr');
    const name = element('td');
    const real = generation.mode === 'real';
    const demo = generation.mode === 'demo';
    name.append(element('span', 'history-name', generation.filename || (real ? 'v10 真实数据看板' : demo ? 'v5 演示看板' : '历史看板')));
    const sources = generation.sourceIds ? Object.values(generation.sourceIds).filter(Boolean).length : 0;
    const sourceLabel = real ? `${generation.needsReview ? '待确认版本 · ' : ''}真实上传数据 · ${sources} 类来源版本` : demo ? `历史合成演示数据 · 记录 ${sources} 类资料版本` : `历史生成记录 · ${sources} 类资料版本`;
    name.append(element('span', 'history-sub', `${sourceLabel}${generation.bytes ? ` · ${readableSize(generation.bytes)}` : ''}`));
    if (real && generation.status === 'completed' && generation.moduleStates) {
      const moduleTitle = id => state.modules.find(module => module.id === id)?.title || id;
      const unavailable = Object.entries(generation.moduleStates).filter(([, value]) => ['unavailable', 'missing_source'].includes(value)).map(([id]) => moduleTitle(id));
      const partial = Object.entries(generation.moduleStates).filter(([, value]) => value === 'partial').map(([id]) => moduleTitle(id));
      const notes = [unavailable.length ? `无可用来源：${unavailable.join('、')}` : '', partial.length ? `部分指标可用：${partial.join('、')}` : ''].filter(Boolean);
      if (notes.length) name.append(element('span', 'history-sub', notes.join('；')));
    }
    const created = element('td', '', readableTime(generation.createdAt));
    const statusCell = element('td');
    const statusNames = {completed:'已完成', failed:'生成失败', running:'生成中'};
    statusCell.append(element('span', `status ${generation.status === 'completed' ? 'ready' : generation.status === 'failed' ? 'error' : 'running'}`, generation.status === 'completed' && generation.needsReview ? '待确认版本' : statusNames[generation.status] || generation.status));
    const actions = element('td');
    if (generation.status === 'completed') {
      const links = element('div', 'history-links');
      const view = localLink(generation.viewUrl, '查看 ↗'); const download = localLink(generation.downloadUrl, '下载 HTML', true);
      if (view) links.append(view); if (download) links.append(download);
      actions.append(links);
    } else if (generation.status === 'failed') actions.append(element('span', 'history-sub history-error', generation.error || '生成未完成，请重试。'));
    else actions.append(element('span', 'history-sub', generation.stage || '正在准备成品…'));
    row.append(name, created, statusCell, actions); tbody.append(row);
  }
  table.append(thead, tbody); wrapper.append(table); host.append(wrapper);
}

function applyState(next) {
  state = next;
  const limits = currentUploadLimits();
  $('#upload-limit-hint').textContent = `单文件 ≤ ${limits.fileBytes / 1048576} MB · 原文件保留`;
  $('#upload-capacity-description').textContent = `单表解压 ≤ ${limits.entryBytes / 1048576} MB，整本解压 ≤ ${limits.totalBytes / 1048576} MB。解压大小不同于文件大小。`;
  connectionStatus(true);
  const modules = [...(state.modules || [])].sort((a,b) => preferredOrder.indexOf(a.id) - preferredOrder.indexOf(b.id));
  const grid = $('#module-grid');
  if (!rows.size) grid.replaceChildren();
  for (const module of modules) {
    if (!rows.has(module.id)) grid.append(createStatusRow(module).root);
    updateStatusRow(module);
  }
  $('#ready-count').textContent = modules.filter(module => module.activeUpload).length;
  $('#ready-total').textContent = ` / ${modules.length} 类`;
  const today = modules.filter(module => sourceAge(selectedUpload(module)?.uploadedAt, 'daily').today);
  $('#today-count').textContent = today.length;
  $('#today-total').textContent = ` / ${modules.length} 类`;
  const fresh = today.map(module => module.title), kept = modules.filter(module => module.activeUpload && !today.includes(module)).map(module => module.title);
  const missing = modules.filter(module => !module.activeUpload && !module.candidateUpload).map(module => module.title);
  $('#generate-sources').textContent = [fresh.length ? `今日更新：${fresh.join('、')}` : '今日还没有更新任何板块', kept.length ? `沿用上次：${kept.join('、')}` : '', missing.length ? `未上传：${missing.join('、')}` : ''].filter(Boolean).join('；') + '。';
  $('#data-directory').textContent = state.app?.dataDir || '本机资料目录';
  const realMode = state.app?.mode === 'real';
  $('#mode-title').textContent = realMode ? '当前生成：v10 真实数据看板' : '当前后台尚未启用真实数据生成';
  $('#mode-description').textContent = realMode ? '检查并处理本次来源后，按已确认口径生成。无法决定的问题可保留在待确认版本中；受影响指标不会显示为完整结果。' : '请等待后台升级完成并刷新状态。已有生成记录仍可查看或下载。';
  $('#mode-tag').textContent = realMode ? '真实上传数据' : '等待后台就绪';
  $('#version-label').textContent = `${realMode ? 'v10 真实数据生成' : '等待真实数据生成启用'}${state.app?.version ? ` · 后台 ${state.app.version}` : ''}`;
  renderHistory();
  renderControls();
  window.ReviewUI?.setState(state);
  if (trackedGeneration) {
    const current = (state.generations || []).find(item => item.id === trackedGeneration);
    if (lastReceipt?.generating && ['completed', 'failed'].includes(current?.status)) {
      lastReceipt.generating = false;
      lastReceipt.foot = current.status === 'failed' ? `看板生成失败：${current.error || '请稍后重试'}。资料已更新，可直接重新生成。` : current.needsReview ? '已生成待确认版本，当前看板未替换。收到的原文件都保存在本机。'
        : document.documentElement.classList.contains('embedded') ? '看板已生成并切到「看板」页。收到的原文件都保存在本机。' : '看板已生成，可在下方“生成记录”查看。收到的原文件都保存在本机。';
      renderReceipt();
    }
    if (current?.status === 'completed') {
      setNotice(current.needsReview ? '待确认版本已生成。相关汇总及关联指标保持待确认，请在生成记录中查看；最近正常版本入口未被替换。' : current.mode === 'real' ? '真实数据看板已生成，使用本次开始生成时锁定的来源。可在“生成记录”中查看或下载 HTML；缺失来源和待确认指标已明确标注。' : '历史演示看板已生成。请查看生成记录中的模式说明。');
      trackedGeneration = null;
    } else if (current?.status === 'failed') {
      setNotice(`生成失败：${current.error || '请检查后台状态后重试。'}`, true);
      trackedGeneration = null;
    }
  }
}

async function refresh(silent = false) {
  if (polling) return;
  polling = true;
  try { applyState(await request('/api/state')); }
  catch (error) {
    connectionStatus(false);
    renderControls();
    if (!silent) setNotice(`无法连接本机后台。${error.message}`, true);
  } finally { polling = false; }
}

// ---- 更新数据: every board from one entry (design ⑨) ----
// Files are identified by sheet name. Dated boards (invoice, movement, opening,
// inventory) and whole-replacement boards (terminal, banquet) are analysed by
// the backend, which suggests the mode and checks the export scope; the target
// workbook keeps its original whole upload.
const batchItems = [];
let batchRunning = false;
let generateAfterBatch = false;
let lastReceipt = null;
const moduleOf = id => state?.modules?.find(module => module.id === id) || null;
const moduleTitle = id => moduleOf(id)?.title || '';
const SHORT = { invoice: '发票', movement: '动销', opening: '开瓶', inventory: '库存', terminal: '签约', banquet: '宴席', target: '目标' };
const shortTitle = id => SHORT[id] || moduleTitle(id);
const isUpdatable = id => Boolean(moduleOf(id)?.updatable);
const modesOf = id => moduleOf(id)?.modes || [];
const MODE_LABELS = { incremental: '增量', range: '范围更新', full: '整份替换' };
const countText = value => value === null || value === undefined ? '—' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const wanText = value => value === null || value === undefined ? '—' : (Number(value) / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const figureValue = (figure, value) => figure.unit === 'wan' ? wanText(value) : countText(value);
function figureDelta(figure) {
  if (figure.before === null || figure.after === null || figure.before === undefined || figure.after === undefined) return { text: '—', tone: '' };
  const delta = Number(figure.after) - Number(figure.before);
  if (!delta) return { text: '0', tone: '' };
  const text = figure.unit === 'wan' ? wanText(Math.abs(delta)) : countText(Math.abs(delta));
  return { text: `${delta > 0 ? '+' : '−'}${text}`, tone: delta > 0 ? 'pos' : 'neg' };
}
function batchConflicts() {
  const counts = new Map();
  for (const item of batchItems) if (item.moduleId && ['ready', 'analyzing', 'uploading'].includes(item.status)) counts.set(item.moduleId, (counts.get(item.moduleId) || 0) + 1);
  return counts;
}
// What the card says about this file: ok, confirm (needs a tick), adjust (fixable), scope (re-export).
function itemState(item) {
  if (!['ready', 'uploading'].includes(item.status) || !item.moduleId) return item.status;
  if (!isUpdatable(item.moduleId)) return 'ok';
  const r = item.receipt;
  if (!r) return 'adjust';
  if (r.scope && !r.scope.ok) return 'scope';
  if (r.blocked?.length) return 'adjust';
  if (r.requiresConfirmation && !item.confirmMissing) return 'confirm';
  return 'ok';
}
async function discardStaged(item) {
  if (!item.staged) return;
  const stagedId = item.staged.stagedId; item.staged = null;
  try { await request('/api/updates/discard', { method:'POST', headers:{'Content-Type':'application/json', 'X-Local-Token':state?.token || ''}, body:JSON.stringify({ stagedId }) }); } catch {}
}
async function analyzeItem(item) {
  await discardStaged(item);
  item.status = 'analyzing'; item.confirmMissing = false; item.needConfirm = false; item.error = ''; item.receipt = null; renderBatch();
  while (currentBusy()) { await new Promise(resolve => setTimeout(resolve, 400)); await refresh(true); }
  try {
    const result = await request('/api/updates/analyze', { method:'POST', headers:{'Content-Type':'application/octet-stream', 'X-Filename':encodeURIComponent(item.file.name), 'X-Module-Id':item.moduleId, 'X-Local-Token':state?.token || ''}, body:item.file });
    if (result.duplicate) { item.status = 'duplicate'; item.message = result.message; }
    else Object.assign(item, { staged: result, mode: result.suggestion.mode, start: result.suggestion.start, end: result.suggestion.end, modeAuto: true, receipt: result.receipt, status: 'ready' });
  } catch (error) { item.status = 'failed'; item.message = error.message; }
  renderBatch();
}
let previewTimer = null;
function schedulePreview(item) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (!item.staged) return;
    try {
      const result = await request('/api/updates/preview', { method:'POST', headers:{'Content-Type':'application/json', 'X-Local-Token':state?.token || ''}, body:JSON.stringify({ stagedId:item.staged.stagedId, mode:item.mode, start:item.start, end:item.end }) });
      item.receipt = result.receipt; item.error = '';
    } catch (error) { item.error = error.message; if (error.data?.receipt) item.receipt = error.data.receipt; }
    renderBatch();
  }, 250);
}

const STATUS_TEXT = { ok: ['✓ 可以提交', 'is-ok'], confirm: ['! 需确认', 'is-warn'], adjust: ['✕ 需要调整', 'is-bad'], scope: ['✕ 需要重新导出', 'is-bad'],
  identifying: ['正在识别…', ''], analyzing: ['正在核对…', ''], uploading: ['正在更新…', ''], unknown: ['请选择板块', 'is-warn'], failed: ['✕ 未通过', 'is-bad'], duplicate: ['已处理过', 'is-ok'] };
function scopeLine(item) {
  const scope = item.receipt?.scope;
  if (!scope) return '';
  const parts = [], sentences = [];
  if (scope.checked.zone) parts.push(`战区 ${scope.counts.zones} 个`);
  if (scope.checked.region) parts.push(`大区 ${scope.counts.regions} 个`);
  const product = scope.checked.product ? `${scope.productLabel} ${countText(scope.counts.products)} 个` : '';
  if (parts.length) sentences.push(`范围检查通过：${parts.join('、')}，与当前一致${product ? `；${product}` : ''}`);
  else if (product) sentences.push(`范围检查通过：${product}`);
  for (const note of scope.notes || []) sentences.push(note.replace(/。$/, ''));
  if (item.mode === 'range') sentences.push('区间外数据保持不变');
  if (item.mode === 'incremental') sentences.push(`${item.receipt.identity?.existing ? '' : '全部是新记录，直接追加；'}${item.moduleId === 'inventory' ? '历史盘点保留，「较上次变化」自动接上之前的记录' : '已有日期保持不变'}`);
  return sentences.length ? `${sentences.join('。')}。` : '';
}
function figuresTable(item) {
  const r = item.receipt;
  const whole = !moduleOf(item.moduleId)?.flow;
  const table = element('div', 'check-table');
  table.setAttribute('role', 'table');
  const [beforeLabel, afterLabel] = whole ? ['当前', '新文件'] : item.mode === 'incremental' ? ['现有', '追加后'] : item.mode === 'range' ? ['替换前', '替换后'] : ['当前', '整份替换后'];
  const label = whole ? '' : item.mode === 'range' ? `替换 ${dayRange(r.start, r.end)}` : item.mode === 'incremental' ? `追加 ${dayRange(r.file.start, r.file.end)}` : '整份替换';
  const head = [label, beforeLabel, afterLabel, '变化'].map(text => element('span', 'check-col', text));
  head.forEach(cell => cell.setAttribute('role', 'columnheader'));
  table.append(...head);
  for (const figure of r.figures || []) {
    const delta = figureDelta(figure);
    const cells = [element('span', 'check-label', figure.label), element('span', '', figureValue(figure, figure.before)), element('span', '', figureValue(figure, figure.after)), element('span', `check-delta ${delta.tone}`, delta.text)];
    cells.forEach(cell => cell.setAttribute('role', 'cell'));
    table.append(...cells);
  }
  return table;
}
function checkCard(item, counts) {
  const st = itemState(item), conflict = item.moduleId && counts.get(item.moduleId) > 1;
  const [statusText, statusTone] = conflict ? ['同一板块只能选一个文件', 'is-bad'] : STATUS_TEXT[st] || ['', ''];
  const card = element('div', `check-card is-${conflict ? 'conflict' : st}`);
  const head = element('div', 'check-head');
  const locked = batchRunning || ['uploading', 'analyzing', 'identifying'].includes(item.status);
  if (!item.moduleId || item.status === 'unknown') {
    const select = element('select', 'check-board-select');
    select.setAttribute('aria-label', `${item.file.name} 对应的板块`);
    const empty = element('option', '', '选择板块'); empty.value = ''; select.append(empty);
    for (const module of [...(state?.modules || [])].sort((a,b) => preferredOrder.indexOf(a.id) - preferredOrder.indexOf(b.id))) { const option = element('option', '', module.title); option.value = module.id; select.append(option); }
    select.value = item.moduleId || ''; select.disabled = locked;
    select.addEventListener('change', async () => {
      item.moduleId = select.value || null;
      if (!item.moduleId) { item.status = 'unknown'; renderBatch(); return; }
      if (isUpdatable(item.moduleId)) return analyzeItem(item);
      item.status = 'ready'; renderBatch();
    });
    head.append(select);
  } else head.append(element('b', 'check-board', moduleTitle(item.moduleId)));
  const r = item.receipt;
  const dateLabel = { terminal: '签约日期', inventory: '提交时间' }[item.moduleId] || '文件日期';
  const fileInfo = r?.file?.start ? `${item.file.name} · ${dateLabel} ${dayRange(r.file.start, r.file.end)}` : item.moduleId === 'banquet' && r ? `${item.file.name} · ${countText(r.file.rows)} 行` : item.file.name;
  const file = element('span', 'check-file', fileInfo); file.title = item.file.name;
  head.append(file);
  if (item.status === 'ready' || item.status === 'uploading') {
    const modes = modesOf(item.moduleId);
    if (modes.length > 1) {
      const label = element('label', 'check-mode', '更新方式 ');
      const select = element('select');
      for (const mode of modes) { const option = element('option', '', MODE_LABELS[mode]); option.value = mode; select.append(option); }
      select.value = item.mode; select.disabled = locked || st === 'scope';
      select.addEventListener('change', () => { item.mode = select.value; item.modeAuto = item.mode === item.staged.suggestion.mode; item.confirmMissing = false; if (item.mode === 'range' && !item.start) { item.start = item.staged.suggestion.start; item.end = item.staged.suggestion.end; } schedulePreview(item); renderBatch(); });
      label.append(select); head.append(label);
      if (st !== 'scope') {
        const tag = element('span', item.modeAuto ? 'check-tag' : 'check-tag manual', item.modeAuto ? '系统建议' : '手动');
        tag.title = item.modeAuto ? item.staged.suggestion.reason : `系统建议：${MODE_LABELS[item.staged.suggestion.mode]}（${item.staged.suggestion.reason}）`;
        head.append(tag);
      }
    } else head.append(element('span', 'check-only', isUpdatable(item.moduleId) ? `整份替换（${shortTitle(item.moduleId)}只支持整份）` : '整份替换'));
  }
  head.append(element('span', `check-status ${statusTone}`, statusText));
  const remove = element('button', 'text-button', '移除'); remove.type = 'button'; remove.disabled = locked;
  remove.addEventListener('click', async () => { batchItems.splice(batchItems.indexOf(item), 1); await discardStaged(item); renderBatch(); });
  head.append(remove);
  card.append(head);

  if (['failed', 'duplicate'].includes(item.status)) { card.append(element('p', item.status === 'failed' ? 'check-error' : 'check-note', item.message || '')); return card; }
  if (!isUpdatable(item.moduleId) && item.status === 'ready') { card.append(element('p', 'check-note', '经营目标按原方式整份上传，提交时校验结构。')); return card; }
  if (!r || !['ready', 'uploading'].includes(item.status)) return card;

  if (st === 'scope') {
    const box = element('div', 'check-scope');
    box.append(element('b', '', '导出范围和当前数据不一致，未提交。'));
    for (const message of r.scope.blocked) box.append(element('p', '', `· ${message}`));
    if (r.scope.advice) box.append(element('p', '', r.scope.advice));
    card.append(box);
    return card;
  }
  if (item.mode === 'range' && modesOf(item.moduleId).length > 1) {
    const range = element('div', 'check-range');
    range.append(element('span', '', '替换区间'));
    for (const key of ['start', 'end']) {
      const input = element('input'); input.type = 'date'; input.value = item[key] || ''; input.disabled = locked;
      input.setAttribute('aria-label', key === 'start' ? '替换开始日期' : '替换结束日期');
      input.addEventListener('change', () => { item[key] = input.value; item.modeAuto = false; item.confirmMissing = false; schedulePreview(item); });
      range.append(input);
      if (key === 'start') range.append(element('span', '', '~'));
    }
    card.append(range);
  }
  const compact = item.moduleId === 'banquet' && !r.blocked.length && !r.requiresConfirmation;
  if (compact) {
    const [events, bottles] = r.figures;
    card.append(element('p', 'check-note', `执行场次 ${countText(events.before)} → ${countText(events.after)} · 开瓶 ${countText(bottles.before)} → ${countText(bottles.after)} 瓶。${(r.notes || []).join('')}`));
  } else card.append(figuresTable(item));
  const notes = element('div', 'check-notes');
  if (r.identity?.existing) notes.append(element('p', 'check-note', `按${r.identity.label}：已存在 ${countText(r.identity.existing)} 行 · 新增 ${countText(r.identity.added)} 行。${item.moduleId === 'invoice' ? '合并后仍做重复候选检查。' : '不自动去重。'}`));
  if (r.disappearingDates?.length) notes.append(element('p', 'check-warn', `区间内 ${r.disappearingDates.length} 天在新文件里没有记录，替换后这些天的原有数据会移除：${r.disappearingDates.slice(0, 8).map(shortDay).join('、')}${r.disappearingDates.length > 8 ? ' 等' : ''}。`));
  for (const warning of r.warnings || []) notes.append(element('p', 'check-warn', warning));
  for (const message of r.blocked || []) notes.append(element('p', 'check-error', message));
  if (!compact) for (const note of r.notes || []) notes.append(element('p', 'check-note', note));
  if (r.confirmation) {
    const label = element('label', `check-confirm${item.needConfirm ? ' is-required' : ''}`);
    const box = element('input'); box.type = 'checkbox'; box.checked = !!item.confirmMissing; box.disabled = locked;
    box.addEventListener('change', () => { item.confirmMissing = box.checked; item.needConfirm = false; renderBatch(); });
    label.append(box, document.createTextNode(` ${r.confirmation.message} ${r.confirmation.label}`));
    notes.append(label);
  }
  if (item.error) notes.append(element('p', 'check-error', item.error));
  const line = scopeLine(item);
  if (line && !r.blocked.length) notes.append(element('p', 'check-note', line));
  card.append(notes);
  return card;
}
function effectiveText(moduleId) {
  const upload = selectedUpload(moduleOf(moduleId));
  if (!upload) return '尚未上传';
  return upload.coverage?.end ? `截至 ${shortDay(upload.coverage.end)}` : '上一版';
}
let batchSignature = '';
function renderBatch() {
  const list = $('#batch-list'), counts = batchConflicts();
  // The status poll calls this every two seconds; rebuild the cards only when
  // something on them changed so an open dropdown or date field is not reset.
  const signature = JSON.stringify([batchRunning, batchItems.map(item => [item.file.name, item.status, item.moduleId, item.mode, item.start, item.end, item.modeAuto, item.confirmMissing, item.needConfirm, item.error, item.message, item.receipt])]);
  if (signature !== batchSignature) {
    batchSignature = signature;
    list.replaceChildren();
    for (const item of batchItems) list.append(checkCard(item, counts));
  }
  const has = batchItems.length > 0;
  $('#batch-drop').hidden = has;
  $('#batch-add').hidden = !has;
  $('#batch-actions').hidden = !has;
  const states = batchItems.map(item => ({ item, st: item.moduleId && counts.get(item.moduleId) > 1 ? 'conflict' : itemState(item) }));
  const submittable = states.filter(({ st }) => ['ok', 'confirm'].includes(st));
  const reexport = states.filter(({ st }) => ['scope', 'adjust', 'failed', 'conflict'].includes(st));
  const waiting = states.some(({ st }) => ['identifying', 'analyzing', 'unknown'].includes(st));
  const disabled = batchRunning || !connected || Boolean(currentBusy()) || !submittable.length || waiting;
  $('#batch-upload').disabled = disabled;
  $('#batch-upload').textContent = batchRunning && !generateAfterBatch ? '正在更新…' : '只更新数据';
  $('#batch-generate').disabled = disabled || state?.app?.mode !== 'real';
  $('#batch-generate').textContent = batchRunning && generateAfterBatch ? '正在更新…' : '确认更新并生成看板 →';
  const skipped = states.filter(({ st }) => ['scope', 'adjust', 'conflict'].includes(st)).map(({ item }) => item.moduleId).filter(Boolean);
  const confirmLater = states.filter(({ st }) => st === 'confirm').map(({ item }) => shortTitle(item.moduleId));
  const hints = [];
  for (const id of [...new Set(skipped)]) hints.push(`${shortTitle(id)}不提交，看板沿用${shortTitle(id)}上一版（${effectiveText(id)}）`);
  if (confirmLater.length) hints.push(`${confirmLater.join('、')}勾选确认后一并提交`);
  if (waiting) hints.push(states.some(({ st }) => st === 'unknown') ? '有文件需要选择板块' : '正在核对文件…');
  $('#batch-hint').textContent = hints.join('；') + (hints.length ? '。' : '');
  const touched = new Set(submittable.map(({ item }) => item.moduleId));
  const ready = states.filter(({ st }) => st === 'ok').length, confirm = confirmLater.length;
  $('#batch-summary').textContent = !has ? '六个板块都从这里更新：拖入或选择一个或多个 Excel，按工作表名识别板块。没选的板块沿用当前版本。'
    : `已选 ${batchItems.length} 个文件：${[ready ? `${ready} 个可以提交` : '', confirm ? `${confirm} 个需确认` : '', reexport.length ? `${reexport.length} 个需要重新导出或调整` : ''].filter(Boolean).join('，') || '正在核对'}。${touched.has('target') ? '没选的板块' : '没选的板块和经营目标'}沿用当前版本。`;
  $('#batch-clear').hidden = !has || batchRunning;
}
async function addBatchFiles(files) {
  $('#receipt').hidden = true;
  for (const file of files) {
    if (!/\.xlsx$/i.test(file.name)) { batchItems.push({ file, moduleId:null, status:'failed', message:'不是 .xlsx 文件；旧版 .xls 请先另存为 .xlsx。' }); continue; }
    if (file.size > currentUploadLimits().fileBytes) { batchItems.push({ file, moduleId:null, status:'failed', message:`超过 ${currentUploadLimits().fileBytes / 1048576} MB 上限。` }); continue; }
    batchItems.push({ file, moduleId:null, status:'identifying' });
  }
  renderBatch();
  for (const item of batchItems.filter(item => item.status === 'identifying')) {
    try {
      const result = await request('/api/identify', { method:'POST', headers:{'Content-Type':'application/octet-stream', 'X-Local-Token':state?.token || ''}, body:item.file });
      item.moduleId = result.moduleId; item.reason = result.reason; item.status = result.moduleId ? 'ready' : 'unknown';
    } catch (error) { item.status = 'unknown'; item.reason = `识别失败：${error.message}`; }
    if (item.status === 'ready' && isUpdatable(item.moduleId)) await analyzeItem(item);
    renderBatch();
  }
}
async function uploadTarget(item) {
  const result = await request(`/api/uploads/${encodeURIComponent(item.moduleId)}`, {
    method:'POST', headers:{'Content-Type':'application/octet-stream', 'X-Filename':encodeURIComponent(item.file.name), 'X-Local-Token':state.token}, body:item.file,
  });
  return { result, receipt: null };
}
async function applyItem(item) {
  working = {kind:'upload', moduleId:item.moduleId, stage:item.mode === 'full' ? '正在核对并更新资料' : '正在合并为新版本'}; renderControls();
  try {
    const { result } = isUpdatable(item.moduleId) ? { result: await request('/api/updates/apply', { method:'POST', headers:{'Content-Type':'application/json', 'X-Local-Token':state.token}, body:JSON.stringify({ stagedId:item.staged.stagedId, mode:item.mode, start:item.start, end:item.end, confirmMissing:!!item.confirmMissing }) }) } : await uploadTarget(item);
    item.staged = null;
    if (result.receipt) item.receipt = result.receipt;
    if (result.warnings?.length) item.warnings = result.warnings;
    if (result.state) applyState(result.state);
    const module = result.state?.modules?.find(entry => entry.id === item.moduleId);
    return { ok:true, duplicate:!!result.duplicate, pending:!!module?.candidateUpload, upload:result.upload };
  } catch (error) {
    if (error.data?.receipt) item.receipt = error.data.receipt;
    return { ok:false, message:error.message };
  } finally { working = null; await refresh(true); renderControls(); }
}
function changeText(item) {
  const r = item.receipt;
  if (!r) return '整份替换';
  const figure = key => r.figures?.find(entry => entry.key === key);
  const delta = (key, unit) => { const value = figure(key); if (!value) return ''; const d = figureDelta(value); return `${d.text === '0' ? '±0' : d.text}${unit}`; };
  const arrow = key => { const value = figure(key); return value ? `${countText(value.before)} → ${countText(value.after)}` : ''; };
  const auto = isUpdatable(item.moduleId) && modesOf(item.moduleId).length > 1 ? `（${item.modeAuto ? '系统建议' : '手动'}）` : '';
  const what = item.mode === 'range' ? `范围更新 ${dayRange(r.start, r.end)}${auto}` : item.mode === 'incremental' ? `增量追加 ${dayRange(r.file.start, r.file.end)}${auto}` : `整份替换${auto}`;
  const core = { invoice: `净额 ${delta('amount', ' 万元')}`, movement: `扫码金额 ${delta('amount', ' 万元')}`, opening: `开瓶 ${delta('bottles', ' 瓶')}`, inventory: `${delta('rows', '')} 条盘点`,
    terminal: `协议 ${arrow('agreements')}${r.disappearingAgreements ? `（已确认 ${countText(r.disappearingAgreements)} 份消失）` : ''}`, banquet: `场次 ${arrow('events')}` }[item.moduleId] || '';
  return [what, core].filter(Boolean).join('，');
}
function renderReceipt() {
  const section = $('#receipt');
  if (!lastReceipt) { section.hidden = true; return; }
  section.hidden = false;
  $('#receipt-title').textContent = `本次更新回执 · ${lastReceipt.time}`;
  const grid = $('#receipt-grid'); grid.replaceChildren();
  for (const label of ['板块', '做了什么', '现在生效']) grid.append(element('span', 'receipt-col', label));
  for (const line of lastReceipt.lines) grid.append(element('span', `receipt-board${line.ok ? '' : ' is-bad'}`, line.title), element('span', line.ok ? '' : 'is-bad', line.what), element('span', `receipt-now ${line.ok ? 'is-ok' : 'is-warn'}`, line.now));
  $('#receipt-foot').textContent = lastReceipt.foot;
}
function nowText(moduleId) {
  const module = moduleOf(moduleId), upload = selectedUpload(module);
  if (!upload) return '—';
  const step = upload.composition?.step;
  const end = upload.coverage?.end ? shortDay(upload.coverage.end) : '';
  const pending = module.candidateUpload ? '（检查项待处理，生成仍用上一版）' : '';
  if (step) return `截至 ${end || '—'} · 第 ${step} 次更新${pending}`;
  return `新基线${end ? ` · ${end}` : ''}${pending}`;
}
async function uploadBatch(andGenerate = false) {
  const counts = batchConflicts();
  const states = batchItems.map(item => ({ item, st: item.moduleId && counts.get(item.moduleId) > 1 ? 'conflict' : itemState(item) }));
  const queue = states.filter(({ st }) => ['ok', 'confirm'].includes(st)).map(({ item }) => item);
  if (!queue.length || batchRunning) return;
  // Ticks are settled before anything changes; files that must be re-exported are skipped.
  const unconfirmed = queue.filter(item => itemState(item) === 'confirm');
  if (unconfirmed.length) { for (const item of unconfirmed) item.needConfirm = true; renderBatch(); setNotice('有文件需要先核对并勾选确认，本次还没有更新任何板块。', true); return; }
  const skipped = states.filter(({ st }) => ['scope', 'adjust', 'conflict', 'failed', 'duplicate'].includes(st)).map(({ item }) => item);
  batchRunning = true; generateAfterBatch = andGenerate; setNotice(''); renderBatch();
  const lines = [];
  for (const item of queue) {
    item.status = 'uploading'; renderBatch();
    while (currentBusy()) { await new Promise(resolve => setTimeout(resolve, 500)); await refresh(true); }
    const result = await applyItem(item);
    item.status = result.ok ? result.duplicate ? 'duplicate' : 'done' : 'failed';
    item.pending = result.pending;
    if (result.ok) lines.push({ title: moduleTitle(item.moduleId), ok: true, what: result.duplicate ? '与当前版本相同，未新增版本' : changeText(item), now: nowText(item.moduleId), moduleId: item.moduleId });
    else lines.push({ title: moduleTitle(item.moduleId), ok: false, what: `未提交：${result.message}`, now: `沿用 · ${effectiveText(item.moduleId)}`, moduleId: item.moduleId });
    renderBatch();
  }
  for (const item of skipped) {
    if (!item.moduleId) continue;
    const st = itemState(item);
    const reason = item.status === 'duplicate' ? '这份文件已经处理过，未重复计入' : st === 'scope' ? '未提交：导出范围不一致，请重新导出' : item.status === 'failed' ? `未提交：${item.message || '文件未通过检查'}` : '未提交：需要先调整更新方式或区间';
    lines.push({ title: moduleTitle(item.moduleId), ok: item.status === 'duplicate', what: reason, now: `沿用 · ${effectiveText(item.moduleId)}`, moduleId: item.moduleId });
  }
  lines.sort((a, b) => preferredOrder.indexOf(a.moduleId) - preferredOrder.indexOf(b.moduleId));
  const failed = queue.filter(item => item.status === 'failed').length, pending = queue.some(item => item.pending);
  const now = new Date();
  const willGenerate = andGenerate && !failed && !pending && lines.some(line => line.ok);
  lastReceipt = { time: `${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`, lines, generating: willGenerate,
    foot: willGenerate ? '正在生成看板，完成后切到「看板」页。收到的原文件都保存在本机。'
      : pending ? '有重复候选或组织对应待处理，请在下方“本次数据检查”确认后再生成。收到的原文件都保存在本机。'
        : failed && andGenerate ? '有板块未通过，本次没有生成看板。收到的原文件都保存在本机。' : '收到的原文件都保存在本机。可直接生成看板。' };
  for (const item of batchItems.splice(0, batchItems.length)) await discardStaged(item);
  batchRunning = false; generateAfterBatch = false;
  renderBatch(); renderReceipt(); renderControls();
  $('#receipt').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (willGenerate) await generate(false);
}
$('#batch-input').addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; addBatchFiles(files); });
$('#batch-more').addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; addBatchFiles(files); });
$('#batch-upload').addEventListener('click', () => uploadBatch(false));
$('#batch-generate').addEventListener('click', () => uploadBatch(true));
$('#batch-clear').addEventListener('click', async () => { const items = batchItems.splice(0, batchItems.length); renderBatch(); for (const item of items) await discardStaged(item); });
$('#receipt-close').addEventListener('click', () => { lastReceipt = null; renderReceipt(); });
const panel = $('#update-panel'), drop = $('#batch-drop');
for (const name of ['dragenter', 'dragover']) panel.addEventListener(name, event => { event.preventDefault(); drop.classList.add('is-dragging'); panel.classList.add('is-dragging'); });
for (const name of ['dragleave', 'drop']) panel.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('is-dragging'); panel.classList.remove('is-dragging'); });
panel.addEventListener('drop', event => addBatchFiles([...event.dataTransfer.files]));

async function generate(allowPending = false) {
  if (currentBusy() || !state?.token || state.app?.mode !== 'real' || !state.modules?.some(module => module.activeUpload || module.candidateUpload)) return;
  working = {kind:'generate', stage:'正在创建生成任务'}; setNotice(''); renderControls();
  try {
    const result = await request('/api/generations', {method:'POST', headers:{'Content-Type':'application/json', 'X-Local-Token':state.token}, body:JSON.stringify({allowPending})});
    trackedGeneration = result.generation.id;
  } catch (error) { setNotice(`无法开始生成：${error.message}`, true); }
  finally { working = null; await refresh(); renderControls(); }
}

$('#refresh').addEventListener('click', async () => { setNotice(''); await refresh(); });
$('#generate-button').addEventListener('click', () => generate(false));
document.querySelectorAll('.rail-item').forEach(link => link.addEventListener('click', () => {
  document.querySelectorAll('.rail-item').forEach(item => item.classList.toggle('active', item === link));
}));
window.ReviewUI?.init({request, getState: () => state, applyState, isBusy: () => Boolean(currentBusy()) || !connected, setWorking: value => { working = value; renderControls(); }, generate});
refresh();
setInterval(() => { if (document.visibilityState === 'visible' || currentBusy()) refresh(true); }, 2000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(true); });
