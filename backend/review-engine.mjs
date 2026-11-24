import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { moduleById, normalizeHeader } from './modules.mjs';
import { validateWorkbook } from './validate-workbook.mjs';

// This module is pure apart from workbook reads. Persisted decisions and source
// promotion remain the server's responsibility; original workbooks are never edited.
const VERSION = 1;
const ORG_FIELDS = ['marketingCompany', 'businessUnit', 'theater', 'region', 'office', 'unit'];
const DATE_MODULES = new Set(['invoice', 'movement', 'opening']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => value === null || value === undefined ? '' : String(value).trim();
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validPath = path => Array.isArray(path) && path.length === 6 && path.every(value => typeof value === 'string' && value.length <= 1000);
const pathKey = path => JSON.stringify(path);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const alive = record => !record.revokedAt && record.disabled !== true;
// A source composed from earlier versions (incremental / range updates) keeps
// decisions made on those versions; changed groups no longer match by content.
const boundTo = (record, source) => record.remember === true || record.sourceSha256 === source.sha256 || (Array.isArray(source.lineage) && source.lineage.includes(record.sourceSha256));

function scalar(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  if ('formula' in value || 'sharedFormula' in value) return scalar(value.result);
  if (value.richText) return value.richText.map(part => part.text).join('');
  if ('text' in value) return value.text;
  return null;
}

export function sourceDate(value, date1904 = false) {
  if (value instanceof Date) value = value.toISOString();
  if (typeof value === 'number' && value > 0 && value < 100000) {
    if (!date1904 && Math.floor(value) === 60) return null;
    const correction = !date1904 && value < 60 ? 86400000 : 0;
    value = new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) + Math.floor(value) * 86400000 + correction).toISOString();
  }
  const match = text(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T].*)?$/);
  if (!match) return null;
  const result = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const parsed = new Date(`${result}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === result ? result : null;
}

function numeric(value) {
  if (value === null || value === undefined || text(value) === '' || typeof value === 'boolean') return null;
  const raw = text(value);
  if (raw.includes(',') && !/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) return null;
  const clean = raw.replaceAll(',', '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(clean)) return null;
  const result = Number(clean);
  return Number.isFinite(result) ? result : null;
}

function canonical(header, value, date1904) {
  value = scalar(value);
  if (value === null || value === undefined || typeof value === 'string' && !value.trim()) return null;
  // Only declared dates/numbers are normalized. Codes and document line IDs
  // retain leading zeros and never pass through numeric conversion.
  if (/日期$/.test(header)) return sourceDate(value, date1904) ?? text(value);
  if (/金额|数量|瓶数|件数|拆分比例|含税单价|毫升/.test(header) && !/编号|编码/.test(header)) return numeric(value) ?? text(value);
  return typeof value === 'string' ? value.trim() : value;
}

function fieldAccess(headers, values, positions = new Map(headers.map((header, index) => [normalizeHeader(header), index]))) {
  return (...names) => {
    for (const name of names) {
      const index = positions.get(normalizeHeader(name));
      if (index !== undefined) return values[index];
    }
    return null;
  };
}

// Keep visit-history path interpretation aligned with inventory-history.mjs:
// the raw complete source path is the identity when explicit anchors cannot
// uniquely locate its hierarchy. A same-named short path is never substituted.
function visitOrganization(row) {
  const get = row.get;
  const rawPath = get('营销组织') === null || get('营销组织') === undefined ? '' : String(get('营销组织'));
  const segments = rawPath.split('/').map(part => part.trim());
  const company = text(get('营销公司'));
  const anchors = [text(get('大区')), text(get('办事处')), text(get('客户主任单元'))];
  const positions = segments.flatMap((part, index) => company && part === company ? [index] : []);
  const companyIndex = positions.length === 1 ? positions[0] : -1;
  const collapsed = anchors.filter((part, index) => !index || part !== anchors[index - 1]);
  const suffixes = anchors.every(part => part === anchors[0]) ? [anchors, anchors.slice(0, 2), collapsed] : [anchors, collapsed];
  if (companyIndex >= 0 && anchors.every(Boolean)) for (const suffix of suffixes) {
    if (!suffix.every((part, index) => segments.at(index - suffix.length) === part)) continue;
    const between = segments.slice(companyIndex + 1, -suffix.length);
    if (companyIndex >= segments.length - suffix.length || ![1, 2].includes(between.length) || !between.every(Boolean)) continue;
    return [company, between.length === 2 ? between[0] : '', between.at(-1), ...anchors];
  }
  return [rawPath || `未提供营销组织（${row.sheet ?? ''} 第 ${row.row ?? ''} 行）`, '', '', '', '', ''];
}

function organization(moduleId, row, sourceFormat) {
  if (moduleId === 'inventory' && sourceFormat === 'visit-history') return visitOrganization(row);
  const headers = {
    invoice: ['销售大区', '办事处', '客户主任单元'], movement: ['大区名称', '办事处名称', '主任单元名称'],
    opening: ['产品所属-大区', '产品所属-办事处', '产品所属-主任单元'], terminal: ['大区', '办事处', '主任单元'],
    inventory: ['大区名称', '办事处名称', '单元名称'], banquet: ['大区', '办事处', '主任单元'], target: ['大区', '办事处', '主任单元'],
  }[moduleId];
  return [text(row.get('营销公司名称')), text(row.get('事业部名称', '事业部')), text(row.get('战区名称')), ...headers.map(header => text(row.get(header)))];
}

function recordDate(moduleId, row, date1904) {
  const header = { invoice: '业务日期', movement: '扫码日期', opening: '抽奖日期', terminal: '签约日期', inventory: '提交时间' }[moduleId];
  return header ? sourceDate(row.get(header), date1904) : null;
}

export async function inspectWorkbook({ file, moduleId, sha256, validation }) {
  if (!moduleById.has(moduleId)) throw new Error('没有这个资料入口。');
  validation ??= await validateWorkbook(file, moduleId);
  if (!validation.ok) throw new Error('工作簿结构校验未通过，不能检查业务记录。');
  const bytes = await readFile(file);
  const actualSha = createHash('sha256').update(bytes).digest('hex');
  if (sha256 && actualSha !== sha256.toLowerCase()) throw new Error('检查时文件内容已变化，请重新上传。');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.getWorksheet(validation.sheet);
  if (!sheet) throw new Error('已验证的工作表无法读取。');
  const headerRow = validation.headerRow ?? 1;
  const count = Math.min(sheet.columnCount, moduleById.get(moduleId).sourceColumnLimit ?? sheet.columnCount);
  const headers = Array.from({ length: count }, (_, index) => text(scalar(sheet.getRow(headerRow).getCell(index + 1).value)));
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (source, row) => {
    if (row <= headerRow) return;
    const values = headers.map((_, index) => scalar(source.getCell(index + 1).value));
    if (values.some(value => text(value) !== '')) rows.push({ row, sheet: sheet.name, values });
  });
  return inspectRows({ moduleId, headers, rows, sheet: sheet.name, sha256: actualSha, date1904: workbook.properties.date1904, sourceFormat: validation.sourceFormat });
}

export function inspectRows({ moduleId, headers, rows, sheet, sha256, date1904 = false, sourceFormat }) {
  if (!moduleById.has(moduleId)) throw new Error('未知板块，无法检查。');
  const limited = headers.slice(0, moduleById.get(moduleId).sourceColumnLimit ?? headers.length);
  const normalized = limited.map(header => normalizeHeader(header));
  const positions = new Map(normalized.map((header, index) => [header, index]));
  const sortedHeaders = [...normalized].sort();
  const formatKey = hash([VERSION, moduleId, sheet, sourceFormat ?? '', sortedHeaders]);
  const inspected = { version: VERSION, moduleId, sha256, sheet, formatKey, sourceFormat: sourceFormat ?? null,
    rowCount: rows.length, coverage: { start: null, end: null }, groups: [], organizations: [], errors: [] };
  const candidates = new Map(), organizations = new Map(), occurrences = new Map(), missingIdentityRows = [];
  const duplicatesAllowed = moduleId === 'invoice' || moduleId === 'terminal';
  for (const source of rows) {
    const row = { ...source, sheet: source.sheet ?? sheet, get: fieldAccess(limited, source.values, positions) };
    const date = recordDate(moduleId, row, date1904);
    if (date) {
      if (!inspected.coverage.start || date < inspected.coverage.start) inspected.coverage.start = date;
      if (!inspected.coverage.end || date > inspected.coverage.end) inspected.coverage.end = date;
    }
    const orgPath = organization(moduleId, row, sourceFormat);
    const orgKey = pathKey(orgPath);
    const org = organizations.get(orgKey) ?? { key: hash([formatKey, orgPath]), path: orgPath, count: 0, start: null, end: null, missingDates: 0 };
    org.count++;
    if (date) { if (!org.start || date < org.start) org.start = date; if (!org.end || date > org.end) org.end = date; }
    else org.missingDates++;
    organizations.set(orgKey, org);
    if (!duplicatesAllowed) continue;
    const values = Object.fromEntries(limited.map((header, index) => [header, scalar(row.values[index])]));
    const canonicalFields = normalized.map((header, index) => [header, canonical(header, row.values[index], date1904)]).sort((a, b) => a[0].localeCompare(b[0]));
    let identity;
    if (moduleId === 'invoice') {
      const fields = ['单据类型', '单据编码', '单据行号'].map(field => text(row.get(field)));
      if (fields.some(value => !value)) { missingIdentityRows.push(row.row); continue; }
      identity = JSON.stringify(fields);
    } else identity = JSON.stringify(canonicalFields.filter(([header]) => header !== normalizeHeader('协议编号')));
    const fingerprint = hash([formatKey, canonicalFields]);
    const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
    occurrences.set(fingerprint, occurrence);
    const evidence = { key: `${fingerprint}:${occurrence}`, row: row.row, values, orgPath, date,
      amount: numeric(row.get('发票金额')), quantity: numeric(row.get('计价数量')), agreementId: text(row.get('协议编号')) || null };
    const group = candidates.get(identity) ?? [];
    group.push(evidence); candidates.set(identity, group);
  }
  if (missingIdentityRows.length) inspected.errors.push(`${missingIdentityRows.length} 行缺少单据类型、编码或行号，无法核对身份；Excel 行号：${missingIdentityRows.slice(0, 30).join('、')}${missingIdentityRows.length > 30 ? '等' : ''}。请补充来源后重新上传。`);
  for (const [identity, members] of candidates) {
    if (members.length < 2) continue;
    const key = hash([VERSION, moduleId, formatKey, identity, members.map(member => member.key).sort()]);
    inspected.groups.push({ id: key, key, reason: moduleId === 'invoice' ? '单据类型、单据编码和单据行号相同，需要确认哪些记录计入。' : '前 36 列除协议编号外内容相同，需要确认哪些协议计入。',
      rows: members, differentFields: limited.filter(header => new Set(members.map(member => JSON.stringify(canonical(normalizeHeader(header), member.values[header], date1904)))).size > 1) });
  }
  inspected.organizations = [...organizations.values()].sort((a, b) => pathKey(a.path).localeCompare(pathKey(b.path)));
  return inspected;
}

function legacySelection(inspection, group, legacy) {
  const decision = legacy?.[inspection.moduleId];
  if (!decision || !(decision.sourceSha256 === inspection.sha256 || inspection.lineage?.includes(decision.sourceSha256)) || decision.sheet !== inspection.sheet) return null;
  if (inspection.moduleId === 'invoice') {
    for (const pair of decision.duplicateDisposition?.groups ?? []) {
      if (group.rows.length !== 2) continue;
      const matches = item => group.rows.find(row => row.row === item?.row && isObject(item.values) && Object.keys(item.values).length && Object.entries(item.values).every(([field, expected]) => {
        const actual = row.values[field];
        if (/^\d{4}-\d{2}-\d{2}$/.test(text(expected))) return sourceDate(actual) === expected;
        if (/金额|数量|瓶数|件数|拆分比例/.test(field)) return numeric(actual) !== null && numeric(actual) === numeric(expected);
        return text(actual) === text(expected);
      }));
      const keep = matches(pair.keep), exclude = matches(pair.excludeInFutureProcessedResult);
      if (keep && exclude && keep.key !== exclude.key) return [keep.key];
    }
  }
  if (inspection.moduleId === 'terminal') {
    const ids = group.rows.map(row => row.agreementId);
    if (!ids.every(id => /^SD\d{13}$/.test(id ?? '')) || new Set(ids).size !== ids.length) return null;
    if (!(decision.duplicateGroups ?? []).some(candidate => Array.isArray(candidate.agreementIds) && same([...candidate.agreementIds].sort(), [...ids].sort()))) return null;
    const keep = group.rows.reduce((left, right) => BigInt(left.agreementId.slice(2)) > BigInt(right.agreementId.slice(2)) ? left : right);
    return [keep.key];
  }
  return null;
}

export function validateDecision(inspection, body) {
  if (!isObject(body)) throw new Error('处理决定格式无效。');
  const group = inspection.groups.find(item => item.key === body.groupKey);
  if (!group) throw new Error('这组候选已经变化，请刷新检查结果。');
  if (body.remember !== true && body.remember !== false) throw new Error('请选择仅本次使用或记住这一组。');
  if (!Array.isArray(body.keepKeys) || !body.keepKeys.length || body.keepKeys.length > group.rows.length || new Set(body.keepKeys).size !== body.keepKeys.length || body.keepKeys.some(key => !group.rows.some(row => row.key === key))) throw new Error('请至少选择一条本组记录，不能选择其他组或重复选择。');
  return { moduleId: inspection.moduleId, formatKey: inspection.formatKey, groupKey: group.key, keepKeys: [...body.keepKeys].sort(), remember: body.remember, sourceSha256: inspection.sha256 };
}

export function resolveInspection(inspection, reviewState = {}, legacyDecisions = {}) {
  const result = structuredClone(inspection);
  result.pendingCount = 0; result.resolvedCount = 0;
  for (const group of result.groups) {
    const known = (reviewState.decisions ?? []).filter(record => record.moduleId === inspection.moduleId && record.formatKey === inspection.formatKey && record.groupKey === group.key);
    const candidates = known.filter(record => alive(record) && boundTo(record, inspection));
    const signatures = new Map();
    let invalid = false;
    for (const record of candidates) {
      try {
        const valid = validateDecision(inspection, record);
        signatures.set(JSON.stringify(valid.keepKeys), { record, keepKeys: valid.keepKeys });
      } catch { invalid = true; }
    }
    let selected = !invalid && signatures.size === 1 ? [...signatures.values()][0] : null;
    if (!selected && !known.length) {
      const keepKeys = legacySelection(inspection, group, legacyDecisions);
      if (keepKeys) selected = { record: { id: `legacy:${inspection.sha256}:${group.key}`, sourceSha256: inspection.sha256 }, keepKeys };
    }
    group.status = selected ? 'resolved' : 'pending';
    group.keepKeys = selected?.keepKeys ?? [];
    group.decisionId = selected?.record.id ?? null;
    group.reused = !!selected && selected.record.sourceSha256 !== inspection.sha256;
    group.legacy = !!selected?.record.id?.startsWith('legacy:');
    group.conflict = invalid || signatures.size > 1;
    if (group.conflict) group.message = '已保存的处理决定冲突或失效，请撤销冲突决定后重新选择。';
    if (selected) result.resolvedCount++; else result.pendingCount++;
  }
  result.organizationIssues = organizationIssues(inspection, reviewState);
  result.errors = [...new Set([...result.errors, ...result.organizationIssues])];
  return result;
}

function organizationIssues(inspection, reviewState) {
  const issues = [];
  const rules = (reviewState.organizationRules ?? []).filter(rule => alive(rule) && rule.moduleId === inspection.moduleId);
  for (const org of inspection.organizations) {
    const related = rules.filter(rule => validPath(rule.from) && same(rule.from, org.path));
    if (!related.length) continue;
    const applicable = related.filter(rule => rule.formatKey === inspection.formatKey && boundTo(rule, inspection));
    const label = org.path.filter(Boolean).join(' / ');
    const stale = related.some(rule => rule.remember === true && rule.formatKey !== inspection.formatKey);
    // A new explicit mapping (including keep-original) is the user's scoped
    // acknowledgment of a changed source format. Unrelated missing paths do
    // not make this file pending.
    if (stale && !applicable.length) issues.push(`组织“${label}”此前保存过对应关系，但本次来源格式已变化。请为当前格式确认对应关系，或选择保持原表归属。`);
    const valid = [];
    for (const rule of applicable) {
      try { valid.push(validateOrganizationRule(inspection, rule)); }
      catch (error) { issues.push(`组织“${label}”的已保存关系需要重新确认：${error.message}`); }
    }
    for (let i = 0; i < valid.length; i++) for (let j = i + 1; j < valid.length; j++) {
      if (same(valid[i].to, valid[j].to)) continue;
      const start = [valid[i].start ?? '0000', valid[j].start ?? '0000', org.start ?? '0000'].sort().at(-1);
      const end = [valid[i].end ?? '9999', valid[j].end ?? '9999', org.end ?? '9999'].sort()[0];
      if (start <= end || org.missingDates > 0) issues.push(`组织“${label}”在相同期间命中了不同的归属决定，请撤销冲突关系后重新确认。`);
    }
  }
  return [...new Set(issues)];
}

export function applyDuplicateDecisions(rows, inspection, resolved) {
  if (inspection.errors.length) throw new Error(inspection.errors.join('；'));
  if (resolved.moduleId !== inspection.moduleId || resolved.sha256 !== inspection.sha256 || resolved.formatKey !== inspection.formatKey || resolved.groups.length !== inspection.groups.length) throw new Error('检查结果与当前文件不一致，请重新检查。');
  const excluded = new Set();
  for (const group of inspection.groups) {
    const selected = resolved.groups.find(candidate => candidate.key === group.key);
    if (selected?.status !== 'resolved') throw new Error('当前来源还有重复候选待确认，请在导入检查中选择计入记录。');
    validateDecision(inspection, { groupKey: group.key, keepKeys: selected.keepKeys, remember: false });
    const kept = new Set(selected.keepKeys);
    for (const row of group.rows) if (!kept.has(row.key)) excluded.add(row.row);
  }
  return { rows: rows.filter(row => !excluded.has(row.row)), excludedRows: [...excluded].sort((a, b) => a - b) };
}

export function validateOrganizationRule(inspection, body) {
  if (!isObject(body) || !['alias', 'transfer', 'merge', 'keep'].includes(body.kind)) throw new Error('请选择组织改名、归属调整、合并或保持原表。');
  if (!validPath(body.from) || !validPath(body.to)) throw new Error('组织路径必须包含六个明确的层级位置。');
  const from = body.from.map(text), to = body.to.map(text);
  if (!inspection.organizations.some(org => same(org.path, from))) throw new Error('原组织不在当前文件中，请刷新检查结果。');
  if (!from.some(Boolean)) throw new Error('原组织完全缺失，不能建立可复用的身份对应。');
  if (body.kind === 'keep' ? !same(from, to) : !to.every(Boolean)) throw new Error(body.kind === 'keep' ? '保持原表时目标路径必须与原路径一致。' : '请补齐目标组织的完整六级路径。');
  if (body.remember !== true && body.remember !== false) throw new Error('请选择本次使用或记住组织对应关系。');
  if (body.remember && inspection.moduleId === 'inventory' && from[0].startsWith('未提供营销组织（')) throw new Error('原营销组织缺失，目前只能按这份文件的具体行处理，不能记住并跨文件复用。');
  const start = body.start === null || body.start === undefined || body.start === '' ? null : body.start;
  const end = body.end === null || body.end === undefined || body.end === '' ? null : body.end;
  for (const value of [start, end]) if (value !== null && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || sourceDate(value) !== value)) throw new Error('组织规则期间必须填写有效的 YYYY-MM-DD 日期。');
  if (start && end && start > end) throw new Error('组织规则开始日期不能晚于结束日期。');
  if ((start || end) && !DATE_MODULES.has(inspection.moduleId)) throw new Error('该来源没有已确认的逐笔归属日期，不能按签约日期、库存提交时间或上传时间推断组织调整期间。请选择整份来源范围。');
  const source = inspection.organizations.find(org => same(org.path, from));
  if ((start || end) && source.missingDates > 0) throw new Error('该组织有日期缺失记录，不能确定期间归属；请先核实来源，或明确选择整份来源范围。');
  return { moduleId: inspection.moduleId, formatKey: inspection.formatKey, from, to, start, end, remember: body.remember, sourceSha256: inspection.sha256, kind: body.kind };
}

export function applyOrganizationRules(payload, reviewState = {}) {
  const report = { status: 'not-configured', appliedRows: 0, appliedRules: [], conflicts: [], errors: [], modules: {} };
  const rules = (reviewState.organizationRules ?? []).filter(alive);
  if (!rules.length) return report;
  report.status = 'confirmed';
  const appliedRules = new Set();
  for (const [moduleId, output] of Object.entries(payload.modules)) {
    const source = payload.sources[moduleId];
    if (!source) continue;
    const selected = rules.filter(rule => rule.moduleId === moduleId && rule.formatKey === source.formatKey && boundTo(rule, source));
    if (!selected.length) continue;
    const detail = { appliedRows: 0, conflicts: 0, errors: [] };
    report.modules[moduleId] = detail;
    for (const row of output.records) {
      row.originalOrgPath ??= [...row.orgPath];
      const matches = selected.filter(rule => validPath(rule.from) && same(rule.from, row.originalOrgPath));
      if (!matches.length) continue;
      const applicable = [];
      let invalid = false;
      for (const rule of matches) {
        const badPath = !validPath(rule.to) || (rule.kind !== 'keep' && !rule.to.every(Boolean)) || !['alias', 'transfer', 'merge', 'keep'].includes(rule.kind) || (rule.kind === 'keep' && !same(rule.from, rule.to)) || (moduleId === 'inventory' && rule.remember && rule.from[0].startsWith('未提供营销组织（'));
        const badPeriod = [rule.start, rule.end].some(value => value != null && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || sourceDate(value) !== value)) || (rule.start && rule.end && rule.start > rule.end);
        if (badPath || badPeriod || (rule.start || rule.end) && (!DATE_MODULES.has(moduleId) || !row.date)) { invalid = true; break; }
        if (rule.start && row.date < rule.start || rule.end && row.date > rule.end) continue;
        applicable.push(rule);
      }
      const destinations = new Set(applicable.map(rule => pathKey(rule.to)));
      if (invalid || destinations.size > 1) {
        detail.conflicts++;
        row.reviewOrganizationConflict = true;
        report.conflicts.push({ moduleId, sourceRef: row.sourceRef, from: row.originalOrgPath, ruleIds: matches.map(rule => rule.id), reason: invalid ? '组织规则缺少可靠的路径或日期依据。' : '相同记录命中了不同的组织归属决定。' });
        continue;
      }
      if (!applicable.length) continue;
      const destination = applicable[0].to;
      row.orgPath = [...destination]; row.orgKey = pathKey(destination);
      row.org = Object.fromEntries(ORG_FIELDS.map((field, index) => [field, destination[index]]));
      row.reviewOrganization = { ruleIds: applicable.map(rule => rule.id), kinds: [...new Set(applicable.map(rule => rule.kind))], status: 'applied' };
      for (const rule of applicable) appliedRules.add(rule.id);
      detail.appliedRows++; report.appliedRows++;
    }
  }
  report.appliedRules = [...appliedRules];
  if (report.conflicts.length) report.status = 'pending';
  return report;
}
