// Incremental, range and full updates. Invoice, movement, opening and
// inventory are dated sources (three modes); terminal and banquet are only
// replaced as a whole but go through the same check card. The composed
// workbook is written as an ordinary source so validation, inspection,
// review decisions and generation keep their existing contracts.
import ExcelJS from 'exceljs';
import { normalizeHeader } from '../modules.mjs';
import { sourceDate } from '../review-engine.mjs';
import { streamSheetRows } from './xlsx-rows.mjs';

export const AGGREGATE_VERSION = 2;
// A field may name several headers; the first one present in the file is used.
export const FLOW = {
  invoice: { date: '业务日期', org: ['销售大区', '办事处'], amount: '发票金额', quantity: '计价数量', key: ['单据类型', '单据编码', '单据行号'], overlapAllowed: true },
  movement: { date: '扫码日期', org: ['大区名称', '办事处名称'], amount: '扫码金额', quantity: '扫码件数', bottles: '扫码数量(瓶)' },
  opening: { date: '抽奖日期', org: ['产品所属-大区', '产品所属-办事处'], city: '开瓶城市', amount: '开瓶金额', bottles: '开瓶瓶数' },
  // Inventory: compared and replaced by the day of 提交时间, which itself keeps its seconds.
  inventory: { date: '提交时间', time: true, org: [['大区', '大区名称'], ['办事处', '办事处名称']], dealer: '经销商编码', key: ['经销商编码', ['产品名称', '产品编码'], '提交时间'], overlapAllowed: true },
};
export const WHOLE = {
  terminal: { date: '签约日期', agreement: '协议编号', outlet: '网点编号' },
  banquet: { events: '执行场次', bottles: '开瓶数量' },
};
// Export scope check (contract §11.4). Empty list: the board has no such field.
export const SCOPE = {
  invoice: { zone: ['战区名称'], region: ['销售大区'], product: ['品种'], productLabel: '品种' },
  movement: { zone: ['战区名称'], region: ['大区名称'], product: ['品种名称'], productLabel: '品种' },
  opening: { zone: ['产品所属-战区'], region: ['产品所属-大区'], product: ['品种'], productLabel: '品种' },
  inventory: { zone: ['战区名称'], region: ['大区', '大区名称'], product: ['产品名称', '产品编码'], productLabel: '产品' },
  terminal: { zone: ['战区名称'], region: ['大区'], product: ['签约品种'], productLabel: '签约品种' },
  banquet: { zone: [], region: ['大区'], product: [], productLabel: '产品' },
};
export const PRODUCT_RULE = { windowMin: 3, fileMax: 1, minRows: 20, fallbackDays: 30 };
export const MODES = ['incremental', 'range', 'full'];
export const MODE_LABELS = { incremental: '增量', range: '范围更新', full: '整份替换' };
export const isFlowModule = id => Object.hasOwn(FLOW, id);
export const isWholeModule = id => Object.hasOwn(WHOLE, id);
export const isUpdatable = id => isFlowModule(id) || isWholeModule(id);
export const modesFor = id => isFlowModule(id) ? MODES : isWholeModule(id) ? ['full'] : [];

const text = value => value === null || value === undefined ? '' : String(value).trim();
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const validDay = value => typeof value === 'string' && DAY.test(value) && sourceDate(value) === value;
const shiftDay = (day, offset) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

function plain(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date || typeof value !== 'object') return value;
  if ('formula' in value || 'sharedFormula' in value) return plain(value.result ?? null);
  if (value.richText) return value.richText.map(part => part.text).join('');
  if ('text' in value) return plain(value.text);
  return null;
}

function number(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = text(value);
  if (!raw || (raw.includes(',') && !/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw))) return null;
  const parsed = Number(raw.replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

// Excel serial → Date keeping the wall-clock time to the second (same rule as the inventory reader).
function serialDateTime(value, date1904) {
  const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30);
  const correction = !date1904 && value < 60 ? 86400000 : 0;
  return new Date(epoch + correction + Math.round(value * 86400) * 1000);
}

/** Header lookup; a field may list several header names. */
function accessor(headers) {
  const positions = new Map();
  headers.forEach((header, index) => { const key = normalizeHeader(header); if (key && !positions.has(key)) positions.set(key, index); });
  const cache = new Map();
  const index = names => {
    if (names === undefined || names === null) return -1;
    const id = Array.isArray(names) ? names.join('\u0000') : names;
    if (cache.has(id)) return cache.get(id);
    let found = -1;
    for (const name of [].concat(names)) { const at = positions.get(normalizeHeader(name)); if (at !== undefined) { found = at; break; } }
    cache.set(id, found);
    return found;
  };
  const get = (values, names) => { const at = index(names); return at < 0 ? null : values[at]; };
  get.has = names => [].concat(names ?? []).length > 0 && index(names) >= 0;
  return get;
}
const keyText = value => value instanceof Date ? value.toISOString() : text(value);

/**
 * Stream the validated main sheet row by row with plain values and the flow date.
 * Streaming keeps a year of daily data within the worker's memory limit.
 */
export async function streamSource(file, validation, moduleId, onHeader, onRow) {
  const spec = FLOW[moduleId];
  const headerRow = validation.headerRow ?? 1;
  let headers = null, dateColumn = -1;
  // date1904 is filled in once workbook.xml has been read, before any row.
  const date1904Ref = { value: false };
  const result = await streamSheetRows(file, validation.sheet, async (rowNumber, cells) => {
    if (rowNumber < headerRow) return;
    if (rowNumber === headerRow) {
      headers = cells.map(value => text(plain(value)));
      while (headers.length && !headers.at(-1)) headers.pop();
      dateColumn = headers.findIndex(header => normalizeHeader(header) === normalizeHeader(spec.date));
      if (dateColumn < 0) throw new Error(`缺少日期字段：${spec.date}。`);
      await onHeader({ sheetName: validation.sheet, headers, dateColumn, format: validation.sourceFormat ?? null });
      return;
    }
    if (!headers) throw new Error('未找到表头行。');
    const values = headers.map((_, index) => plain(cells[index] ?? null));
    if (!values.some(value => text(value) !== '')) return;
    const raw = values[dateColumn];
    const day = sourceDate(raw, date1904Ref.value);
    // Numeric serial dates are rewritten as dates so the 1900/1904 base of the
    // composed workbook cannot shift them. Inventory keeps the time of day.
    if (day && typeof raw === 'number') values[dateColumn] = spec.time ? serialDateTime(raw, date1904Ref.value) : new Date(`${day}T00:00:00Z`);
    await onRow({ row: rowNumber, values, date: day });
  }, date1904Ref);
  if (!headers) throw new Error('已验证的工作表无法读取。');
  return result;
}

/** Read a (small) source fully into memory. */
export async function readSource(file, validation, moduleId) {
  const source = { rows: [] };
  await streamSource(file, validation, moduleId, header => Object.assign(source, header), row => { source.rows.push(row); });
  return source;
}

const round = value => Math.round(value * 100) / 100;
const addTo = (set, value) => { const name = text(value); if (name) set.add(name); };
const sorted = set => [...set].sort();
function scopeHas(get, moduleId) {
  const spec = SCOPE[moduleId];
  return { zone: get.has(spec.zone), region: get.has(spec.region), product: get.has(spec.product) };
}

/** Per-day totals, organizations and scope values, small enough to keep beside a source. */
export function aggregator(moduleId) {
  const spec = FLOW[moduleId], scope = SCOPE[moduleId], byDate = {}, invalidRows = [], zones = new Set(), days = new Map();
  let get = null, headers = [], rows = 0, format = null;
  return {
    header(info) { headers = info.headers; format = info.format ?? null; get = accessor(info.headers); },
    row({ row, values, date }) {
      rows++;
      addTo(zones, get(values, scope.zone));
      if (!date) { invalidRows.push(row); return; }
      let day = days.get(date);
      if (!day) { day = { rows: 0, amount: 0, quantity: 0, bottles: 0, regions: new Set(), offices: new Set(), cities: new Set(), dealers: new Set(), products: new Set() }; days.set(date, day); }
      day.rows++;
      if (spec.amount) day.amount += number(get(values, spec.amount)) ?? 0;
      if (spec.quantity) day.quantity += number(get(values, spec.quantity)) ?? 0;
      if (spec.bottles) day.bottles += number(get(values, spec.bottles)) ?? 0;
      const region = text(get(values, spec.org[0]));
      addTo(day.regions, region);
      addTo(day.offices, [region, text(get(values, spec.org[1]))].filter(Boolean).join(' / '));
      if (spec.city) addTo(day.cities, get(values, spec.city));
      if (spec.dealer) addTo(day.dealers, get(values, spec.dealer));
      addTo(day.products, get(values, scope.product));
    },
    result() {
      const regions = new Set(), products = new Set();
      for (const [date, day] of days) {
        for (const value of day.regions) regions.add(value);
        for (const value of day.products) products.add(value);
        byDate[date] = { rows: day.rows, amount: round(day.amount), quantity: round(day.quantity), bottles: round(day.bottles),
          regions: sorted(day.regions), offices: sorted(day.offices), cities: sorted(day.cities), dealers: sorted(day.dealers), products: sorted(day.products) };
      }
      const dates = Object.keys(byDate).sort();
      return { version: AGGREGATE_VERSION, moduleId, format, rows, start: dates[0] ?? null, end: dates.at(-1) ?? null,
        invalidDateRows: invalidRows.length, invalidDateSample: invalidRows.slice(0, 20), byDate, headers,
        has: get ? scopeHas(get, moduleId) : { zone: false, region: false, product: false }, zones: sorted(zones), regions: sorted(regions), products: sorted(products) };
    },
  };
}
export function aggregate(source, moduleId) {
  const acc = aggregator(moduleId);
  acc.header(source); for (const row of source.rows) acc.row(row);
  return acc.result();
}
export async function aggregateFile(file, validation, moduleId) {
  const acc = aggregator(moduleId);
  await streamSource(file, validation, moduleId, info => acc.header(info), row => acc.row(row));
  return acc.result();
}

/** Summary of a board that is only replaced as a whole (terminal, banquet). */
export async function summarizeFile(file, validation, moduleId) {
  const spec = WHOLE[moduleId], scope = SCOPE[moduleId], headerRow = validation.headerRow ?? 1;
  const zones = new Set(), regions = new Set(), products = new Set(), agreements = new Set(), outlets = new Set();
  const date1904Ref = { value: false };
  let get = null, headers = [], rows = 0, events = 0, bottles = 0, start = null, end = null;
  await streamSheetRows(file, validation.sheet, (rowNumber, cells) => {
    if (rowNumber < headerRow) return;
    if (rowNumber === headerRow) { headers = cells.map(value => text(plain(value))); while (headers.length && !headers.at(-1)) headers.pop(); get = accessor(headers); return; }
    if (!get) throw new Error('未找到表头行。');
    const values = headers.map((_, index) => plain(cells[index] ?? null));
    if (!values.some(value => text(value) !== '')) return;
    rows++;
    addTo(zones, get(values, scope.zone)); addTo(regions, get(values, scope.region)); addTo(products, get(values, scope.product));
    if (spec.agreement) addTo(agreements, get(values, spec.agreement));
    if (spec.outlet) addTo(outlets, get(values, spec.outlet));
    if (spec.events) events += number(get(values, spec.events)) ?? 0;
    if (spec.bottles) bottles += number(get(values, spec.bottles)) ?? 0;
    if (spec.date) {
      const day = sourceDate(get(values, spec.date), date1904Ref.value);
      if (day) { if (!start || day < start) start = day; if (!end || day > end) end = day; }
    }
  }, date1904Ref);
  if (!get) throw new Error('已验证的工作表无法读取。');
  return { version: AGGREGATE_VERSION, moduleId, whole: true, format: validation.sourceFormat ?? null, rows, start, end, headers,
    agreements: agreements.size, outlets: outlets.size, agreementIds: spec.agreement ? sorted(agreements) : [], events: round(events), bottles: round(bottles),
    has: scopeHas(get, moduleId), zones: sorted(zones), regions: sorted(regions), products: sorted(products) };
}

/** Rows of the new file whose identity key already exists on the same day in the current source (classification only). */
export function keyMatcher(moduleId, part) {
  const spec = FLOW[moduleId];
  if (!spec?.key) return null;
  const partGet = accessor(part.headers);
  const keyOf = (get, values) => JSON.stringify(spec.key.map(name => keyText(get(values, name))));
  const wanted = new Map();
  for (const row of part.rows) if (row.date) { const set = wanted.get(row.date) ?? new Set(); set.add(keyOf(partGet, row.values)); wanted.set(row.date, set); }
  const found = new Map();
  let baseGet = null;
  return {
    header(info) { baseGet = accessor(info.headers); },
    row(row) { if (row.date && wanted.has(row.date)) { const key = keyOf(baseGet, row.values); if (wanted.get(row.date).has(key)) { const set = found.get(row.date) ?? new Set(); set.add(key); found.set(row.date, set); } } },
    result() {
      const result = {};
      for (const row of part.rows) if (row.date && found.get(row.date)?.has(keyOf(partGet, row.values))) result[row.date] = (result[row.date] ?? 0) + 1;
      return result;
    },
  };
}
export const invoiceMatcher = part => keyMatcher('invoice', part);
export function existingRows(moduleId, base, part) {
  const matcher = keyMatcher(moduleId, part);
  if (!matcher) return {};
  matcher.header(base); for (const row of base.rows) matcher.row(row);
  return matcher.result();
}
export const existingInvoiceRows = (base, part) => existingRows('invoice', base, part);

export function suggestMode(base, part) {
  if (part?.whole) return { mode: 'full', start: part.start, end: part.end, reason: '这个板块只支持整份替换。' };
  if (!base || !base.start) return { mode: 'full', start: part.start, end: part.end, reason: '当前没有有效数据，用这份文件建立基线。' };
  if ((base.format ?? null) !== (part.format ?? null)) return { mode: 'full', start: part.start, end: part.end, reason: '文件格式与当前数据不同，只能整份替换。' };
  const overlap = Object.keys(part.byDate).filter(day => base.byDate[day]);
  if (!overlap.length) return { mode: 'incremental', start: part.start, end: part.end, reason: '文件里全部是新日期，直接追加。' };
  if (part.start <= base.start && part.end >= base.end) return { mode: 'full', start: part.start, end: part.end, reason: '文件覆盖了当前全部日期，整份替换。' };
  return { mode: 'range', start: part.start, end: part.end, reason: `与现有数据有 ${overlap.length} 天重叠，按文件日期范围整段替换。` };
}

/** Totals over several (byDate, days) parts; dealers are counted once across parts. */
function totals(parts) {
  const result = { rows: 0, amount: 0, quantity: 0, bottles: 0, days: 0, dealers: 0 };
  const dealers = new Set(), seenDays = new Set();
  for (const [byDate, days] of parts) for (const day of days) {
    const value = byDate[day]; if (!value) continue;
    result.rows += value.rows; result.amount += value.amount; result.quantity += value.quantity; result.bottles += value.bottles;
    seenDays.add(day);
    for (const dealer of value.dealers ?? []) dealers.add(dealer);
  }
  for (const key of ['amount', 'quantity', 'bottles']) result[key] = round(result[key]);
  result.days = seenDays.size; result.dealers = dealers.size;
  return result;
}
function union(byDate, days, field) { const set = new Set(); for (const day of days) for (const value of byDate[day]?.[field] ?? []) set.add(value); return set; }
const listDays = (byDate, inRange) => Object.keys(byDate).filter(inRange).sort();
const months = days => [...new Set(days.map(day => day.slice(0, 7)))].sort();

const FIGURES = {
  invoice: [['行数', 'rows', 'count'], ['发票净额（万元）', 'amount', 'wan']],
  movement: [['行数', 'rows', 'count'], ['扫码金额（万元）', 'amount', 'wan'], ['扫码件数', 'quantity', 'count'], ['扫码瓶数', 'bottles', 'count']],
  opening: [['行数', 'rows', 'count'], ['开瓶瓶数', 'bottles', 'count'], ['红包金额（万元）', 'amount', 'wan']],
  inventory: [['盘点记录', 'rows', 'count'], ['经销商', 'dealers', 'count']],
  terminal: [['协议数', 'agreements', 'count'], ['签约终端', 'outlets', 'count']],
  banquet: [['执行场次', 'events', 'count'], ['开瓶瓶数', 'bottles', 'count']],
};
const figures = (moduleId, before, after) => FIGURES[moduleId].map(([label, key, unit]) => ({ label, key, unit, before: before ? before[key] ?? null : null, after: after ? after[key] ?? null : null }));
const listText = (values, limit = 3) => `${values.slice(0, limit).join('、')}${values.length > limit ? ` 等 ${values.length} 个` : ''}`;
const DIMENSIONS = [['zone', 'zones', '战区'], ['region', 'regions', '大区']];

/** Products of the current source over the comparison window (§11.4). */
function productWindow(base, part) {
  if (!base.byDate) return base.products ?? [];
  let days = Object.keys(part.byDate ?? {}).filter(day => base.byDate[day]);
  if (!days.length && base.end) { const from = shiftDay(base.end, 1 - PRODUCT_RULE.fallbackDays); days = Object.keys(base.byDate).filter(day => day >= from && day <= base.end); }
  return [...union(base.byDate, days, 'products')].sort();
}

/** Export scope check: blocks a file whose organizations or products do not match the current source. */
export function scopeCheck(moduleId, base, part) {
  const spec = SCOPE[moduleId];
  const result = { ok: true, checked: { zone: false, region: false, product: false }, blocked: [], notes: [], advice: '', productLabel: spec.productLabel,
    counts: { zones: part.zones?.length ?? 0, regions: part.regions?.length ?? 0, products: part.products?.length ?? 0 } };
  if (!base) { result.notes.push('当前没有有效数据，本次不检查导出范围。'); return result; }
  const unchecked = [];
  for (const [dim, list, label] of DIMENSIONS) {
    if (!spec[dim].length) { unchecked.push(`${label}（表中没有该字段）`); continue; }
    if (!part.has?.[dim] || !base.has?.[dim] || !base[list]?.length) { unchecked.push(`${label}（${!part.has?.[dim] ? '新文件' : '当前数据'}没有该字段）`); continue; }
    result.checked[dim] = true;
    const known = new Set(base[list]), extra = (part[list] ?? []).filter(value => !known.has(value));
    if (extra.length) result.blocked.push(`文件包含当前数据没有的${label}：${listText(extra)}`);
  }
  const productLabel = spec.productLabel;
  if (!spec.product.length) unchecked.push(`${productLabel}（表中没有该字段）`);
  else if (!part.has?.product || !base.has?.product) unchecked.push(`${productLabel}（${!part.has?.product ? '新文件' : '当前数据'}没有该字段）`);
  else {
    result.checked.product = true;
    const window = productWindow(base, part), mine = part.products ?? [];
    result.counts.windowProducts = window.length;
    if (window.length >= PRODUCT_RULE.windowMin && mine.length <= PRODUCT_RULE.fileMax && part.rows >= PRODUCT_RULE.minRows)
      result.blocked.push(`${productLabel}只有「${mine[0] ?? '—'}」${mine.length} 个，当前数据同期有 ${window.length} 个${productLabel}，可能只导出了部分产品`);
  }
  if (unchecked.length) result.notes.push(`未检查：${unchecked.join('、')}。`);
  if (result.blocked.length) {
    const zones = base.zones ?? [];
    const scopeName = zones.length && zones.length <= 3 ? zones.join('、') : '当前组织范围';
    result.advice = `请在系统里按「${scopeName}${spec.product.length ? '、全部产品' : ''}」重新导出${base.byDate ? '最近 7 天' : ''}，再拖进来。`;
    result.ok = false;
  }
  return result;
}

/** What an update will change. Used for the check card and enforced again on apply. */
export function receipt({ moduleId, base, part, mode, start, end, existingByDate = {} }) {
  if (isWholeModule(moduleId)) return wholeReceipt({ moduleId, base, part, mode });
  if (!MODES.includes(mode)) throw new Error('更新方式无效。');
  const spec = FLOW[moduleId], blocked = [], warnings = [];
  const baseBy = base?.byDate ?? {}, partBy = part.byDate;
  const partDays = Object.keys(partBy).sort(), baseAll = Object.keys(baseBy);
  if (!part.rows) blocked.push('文件没有数据行。');
  if (part.invalidDateRows) blocked.push(`${part.invalidDateRows} 行${spec.date}无效（Excel 行号：${part.invalidDateSample.join('、')}${part.invalidDateRows > part.invalidDateSample.length ? '等' : ''}），请修正后重新导出。`);
  if (mode !== 'full' && base && (base.format ?? null) !== (part.format ?? null)) blocked.push('文件格式与当前数据不同，只能整份替换。');
  let window, after, before, disappearing = [], missing = { regions: [], offices: [], cities: [] };
  if (mode === 'range') {
    if (!validDay(start) || !validDay(end) || start > end) { blocked.push('请填写有效的起止日期（开始不晚于结束）。'); start = part.start; end = part.end; }
    const outside = partDays.filter(day => day < start || day > end);
    if (outside.length) blocked.push(`文件有 ${outside.reduce((n, day) => n + partBy[day].rows, 0)} 行日期不在替换区间内（${outside[0]}${outside.length > 1 ? ` 等 ${outside.length} 天` : ''}），请调整区间或重新导出。`);
    window = day => day >= start && day <= end;
    const baseDays = listDays(baseBy, window);
    before = totals([[baseBy, baseDays]]); after = totals([[partBy, partDays.filter(window)]]);
    disappearing = baseDays.filter(day => !partBy[day]);
  } else if (mode === 'incremental') {
    const overlap = partDays.filter(day => baseBy[day]);
    if (overlap.length && !spec.overlapAllowed) blocked.push(`文件包含已有记录的日期（${overlap.slice(0, 5).join('、')}${overlap.length > 5 ? ` 等 ${overlap.length} 天` : ''}），增量只能追加新日期，请改用范围更新。`);
    const existing = Object.values(existingByDate).reduce((n, value) => n + value, 0);
    if (moduleId === 'invoice' && existing) warnings.push(`有 ${existing} 行的单据类型、编码和行号在同一天已经存在，追加后会进入重复候选检查；建议改用范围更新。`);
    if (moduleId === 'inventory' && existing) warnings.push(`有 ${existing} 行的经销商编码、产品和提交时间与现有记录相同，追加后作为并列记录保留（不自动去重）；建议改用范围更新。`);
    // Incremental compares the whole current source with the source after appending.
    before = totals([[baseBy, baseAll]]); after = totals([[baseBy, baseAll], [partBy, partDays]]);
    window = day => partBy[day];
  } else {
    window = () => true;
    before = totals([[baseBy, baseAll]]); after = totals([[partBy, partDays]]);
    if (base?.start && part.start && part.start > base.start) warnings.push(`历史起点从 ${base.start} 变为 ${part.start}，之前的数据会被移除。`);
    if (base?.end && part.end && part.end < base.end) warnings.push(`最新日期从 ${base.end} 倒退到 ${part.end}。`);
    const lost = months(baseAll).filter(month => !partDays.some(day => day.startsWith(month)));
    if (lost.length) warnings.push(`${lost.slice(0, 6).join('、')}${lost.length > 6 ? ` 等 ${lost.length} 个月` : ''}在新文件里整月没有数据。`);
  }
  if (mode !== 'incremental' && base) {
    const baseDays = listDays(baseBy, window), newDays = partDays.filter(window);
    for (const field of ['regions', 'offices', 'cities']) {
      const now = union(partBy, newDays, field);
      missing[field] = [...union(baseBy, baseDays, field)].filter(value => !now.has(value)).sort();
    }
    if (moduleId !== 'opening') missing.cities = [];
  }
  const scope = scopeCheck(moduleId, base, part);
  blocked.push(...scope.blocked);
  const requiresConfirmation = missing.regions.length + missing.offices.length + missing.cities.length > 0;
  const parts = [];
  if (missing.regions.length) parts.push(`大区：${missing.regions.join('、')}`);
  if (missing.offices.length) parts.push(`办事处：${listText(missing.offices, 6)}`);
  if (missing.cities.length) parts.push(`城市：${listText(missing.cities, 6)}`);
  const existingRows = Object.entries(existingByDate).filter(([day]) => window(day)).reduce((n, [, value]) => n + value, 0);
  const identity = spec.key ? { existing: existingRows, added: Math.max(0, totals([[partBy, partDays.filter(window)]]).rows - existingRows),
    label: moduleId === 'invoice' ? '单据类型＋编码＋行号' : '经销商编码＋产品＋提交时间' } : null;
  const outStart = mode === 'range' ? start : part.start, outEnd = mode === 'range' ? end : part.end;
  return {
    moduleId, mode, modeLabel: MODE_LABELS[mode], start: outStart, end: outEnd,
    windowLabel: mode === 'range' ? `替换 ${outStart} ~ ${outEnd}` : mode === 'incremental' ? `追加 ${part.start} ~ ${part.end}` : '整份替换',
    file: { rows: part.rows, start: part.start, end: part.end }, before, after, figures: figures(moduleId, before, after),
    disappearingDates: disappearing, missingOrganizations: missing, requiresConfirmation,
    confirmation: requiresConfirmation ? { message: `组织缺失提醒：区间内的旧数据有、新文件里没有的 ${parts.join('；')}。可能导出时只选了部分组织。`, label: '我已核对，这些组织在区间内确实没有数据' } : null,
    identity, invoiceIdentity: moduleId === 'invoice' ? { existing: identity.existing, added: identity.added } : null,
    scope, blocked, warnings,
  };
}

/** Check card for terminal and banquet: whole replacement only. */
export function wholeReceipt({ moduleId, base, part, mode = 'full' }) {
  const blocked = [], warnings = [], notes = [];
  if (mode !== 'full') blocked.push('这个板块只支持整份替换。');
  if (!part.rows) blocked.push('文件没有数据行。');
  let requiresConfirmation = false, confirmation = null, disappearingAgreements = [];
  if (moduleId === 'terminal') {
    if (base) {
      const now = new Set(part.agreementIds ?? []);
      disappearingAgreements = (base.agreementIds ?? []).filter(id => !now.has(id));
      if (disappearingAgreements.length) {
        requiresConfirmation = true;
        confirmation = { message: `当前 ${disappearingAgreements.length} 份协议在新文件里找不到（可能被关闭或删除）：${listText(disappearingAgreements, 5)}。`, label: '我已核对，确认替换' };
      }
      if (base.end && part.end && part.end < base.end) warnings.push(`签约日期最新只到 ${part.end}，早于当前数据的 ${base.end}。`);
    }
  }
  if (moduleId === 'banquet') notes.push('宴席表没有日期列；新文件的统计期间需要在导入检查中重新确认。');
  const scope = scopeCheck(moduleId, base, part);
  blocked.push(...scope.blocked);
  return {
    moduleId, mode: 'full', modeLabel: MODE_LABELS.full, start: part.start, end: part.end, windowLabel: '整份替换',
    file: { rows: part.rows, start: part.start, end: part.end }, before: base ?? null, after: part, figures: figures(moduleId, base, part),
    disappearingDates: [], missingOrganizations: { regions: [], offices: [], cities: [] }, disappearingAgreements: disappearingAgreements.length,
    requiresConfirmation, confirmation, identity: null, invoiceIdentity: null, scope, blocked, warnings, notes,
  };
}

function layout(baseHeaders, partHeaders) {
  const headers = [...baseHeaders];
  const positions = new Map(headers.map((header, index) => [normalizeHeader(header), index]));
  const added = [];
  for (const header of partHeaders) if (header && !positions.has(normalizeHeader(header))) { positions.set(normalizeHeader(header), headers.length); headers.push(header); added.push(header); }
  const missing = baseHeaders.filter(header => header && !partHeaders.some(item => normalizeHeader(item) === normalizeHeader(header)));
  const map = partHeaders.map(header => header ? positions.get(normalizeHeader(header)) : undefined);
  const warnings = [];
  if (added.length) warnings.push(`新文件多了 ${added.join('、')} 列，已一并保留；表头变化后，已保存的处理决定可能需要重新确认。`);
  if (missing.length) warnings.push(`新文件缺少 ${missing.join('、')} 列，这些列在新数据里留空。`);
  return {
    headers, warnings,
    widen: values => { const out = values.slice(0, headers.length); while (out.length < headers.length) out.push(null); return out; },
    project: values => { const out = new Array(headers.length).fill(null); values.forEach((value, index) => { if (map[index] !== undefined) out[map[index]] = value; }); return out; },
  };
}
function keeper(mode, start, end) {
  if (mode === 'incremental') return () => true;
  if (mode === 'range') return row => !row.date || row.date < start || row.date > end;
  throw new Error('整份替换不需要合并。');
}

/** In-memory composition (small sources and tests). Headers follow the current source; new columns are appended. */
export function compose({ moduleId, base, part, mode, start, end }) {
  const plan = layout(base.headers, part.headers), keep = keeper(mode, start, end);
  const rows = [...base.rows.filter(keep).map(row => plan.widen(row.values)), ...part.rows.map(row => plan.project(row.values))];
  return { sheetName: base.sheetName, headers: plan.headers, rows, dateColumn: base.dateColumn, time: !!FLOW[moduleId ?? base.moduleId]?.time, warnings: plan.warnings, kept: rows.length - part.rows.length, appended: part.rows.length };
}

function writer(file, sheetName, headers, dateColumn, time = false) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useSharedStrings: true, useStyles: true });
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(headers).commit();
  return {
    add(values) { const row = sheet.addRow(values); if (values[dateColumn] instanceof Date) row.getCell(dateColumn + 1).numFmt = time ? 'yyyy-mm-dd hh:mm:ss' : 'yyyy-mm-dd'; row.commit(); },
    async close() { sheet.commit(); await workbook.commit(); },
  };
}
export async function writeSource(file, { sheetName, headers, rows, dateColumn, time = false }) {
  const out = writer(file, sheetName, headers, dateColumn, time);
  for (const values of rows) out.add(values);
  await out.close();
}

/** Streaming composition: the current source is read once and never held in memory. */
export async function composeFile({ baseFile, baseValidation, part, mode, start, end, outFile, moduleId }) {
  const keep = keeper(mode, start, end);
  let plan = null, out = null, kept = 0;
  await streamSource(baseFile, baseValidation, moduleId, info => {
    plan = layout(info.headers, part.headers);
    out = writer(outFile, info.sheetName, plan.headers, info.dateColumn, !!FLOW[moduleId].time);
  }, row => { if (keep(row)) { out.add(plan.widen(row.values)); kept++; } });
  for (const row of part.rows) out.add(plan.project(row.values));
  await out.close();
  return { warnings: plan.warnings, kept, appended: part.rows.length, rows: kept + part.rows.length };
}

/** Earlier source fingerprints this upload was composed from (newest first). */
export function lineageShas(state, uploadId) {
  const result = [], seen = new Set();
  let current = state?.uploads?.find(upload => upload.id === uploadId);
  while (current?.composition?.baseUploadId && !seen.has(current.id) && result.length < 5000) {
    seen.add(current.id);
    const base = state.uploads.find(upload => upload.id === current.composition.baseUploadId);
    if (!base?.sha256) break;
    result.push(base.sha256.toLowerCase());
    current = base;
  }
  return result;
}
