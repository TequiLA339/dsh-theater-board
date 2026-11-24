import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './store.mjs';
import { moduleDefinitions } from './modules.mjs';
import { resolveInspection, validateDecision, validateOrganizationRule } from './review-engine.mjs';
import { lineageShas } from './incremental/flow.mjs';

export const emptyReview = () => ({ version: 1, revision: 0, decisions: [], organizationRules: [], history: [] });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const live = rule => !rule.revokedAt;
function validated(fn, ...args) { try { return fn(...args); } catch (e) { throw error(e.message); } }
function organizationConflict(a, b) {
  return live(a) && live(b) && a.moduleId === b.moduleId && a.formatKey === b.formatKey && same(a.from, b.from)
    && (a.remember || b.remember || a.sourceSha256 === b.sourceSha256)
    && (a.start || '0000') <= (b.end || '9999') && (b.start || '0000') <= (a.end || '9999')
    && !same(a.to, b.to);
}

export function createReviewService({ store, dataDir, scan }) {
  const cache = new Map();
  const settings = () => store.state.review ?? emptyReview();
  function resolveCurrent(raw, rules, old) {
    return resolveInspection(raw, rules, old);
  }
  async function legacy() {
    try { return JSON.parse(await readFile(resolve(dataDir, 'generation-decisions.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return {}; throw error('原业务决定文件无法读取，请先核实文件。', 422); }
  }
  async function inspection(upload) {
    if (!upload) return null;
    if (cache.has(upload.id)) return cache.get(upload.id);
    try {
      const result = JSON.parse(await readFile(resolve(dataDir, 'uploads', upload.id, 'inspection.json'), 'utf8'));
      if (result.sha256 !== upload.sha256 || result.moduleId !== upload.moduleId || result.version !== 1) throw error('检查记录与来源不一致，请重新检查。', 422);
      cache.set(upload.id, result); return result;
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function saveInspection(upload, result) {
    await atomicJson(resolve(dataDir, 'uploads', upload.id, 'inspection.json'), result);
    cache.set(upload.id, result);
  }
  async function inspect(upload) {
    const result = await scan({ file: resolve(dataDir, 'uploads', upload.id, 'source.xlsx'), moduleId: upload.moduleId, sha256: upload.sha256, validation: upload.validation });
    await saveInspection(upload, result); return result;
  }
  const selected = (state, id) => state.uploads.find(u => u.id === (state.candidates?.[id] || state.active[id]) && u.moduleId === id);
  async function view() {
    const rules = settings(), old = await legacy();
    const modules = [];
    for (const module of moduleDefinitions) {
      const upload = selected(store.state, module.id);
      const raw = await inspection(upload);
      const result = raw ? resolveCurrent({ ...raw, lineage: lineageShas(store.state, upload.id) }, rules, old) : null;
      modules.push({ id: module.id, title: module.title, uploadId: upload?.id ?? null, filename: upload?.filename ?? null,
        sha256: upload?.sha256 ?? null, activeUploadId: store.state.active[module.id] ?? null,
        status: !upload ? 'missing' : !result ? 'unchecked' : result.errors.length ? 'error' : result.pendingCount ? 'pending' : 'ready', inspection: result });
    }
    return { revision: rules.revision, modules, decisions: rules.decisions, organizationRules: rules.organizationRules, history: rules.history };
  }
  async function update(change, action, detail = {}) {
    await store.update(async next => {
      next.review ??= emptyReview(); next.candidates ??= {};
      await change(next);
      next.review.revision++;
      next.review.history.push({ id: randomUUID(), action, at: new Date().toISOString(), ...detail });
    });
  }
  async function promote(next) {
    const old = await legacy();
    for (const module of moduleDefinitions) {
      const upload = selected(next, module.id), raw = await inspection(upload);
      if (!raw) continue;
      const result = resolveCurrent({ ...raw, lineage: lineageShas(next, upload.id) }, next.review, old);
      upload.reviewStatus = result.errors.length ? 'error' : result.pendingCount ? 'pending' : 'ready';
      if (!result.pendingCount && !result.errors.length) {
        next.active[module.id] = upload.id; delete next.candidates[module.id];
      } else next.candidates[module.id] = upload.id;
    }
  }
  async function check() {
    // Continue checking independent sources even when another source cannot be read.
    for (const module of moduleDefinitions) {
      const upload = selected(store.state, module.id);
      if (!upload) continue;
      try { await inspect(upload); }
      catch (e) {
        await saveInspection(upload, { version: 1, moduleId: module.id, sha256: upload.sha256, sheet: upload.validation?.sheet ?? '', formatKey: '', rowCount: upload.validation?.rowCount ?? 0, coverage: { start: null, end: null }, groups: [], organizations: [], errors: [e.message] });
      }
    }
    await update(promote, 'check');
    return view();
  }
  function assertRevision(body) {
    if (!Number.isSafeInteger(body.revision) || body.revision !== settings().revision) throw error('检查结果已变化，请刷新后再保存；原选择尚未改写。', 409);
  }
  async function currentInspection(body) {
    const upload = store.state.uploads.find(u => u.id === body.uploadId);
    if (!upload || selected(store.state, upload.moduleId)?.id !== upload.id) throw error('当前来源已变化，请刷新检查结果。', 409);
    const result = await inspection(upload);
    if (!result || result.errors.length) throw error('请先完成来源检查并处理无法读取的问题。', 422);
    return result;
  }
  async function mutate(action, body) {
    assertRevision(body);
    if (action === 'decisions') {
      const raw = await currentInspection(body), clean = validated(validateDecision, raw, body);
      const id = randomUUID(), createdAt = new Date().toISOString();
      await update(async next => {
        // Saving a new explicit choice revises this group's previous choices, not unrelated groups.
        for (const item of next.review.decisions) if (live(item) && item.moduleId === clean.moduleId && item.formatKey === clean.formatKey && item.groupKey === clean.groupKey && (item.remember || clean.remember || item.sourceSha256 === clean.sourceSha256)) item.revokedAt = createdAt;
        next.review.decisions.push({ id, createdAt, ...clean }); await promote(next);
      }, 'decision', { decisionId: id, moduleId: clean.moduleId, uploadId: body.uploadId });
    } else if (action === 'organizations') {
      const raw = await currentInspection(body), clean = validated(validateOrganizationRule, raw, body);
      if (settings().organizationRules.some(rule => organizationConflict(rule, clean))) throw error('此期间已有不同的组织对应关系，请先撤销原关系再保存。', 409);
      const id = randomUUID();
      await update(async next => { next.review.organizationRules.push({ id, createdAt: new Date().toISOString(), ...clean }); await promote(next); }, 'organization', { ruleId: id, moduleId: clean.moduleId });
    } else if (action === 'revoke') {
      if (typeof body.id === 'string' && body.id.startsWith('legacy:')) {
        const current = await view();
        const module = current.modules.find(module => module.inspection?.groups.some(group => group.decisionId === body.id));
        const group = module?.inspection.groups.find(group => group.decisionId === body.id);
        if (!group || group.status !== 'resolved') throw error('原处理记录已变化，请刷新后重试。', 409);
        const clean = validateDecision(module.inspection, { groupKey: group.key, keepKeys: group.keepKeys, remember: false });
        const id = randomUUID(), at = new Date().toISOString();
        await update(async next => { next.review.decisions.push({ id, ...clean, createdAt: at, revokedAt: at, legacyDecisionId: body.id }); await promote(next); }, 'revoke', { recordId: id });
        return view();
      }
      const item = [...settings().decisions, ...settings().organizationRules].find(item => item.id === body.id && live(item));
      if (!item) throw error('没有可撤销的处理记录，请刷新后重试。', 404);
      await update(async next => {
        [...next.review.decisions, ...next.review.organizationRules].find(item => item.id === body.id).revokedAt = new Date().toISOString();
        await promote(next);
      }, 'revoke', { recordId: body.id });
    } else if (action === 'select') {
      const upload = store.state.uploads.find(u => u.id === body.uploadId && u.moduleId === body.moduleId);
      if (!upload) throw error('上传版本不存在。', 404);
      if (!await inspection(upload)) await inspect(upload);
      await update(async next => { next.candidates[body.moduleId] = upload.id; await promote(next); }, 'select', { uploadId: upload.id, moduleId: upload.moduleId });
    } else if (action === 'restore') {
      const backup = body.backup;
      if (!backup || backup.kind !== 'theater-review-settings' || backup.version !== 1 || !Array.isArray(backup.decisions) || !Array.isArray(backup.organizationRules) || backup.decisions.length + backup.organizationRules.length > 20000) throw error('不是受支持的处理设置备份。');
      const imported = { decisions: [], organizationRules: [] };
      const ids = new Set([...settings().decisions, ...settings().organizationRules].map(item => item.id));
      for (const type of ['decisions', 'organizationRules']) for (const item of backup[type]) {
        if (!item || typeof item.id !== 'string' || !/^[a-f0-9-]{36}$/.test(item.id) || !Number.isFinite(Date.parse(item.createdAt)) || (item.revokedAt && !Number.isFinite(Date.parse(item.revokedAt)))) throw error('备份中的处理记录无效。');
        if (ids.has(item.id)) {
          const existing = [...settings().decisions, ...settings().organizationRules].find(row => row.id === item.id);
          if (!same(existing, item)) throw error('备份与本机同一处理记录不同，未覆盖本机决定。', 409);
          continue;
        }
        const source = store.state.uploads.find(u => u.moduleId === item.moduleId && u.sha256 === item.sourceSha256);
        if (!source) throw error('备份对应的原始上传尚未恢复；请先恢复或导入对应 Excel。', 422);
        const raw = await inspection(source) ?? await inspect(source);
        const clean = validated(type === 'decisions' ? validateDecision : validateOrganizationRule, raw, item);
        if (clean.formatKey !== item.formatKey || clean.sourceSha256 !== item.sourceSha256) throw error('备份与来源核对不一致。');
        const record = { id: item.id, createdAt: item.createdAt, ...clean, ...(item.revokedAt ? { revokedAt: item.revokedAt } : {}) };
        const candidates = [...settings()[type], ...imported[type]];
        if (type === 'organizationRules' && candidates.some(row => organizationConflict(row, record))) throw error('备份中存在冲突的组织关系，未导入。', 409);
        if (type === 'decisions' && live(record) && candidates.some(row => live(row) && row.moduleId === record.moduleId && row.formatKey === record.formatKey && row.groupKey === record.groupKey && (row.remember || record.remember || row.sourceSha256 === record.sourceSha256) && !same([...row.keepKeys].sort(), record.keepKeys))) throw error('备份中存在冲突的重复处理决定，未导入。', 409);
        imported[type].push(record); ids.add(record.id);
      }
      const history = backup.history ?? [];
      if (!Array.isArray(history) || history.length > 100000) throw error('备份的操作记录格式无效。');
      const restoredHistory = history.map(item => {
        if (!item || typeof item.id !== 'string' || !/^[a-f0-9-]{36}$/.test(item.id) || typeof item.action !== 'string' || item.action.length > 50 || !Number.isFinite(Date.parse(item.at))) throw error('备份的操作记录无效。');
        return Object.fromEntries(Object.entries(item).filter(([key, value]) => ['id', 'action', 'at', 'decisionId', 'ruleId', 'recordId', 'moduleId', 'uploadId', 'imported'].includes(key) && (typeof value === 'string' && value.length < 1000 || typeof value === 'number' && Number.isSafeInteger(value))));
      });
      await update(async next => {
        next.review.decisions.push(...imported.decisions); next.review.organizationRules.push(...imported.organizationRules);
        const seen = new Set(next.review.history.map(item => item.id));
        for (const item of restoredHistory) if (!seen.has(item.id)) { next.review.history.push(item); seen.add(item.id); }
        await promote(next);
      }, 'restore', { imported: imported.decisions.length + imported.organizationRules.length });
    } else throw error('没有这个检查操作。', 404);
    return view();
  }
  function backup() { return { kind: 'theater-review-settings', version: 1, exportedAt: new Date().toISOString(), decisions: settings().decisions, organizationRules: settings().organizationRules, history: settings().history, note: '仅包含处理设置，不包含原始 Excel。完整业务迁移请保留整个本机数据目录。' }; }
  return { view, check, mutate, backup, inspect, inspection, saveInspection, promote, settings, legacy };
}
