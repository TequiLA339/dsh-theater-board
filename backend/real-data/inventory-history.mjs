import { createHash } from 'node:crypto';

const SOURCE_HEADERS = [
  '经销商名称', '经销商编码', '营销组织', '营销公司', '事业部', '大区', '办事处', '客户主任单元',
  '提交人', '手机号', '提交时间', '经销商类型', '盘点编码', '产品名称', '库存瓶数', '提交时实时库存数',
  '提交时实时库存数金额', '差异', '是否存在盘点偏差', '偏差数量（瓶）', '是否发起补录', '补录单数据状态',
];
const NUMBER_FIELDS = [
  ['counted', '库存瓶数'], ['system', '提交时实时库存数'],
  ['systemAmount', '提交时实时库存数金额'], ['sourceVariance', '偏差数量（瓶）'],
];
const rawText = value => value === null || value === undefined ? '' : String(value);
const text = value => rawText(value).trim();
const absent = value => value === null || value === undefined || typeof value === 'string' && !value.trim();
const pad = value => String(value).padStart(2, '0');

function sourceNumber(value) {
  if (absent(value)) return { value: null, status: 'missing' };
  if (typeof value !== 'number' && typeof value !== 'string') return { value: null, status: 'invalid' };
  let normalized = text(value);
  if (normalized.includes(',')) {
    if (!/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(normalized)) return { value: null, status: 'invalid' };
    normalized = normalized.replaceAll(',', '');
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return { value: null, status: 'invalid' };
  const number = Number(normalized);
  return Number.isFinite(number) ? { value: number, status: 'valid' } : { value: null, status: 'invalid' };
}

// Source numbers may contain decimals. Subtract their decimal representations
// without introducing a binary artefact such as 0.3 - 0.2 = 0.09999999999999998.
function difference(left, right) {
  if (left === null || right === null) return null;
  const parts = [left, right].map(value => {
    const match = String(value).match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
    let digits = BigInt(`${match[1]}${match[2]}${match[3] ?? ''}`);
    let scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
    if (scale < 0) { digits *= 10n ** BigInt(-scale); scale = 0; }
    return { digits, scale };
  });
  const scale = Math.max(...parts.map(part => part.scale));
  const result = parts[0].digits * 10n ** BigInt(scale - parts[0].scale) - parts[1].digits * 10n ** BigInt(scale - parts[1].scale);
  const number = Number(result) / 10 ** scale;
  return Number.isFinite(number) ? number : null;
}

function submittedTime(value, date1904) {
  // Excel serial dates have no timezone. Preserve the workbook's wall-clock
  // components, including its fractional day, at the contracted second precision.
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value >= 2958466 || !date1904 && Math.floor(value) === 60) return null;
    const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30);
    const early1900Correction = !date1904 && value < 60 ? 86400000 : 0;
    const parsed = new Date(epoch + early1900Correction + Math.round(value * 86400) * 1000);
    if (!Number.isFinite(parsed.valueOf())) return null;
    value = parsed.toISOString();
  }
  // A trailing Z is accepted from the shared Excel Date scalar adapter. No
  // timezone offset is applied; explicit non-zero offsets require source review.
  const match = text(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?Z?$/);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(value => Number(value ?? 0));
  if (year < 1000 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

function organization(row) {
  const get = row.get;
  const sourceOrgPath = rawText(get('营销组织'));
  const segments = sourceOrgPath.split('/').map(part => part.trim());
  const company = text(get('营销公司')), region = text(get('大区'));
  const office = text(get('办事处')), unit = text(get('客户主任单元'));
  const companyIndices = segments.flatMap((part, index) => company && part === company ? [index] : []);
  const companyIndex = companyIndices.length === 1 ? companyIndices[0] : -1;
  const anchors = [region, office, unit];
  // The explicit columns can assign adjacent roles to the same source node
  // (e.g. a directly managed office is both region and office). Accept that
  // exact node once in the source suffix, but preserve both explicit roles in
  // orgPath. This is source-field expansion, not an alias to another source.
  const collapsedAnchors = anchors.filter((part, index) => !index || part !== anchors[index - 1]);
  const suffixes = anchors.every(part => part === anchors[0])
    ? [anchors, anchors.slice(0, 2), collapsedAnchors] : [anchors, collapsedAnchors];
  let middle = [], parsed = false;
  if (companyIndex >= 0 && anchors.every(Boolean)) for (const suffix of suffixes) {
    if (!suffix.every((part, index) => segments.at(index - suffix.length) === part)) continue;
    const between = segments.slice(companyIndex + 1, -suffix.length);
    if (companyIndex >= segments.length - suffix.length || ![1, 2].includes(between.length) || !between.every(Boolean)) continue;
    middle = between; parsed = true; break;
  }
  // An unparsed path is an independent identity. In particular, matching short
  // region/office/unit labels cannot silently join an ambiguous source path.
  const org = parsed ? {
    marketingCompany: company, businessUnit: middle.length === 2 ? middle[0] : '',
    theater: middle.at(-1), region, office, unit,
  } : {
    marketingCompany: sourceOrgPath || `未提供营销组织（${row.sheet ?? ''} 第 ${row.row ?? ''} 行）`,
    businessUnit: '', theater: '', region: '', office: '', unit: '',
  };
  const orgPath = Object.values(org);
  return { org, orgPath, orgKey: JSON.stringify(orgPath), sourceOrgPath, inventoryOrganizationUnparsed: parsed ? 0 : 1 };
}

const addTo = (map, key, value) => {
  const values = map.get(key);
  if (values) values.push(value); else map.set(key, [value]);
};
const compareRecords = (left, right) => left.submittedAt.localeCompare(right.submittedAt) ||
  left.inventoryGroupKey.localeCompare(right.inventoryGroupKey) || left.sourceRef.row - right.sourceRef.row;
const evidence = row => ({ sheet: row.sheet ?? '拜访采集-库存盘点', row: row.row });

function addPreviousComparison(observations, invalidDate) {
  // Resolve the immediately preceding distinct timestamp before month-end
  // compression. A missing count or a tied bucket is still the preceding
  // observation; never skip it in favour of an older, usable number.
  const buckets = new Map();
  for (const record of observations) addTo(buckets, record.submittedAt, record);
  let previous = null;
  for (const timestamp of [...buckets.keys()].sort()) {
    const current = buckets.get(timestamp);
    for (const record of current) {
      record.previousSubmittedAt = !invalidDate && previous ? previous[0].submittedAt : null;
      record.previousCounted = !invalidDate && previous?.length === 1 ? previous[0].counted : null;
      record.changeFromPrevious = null;
      if (invalidDate) record.inventoryComparisonStatus = 'invalid-date';
      else if (current.length > 1) record.inventoryComparisonStatus = 'current-conflict';
      else if (previous?.length > 1) record.inventoryComparisonStatus = 'previous-conflict';
      else if (!previous) record.inventoryComparisonStatus = 'no-previous';
      else if (record.counted === null || record.previousCounted === null) record.inventoryComparisonStatus = 'missing-counted';
      else {
        const change = difference(record.counted, record.previousCounted);
        record.inventoryComparisonStatus = change === null ? 'invalid-change' : 'comparable';
        record.changeFromPrevious = change;
      }
    }
    previous = current;
  }
}

/**
 * Normalize historical inventory observations without changing input rows.
 * `records` contains every tied month-end candidate for each exact dealer/name
 * group. `latestRecords` contains all globally latest candidates. Neither array
 * is an additive historical inventory series. Local-only diagnostics retain
 * excluded-row references and duplicate evidence; callers should not embed them
 * in offline HTML. Unknown dates are exposed separately for filtered blocking.
 */
export function processInventoryHistory(rows, { date1904 = false } = {}) {
  const diagnostics = {
    sourceRows: 0, missingDealerCodes: 0, missingProductNames: 0,
    missingIdentityRows: 0, invalidNumbers: 0, missingNumbers: 0, invalidDates: 0,
    exactDuplicateRows: 0, exactDuplicateGroups: 0, sameTimeDuplicateRows: 0,
    sameTimeDuplicateGroups: 0, sameStocktakeDuplicateRows: 0, sameStocktakeDuplicateGroups: 0,
    latestRows: 0, latestTieGroups: 0, latestTieRows: 0, monthEndRows: 0,
    historyCompressedRows: 0, validObservationRows: 0, groupCount: 0,
    unparsedOrganizationRows: 0, organizationChangedGroups: 0,
    negativeSystemRows: 0, negativeCountedRows: 0, negativeSystemAmountRows: 0,
    supplementReviewRows: 0, missingIdentity: [], numericIssues: [], invalidDateRows: [],
    invalidDateGroupKeys: [], duplicateGroups: [], organizationChanges: [],
    unparsedOrganizations: [], compressedRows: [],
  };
  const all = [], groups = new Map(), exact = new Map(), byTime = new Map(), byStocktake = new Map();
  const uncertain = new Map(), groupOrganizations = new Map();
  let earliest = null, latest = null;
  for (const row of rows) {
    diagnostics.sourceRows++;
    const get = row.get, sourceRef = evidence(row), issues = [];
    const values = Array.isArray(row.values) ? row.values : SOURCE_HEADERS.map(header => get(header));
    const digest = createHash('sha256').update(JSON.stringify(values)).digest('hex');
    addTo(exact, digest, sourceRef);
    const dealerCode = rawText(get('经销商编码')), productName = rawText(get('产品名称'));
    const missingCode = !dealerCode.trim(), missingProduct = !productName.trim();
    if (missingCode) diagnostics.missingDealerCodes++;
    if (missingProduct) diagnostics.missingProductNames++;
    const inventoryGroupKey = missingCode || missingProduct ? null : JSON.stringify([dealerCode, productName]);
    const submittedAt = submittedTime(get('提交时间'), date1904);
    if (submittedAt) {
      if (!earliest || submittedAt < earliest) earliest = submittedAt;
      if (!latest || submittedAt > latest) latest = submittedAt;
    } else {
      diagnostics.invalidDates++;
      diagnostics.invalidDateRows.push({ ...sourceRef, inventoryGroupKey, value: get('提交时间') ?? null });
    }
    const org = organization(row);
    if (org.inventoryOrganizationUnparsed) {
      diagnostics.unparsedOrganizationRows++;
      diagnostics.unparsedOrganizations.push({ ...sourceRef, sourceOrgPath: org.sourceOrgPath });
      issues.push('完整组织路径未解析');
    }
    const numbers = {};
    for (const [field, header] of NUMBER_FIELDS) {
      const parsed = sourceNumber(get(header));
      numbers[field] = parsed.value;
      if (parsed.status !== 'valid') {
        diagnostics[parsed.status === 'missing' ? 'missingNumbers' : 'invalidNumbers']++;
        diagnostics.numericIssues.push({ ...sourceRef, field, header, status: parsed.status, value: get(header) ?? null });
        // A missing source variance is preserved; it does not invalidate the
        // independently calculated difference when both source counts exist.
        if (field !== 'sourceVariance' || parsed.status === 'invalid') issues.push(`${header}${parsed.status === 'missing' ? '缺失' : '无法转换'}`);
      }
    }
    if (numbers.system !== null && numbers.system < 0) { diagnostics.negativeSystemRows++; issues.push('系统库存为负'); }
    if (numbers.counted !== null && numbers.counted < 0) { diagnostics.negativeCountedRows++; issues.push('盘点库存为负'); }
    if (numbers.systemAmount !== null && numbers.systemAmount < 0) { diagnostics.negativeSystemAmountRows++; issues.push('系统金额为负'); }
    const supplementRequested = text(get('是否发起补录')), supplementStatus = text(get('补录单数据状态'));
    if (['审批中', '审批不通过'].includes(supplementStatus) || supplementRequested === '是' && !supplementStatus) {
      diagnostics.supplementReviewRows++;
      issues.push(supplementStatus ? `补录${supplementStatus}` : '补录状态缺失');
    }
    if (inventoryGroupKey) {
      let organizations = groupOrganizations.get(inventoryGroupKey);
      if (!organizations) { organizations = new Map(); groupOrganizations.set(inventoryGroupKey, organizations); }
      if (!organizations.has(org.sourceOrgPath)) organizations.set(org.sourceOrgPath, { ...org, sourceRefs: [] });
      organizations.get(org.sourceOrgPath).sourceRefs.push(sourceRef);
      if (!submittedAt) {
        let uncertainty = uncertain.get(inventoryGroupKey);
        if (!uncertainty) {
          uncertainty = { inventoryGroupKey, dealerCode, productName, sourceRefs: [], reason: 'invalid-date', organizations: [] };
          uncertain.set(inventoryGroupKey, uncertainty);
        }
        uncertainty.sourceRefs.push(sourceRef);
      }
    }
    if (missingCode || missingProduct) {
      diagnostics.missingIdentityRows++;
      diagnostics.missingIdentity.push({ ...sourceRef, missingDealerCode: missingCode, missingProductName: missingProduct });
      continue;
    }
    if (!submittedAt) continue;
    const signedVariance = difference(numbers.counted, numbers.system);
    const record = {
      sourceRef, ...org, date: submittedAt.slice(0, 10), submittedAt,
      dealerCode, dealerName: rawText(get('经销商名称')), dealerType: text(get('经销商类型')),
      productCode: '', productName, brand: null, category: null,
      ...numbers, countAmount: null, stockAmount: null, signedVariance,
      absoluteVariance: signedVariance === null ? null : Math.abs(signedVariance),
      varianceFlag: text(get('是否存在盘点偏差')), safety: '', stocktakeCode: rawText(get('盘点编码')),
      inventoryGroupKey, inventoryConflict: 0, inventoryDateUncertain: 0,
      supplementRequested, supplementStatus, inventoryIssues: issues.join('；'),
    };
    all.push(record);
    addTo(groups, inventoryGroupKey, record);
    addTo(byTime, JSON.stringify([inventoryGroupKey, submittedAt]), sourceRef);
    if (record.stocktakeCode.trim()) addTo(byStocktake, JSON.stringify([inventoryGroupKey, record.stocktakeCode]), sourceRef);
  }
  for (const [kind, map, rowCount, groupCount] of [
    ['exact', exact, 'exactDuplicateRows', 'exactDuplicateGroups'],
    ['same-time', byTime, 'sameTimeDuplicateRows', 'sameTimeDuplicateGroups'],
    ['same-stocktake', byStocktake, 'sameStocktakeDuplicateRows', 'sameStocktakeDuplicateGroups'],
  ]) {
    for (const refs of map.values()) if (refs.length > 1) {
      diagnostics[rowCount] += refs.length;
      diagnostics[groupCount]++;
      diagnostics.duplicateGroups.push({ kind, sourceRefs: refs });
    }
  }
  const appendIssue = (record, issue) => { record.inventoryIssues = [record.inventoryIssues, issue].filter(Boolean).join('；'); };
  const records = [], latestRecords = [];
  for (const [key, observations] of groups) {
    addPreviousComparison(observations, uncertain.has(key));
    const organizations = groupOrganizations.get(key);
    if (organizations.size > 1) {
      diagnostics.organizationChangedGroups++;
      diagnostics.organizationChanges.push({ inventoryGroupKey: key, organizations: [...organizations.values()] });
    }
    const months = new Map();
    let latestTime = null;
    for (const record of observations) {
      if (organizations.size > 1) appendIssue(record, '历史组织路径变化');
      if (uncertain.has(key)) { record.inventoryDateUncertain = 1; appendIssue(record, '组内日期无效，最新状态待核实'); }
      if (!latestTime || record.submittedAt > latestTime) latestTime = record.submittedAt;
      const month = record.date.slice(0, 7), candidates = months.get(month);
      if (!candidates || record.submittedAt > candidates[0].submittedAt) months.set(month, [record]);
      else if (record.submittedAt === candidates[0].submittedAt) candidates.push(record);
    }
    const selected = new Set();
    for (const candidates of months.values()) {
      if (candidates.length > 1) for (const record of candidates) { record.inventoryConflict = 1; appendIssue(record, '同组最新时间并列'); }
      for (const record of candidates) { records.push(record); selected.add(record); }
    }
    const globalCandidates = observations.filter(record => record.submittedAt === latestTime);
    latestRecords.push(...globalCandidates);
    if (globalCandidates.length > 1) { diagnostics.latestTieGroups++; diagnostics.latestTieRows += globalCandidates.length; }
    for (const record of observations) if (!selected.has(record)) diagnostics.compressedRows.push(record.sourceRef);
  }
  const uncertaintyGroups = [...uncertain.values()].map(group => ({
    ...group,
    organizations: [...groupOrganizations.get(group.inventoryGroupKey).values()].map(({ sourceRefs, ...org }) => org),
  }));
  diagnostics.invalidDateGroupKeys = [...uncertain.keys()];
  diagnostics.validObservationRows = all.length;
  diagnostics.groupCount = groupOrganizations.size;
  diagnostics.latestRows = latestRecords.length;
  diagnostics.monthEndRows = records.length;
  diagnostics.historyCompressedRows = all.length - records.length;
  records.sort(compareRecords);
  latestRecords.sort((left, right) => left.inventoryGroupKey.localeCompare(right.inventoryGroupKey) || left.sourceRef.row - right.sourceRef.row);
  const warnings = [];
  if (diagnostics.missingIdentityRows) warnings.push(`${diagnostics.missingIdentityRows} 行缺少分组身份，未进入库存候选。`);
  if (diagnostics.invalidDates) warnings.push(`${diagnostics.invalidDates} 行提交时间无效；相关组的最新库存状态待核实。`);
  if (diagnostics.invalidNumbers) warnings.push(`${diagnostics.invalidNumbers} 个数字无法转换，保留为缺失，不回填旧值。`);
  if (diagnostics.sameTimeDuplicateRows) warnings.push(`${diagnostics.sameTimeDuplicateRows} 行属于同组同时间候选；并列候选保留，选择时阻断相关汇总。`);
  if (diagnostics.unparsedOrganizationRows) warnings.push(`${diagnostics.unparsedOrganizationRows} 行完整组织无法可靠拆解，保持独立路径。`);
  if (diagnostics.organizationChangedGroups) warnings.push(`${diagnostics.organizationChangedGroups} 个分组存在历史组织变化，按所选最新记录归属筛选。`);
  return {
    sourceFormat: 'visit-history', records, latestRecords, diagnostics, uncertaintyGroups,
    coverage: {
      start: earliest?.slice(0, 10) ?? null, end: latest?.slice(0, 10) ?? null,
      startSubmittedAt: earliest, endSubmittedAt: latest,
      semantics: 'stocktake-observation-history-not-real-time-stock',
      status: diagnostics.invalidDates ? 'partial' : earliest ? 'observed' : 'missing', productFilter: false,
    },
    warnings,
  };
}
