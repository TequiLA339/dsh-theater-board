import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createV10Model } from './v10-model.mjs';
import { createV10Components } from './v10-components.mjs';
import { buildTerminalStructure } from './terminal-structure.mjs';
import { createTerminalComponents } from './terminal-components.mjs';
import { createV10Presentation } from './v10-presentation.mjs';
import { createV10Details } from './v10-details.mjs';
import { createV10OverviewData } from './v10-overview-data.mjs';
import { createV10Overview } from './v10-overview.mjs';

export { createV10Model } from './v10-model.mjs';
export const V10_TEMPLATE_SHA256 = 'b58e609411d0b9ab2d77d7079ea580e8210d11946999a8c11cea1fc34bf9b886';
export const V10_SCRIPT_SHA256 = 'd11a689940d80a4010c5f45786ac2da7d3106cb8309216b4df2d55c8dac4599c';
export const V10_RENDERER_VERSION = 18;
export const V10_SHELL_SHA256 = 'd5118e6e2ec447cc22992c348e18ae719bfbda959a2b694352843c120522a5f1';
const APPLICATION_MARKER = '/*__V10_APPLICATION__*/';
const IDS = ['invoice', 'movement', 'opening', 'terminal', 'inventory', 'banquet'];
const ORG = ['marketingCompany', 'businessUnit', 'theater', 'region', 'office', 'unit'];
const NUMERIC = {
  invoice: ['amount'], movement: ['amount', 'bottles', 'boxes', 'cases'], opening: ['bottles', 'amount'],
  terminal: [], inventory: ['counted', 'system', 'countAmount', 'systemAmount', 'absoluteVariance', 'signedVariance', 'sourceVariance'], banquet: ['events', 'bottles'],
};
const TEXT = { invoice: ['brand', 'category', 'dealerCode', 'dealerName', 'productCode', 'productName'], movement: ['brand', 'category', 'quantityUnit', 'terminalCode', 'terminalName', 'channel', 'movementType', 'productCode', 'productName', 'variety', 'dealerCode', 'dealerName'], opening: ['city'], terminal: ['terminalCode', 'terminalName', 'star', 'agreementId', 'type', 'series', 'signLevel', 'signVariety'], inventory: ['brand', 'category', 'safety', 'dealerCode', 'dealerName', 'productCode', 'productName'], banquet: [] };
const OPTIONAL_DISPLAY_TEXT = new Set(['productCode', 'productName', 'variety', 'terminalName', 'channel', 'movementType', 'agreementId', 'type', 'series', 'signLevel', 'signVariety']);
const hash = text => createHash('sha256').update(text).digest('hex');
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`v10 看板校验失败：${message}`); };
const string = (value, name, nullable = false) => {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > 1000) fail(`${name} 必须是有限长度字符串`);
  return value;
};
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** Project internal records onto only fields required by this offline view.
 * Raw rows, sourceRef, contact details, diagnostic reports and machine paths
 * are intentionally not copied. Missing business values remain null.
 */
export function sanitizeV10Payload(input) {
  if (!isObject(input) || input.schemaVersion !== 1 || !['real-preview', 'real'].includes(input.mode)) fail('不支持的数据合同或数据模式');
  if (!isObject(input.modules) || !isObject(input.sources) || !isObject(input.coverage)) fail('缺少 modules / sources / coverage');
  if (typeof input.generatedAt !== 'string' || !Number.isFinite(Date.parse(input.generatedAt))) fail('缺少有效生成时间');
  const result = { schemaVersion: 1, mode: input.mode, generatedAt: input.generatedAt, sources: {}, coverage: {}, modules: {} };
  if (input.decisionContract !== undefined) {
    const contract = input.decisionContract;
    if (!isObject(contract) || contract.version !== 1) fail('不支持的已确认规则合同');
    result.decisionContract = { version: 1 };
    if (contract.decisionId !== undefined && contract.decisionId !== null) result.decisionContract.decisionId = string(contract.decisionId, 'decisionContract.decisionId');
    for (const key of ['organizationMapping', 'terminalIdentity', 'crossTableMetrics', 'banquetOpeningSubset', 'banquetReward', 'inventoryValuationBasis']) {
      const rule = contract[key];
      if (!rule) continue;
      if (!isObject(rule) || !['confirmed', 'pending', 'not-guaranteed'].includes(rule.status)) fail(`规则 ${key} 状态无效`);
      const clean = { status: rule.status };
      for (const field of ['sources', 'appliedSources']) if (rule[field]) {
        if (!isObject(rule[field])) fail(`规则 ${key} 来源绑定无效`);
        clean[field] = Object.fromEntries(Object.entries(rule[field]).map(([id, sha]) => {
          if (!IDS.includes(id) || typeof sha !== 'string' || !/^[a-f0-9]{64}$/i.test(sha)) fail(`规则 ${key} 来源指纹无效`);
          return [id, sha.toLowerCase()];
        }));
      }
      if (key === 'terminalIdentity' && rule.key !== undefined) clean.key = string(rule.key, 'terminalIdentity.key');
      if (key === 'organizationMapping' && rule.version !== undefined) {
        if (!Number.isSafeInteger(rule.version) || rule.version < 1) fail('组织映射版本无效');
        clean.version = rule.version;
      }
      result.decisionContract[key] = clean;
    }
  }
  for (const id of IDS) {
    const module = input.modules[id];
    if (!isObject(module) || !['ready', 'partial', 'unavailable'].includes(module.state) || !Array.isArray(module.records) || !isObject(module.metrics) || !Array.isArray(module.unavailable)) fail(`${id} 模块合同不完整`);
    if (module.state === 'unavailable' && module.records.length) fail(`${id} 不可用模块不能带可展示记录`);
    const source = input.sources[id];
    if (module.state !== 'unavailable' && !source) fail(`${id} 缺少锁定来源`);
    if (source) {
      if (!isObject(source) || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sha256)) fail(`${id} SHA-256 无效`);
      const name = source.originalName === null ? '未提供文件名' : string(source.originalName, `${id}.originalName`);
      result.sources[id] = { uploadId: string(source.uploadId, `${id}.uploadId`), sha256: source.sha256.toLowerCase(), originalName: name.replaceAll('\\', '/').split('/').at(-1) };
      if (!result.sources[id].uploadId) fail(`${id} 上传版本为空`);
    }
    const coverage = input.coverage[id];
    if (module.state !== 'unavailable' && !isObject(coverage)) fail(`${id} 缺少期间说明`);
    if (coverage) {
      for (const key of ['start', 'end']) if (coverage[key] !== null && !validDate(coverage[key])) fail(`${id} 期间 ${key} 无效`);
      if (coverage.start && coverage.end && coverage.start > coverage.end) fail(`${id} 期间倒置`);
      result.coverage[id] = { start: coverage.start, end: coverage.end, semantics: string(coverage.semantics, `${id}.coverage.semantics`, module.state === 'unavailable') };
    }
    const records = module.records.map((row, index) => {
      const where = `${id}[${index}]`;
      if (!isObject(row) || !isObject(row.org) || !Array.isArray(row.orgPath) || row.orgPath.length !== 6) fail(`${where} 缺少完整六级组织路径`);
      const orgPath = row.orgPath.map((value, i) => string(value, `${where}.orgPath[${i}]`));
      const org = Object.fromEntries(ORG.map((key, i) => {
        const value = string(row.org[key], `${where}.org.${key}`);
        if (value !== orgPath[i]) fail(`${where} 组织字段与完整路径不一致`);
        return [key, value];
      }));
      if (row.date !== null && !validDate(row.date)) fail(`${where}.date 无效`);
      if (id === 'banquet' && row.date !== null) fail('宴席必须保持来源固定期间');
      const clean = { org, orgPath, date: row.date };
      for (const key of NUMERIC[id]) {
        if (!(key in row)) fail(`${where}.${key} 缺失，不能静默补零`);
        const value = row[key];
        if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) fail(`${where}.${key} 必须为有限数或 null`);
        clean[key] = value;
      }
      for (const key of TEXT[id]) clean[key] = string(row[key] ?? ((OPTIONAL_DISPLAY_TEXT.has(key) || id !== 'invoice' && ['dealerCode', 'dealerName'].includes(key)) ? '' : row[key]), `${where}.${key}`, ['brand', 'category'].includes(key));
      if (id === 'inventory' && module.inventoryMode === 'visit-history') {
        for (const key of ['submittedAt', 'inventoryGroupKey', 'sourceOrgPath', 'inventoryIssues', 'supplementRequested', 'supplementStatus', 'stocktakeCode']) clean[key] = string(row[key] ?? '', `${where}.${key}`);
        const prior = row.previousSubmittedAt;
        if (prior !== null && (typeof prior !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(prior)
          || !validDate(prior.slice(0, 10)) || prior.slice(11, 13) > '23' || prior.slice(14, 16) > '59' || prior.slice(17, 19) > '59'
          || prior >= row.submittedAt)) fail(`${where}.previousSubmittedAt 必须为空或严格早于本次的有效提交时间`);
        clean.previousSubmittedAt = prior;
        for (const key of ['previousCounted', 'changeFromPrevious']) {
          if (!(key in row) || row[key] !== null && (typeof row[key] !== 'number' || !Number.isFinite(row[key]))) fail(`${where}.${key} 必须为有限数或 null`);
          clean[key] = row[key];
        }
        const statuses = ['comparable', 'no-previous', 'invalid-date', 'current-conflict', 'previous-conflict', 'missing-counted', 'invalid-change'];
        if (!statuses.includes(row.inventoryComparisonStatus)) fail(`${where}.inventoryComparisonStatus 无效`);
        clean.inventoryComparisonStatus = row.inventoryComparisonStatus;
        if (row.inventoryComparisonStatus === 'comparable' && (prior === null || row.previousCounted === null || row.counted === null || row.changeFromPrevious === null || row.inventoryConflict || row.inventoryDateUncertain)) fail(`${where} 可比较状态缺少有效前次或差值，或存在时间冲突`);
        if (row.inventoryComparisonStatus !== 'comparable' && row.changeFromPrevious !== null) fail(`${where} 不可比较记录不能带变化瓶数`);
        for (const key of ['inventoryConflict', 'inventoryDateUncertain']) {
          if (![0, 1].includes(row[key] ?? 0)) fail(`${where}.${key} 必须为 0 或 1`);
          clean[key] = row[key] ?? 0;
        }
      }
      return clean;
    });
    // Metrics are recomputed for the selected scope; global totals are never
    // reused as filtered values. Internal pending keys are not user-facing text.
    const gates = Object.fromEntries(Object.entries(module.metrics).filter(([key]) => id !== 'terminal' || !['target', 'stageTarget', 'received', 'receivedAmount', 'achievement', 'movementCoverage'].includes(key)).map(([key, metric]) => {
      if (!isObject(metric) || !['available', 'pending', 'missing'].includes(metric.status)) fail(`${id}.${key} 指标状态无效`);
      return [key, { status: metric.status }];
    }));
    result.modules[id] = { state: module.state, records, metrics: gates, unavailable: [] };
    if (module.reviewPending === true) {
      if (module.state !== 'unavailable' || !source) fail('待确认板块必须保留来源且不输出不完整的记录汇总');
      result.modules[id].reviewPending = true;
      result.modules[id].reviewReason = string(module.reviewReason, `${id}.reviewReason`);
    }
    if (id === 'inventory' && module.inventoryMode === 'visit-history') {
      const clean = result.modules[id];
      clean.inventoryMode = 'visit-history';
      clean.inventoryStats = {};
      for (const key of ['sourceRows', 'compressedRows', 'groupCount', 'missingDealerCodes', 'invalidDates', 'invalidNumbers']) {
        const value = module.inventoryStats?.[key] ?? 0;
        if (!Number.isSafeInteger(value) || value < 0) fail(`inventory.inventoryStats.${key} 无效`);
        clean.inventoryStats[key] = value;
      }
      clean.uncertaintyGroups = (module.uncertaintyGroups || []).map(group => ({
        inventoryGroupKey: string(group.inventoryGroupKey, 'inventory.uncertaintyGroup.key'),
        organizations: (group.organizations || []).map(value => {
          if (!Array.isArray(value.orgPath) || value.orgPath.length !== 6) fail('无效时间组缺少组织路径');
          return { orgPath: value.orgPath.map(part => string(part, 'inventory.uncertaintyGroup.orgPath')) };
        }),
      }));
    }
  }
  const target = input.modules.target;
  if (target !== undefined) {
    if (!isObject(target) || !Array.isArray(target.records) || !['ready', 'partial', 'unavailable'].includes(target.state)) fail('经营目标模块合同不完整');
    const source = input.sources.target, ready = target.state !== 'unavailable' && source;
    if (ready && (!isObject(source) || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sha256))) fail('经营目标 SHA-256 无效');
    result.targets = { state: ready ? 'ready' : 'unavailable', reason: ready ? null : string(target.reason ?? '未接入有效目标来源', 'target.reason'),
      source: ready ? { uploadId: string(source.uploadId, 'target.uploadId'), sha256: source.sha256.toLowerCase(),
        originalName: (source.originalName === null ? '未提供文件名' : string(source.originalName, 'target.originalName')).replaceAll('\\', '/').split('/').at(-1) } : null,
      records: ready ? target.records.filter(row => isObject(row) && !row.issue).map((row, index) => {
        const where = `target[${index}]`;
        if (typeof row.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month)) fail(`${where}.month 无效`);
        if (!['invoice', 'movement', 'opening'].includes(row.metric)) fail(`${where}.metric 无效`);
        if (row.value !== null && (typeof row.value !== 'number' || !Number.isFinite(row.value) || row.value < 0)) fail(`${where}.value 必须为非负有限数或 null`);
        if (!isObject(row.org)) fail(`${where} 缺少组织`);
        return { month: row.month, metric: row.metric, value: row.value, region: string(row.org.region ?? '', `${where}.region`), office: string(row.org.office ?? '', `${where}.office`), unit: string(row.org.unit ?? '', `${where}.unit`) };
      }) : [] };
  }
  if (!IDS.some(id => result.modules[id].state !== 'unavailable' && result.modules[id].records.length) && !IDS.some(id => result.modules[id].reviewPending)) fail('零有效来源不能生成真实数据看板');
  return result;
}

const literal = value => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
export function packV10Payload(payload) {
  const paths = [], keys = new Map();
  const modules = Object.fromEntries(IDS.map(id => {
    const module = payload.modules[id];
    let records = module.records.map(({ org, orgPath, ...row }) => {
      const key = JSON.stringify(orgPath);
      if (!keys.has(key)) { keys.set(key, paths.length); paths.push(orgPath); }
      return { ...row, orgIndex: keys.get(key) };
    });
    if (id === 'inventory' && module.inventoryMode === 'visit-history' && records.length) {
      const fields = Object.keys(records[0]);
      // Sanitized inventory has a uniform schema. Keep the original form if a
      // future caller supplies varying keys, rather than silently losing fields.
      if (records.every(row => Object.keys(row).length === fields.length && fields.every(field => Object.hasOwn(row, field)))) {
        const columns = fields.map(field => {
          const values = records.map(row => row[field]);
          if (values.every(value => Object.is(value, values[0]))) return { value: values[0] };
          const plain = { values };
          if (values.every(value => value === null || typeof value === 'string')) {
            const dictionary = [], indexes = [], lookup = new Map();
            for (const value of values) {
              if (!lookup.has(value)) { lookup.set(value, dictionary.length); dictionary.push(value); }
              indexes.push(lookup.get(value));
            }
            const encoded = { dictionary, indexes };
            if (JSON.stringify(encoded).length < JSON.stringify(plain).length) return encoded;
          }
          return plain;
        });
        records = { encoding: 'inventory-columns-v1', length: records.length, fields, columns };
      }
    }
    return [id, { ...module, records }];
  }));
  return { ...payload, organizationPaths: paths, modules };
}
// Shared objects are restored in memory, so the offline file does not repeat a
// full six-level organization hundreds of thousands of times. Keep this function
// self-contained: its source is embedded directly into the offline HTML.
export function unpackV10Payload(payload) {
  const fields = ['marketingCompany', 'businessUnit', 'theater', 'region', 'office', 'unit'];
  const orgs = payload.organizationPaths.map(path => Object.fromEntries(fields.map((field, index) => [field, path[index]])));
  const modules = Object.fromEntries(Object.entries(payload.modules).map(([id, module]) => {
    let records = module.records;
    if (id === 'inventory' && module.inventoryMode === 'visit-history' && records.encoding === 'inventory-columns-v1') {
      const packed = records;
      records = Array.from({ length: packed.length }, (_, index) => Object.fromEntries(packed.fields.map((field, columnIndex) => {
        const column = packed.columns[columnIndex];
        const value = Object.prototype.hasOwnProperty.call(column, 'value') ? column.value
          : column.dictionary ? column.dictionary[column.indexes[index]] : column.values[index];
        return [field, value];
      })));
    }
    return [id, { ...module, records: records.map(({ orgIndex, ...row }) => ({ ...row, org: orgs[orgIndex], orgPath: payload.organizationPaths[orgIndex] })) }];
  }));
  const { organizationPaths, ...rest } = payload;
  return { ...rest, modules };
}
function once(source, search, replacement) {
  const start = source.indexOf(search);
  if (start < 0 || source.indexOf(search, start + search.length) >= 0) fail(`模板替换边界不唯一：${search.slice(0, 45)}`);
  return source.slice(0, start) + replacement + source.slice(start + search.length);
}

/** Remove the original business snapshot and all of its calculation code.
 * This only accepts the exact reviewed private template. The returned shell
 * contains libraries, CSS and the data-independent layout, never source rows.
 */
export function extractV10Shell(templateHtml) {
  if (typeof templateHtml !== 'string' || hash(templateHtml) !== V10_TEMPLATE_SHA256) fail('模板 SHA 不在已审查允许列表，拒绝套用旧替换边界');
  const scripts = [...templateHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  if (scripts.length !== 1 || !/^<script type="module">/.test(scripts[0][0])) fail('模板脚本结构改变');
  const script = scripts[0][1];
  if (hash(script) !== V10_SCRIPT_SHA256) fail('模板脚本 SHA 不匹配');
  const prefixEnd = 606234, rootStart = 2916206, mountStart = 2929786;
  if (!script.startsWith('const ZQ_RD = ', prefixEnd) || !script.startsWith('function XZ() {', rootStart) || !script.startsWith('h7.createRoot(document.getElementById("root")).render(', mountStart)) fail('已审查模板的应用边界不匹配');
  let root = script.slice(rootStart, mountStart);
  root = once(root, 'Array.from({ length: 10 }, (x, i) => `2026-${pad2(10 - i)}`)', '[...V10.months].reverse()');
  root = once(root, 'children: [b.replace("-", " 年 "), " 月"]', 'children: b === "fixed" ? "来源固定期间" : [b.replace("-", " 年 "), " 月"]');
  for (const name of ['ME', 'h', 'm']) root = once(root, `${name}.map((b) => T.jsx("option", { children: b }, b))`, `${name}.map((b) => T.jsx("option", { value: b, children: V10.label(b) }, b))`);
  root = once(root, 'children: [b.name, T.jsx(Z4, { size: 15 })]', 'children: [V10.label(b.name), T.jsx(Z4, { size: 15 })]');
  root = once(root, 'T.jsx("small", { children: "万元" })', 'T.jsx("small", { children: b.invoice == null ? "" : "万元" })');
  root = once(root, '" 万元",', 'b.movement == null ? "" : " 万元",');
  root = once(root, '"六个板块均为真实数据"', 'V10_PRESENTATION.badge');
  root = once(root, '"六个板块均为真实明细 · 截至 2026-10-26"', 'V10_PRESENTATION.sourceLabel');
  root = once(root, '" DESIGN PREVIEW 01"', 'V10_PRESENTATION.versionLabel');
  root = once(root, '"V 0.1"', '"V 10"');
  const replacement = `<script type="module">${script.slice(0, prefixEnd)}${APPLICATION_MARKER}\n${root}${script.slice(mountStart)}</script>`;
  const shell = templateHtml.slice(0, scripts[0].index) + replacement + templateHtml.slice(scripts[0].index + scripts[0][0].length);
  if (shell.includes('const ZQ_RD = ') || shell.includes('六个板块均为真实明细')) fail('原始快照或旧状态文案残留');
  return shell;
}

function renderShell(shell, input, { mode, templateSha256 }) {
  const payload = sanitizeV10Payload(input), payloadSha256 = hash(JSON.stringify(payload));
  if (payload.mode !== mode) fail('生成入口与数据模式不一致');
  const presentation = mode === 'real' ? {
    badge: '本机上传 · 真实数据', versionLabel: ' V10 REAL DATA',
    notice: '真实数据看板：使用本次生成时最新校验通过的上传版本；未提供来源和待确认指标明确标示。',
  } : {
    badge: '真实来源 · 隔离预览', versionLabel: ' V10 SOURCE PREVIEW',
    notice: '真实数据接入预览：已锁定本机上传版本；待确认指标不计算；尚未替换正式后台生成链路。',
  };
  presentation.sourceLabel = `来源版本已锁定 · 数据指纹 ${payloadSha256.slice(0, 12)}`;
  const sourceEnds = [...new Set(IDS.filter(id => payload.modules[id].state !== 'unavailable').map(id => payload.coverage[id]?.end))];
  const cutoff = !sourceEnds.some(Boolean) ? '来源截止日期未提供' : sourceEnds.length === 1 && sourceEnds[0] ? `截至 ${sourceEnds[0]}` : `最新至 ${sourceEnds.filter(Boolean).sort().at(-1)} · 各来源截止不同`;
  presentation.badge = `${mode === 'real' ? '真实数据' : '真实来源预览'} · ${cutoff}`;
  const injected = `
const V10_PAYLOAD=(${unpackV10Payload.toString()})(${literal(packV10Payload(payload))});
const V10_PRESENTATION=${literal(presentation)};
const buildTerminalStructure=(${buildTerminalStructure.toString()});
const createTerminalComponents=(${createTerminalComponents.toString()});
const createV10Presentation=(${createV10Presentation.toString()});
const createV10Details=(${createV10Details.toString()});
const createV10OverviewData=(${createV10OverviewData.toString()});
const createV10Overview=(${createV10Overview.toString()});
const V10=(${createV10Model.toString()})(V10_PAYLOAD);
const pad2=x=>String(x).padStart(2,'0'),Al=V10.organizations,Ur=V10.categories,BRANDS=[...new Set(Ur.map(x=>x.brand))],ME=[...new Set(Al.map(x=>x.region))],N4=V10.defaults,mf=V10.ids;
const Je=V10.format,Yr=x=>typeof x==='number'&&Number.isFinite(x)?Je(x/10000,2):'无记录',DE=V10.scope,$Z=V10.select;
const previewIcons={invoice:nx,movement:P7,opening:I7,terminal:$7,inventory:U7,banquet:H7};
const Pn=Object.fromEntries(mf.map(id=>[id,{title:V10.titles[id],color:V10.colors[id],icon:previewIcons[id]}]));
const {z4,GZ,VZ,KZ}=(${createV10Components.toString()})({T,g,model:V10,icons:{arrow:Z4,close:B7},Pn});
const {Overview,PeriodFilter,UpLevel}=createV10Overview({T,g,model:V10,Pn});
`;
  let html = once(shell, APPLICATION_MARKER, injected);
  // An offline payload is immutable. Module navigation changes n, not filters e;
  // keep the current selection stable so the presentation caches can reuse it.
  html = once(html, '    s = $Z(e);', '    s = g.useMemo(() => $Z(e), [e]);');
  // Month selection returns to month mode; a custom range keeps its end month
  // as the anchor for yearly views. Organization drills keep the period.
  html = once(html, '      const E = { ...S, [b]: x };', '      const E = b === "range" ? { ...S, period: "range", start: x.start, end: x.end, month: x.end.slice(0, 7) } : { ...S, [b]: x, ...(b === "month" ? { period: "month", start: null, end: null } : {}) };');
  const monthLabelStart = html.indexOf('T.jsx("span", { children: "月份" })');
  const monthOpen = html.lastIndexOf('T.jsxs("label", {', monthLabelStart), monthClose = html.indexOf('T.jsxs("label", {', monthLabelStart);
  if (monthLabelStart < 0 || monthOpen < 0 || monthClose < 0 || html.indexOf('T.jsx("span", { children: "月份" })', monthLabelStart + 1) >= 0) fail('月份筛选替换边界不唯一');
  html = html.slice(0, monthOpen) + 'T.jsx(PeriodFilter, { filters: e, drill: f, detail: Boolean(n) }),\n              ' + html.slice(monthClose);
  // Global one-step-up control next to the current scope, in overview and details.
  html = once(html, '                  DE(e),\n', '                  DE(e),\n                  T.jsx(UpLevel, { filters: e, drill: f }),\n');
  html = once(html, 'T.jsxs("div", {\n            className: "scope-line",', 'n ? T.jsxs("div", {\n            className: "scope-line",');
  html = once(html, '                  : "点击任意板块，展开详细信息",\n              }),\n            ],\n          }),', '                  : null,\n              }),\n            ],\n          }) : T.jsx("div", { className: "scope-line", children: T.jsx(UpLevel, { filters: e, drill: f }) }),');
  // The reviewed shell stays immutable. Replace only its overview branch after
  // the original template/shell fingerprints have passed verification.
  html = once(html, 'className: `app-shell ${n ? "detail-mode" : ""}`', 'className: `app-shell ${n ? "detail-mode" : "overview-mode"}`');
  const overviewStart = '            : T.jsxs(T.Fragment, {', overviewEnd = '          T.jsxs("footer", {';
  const start = html.indexOf(overviewStart), end = html.indexOf(overviewEnd, start);
  if (start < 0 || end < 0 || html.indexOf(overviewStart, start + overviewStart.length) >= 0) fail('总览替换边界不唯一');
  html = once(html, html.slice(start, end), '            : T.jsx(Overview, {data:s, filters:e, open:d, drill:f}),\n');
  html = once(html, '<title>战区经营看板 · 设计原型</title>', '<title>战区经营看板 · V10 真实数据</title>');
  html = once(html, '</head>', `<style id="v10-source-preview-style">${readFileSync(new URL('./terminal-structure.css', import.meta.url), 'utf8')}\n${readFileSync(new URL('./v10-details.css', import.meta.url), 'utf8')}\n${readFileSync(new URL('./v10-layout.css', import.meta.url), 'utf8')}\n${readFileSync(new URL('./v10-overview.css', import.meta.url), 'utf8')}</style></head>`);
  html = once(html, '<body>', `<body><div class="v10-source-notice" role="note">${presentation.notice}</div>`);
  return { html, templateSha256, payloadSha256, rendererVersion: V10_RENDERER_VERSION,
    moduleStates: Object.fromEntries(IDS.map(id => [id, payload.modules[id].state])), sources: payload.sources };
}

/** Preserve the private-template preview entry point for isolated reviews. */
export function renderV10Preview(templateHtml, input) {
  const shell = extractV10Shell(templateHtml);
  return renderShell(shell, input, { mode: 'real-preview', templateSha256: V10_TEMPLATE_SHA256 });
}

/** Production generation uses only this repository's data-free shell.
 * Source processors may still use the preview contract internally; only an
 * already supported real contract may be promoted to the production view.
 */
export function renderV10Dashboard(input) {
  if (!isObject(input) || !['real-preview', 'real'].includes(input.mode)) fail('不支持的数据合同或数据模式');
  const shell = readFileSync(new URL('./v10-shell.html', import.meta.url), 'utf8');
  if (hash(shell) !== V10_SHELL_SHA256) fail('内置模板 SHA 不匹配，请检查代码版本');
  return renderShell(shell, { ...input, mode: 'real' }, { mode: 'real', templateSha256: V10_SHELL_SHA256 });
}
