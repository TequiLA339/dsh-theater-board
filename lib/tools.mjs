// Read-only board queries behind the DSH AI tools (contract: docs/DSH插件.md §5).
// Everything is computed from the latest completed generation's embedded payload
// with the same createV10Model the dashboard runs, so numbers match the board.
// Nothing here writes to the data directory or calls backend write endpoints.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export class BoardToolError extends Error {
  constructor(code, message, detail = {}) { super(message); this.code = code; this.detail = detail; }
}

const FLOW = ['invoice', 'movement', 'opening'];
const MONTH = /^\d{4}-\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = value => String(value ?? '').trim();

/** Payload literal boundaries inside a rendered dashboard (see v10-template.mjs renderShell). */
export function extractPayload(html, unpackSource) {
  const prefix = `const V10_PAYLOAD=(${unpackSource})(`;
  const start = html.indexOf(prefix);
  if (start < 0) return null;
  const from = start + prefix.length;
  const end = html.indexOf(');\nconst V10_PRESENTATION=', from);
  if (end < 0) return null;
  return JSON.parse(html.slice(from, end));
}

export function createBoardQueries({ dataDir, backendDir, port, problem = () => null }) {
  let modulesPromise;
  const code = () => modulesPromise ??= Promise.all([
    import(pathToFileURL(resolve(backendDir, 'real-data/v10-template.mjs')).href),
    import(pathToFileURL(resolve(backendDir, 'real-data/v10-model.mjs')).href),
    import(pathToFileURL(resolve(backendDir, 'real-data/terminal-structure.mjs')).href),
    import(pathToFileURL(resolve(backendDir, 'modules.mjs')).href),
    import(pathToFileURL(resolve(backendDir, 'server.mjs')).href),
  ]).then(([template, model, terminal, modules, server]) => ({
    unpack: template.unpackV10Payload, createV10Model: model.createV10Model, buildTerminalStructure: terminal.buildTerminalStructure,
    definitions: modules.moduleDefinitions, cycles: server.DEFAULT_CYCLES,
  }));

  const readState = async () => {
    try { return JSON.parse(await readFile(resolve(dataDir, 'state.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { uploads: [], active: {}, candidates: {}, generations: [] };
      throw new BoardToolError('state_unreadable', '无法读取插件数据目录中的 state.json，请在看板“更新数据”中检查后台状态。');
    }
  };
  const selectedId = (state, id) => state.candidates?.[id] || state.active?.[id] || null;
  const byTime = (a, b) => String(b.finishedAt || b.createdAt || '').localeCompare(String(a.finishedAt || a.createdAt || ''));
  const latestCompleted = state => [...(state.generations || [])].filter(job => job.status === 'completed').sort(byTime)[0] || null;
  const boardUrl = id => `http://127.0.0.1:${port}/api/generations/${id}/view`;
  const newerUploads = (state, job, titles) => {
    const ids = new Set([...Object.keys(state.active || {}), ...Object.keys(state.candidates || {})]);
    return [...ids].filter(id => selectedId(state, id) && selectedId(state, id) !== job.sourceVersions?.[id]?.uploadId)
      .map(id => ({ moduleId: id, title: titles[id] || id }));
  };

  let cached = null;
  /** Load (and cache by generation id) the latest board's model. */
  async function board() {
    const [state, lib] = await Promise.all([readState(), code()]);
    const titles = Object.fromEntries(lib.definitions.map(item => [item.id, item.title]));
    const job = latestCompleted(state);
    if (!job) throw new BoardToolError('no_board', '还没有成功生成过看板。请在战区看板的“更新数据”中上传资料并生成看板后再查询。');
    if (cached?.id !== job.id) {
      let html;
      try { html = await readFile(resolve(dataDir, 'generations', job.id, 'dashboard.html'), 'utf8'); }
      catch { throw new BoardToolError('no_board', '最近一次生成的看板文件无法读取，请重新生成看板。'); }
      let payload;
      try { payload = extractPayload(html, lib.unpack.toString()); } catch { payload = null; }
      if (!payload) throw new BoardToolError('no_board', '最近一次生成的看板格式较旧，无法读取其中的数据；请在界面中重新生成看板后再查询。');
      const unpacked = lib.unpack(payload);
      const modelMatchesBoard = html.includes(`const V10=(${lib.createV10Model.toString()})(V10_PAYLOAD);`)
        && html.includes(`const buildTerminalStructure=(${lib.buildTerminalStructure.toString()});`);
      cached = { id: job.id, model: lib.createV10Model(unpacked), modelMatchesBoard, coverage: unpacked.coverage || {} };
    }
    const basis = {
      generationId: job.id, generatedAt: job.finishedAt || job.createdAt, payloadSha256: job.payloadSha256 || null,
      modelMatchesBoard: cached.modelMatchesBoard, newerUploads: newerUploads(state, job, titles),
      dataEnd: Object.fromEntries(FLOW.map(id => [id, cached.coverage[id]?.end || null])),
      ...(cached.modelMatchesBoard ? {} : { warning: '看板生成后计算代码已更新，数字可能与看板略有不同，建议重新生成。' }),
    };
    return { model: cached.model, basis, state, titles };
  }

  // ---- status ----
  async function coverageOf(upload) {
    if (upload.coverage?.start || upload.coverage?.end) return upload.coverage;
    for (const file of ['coverage.json', 'aggregate.json']) {
      try {
        const data = JSON.parse(await readFile(resolve(dataDir, 'uploads', upload.id, file), 'utf8'));
        if (data.sha256 !== upload.sha256) continue;
        const range = file === 'coverage.json' ? data : data.aggregate;
        if (range?.start || range?.end) return { start: range.start || null, end: range.end || null };
      } catch {}
    }
    return null;
  }
  const localDay = value => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? null : new Date(date.getFullYear(), date.getMonth(), date.getDate()); };
  const cycleDays = { daily: 1, weekly: 7, monthly: 31, irregular: Infinity };

  async function status({ now = Date.now() } = {}) {
    const [state, lib] = await Promise.all([readState(), code()]);
    const issue = problem();
    const cycles = { ...lib.cycles, ...(state.settings?.cycles || {}) };
    const sources = [];
    for (const definition of lib.definitions) {
      const id = definition.id, uploadId = selectedId(state, id);
      const upload = (state.uploads || []).find(item => item.id === uploadId && item.moduleId === id);
      const cycle = cycles[id] || 'irregular';
      if (!upload) { sources.push({ moduleId: id, title: definition.title, state: 'none', filename: null, uploadedAt: null, dataStart: null, dataEnd: null, reviewStatus: null, cycle, overdue: null }); continue; }
      const range = await coverageOf(upload);
      const day = localDay(upload.uploadedAt || upload.createdAt);
      const age = day ? Math.round((localDay(now) - day) / 86400000) : null;
      sources.push({
        moduleId: id, title: definition.title, state: 'active', filename: upload.originalName || upload.filename || null,
        uploadedAt: upload.uploadedAt || upload.createdAt || null, dataStart: range?.start || null, dataEnd: range?.end || null,
        ...(range ? {} : { dataRangeNote: '数据起止日尚未计算；打开插件后台后会自动补算。' }),
        reviewStatus: upload.reviewStatus ?? 'unchecked', cycle, overdue: age === null ? null : age >= (cycleDays[cycle] ?? Infinity),
      });
    }
    const titles = Object.fromEntries(lib.definitions.map(item => [item.id, item.title]));
    const job = latestCompleted(state);
    const failed = [...(state.generations || [])].sort(byTime)[0];
    return {
      backend: issue ? { state: 'problem', message: issue.message } : { state: 'running', url: `http://127.0.0.1:${port}/` },
      sources,
      latestBoard: job ? { generationId: job.id, generatedAt: job.finishedAt || job.createdAt, filename: job.filename || null, needsReview: Boolean(job.needsReview), url: boardUrl(job.id), newerUploads: newerUploads(state, job, titles) } : null,
      lastAttempt: failed && failed.status === 'failed' ? { at: failed.finishedAt || failed.createdAt, error: failed.error || '生成未完成' } : null,
    };
  }

  // ---- organizations ----
  const partsOf = key => { try { const parts = JSON.parse(key); return Array.isArray(parts) ? parts.map(text) : []; } catch { return []; } };
  const fullPath = key => partsOf(key).map(value => value || '未提供').join(' / ');
  function levelItems(model, level, parentFilter) {
    const keys = new Map();
    for (const org of model.organizations) {
      if (parentFilter && !parentFilter(org)) continue;
      const key = org[level];
      if (!keys.has(key)) keys.set(key, { key, name: partsOf(key).at(-1) || '未提供', fullPath: fullPath(key), label: model.label(key) });
    }
    return [...keys.values()];
  }
  function sourcesOf(model, level, key) {
    return model.ids.filter(id => model.payload.modules[id].records.some(row => {
      const parts = row.orgPath || [];
      const depth = { region: 4, office: 5, unit: 6 }[level];
      return JSON.stringify(parts.slice(0, depth).map(value => value || '')) === JSON.stringify(partsOf(key).map(value => value || ''));
    })).map(id => model.titles[id]);
  }
  function resolveOrg(model, { region, office, unit }) {
    const filters = { region: 'all', office: 'all', unit: 'all' };
    const pick = (level, name, parent) => {
      const all = levelItems(model, level, parent);
      // Board dropdown label first (unique by construction), then full path, then bare name.
      let items = all.filter(item => item.label === name);
      if (!items.length) items = all.filter(item => item.fullPath === name);
      if (!items.length) items = all.filter(item => item.name === name);
      const names = { region: '大区', office: '办事处', unit: '主任单元' };
      if (!items.length) {
        const options = all.map(item => item.label);
        const near = options.filter(option => option.includes(name) || name.includes(option)).slice(0, 10);
        throw new BoardToolError('org_not_found', `看板中没有名为“${name}”的${names[level]}。`, { level, suggestions: near.length ? near : options.slice(0, 20) });
      }
      if (items.length > 1) throw new BoardToolError('org_ambiguous', `“${name}”对应多个${names[level]}，请改用看板中的显示名称或完整路径。`, { level, candidates: items.map(item => ({ name: item.label, fullPath: item.fullPath })) });
      return items[0].key;
    };
    if (text(region)) filters.region = pick('region', text(region));
    if (text(office)) filters.office = pick('office', text(office), filters.region === 'all' ? null : org => org.region === filters.region);
    if (text(unit)) filters.unit = pick('unit', text(unit), org => (filters.region === 'all' || org.region === filters.region) && (filters.office === 'all' || org.office === filters.office));
    // Fill parents from the chosen child so the selection is a consistent path.
    const chosen = model.organizations.find(org => (filters.unit === 'all' || org.unit === filters.unit) && (filters.office === 'all' || org.office === filters.office) && (filters.region === 'all' || org.region === filters.region));
    if (chosen && filters.unit !== 'all') { filters.office = chosen.office; filters.region = chosen.region; }
    else if (chosen && filters.office !== 'all') filters.region = chosen.region;
    return filters;
  }

  async function organizations({ region, office } = {}) {
    const { model, basis } = await board();
    const parentFilters = resolveOrg(model, { region, office });
    const level = parentFilters.office !== 'all' ? 'unit' : parentFilters.region !== 'all' ? 'office' : 'region';
    const items = levelItems(model, level, org => (parentFilters.region === 'all' || org.region === parentFilters.region) && (parentFilters.office === 'all' || org.office === parentFilters.office))
      .map(item => ({ name: item.label, fullPath: item.fullPath, sources: sourcesOf(model, level, item.key) }))
      // Only organizations the summary can answer for (invoice / movement / opening).
      .filter(item => item.sources.some(title => FLOW.some(id => model.titles[id] === title)));
    return { basis: { generationId: basis.generationId, generatedAt: basis.generatedAt }, level, items };
  }

  // ---- summary ----
  function shape(item, model) {
    if (!item) return { label: null, unit: null, value: null, display: null, state: 'missing', reason: '没有该指标' };
    const available = item.state === 'available' && finite(item.value);
    let display = null;
    if (available) display = item.unit === '元' ? `${model.format(item.value / 10000, 2)} 万元` : item.unit === '%' ? `${model.format(item.value, 1)}%` : `${model.format(item.value, item.precision ?? 0)} ${item.unit}`;
    return { label: item.label, unit: item.unit, value: available ? item.value : null, display, state: available ? 'available' : (item.state === 'available' ? 'pending' : item.state || 'pending'), reason: available ? null : item.reason || null, ...(item.note ? { note: item.note } : {}) };
  }

  function periodFilters(model, { month, start, end }) {
    const hasMonth = month !== undefined && month !== null && month !== '';
    const hasRange = Boolean(start || end);
    if (hasMonth && hasRange) throw new BoardToolError('bad_period', 'month 与 start/end 只能二选一。');
    const months = model.months.filter(value => MONTH.test(value));
    if (hasMonth) {
      if (!MONTH.test(month)) throw new BoardToolError('bad_period', `月份格式应为 YYYY-MM：${month}`);
      if (!months.includes(month)) throw new BoardToolError('bad_period', `看板中没有 ${month} 的来源记录。`, { months: months.length ? { first: months[0], last: months.at(-1) } : null });
      return { month, period: 'month', start: null, end: null };
    }
    if (hasRange) {
      if (!DATE.test(start || '') || !DATE.test(end || '') || start > end) throw new BoardToolError('bad_period', '区间需同时给出 start 与 end（YYYY-MM-DD），且开始不晚于结束。');
      const bounds = model.dateBounds;
      if (!bounds || start < bounds.min || end > bounds.max) throw new BoardToolError('bad_period', bounds ? `区间超出来源范围 ${bounds.min} 至 ${bounds.max}。` : '来源没有可用的日期范围。', { bounds });
      return { month: end.slice(0, 7), period: 'range', start, end };
    }
    return { month: model.defaults.month, period: 'month', start: null, end: null };
  }

  async function summary(args = {}) {
    const { model, basis } = await board();
    const org = resolveOrg(model, args);
    const filters = { ...model.defaults, ...periodFilters(model, args), ...org, product: 'all' };
    const result = model.select(filters);
    const p = result.period;
    const modules = {};
    for (const id of FLOW) {
      const m = result.modules[id];
      const t = m.targets || {};
      modules[id] = {
        title: m.title, state: m.state, main: shape(m.main, model),
        ...(id === 'opening' ? {} : { ytd: shape(m.extra.find(item => item.label === '当年截至所选月来源金额'), model) }),
        targets: { attainment: shape(t.attainment, model), ytdAttainment: shape(t.ytdAttainment, model), target: shape(t.month, model), ytdTarget: shape(t.ytd, model) },
        records: m.recordCount, notes: [...m.pending],
      };
    }
    const scopeKey = org.unit !== 'all' ? org.unit : org.office !== 'all' ? org.office : org.region !== 'all' ? org.region : null;
    return {
      basis,
      scope: { label: model.scope(org), fullPath: scopeKey ? fullPath(scopeKey) : '全战区' },
      period: { mode: p.mode, start: p.start, end: p.end, label: p.label },
      modules,
    };
  }

  return { status, summary, organizations, board };
}

/** Stable digest of the data directory files the tools may read (for read-only tests). */
export async function digestFiles(paths) {
  const hash = createHash('sha256');
  for (const path of paths) { try { hash.update(path); hash.update(await readFile(path)); } catch { hash.update(`${path}:missing`); } }
  return hash.digest('hex');
}
