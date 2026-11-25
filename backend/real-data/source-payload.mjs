import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import ExcelJS from 'exceljs';
import { validateWorkbook } from '../validate-workbook.mjs';
import { normalizeHeader, moduleById } from '../modules.mjs';
import { applyOrganizationMapping, buildDecisionContract } from './organization-mapping.mjs';
import { processInventoryHistory } from './inventory-history.mjs';
import { targetColumns } from '../modules/target/index.mjs';
import { inspectRows, resolveInspection, applyDuplicateDecisions, applyOrganizationRules } from '../review-engine.mjs';
import { lineageShas } from '../incremental/flow.mjs';

const MODULES = ['invoice', 'movement', 'opening', 'terminal', 'inventory', 'banquet', 'target'];
const PENDING = {
  invoice: ['invoiceTarget', 'invoiceQuantityConversion'],
  movement: ['invoiceMovementRelationship'],
  opening: ['openingMovementConversion', 'banquetOpeningOverlap'],
  terminal: ['crossTableTerminalIdentity'],
  inventory: ['inventoryHistory', 'inventoryValuationBasis', 'inventorySellableMonthsEstimate'],
  banquet: ['rewardAdditivity', 'banquetOpeningOverlap'],
  target: [],
};
const metric = (value, unit, status = 'available', reason) => ({ value, status, unit, ...(reason ? { reason } : {}) });
const text = value => value === null || value === undefined ? '' : String(value).trim();
function scalar(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  if ('formula' in value || 'sharedFormula' in value) return scalar(value.result);
  if (value.richText) return value.richText.map(part => part.text).join('');
  if ('text' in value) return value.text;
  return null;
}
function number(value) {
  if (value === null || value === undefined || text(value) === '') return null;
  if (typeof value === 'boolean') return null;
  const raw = text(value);
  if (raw.includes(',') && !/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) return null;
  const source = raw.replaceAll(',', '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(source)) return null;
  const result = Number(source);
  return Number.isFinite(result) ? result : null;
}
// Sum decimal source values exactly before returning JSON numbers. This avoids
// accumulated binary floating-point noise in currency and keeps source signs.
function sum(values) {
  let total = 0n, scale = 0;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const match = String(value).match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
    if (!match) continue;
    let digits = BigInt(`${match[1]}${match[2]}${match[3] ?? ''}`);
    let nextScale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
    if (nextScale < 0) { digits *= 10n ** BigInt(-nextScale); nextScale = 0; }
    if (nextScale > scale) { total *= 10n ** BigInt(nextScale - scale); scale = nextScale; }
    total += digits * 10n ** BigInt(scale - nextScale);
  }
  return Number(total) / 10 ** scale;
}
function date(value, date1904 = false) {
  if (typeof value === 'number' && value > 0 && value < 100000) {
    value = new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) + Math.floor(value) * 86400000).toISOString();
  }
  const match = text(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T].*)?$/);
  if (!match) return null;
  const result = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const parsed = new Date(`${result}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === result ? result : null;
}
function fieldAccess(headers, values) {
  const columns = new Map(headers.map((header, index) => [normalizeHeader(header), index]));
  return (...names) => {
    for (const name of names) {
      const index = columns.get(normalizeHeader(name));
      if (index !== undefined) return values[index];
    }
    return null;
  };
}
function organization(get, moduleId) {
  const headers = {
    invoice: ['销售大区', '办事处', '客户主任单元'],
    movement: ['大区名称', '办事处名称', '主任单元名称'],
    opening: ['产品所属-大区', '产品所属-办事处', '产品所属-主任单元'],
    terminal: ['大区', '办事处', '主任单元'],
    inventory: ['大区名称', '办事处名称', '单元名称'],
    banquet: ['大区', '办事处', '主任单元'],
    target: ['大区', '办事处', '主任单元'],
  }[moduleId];
  const org = {
    marketingCompany: text(get('营销公司名称')), businessUnit: text(get('事业部名称', '事业部')),
    theater: text(get('战区名称')), region: text(get(headers[0])), office: text(get(headers[1])), unit: text(get(headers[2])),
  };
  return { org, orgPath: Object.values(org), orgKey: JSON.stringify(Object.values(org)) };
}
function normalizedRecord(moduleId, row, workbook) {
  const get = row.get;
  const common = { sourceRef: { sheet: row.sheet, row: row.row }, ...organization(get, moduleId), date: null };
  const product = () => ({ productCode: text(get('产品编码')), productName: text(get('产品名称')), brand: text(get('品牌', '品牌名称')) || null, category: text(get('品类', '品类名称')) || null });
  const dealer = () => ({ dealerCode: text(get('经销商编码', '签约经销商编码')), dealerName: text(get('经销商名称', '签约经销商')), dealerType: text(get('经销商类型')) });
  const parseDate = value => date(value, workbook.properties.date1904);
  if (moduleId === 'invoice') return { ...common, ...product(), ...dealer(), date: parseDate(get('业务日期')), amount: number(get('发票金额')), quantity: number(get('计价数量')), quantityUnit: text(get('计价单位')), documentType: text(get('单据类型')), documentCode: text(get('单据编码')), documentLine: text(get('单据行号')), grade: text(get('经销商分级')) };
  if (moduleId === 'movement') {
    const quantityUnit = text(get('单品单位')), quantity = number(get('扫码数量(瓶)'));
    return { ...common, ...product(), ...dealer(), variety: text(get('品种名称')), date: parseDate(get('扫码日期')), amount: number(get('扫码金额')), quantity, quantityUnit, bottles: quantityUnit === '瓶' ? quantity : null, boxes: quantityUnit === '盒' ? quantity : null, cases: number(get('扫码件数')), terminalCode: text(get('售点编码')), terminalName: text(get('售点名称')), channel: text(get('渠道类型')), movementType: text(get('出入库名称')), orderCode: text(get('订单编码')) };
  }
  if (moduleId === 'opening') return { ...common, date: parseDate(get('抽奖日期')), bottles: number(get('开瓶瓶数')), amount: number(get('开瓶金额')), city: text(get('开瓶城市')), amountMeaning: '现金红包奖励', amountUnit: '元' };
  if (moduleId === 'terminal') return { ...common, ...dealer(), date: parseDate(get('签约日期')), signDate: parseDate(get('签约日期')), startDate: parseDate(get('协议开始日期')), endDate: parseDate(get('协议结束日期')), agreementId: text(get('协议编号')), terminalCode: text(get('网点编号')), terminalName: text(get('网点名称')), type: text(get('网点类型')), series: text(get('协议名称')), star: text(get('星级')), signLevel: text(get('签约等级')), signVariety: text(get('签约品种')), manualClosed: text(get('是否手工关闭')), approvalStatus: text(get('审批状态')), signingStatus: text(get('签约状态')) };
  if (moduleId === 'inventory') {
    const counted = number(get('库存瓶数（盘点）')), system = number(get('提交时实时库存数（系统）'));
    const signedVariance = counted === null || system === null ? null : sum([counted, -system]);
    return { ...common, ...product(), ...dealer(), date: parseDate(get('提交时间')), submittedAt: get('提交时间'), stocktakeCode: text(get('盘点编码')), counted, system, countAmount: number(get('盘点库存金额')), stockAmount: number(get('盘点库存金额')), systemAmount: number(get('提交时实时库存数金额')), sourceVariance: number(get('偏差数量')), absoluteVariance: signedVariance === null ? null : Math.abs(signedVariance), signedVariance, varianceFlag: text(get('是否存在盘点偏差')), safety: text(get('安全库存')) };
  }
  return { ...common, events: number(get('执行场次')), bottles: number(get('开瓶数量')), reward: number(get('售点推荐奖励')) };
}
// One target record per filled target cell (wide layout) or per row (long layout).
function targetRecords(row, headers, workbook) {
  const common = { sourceRef: { sheet: row.sheet, row: row.row }, ...organization(row.get, 'target'), date: null };
  const date1904 = workbook.properties.date1904, columns = targetColumns(headers);
  const records = columns.map(column => ({ ...common, sourceColumn: column.header, ...targetFields(row.get('年月'), column.label, row.values[column.index], date1904) }));
  if (row.get('指标') !== null || row.get('目标值') !== null) records.push({ ...common, ...targetFields(row.get('年月'), row.get('指标'), row.get('目标值'), date1904) });
  return records;
}
const TARGET_METRICS = [['发票金额', 'invoice', 'amount', '元'], ['动销金额', 'movement', 'amount', '元'], ['开瓶瓶数', 'opening', 'bottles', '瓶']];
export function targetMonth(value, date1904 = false) {
  if (typeof value === 'number' && value > 0 && value < 100000) return date(value, date1904)?.slice(0, 7) ?? null;
  const raw = text(value).replace(/\s+/g, '');
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (iso) return date(raw)?.slice(0, 7) ?? null;
  const match = raw.match(/^(\d{4})(?:[-/.年]?)(\d{1,2})(?:月)?(?:[-/.](\d{1,2})日?)?$/);
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${match[1]}-${String(month).padStart(2, '0')}` : null;
}
export function targetFields(monthValue, metricValue, amountValue, date1904 = false) {
  const label = text(metricValue).replace(/\s+/g, '').replace(/[()]/g, match => match === '(' ? '（' : '）');
  const unitMatch = label.match(/（(元|万元|瓶)）$/), name = unitMatch ? label.slice(0, unitMatch.index) : label;
  const known = TARGET_METRICS.find(([title]) => title === name);
  const unit = unitMatch?.[1] ?? known?.[3] ?? null, raw = number(amountValue);
  const valid = known && (known[3] === '瓶' ? unit === '瓶' : ['元', '万元'].includes(unit));
  const value = raw === null || !valid ? null : unit === '万元' ? Math.round(raw * 10000 * 100) / 100 : raw;
  const month = targetMonth(monthValue, date1904);
  return { month, date: month ? `${month}-01` : null, metric: valid ? known[1] : null, metricLabel: text(metricValue), field: valid ? known[2] : null, value,
    issue: text(amountValue) === '' ? '目标值为空' : !month ? '年月无法识别' : !known ? '指标名称不在可选范围' : !valid ? '指标单位不受支持' : raw === null ? '目标值不是有效数字' : raw < 0 ? '目标值为负数' : null };
}
function totals(records, field, unit) {
  const missing = records.filter(row => row[field] === null).length;
  return missing ? metric(null, unit, 'missing', `${missing} 行缺少可计算的源值；不补零`) : metric(sum(records.map(row => row[field])), unit);
}
function computeMetrics(moduleId, records) {
  const result = { records: metric(records.length, '行') };
  const fields = {
    invoice: { amount: '元' }, movement: { amount: '元', cases: '源件数' }, opening: { bottles: '瓶', amount: '元（现金红包）' },
    terminal: {}, target: {}, inventory: { counted: '瓶（本次导出记录合计）', system: '瓶（本次导出记录合计）', countAmount: '元', systemAmount: '元', absoluteVariance: '瓶' }, banquet: { events: '场', bottles: '瓶' },
  }[moduleId];
  for (const [field, unit] of Object.entries(fields)) result[field] = totals(records, field, unit);
  if (moduleId === 'invoice' || moduleId === 'movement') {
    const complete = records.every(row => row.amount !== null);
    result.positiveAmount = metric(complete ? sum(records.filter(row => row.amount > 0).map(row => row.amount)) : null, '元', complete ? 'available' : 'missing');
    result.negativeAmount = metric(complete ? sum(records.filter(row => row.amount < 0).map(row => row.amount)) : null, '元', complete ? 'available' : 'missing');
  }
  if (moduleId === 'movement') {
    for (const [key, unit] of [['bottles', '瓶'], ['boxes', '盒']]) result[key] = totals(records.filter(row => row.quantityUnit === unit), key, unit);
    result.unknownUnitRows = metric(records.filter(row => !['瓶', '盒'].includes(row.quantityUnit)).length, '行');
  }
  if (moduleId === 'terminal') {
    const missingCode = records.some(row => !row.terminalCode);
    result.terminalCount = metric(missingCode ? null : new Set(records.map(row => row.terminalCode)).size, '终端', missingCode ? 'missing' : 'available');
    result.agreementCount = metric(records.length, '协议');
  }
  if (moduleId === 'banquet') result.reward = metric(null, '元', 'pending', '奖励字段的可加总含义尚未确认');
  if (moduleId === 'target') {
    result.invalidRows = metric(records.filter(row => row.issue).length, '行');
    for (const [, id] of TARGET_METRICS) result[`${id}Rows`] = metric(records.filter(row => !row.issue && row.metric === id).length, '行');
  }
  return result;
}
function coverage(moduleId, records, decisions, sha256) {
  if (moduleId === 'banquet') {
    const decision = decisions?.banquet;
    const start = date(decision?.start ?? decision?.period?.start), end = date(decision?.end ?? decision?.period?.end);
    const confirmed = decision?.sourceSha256 === sha256 && start && end && start <= end;
    return { start: confirmed ? start : null, end: confirmed ? end : null, semantics: 'fixed-source-period', status: confirmed ? 'confirmed' : 'pending', productFilter: false };
  }
  const dates = records.map(row => row.date).filter(Boolean).sort();
  return { start: dates[0] ?? null, end: dates.at(-1) ?? null, semantics: ({ target: 'target-month', invoice: 'business-date', movement: 'scan-date', opening: 'draw-date', terminal: 'signed-date-not-historical-validity', inventory: 'stocktake-record-date-not-historical-stock' })[moduleId], status: dates.length === records.length ? 'observed' : 'partial', productFilter: ['invoice', 'movement', 'inventory'].includes(moduleId) };
}
function comparable(value, expected) {
  if (typeof expected === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expected)) return date(value) === expected;
  if (number(value) !== null && number(expected) !== null) return number(value) === number(expected);
  return text(value) === text(expected);
}
function invoiceRows(rows, decisions, sha256, sheet) {
  const decision = decisions?.invoice ?? decisions;
  if (!decision || decision.sourceSha256 !== sha256 || decision.sheet !== sheet || !Array.isArray(decision.duplicateDisposition?.groups)) {
    // A new ordinary export does not need an empty file-specific decision.
    // This key only detects candidates requiring review; it never deduplicates
    // a new file or transfers an old row-number exclusion to new bytes.
    const seen = new Set();
    for (const row of rows) {
      const parts = ['单据类型', '单据编码', '单据行号'].map(field => text(row.get(field)));
      if (parts.some(value => !value)) throw new Error('新发票来源有单据类型、编码或行号缺失，无法核对重复候选；请核实后重新上传。');
      const key = JSON.stringify(parts);
      if (seen.has(key)) throw new Error('当前发票版本存在重复候选，且没有匹配当前文件的处置决定；请确认保留记录后重新生成，旧文件的行号规则未套用。');
      seen.add(key);
    }
    return { rows, excludedRows: [], checks: [], policy: 'unique-document-candidates-source-values' };
  }
  const excluded = new Set(), kept = new Set(), checks = [];
  for (const group of decision.duplicateDisposition.groups) {
    const keep = group.keep, remove = group.excludeInFutureProcessedResult;
    for (const item of [keep, remove]) {
      const row = rows.find(row => row.row === item?.row);
      if (!row || !item.values || !Object.entries(item.values).every(([key, value]) => comparable(row.get(key), value))) throw new Error('发票来源绑定决定与具体行字段不一致，已停止该板块计算。');
    }
    if (keep.row === remove.row || excluded.has(keep.row) || kept.has(remove.row) || excluded.has(remove.row)) throw new Error('发票去重决定相互冲突，已停止该板块计算。');
    kept.add(keep.row); excluded.add(remove.row); checks.push({ keptRow: keep.row, excludedRow: remove.row });
  }
  return { rows: rows.filter(row => !excluded.has(row.row)), excludedRows: [...excluded], checks };
}
function terminalRows(rows, headers, decisions, sha256, sheet) {
  const idColumn = headers.findIndex(header => normalizeHeader(header) === normalizeHeader('协议编号'));
  const groups = new Map(), excluded = new Set();
  for (const row of rows) {
    const key = JSON.stringify(row.values.filter((_, index) => index !== idColumn));
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ids = group.map(row => text(row.values[idColumn]));
    const decision = decisions?.terminal;
    const reviewed = decision?.sourceSha256 === sha256 && decision.sheet === sheet && decision.duplicateGroups?.some(entry => Array.isArray(entry.agreementIds) && JSON.stringify([...entry.agreementIds].sort()) === JSON.stringify([...ids].sort()));
    if (!reviewed) throw new Error('当前签约版本存在 A–AJ 重复候选，且没有匹配该文件的处置决定；请核实后重新生成，旧来源的重复规则未套用。');
    if (!ids.every(id => /^SD\d{13}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('重复协议编号不可按已确认的 SD 加 13 位数字规则比较，已停止生成。');
    const winner = group.reduce((best, row) => BigInt(text(row.values[idColumn]).slice(2)) > BigInt(text(best.values[idColumn]).slice(2)) ? row : best);
    for (const row of group) if (row !== winner) excluded.add(row.row);
  }
  return { rows: rows.filter(row => !excluded.has(row.row)), excludedRows: [...excluded] };
}
function diagnostics(payload) {
  const records = id => payload.modules[id].records;
  const organizationAliases = new Map();
  for (const id of MODULES) for (const row of records(id)) {
    const shortened = row.orgPath.map(value => value.replace(/（舍得虚拟）/g, ''));
    const key = JSON.stringify(shortened), current = organizationAliases.get(key) ?? new Map();
    current.set(row.orgKey, row.orgPath); organizationAliases.set(key, current);
  }
  const collisions = [...organizationAliases.values()].filter(group => group.size > 1).map(group => [...group.values()]);
  const siteOrgs = new Map(), outletOrgs = new Map();
  for (const [id, target] of [['terminal', siteOrgs], ['movement', outletOrgs]]) for (const row of records(id)) {
    if (!row.terminalCode) continue;
    const orgs = target.get(row.terminalCode) ?? new Set(); orgs.add(row.orgKey); target.set(row.terminalCode, orgs);
  }
  const overlap = [...siteOrgs.keys()].filter(code => outletOrgs.has(code));
  const inconsistent = overlap.filter(code => [...siteOrgs.get(code)].some(org => !outletOrgs.get(code).has(org)) || [...outletOrgs.get(code)].some(org => !siteOrgs.get(code).has(org)));
  const productMap = new Map();
  for (const id of ['invoice', 'movement']) for (const row of records(id)) {
    if (!row.productCode || !row.brand || !row.category) continue;
    const values = productMap.get(row.productCode) ?? new Map(); values.set(JSON.stringify([row.brand, row.category]), { brand: row.brand, category: row.category }); productMap.set(row.productCode, values);
  }
  let unmapped = 0, conflicted = 0, mapped = 0;
  for (const row of records('inventory')) {
    const candidates = productMap.get(row.productCode);
    if (candidates?.size === 1) { Object.assign(row, [...candidates.values()][0]); row.classificationStatus = 'unique-product-code'; mapped++; }
    else { row.brand = null; row.category = null; row.classificationStatus = candidates?.size > 1 ? 'conflict' : 'unmapped'; if (candidates?.size > 1) conflicted++; else unmapped++; }
  }
  return { organizationAliases: { collisionCount: collisions.length, candidates: collisions }, terminalIdentity: { siteCodes: siteOrgs.size, outletCodes: outletOrgs.size, intersectionCount: overlap.length, organizationInconsistentCount: inconsistent.length, inconsistentCodes: inconsistent, status: 'diagnostic-only-not-an-identity-confirmation' }, productClassification: { mappedRows: mapped, unmappedRows: unmapped, conflictRows: conflicted, conflictingCodes: [...productMap].filter(([, values]) => values.size > 1).map(([code]) => code) } };
}

/** Read an immutable active-upload snapshot without changing the source store.
 * Decisions are external: either the original invoice decision object, or
 * { invoice: <object>, banquet: { sourceSha256, start, end, includeOrganizationPlaceholders: true } }.
 * Internal records retain provenance; the HTML exporter must project only the
 * fields needed by the UI and must not publish this local diagnostic report.
 */
// Parsed source rows are cached beside each upload, keyed by the file SHA-256, the
// module's validation contract and this parser's own source, so an unchanged
// source is not read from Excel again. Values are the same scalar() results.
const ROW_CACHE_FILE = 'rows-cache.json.gz';
const ROW_CACHE_VERSION = 1;
let parserSourceSha;
const gzipAsync = promisify(gzip), gunzipAsync = promisify(gunzip);
async function rowCacheKey(moduleId, sha256) {
  parserSourceSha ??= createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
  const { validationFingerprint } = await import('../recognition/fingerprint.mjs');
  return createHash('sha256').update(JSON.stringify([ROW_CACHE_VERSION, moduleId, sha256, await validationFingerprint(moduleId), parserSourceSha])).digest('hex');
}
// JSON cannot carry -0; every other scalar() value (string, finite number, boolean, null) round-trips exactly.
const encodeValue = value => Object.is(value, -0) ? { negativeZero: true } : value;
const decodeValue = value => value !== null && typeof value === 'object' ? (value.negativeZero ? -0 : null) : value;
async function readSourceRows({ file, buffer, moduleId, sha256, cacheFile }) {
  // Only the backend's own generation opts in; previews and exports never write to the data directory.
  const key = cacheFile ? await rowCacheKey(moduleId, sha256) : null;
  if (cacheFile) try {
    const cached = JSON.parse((await gunzipAsync(await readFile(cacheFile))).toString('utf8'));
    if (cached.key === key && cached.sha256 === sha256 && Array.isArray(cached.headers) && Array.isArray(cached.rows)) {
      const { headers } = cached;
      const rows = cached.rows.map(([row, encoded]) => { const values = encoded.map(decodeValue); return { row, sheet: cached.sheetName, values, get: fieldAccess(headers, values) }; });
      return { validation: cached.validation, sheetName: cached.sheetName, date1904: cached.date1904, headers, rows, cached: true };
    }
  } catch {}
  const validation = await validateWorkbook(file, moduleId);
  if (!validation.ok) return { validation, rows: [], headers: [] };
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet(validation.sheet);
  if (!sheet) throw new Error('已验证的主工作表不可读取。');
  const headers = Array.from({ length: Math.min(sheet.columnCount, moduleById.get(moduleId).sourceColumnLimit ?? sheet.columnCount) }, (_, index) => text(scalar(sheet.getRow(1).getCell(index + 1).value)));
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, index) => {
    if (index <= 1) return;
    const values = headers.map((_, column) => scalar(row.getCell(column + 1).value));
    if (!values.some(value => text(value) !== '')) return;
    rows.push({ row: index, sheet: sheet.name, values, get: fieldAccess(headers, values) });
  });
  const result = { validation, sheetName: sheet.name, date1904: workbook.properties.date1904, headers, rows };
  if (!cacheFile) return result;
  // Best effort and atomic: a failed write only means the next generation reads Excel again.
  const temp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, await gzipAsync(JSON.stringify({ key, sha256, validation, sheetName: result.sheetName, date1904: result.date1904, headers, rows: rows.map(row => [row.row, row.values.map(encodeValue)]) }), { level: 6 }), { mode: 0o600 });
    await rename(temp, cacheFile);
  } catch { await rm(temp, { force: true }).catch(() => {}); }
  return result;
}

export async function buildSourcePayload({ dataDir, decisionsFile, sourceVersions, allowPending = false, rowCache = false } = {}) {
  if (!dataDir) throw new Error('必须提供后台数据目录。');
  const root = await realpath(resolve(dataDir));
  const state = JSON.parse(await readFile(resolve(root, 'state.json'), 'utf8'));
  if (state.schemaVersion !== 1 || !Array.isArray(state.uploads) || !state.active || typeof state.active !== 'object') throw new Error('后台 state 格式不受支持。');
  let decisions = null, decisionError = null;
  if (decisionsFile) { try { decisions = JSON.parse(await readFile(decisionsFile, 'utf8')); } catch { decisionError = '决定文件无法读取或不是有效 JSON。'; } }
  const payload = { schemaVersion: 1, processingVersion: 8, mode: 'real-preview', generatedAt: new Date().toISOString(), sources: {}, coverage: {}, modules: {}, pendingDecisions: [...new Set(Object.values(PENDING).flat())] };
  const report = { schemaVersion: 1, generatedAt: payload.generatedAt, decisionError, modules: {}, diagnostics: {}, originalStoreModified: false };
  for (const moduleId of MODULES) {
    const output = { state: 'unavailable', records: [], metrics: {}, unavailable: [...PENDING[moduleId]], warnings: [] };
    payload.modules[moduleId] = output;
    const detail = { sourceRows: 0, includedRows: 0, excludedRows: [], errors: [], warnings: [] }; report.modules[moduleId] = detail;
    try {
      const uploadId = sourceVersions ? sourceVersions[moduleId]?.uploadId : state.active[moduleId];
      if (!uploadId) throw new Error('未选择有效上传版本。');
      if (typeof uploadId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(uploadId)) throw new Error('上传版本标识无效。');
      const upload = state.uploads.find(item => item.id === uploadId && item.moduleId === moduleId);
      if (!upload || !/^[a-f0-9]{64}$/i.test(upload.sha256 ?? '')) throw new Error('上传版本或 SHA 记录不完整。');
      const file = await realpath(resolve(root, 'uploads', uploadId, 'source.xlsx'));
      if (!file.startsWith(`${resolve(root, 'uploads')}${sep}`)) throw new Error('上传文件路径越出后台 uploads 目录。');
      const buffer = await readFile(file), sha256 = createHash('sha256').update(buffer).digest('hex');
      if (sha256 !== upload.sha256.toLowerCase()) throw new Error('源文件 SHA 与有效上传记录不一致，已停止该板块计算。');
      const { validation, sheetName, date1904, headers, rows } = await readSourceRows({ file, buffer, moduleId, sha256, cacheFile: rowCache ? resolve(root, 'uploads', uploadId, ROW_CACHE_FILE) : null });
      if (!validation.ok) throw new Error(`工作簿结构校验失败：${validation.errors.map(error => typeof error === 'string' ? error : error.message).join('；')}`);
      // Later steps only read the sheet name and the workbook date system.
      const workbook = { properties: { date1904 } }, sheet = { name: sheetName };
      payload.sources[moduleId] = { uploadId, sha256, originalName: upload.filename ?? null, sheet: sheet.name, validationVersion: validation.validationVersion };
      detail.sourceRows = rows.length;
      let included = rows;
      if (state.review) {
        const inspection = inspectRows({ moduleId, headers, rows, sheet: sheet.name, sha256, date1904: workbook.properties.date1904, sourceFormat: validation.sourceFormat });
        inspection.lineage = lineageShas(state, uploadId);
        payload.sources[moduleId].lineage = inspection.lineage;
        const reviewed = resolveInspection(inspection, state.review, decisions);
        payload.sources[moduleId].formatKey = inspection.formatKey;
        detail.review = { pendingCount: reviewed.pendingCount, errors: reviewed.errors, groups: reviewed.groups.map(group => ({ key: group.key, status: group.status, decisionId: group.decisionId, reused: group.reused, keptRows: group.rows.filter(row => group.keepKeys.includes(row.key)).map(row => row.row), excludedRows: group.status === 'resolved' ? group.rows.filter(row => !group.keepKeys.includes(row.key)).map(row => row.row) : [] })) };
        if (reviewed.pendingCount || reviewed.errors.length) {
          detail.reviewPending = true;
          payload.coverage[moduleId] = { ...inspection.coverage, status: 'pending', semantics: 'source-requires-review' };
          throw new Error(`待确认：${reviewed.pendingCount ? `${reviewed.pendingCount} 组重复候选；` : ''}${reviewed.errors.join('；')}请返回本机导入检查处理。`);
        }
        const applied = applyDuplicateDecisions(rows, inspection, reviewed);
        included = applied.rows; detail.excludedRows = applied.excludedRows; detail.processingPolicy = 'reviewed-business-group-decisions';
      } else {
        if (moduleId === 'invoice') { const applied = invoiceRows(rows, decisions, sha256, sheet.name); included = applied.rows; detail.excludedRows = applied.excludedRows; detail.decisionChecks = applied.checks; detail.processingPolicy = applied.policy ?? 'source-bound-reviewed-exclusions'; }
        if (moduleId === 'terminal') { const applied = terminalRows(rows, headers, decisions, sha256, sheet.name); included = applied.rows; detail.excludedRows = applied.excludedRows; }
      }
      const visitInventory = moduleId === 'inventory' && validation.sourceFormat === 'visit-history';
      if (visitInventory) {
        const prepared = processInventoryHistory(rows, { date1904: workbook.properties.date1904 });
        output.records = prepared.records;
        output.inventoryMode = 'visit-history';
        output.uncertaintyGroups = prepared.uncertaintyGroups ?? [];
        output.inventoryStats = { sourceRows: rows.length, compressedRows: prepared.records.length,
          groupCount: new Set(prepared.latestRecords.map(row => row.inventoryGroupKey)).size,
          missingDealerCodes: rows.filter(row => !text(row.get('经销商编码'))).length,
          invalidDates: prepared.diagnostics.invalidDates ?? 0, invalidNumbers: prepared.diagnostics.invalidNumbers ?? 0 };
        output.metrics = computeMetrics(moduleId, prepared.latestRecords);
        output.metrics.countAmount = metric(null, '元', 'missing', '拜访采集表没有盘点库存金额，不能用系统金额或假定单价替代');
        if (prepared.latestRecords.some(row => row.inventoryConflict || row.inventoryDateUncertain) || output.uncertaintyGroups.length) {
          for (const field of ['counted', 'system', 'systemAmount', 'absoluteVariance']) output.metrics[field] = metric(null, field === 'systemAmount' ? '元' : '瓶', 'missing', '最近盘点存在同时间候选或无效时间，不能确定唯一库存');
        }
        payload.coverage[moduleId] = { ...prepared.coverage, semantics: 'latest-known-stocktake-before-month-end', productFilter: false };
        detail.inventoryHistory = prepared.diagnostics;
        detail.includedRows = prepared.latestRecords.length;
        detail.historyCandidates = prepared.records.length;
        detail.processingPolicy = 'latest-by-exact-dealer-and-full-product-name-before-month-end';
        detail.warnings.push(...prepared.warnings);
        detail.warnings.push('新来源没有盘点金额和产品编码；金额差额、可销月份、品牌品类联动及安全库存判断不可用。最近盘点不代表统一时点实时库存。');
        output.unavailable = ['inventoryCountAmount', 'inventoryAmountDifference', 'inventorySellableMonthsEstimate', 'inventoryProductMapping', 'inventorySafetyStock'];
      } else {
        output.records = moduleId === 'target' ? included.flatMap(row => targetRecords(row, headers, workbook)) : included.map(row => normalizedRecord(moduleId, row, workbook));
        output.metrics = computeMetrics(moduleId, output.records);
        payload.coverage[moduleId] = coverage(moduleId, output.records, decisions, sha256);
        detail.includedRows = included.length;
      }
      if (moduleId === 'target') {
        const invalid = output.records.filter(row => row.issue && row.issue !== '目标值为空');
        if (invalid.length) detail.warnings.push(`${invalid.length} 个目标无法使用（${[...new Set(invalid.map(row => row.issue))].join('、')}），不计入；例如原表第 ${[...new Set(invalid.map(row => row.sourceRef.row))].slice(0, 5).join('、')} 行。`);
        const seen = new Map();
        for (const row of output.records.filter(item => !item.issue)) { const key = JSON.stringify([row.month, row.metric, row.org.region, row.org.office, row.org.unit]); seen.set(key, (seen.get(key) || 0) + 1); }
        const duplicated = [...seen.values()].filter(count => count > 1).length;
        if (duplicated) detail.warnings.push(`${duplicated} 组目标在同一年月、组织、指标下重复，相关达成率显示待确认，不自动相加。`);
      }
      detail.missingDates = ['banquet', 'target'].includes(moduleId) ? null : output.records.filter(row => row.date === null).length;
      if (detail.missingDates) detail.warnings.push(`${detail.missingDates} 行日期无法确认，不归入任何月份。`);
      if (moduleId === 'movement' && output.metrics.unknownUnitRows.value) detail.warnings.push('存在未确认单品单位，金额保留，数量不归为瓶或盒。');
      if (moduleId === 'banquet' && payload.coverage[moduleId].status !== 'confirmed') { output.unavailable.push('banquetSourcePeriod'); detail.warnings.push('当前来源固定期间未确认，不伪造日期。'); }
      if (moduleId === 'banquet' && !(decisions?.banquet?.sourceSha256 === sha256 && decisions.banquet.includeOrganizationPlaceholders === true)) {
        for (const [field, unit] of [['events', '场'], ['bottles', '瓶']]) output.metrics[field] = metric(null, unit, 'pending', '新来源的组织占位和汇总行粒度尚未核对，保留原值但不直接累加');
        output.unavailable.push('banquetSourceGrain'); detail.warnings.push('宴席汇总粒度确认必须绑定当前来源 SHA。');
      }
      if (moduleId === 'inventory' && !visitInventory) {
        detail.sourceVarianceNullRows = output.records.filter(row => row.sourceVariance === null).length;
        detail.sourceVarianceMismatchRows = output.records.filter(row => row.sourceVariance !== null && row.absoluteVariance !== null && row.sourceVariance !== row.absoluteVariance).length;
        if (detail.sourceVarianceMismatchRows) detail.warnings.push(`${detail.sourceVarianceMismatchRows} 行源偏差与已确认绝对差公式不一致；源值单独保留，未改写。`);
      }
      output.warnings = detail.warnings;
      output.state = detail.warnings.length || Object.values(output.metrics).some(item => item.status === 'missing') ? 'partial' : 'ready';
    } catch (error) {
      detail.errors.push(error.message); output.reason = error.message; output.records = []; output.metrics = {};
      if (detail.reviewPending) { output.reviewPending = true; output.reviewReason = error.message.slice(0, 1000); }
      payload.coverage[moduleId] ??= { start: null, end: null, status: 'unavailable', semantics: null };
    }
  }
  report.organizationMapping = applyOrganizationMapping(payload, decisions?.organizationMapping);
  if (state.review) {
    report.reviewOrganizations = applyOrganizationRules(payload, state.review);
    for (const id of new Set(report.reviewOrganizations.conflicts.map(item => item.moduleId))) {
      report.modules[id].reviewPending = true;
      Object.assign(payload.modules[id], { state: 'unavailable', records: [], metrics: {}, reviewPending: true, reviewReason: '组织对应关系缺少日期依据或存在冲突，请返回导入检查处理。', reason: '待确认：组织对应关系存在冲突，请返回导入检查处理。' });
    }
  }
  payload.decisionContract = buildDecisionContract(payload, decisions, report.organizationMapping);
  const resolved = new Set();
  if (payload.decisionContract.terminalIdentity.status === 'confirmed') { resolved.add('crossTableTerminalIdentity'); delete payload.modules.terminal.metrics.movementCoverage; }
  if (payload.decisionContract.crossTableMetrics.status === 'confirmed') {
    resolved.add('invoiceMovementRelationship'); resolved.add('openingMovementConversion');
    if (payload.modules.inventory.inventoryMode !== 'visit-history') resolved.add('inventorySellableMonthsEstimate');
  }
  if (payload.decisionContract.banquetOpeningSubset.status === 'not-guaranteed') resolved.add('banquetOpeningOverlap');
  payload.pendingDecisions = payload.pendingDecisions.filter(item => !resolved.has(item));
  for (const module of Object.values(payload.modules)) module.unavailable = module.unavailable.filter(item => !resolved.has(item));
  report.decisionContract = payload.decisionContract;
  report.diagnostics = diagnostics(payload);
  report.summary = Object.fromEntries(MODULES.map(id => [id, { state: payload.modules[id].state, ...payload.modules[id].metrics }]));
  const finalState = JSON.parse(await readFile(resolve(root, 'state.json'), 'utf8'));
  report.activeChangedDuringRead = sourceVersions ? false : MODULES.some(id => finalState.active?.[id] !== state.active[id]);
  if (report.activeChangedDuringRead) report.warning = '读取期间有效版本发生变化；本结果仍绑定开始时的上传 ID 与 SHA，不代表最新选择。';
  return { payload, report };
}
