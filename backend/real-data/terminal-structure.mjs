// Serialized into each offline dashboard; keep every helper inside this factory.
export function buildTerminalStructure({ terminalRows = [], movementRows = [], allTerminalRows = terminalRows, month, endDate = null, groupField = 'region', terminalState = 'ready', movementState = 'ready', identityState = 'pending', sourceEnd = null } = {}) {
  const orgFields = ['marketingCompany', 'businessUnit', 'theater', 'region', 'office', 'unit'];
  const names = ['品味舍得', '舍之道·地道', '庆典舍得', '水晶舍得', '智慧舍得', '舍之道·天道', '舍之道·君道', '其他'];
  const keys = ['pinwei', 'didao', 'qingdian', 'shuijing', 'zhihui', 'tiandao', 'jundao', 'other'];
  const clean = value => String(value ?? '').trim();
  const compact = value => clean(value).replace(/[\s·・•\-—_（）()]/g, '').toUpperCase();
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const date = value => { const text = clean(value); if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null; const parsed = new Date(`${text}T00:00:00Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null; };
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month || '');
  const monthLast = validMonth ? new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10) : null;
  // A custom range ends inside its last month; terminal status is taken at that end date.
  const end = validMonth && typeof endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(endDate) && endDate.slice(0, 7) === month && endDate <= monthLast ? endDate : monthLast;
  const start = '2026-07-01';
  const parts = row => (row.orgPath || orgFields.map(key => row.org?.[key] || '')).map(clean);
  const path = row => JSON.stringify(parts(row));
  const hasOrg = row => parts(row).some(Boolean);
  const orgLabel = row => parts(row).map(value => value || '未提供').join(' / ');
  const grouping = row => row[groupField] || JSON.stringify(parts(row).slice(0, groupField === 'region' ? 4 : groupField === 'office' ? 5 : 6));
  const star = value => {
    const text = clean(value), arabic = text.match(/^([1-8])(?:星(?:级)?)?$/);
    if (arabic) return Number(arabic[1]);
    const chinese = text.match(/^([一二三四五六七八])星(?:级)?$/);
    return chinese ? '一二三四五六七八'.indexOf(chinese[1]) + 1 : null;
  };
  const classify = value => {
    const text = compact(value);
    const patterns = [/品味舍得/, /(?:舍之道)?地道/, /庆典(?:二代)?舍得|庆典/, /水晶舍得/, /智慧舍得/, /(?:舍之道)?天道/, /(?:舍之道)?君道/];
    const matches = patterns.map((pattern, index) => pattern.test(text) ? index : -1).filter(index => index >= 0);
    if (matches.length === 1) { const index = matches[0]; return { key: keys[index], matrixKey: keys[index], name: names[index], mapped: true }; }
    if (matches.length > 1) return null;
    if (/吞之乎/.test(text)) return { key: 'other:tunzhihu', matrixKey: 'other', name: '吞之乎', mapped: true };
    if (/沱牌曲酒名酒版|名酒版沱牌曲酒/.test(text)) return { key: 'other:mingjiuban', matrixKey: 'other', name: '沱牌曲酒名酒版', mapped: true };
    if (/T68/.test(text)) return { key: 'other:t68', matrixKey: 'other', name: 'T68 沱牌特级', mapped: true };
    return null;
  };
  const contractSeries = row => {
    const resolved = classify(row.series);
    if (resolved?.matrixKey !== 'other' && resolved) return resolved;
    const otherVarieties = { 'other:tunzhihu': '酱香吞之乎', 'other:mingjiuban': '沱牌曲酒中国名酒', 'other:t68': '沱牌特级2024版' };
    if (resolved && compact(row.signVariety) === otherVarieties[resolved.key]) return resolved;
    return { key: `unmapped:${compact(row.series) || compact(row.signVariety) || 'missing'}`, matrixKey: 'other',
      name: clean(row.series) || clean(row.signVariety) || '未提供品系', mapped: false };
  };
  const scanSeries = row => {
    // The broad "other" categories contain distinct varieties. These names
    // match the supplied signing varieties; a neighboring variety is not a sale
    // of the signed variety merely because its category is the same.
    const variety = compact(row.variety), product = compact(row.productName), category = compact(row.category);
    if (['舍得自在', '藏品舍得', '舍不得', '陶醉2.0', '其他舍得', '尚书坊'].includes(category)) return { key: `unsigned:${category}` };
    const main = ['品味舍得', '庆典舍得', '智慧舍得', '水晶舍得', '舍之道地道', '舍之道天道', '舍之道君道'].includes(category) ? classify(row.category) : null;
    if (main && main.matrixKey !== 'other') return main;
    if (category === '吞之乎' && (variety === '酱香吞之乎' || !variety && product.includes('酱香吞之乎'))) return { key: 'other:tunzhihu' };
    if (category === '沱牌曲酒' && (variety === '沱牌曲酒中国名酒' || !variety && product.includes('沱牌曲酒中国名酒'))) return { key: 'other:mingjiuban' };
    if (category === '沱牌高线' && (variety === '沱牌特级2024版' || !variety && product.includes('沱牌特级2024版'))) return { key: 'other:t68' };
    if (['吞之乎', '沱牌曲酒', '沱牌高线'].includes(category)) return variety ? { key: `other:unsigned:${variety}` } : null;
    if (category === '其他舍之道') {
      if (/礼盒/.test(variety || product)) return { key: 'unsigned:shezhidao-gift' };
      const specific = classify(row.variety || row.productName);
      return specific?.key === 'jundao' ? specific : null;
    }
    return null;
  };
  const decimalSum = values => {
    if (values.some(value => !finite(value))) return null;
    let digits = 0n, scale = 0;
    for (const value of values) {
      const match = String(value).match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
      if (!match) return null;
      let next = BigInt(`${match[1]}${match[2]}${match[3] || ''}`);
      let nextScale = (match[3]?.length || 0) - Number(match[4] || 0);
      if (nextScale < 0) { next *= 10n ** BigInt(-nextScale); nextScale = 0; }
      if (nextScale > scale) { digits *= 10n ** BigInt(nextScale - scale); scale = nextScale; }
      digits += next * 10n ** BigInt(scale - nextScale);
    }
    // Exponent notation also handles finite tiny values without an overflowing
    // intermediate Number(digits) or 10 ** scale. No BigInt leaves this factory.
    const value = Number(`${digits}e-${scale}`);
    return finite(value) ? { digits, scale, value } : null;
  };
  const sum = values => decimalSum(values)?.value ?? null;
  const notes = [
    '签约表仅使用 A–AJ；AJ 之后的字段不参与计算。协议数沿用已确认的来源去重结果，终端按网点编号去重。',
    '按签约日期截至所选月末累计，不额外推定审批、关闭状态或协议有效期筛选。',
    `有效终端：${start} 至所选月末，任一已签约品系的扫码净件数达到 1 件；采购与退货按来源正负号相加。`,
    '签约与有效终端均不随产品筛选；动销仅按原始终端编码及完整组织路径匹配。',
    '矩阵格子及品系行：有效 = 该终端在本品系 7 月以来动销净件数 ≥ 1 件；有效协议数除以该格或该行协议数。终端整体有效率仍按任一已签品系达标的去重终端计算。',
    '其他品系分别匹配酱香吞之乎、沱牌曲酒（中国名酒）、沱牌特级（2024版），不同原品系分别判断；舍之道礼盒不作为君道品系的扫码。',
  ];
  const available = terminalState !== 'unavailable', movementAvailable = movementState !== 'unavailable';
  const unknownDates = terminalRows.some(row => !date(row.signDate || row.date));
  const records = terminalRows.filter(row => { const when = date(row.signDate || row.date); return when && end && when <= end; });
  const missingCodes = records.some(row => !clean(row.terminalCode));
  const countPending = !end || unknownDates || missingCodes;
  if (unknownDates) notes.push('存在签约日期缺失记录，无法完整判断累计范围；展示已定位记录，汇总保持待确认。');
  if (missingCodes) notes.push('存在网点编号缺失记录，终端去重数与有效率待确认。');
  if (!movementAvailable) notes.push('未接入有效动销来源，有效终端保持待确认。');
  if (identityState !== 'confirmed') notes.push('当前上传版本的签约网点编号与动销售点编码关联尚未确认，有效终端保持待确认。');
  if (sourceEnd && end && sourceEnd < end) notes.push(`动销来源最新记录为 ${sourceEnd}，所选月份未提供的后续日期不外推。`);

  const scanMap = new Map(), incompleteOrg = new Set();
  let missingScanCodes = false;
  for (const row of movementRows) {
    const when = date(row.date);
    if (when && (when < start || !end || when > end)) continue;
    const code = clean(row.terminalCode);
    if (!code) { missingScanCodes = true; continue; }
    if (!hasOrg(row)) { incompleteOrg.add(code); continue; }
    const key = JSON.stringify([path(row), code]);
    if (!scanMap.has(key)) scanMap.set(key, []);
    scanMap.get(key).push({ ...row, resolvedSeries: scanSeries(row), validDate: Boolean(when) });
  }
  function terminalDetails(selected) {
    const byCode = new Map();
    for (const row of selected) {
      const code = clean(row.terminalCode);
      if (!code) continue;
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push(row);
    }
    return [...byCode].map(([code, agreements]) => {
      const seriesMap = new Map(), bucketMap = new Map();
      for (const row of agreements) {
        const info = contractSeries(row), rank = star(row.star);
        if (!seriesMap.has(info.key)) seriesMap.set(info.key, { ...info, stars: new Set(), unknownStar: false });
        if (rank) seriesMap.get(info.key).stars.add(rank); else seriesMap.get(info.key).unknownStar = true;
        const bucketKey = JSON.stringify([path(row), info.key]);
        if (!bucketMap.has(bucketKey)) bucketMap.set(bucketKey, { row, info });
      }
      const buckets = [...bucketMap.values()].map(({ row, info }) => {
        const candidates = scanMap.get(JSON.stringify([path(row), code])) || [];
        const related = candidates.filter(scan => !scan.resolvedSeries || scan.resolvedSeries.key === info.key);
        const pending = !movementAvailable || identityState !== 'confirmed' || !end || end < start || !info.mapped || !hasOrg(row) || missingScanCodes || incompleteOrg.has(code)
          || related.some(scan => !scan.validDate || !scan.resolvedSeries || !finite(scan.cases));
        const values = pending ? null : related.map(scan => scan.cases);
        return { key: info.key, values };
      });
      // Join scans only to a signed exact organization path, then net the same
      // terminal and series across those matched paths in the selected scope.
      const outcomes = [...seriesMap.keys()].map(key => {
        const selected = buckets.filter(bucket => bucket.key === key);
        const total = selected.some(bucket => bucket.values === null) ? null : decimalSum(selected.flatMap(bucket => bucket.values));
        return { key, cases: total?.value ?? null, effective: total ? total.digits >= 10n ** BigInt(total.scale) : null };
      });
      const effective = outcomes.some(item => item.effective === true) ? true : outcomes.some(item => item.effective === null) ? null : false;
      const series = [...seriesMap.values()].map(item => {
        const outcome = outcomes.find(outcome => outcome.key === item.key);
        return { ...item, stars: [...item.stars].sort((a, b) => a - b), cases: outcome.cases, effective: outcome.effective };
      });
      const ranks = series.flatMap(item => item.stars), highest = series.some(item => item.unknownStar) ? null : ranks.length ? Math.max(...ranks) : null;
      const orgPaths = [...new Map(agreements.map(row => [path(row), parts(row)])).values()];
      return { code, name: clean(agreements[0].terminalName) || code, orgLabel: [...new Set(agreements.map(orgLabel))].join('；'),
        orgPaths, orgShortLabel: [...new Set(orgPaths.map(path => path.slice(3, 6).map(value => value || '未提供').join(' / ')))].join('；'),
        officeLabel: [...new Set(orgPaths.map(path => path[4] || '未提供'))].join('；'),
        series, highest, effective, cases: sum(outcomes.map(item => item.cases)), agreementCount: agreements.length,
        seriesCount: series.length, span: highest === null || !ranks.length ? null : highest - Math.min(...ranks),
        inconsistent: ranks.length ? new Set(ranks).size > 1 : false };
    }).sort((a, b) => b.agreementCount - a.agreementCount || a.code.localeCompare(b.code, 'zh-CN'));
  }
  const terminals = terminalDetails(records), byCode = new Map(terminals.map(item => [item.code, item]));
  const summarize = (selected, details = byCode, uncertainCounts = countPending) => {
    const codes = [...new Set(selected.map(row => clean(row.terminalCode)).filter(Boolean))];
    const pendingCount = codes.filter(code => details.get(code)?.effective == null).length;
    const knownEffectiveCount = codes.filter(code => details.get(code)?.effective === true).length;
    const terminalCount = available && !uncertainCounts ? codes.length : null;
    const effectiveCount = terminalCount !== null && !pendingCount ? knownEffectiveCount : null;
    return { agreements: available && !unknownDates && end ? selected.length : null, terminalCount,
      effectiveCount, knownEffectiveCount, pendingCount, effectiveRate: terminalCount > 0 && effectiveCount !== null ? effectiveCount / terminalCount : null };
  };
  // Every protocol inherits only its own series outcome. Retained duplicate
  // protocols count separately, while their matched scans are netted once.
  const summarizeAgreements = selected => {
    const outcomes = selected.map(row => byCode.get(clean(row.terminalCode))?.series.find(item => item.key === contractSeries(row).key)?.effective ?? null);
    const pendingAgreements = outcomes.filter(value => value === null).length;
    const knownEffectiveAgreements = outcomes.filter(value => value === true).length;
    const agreements = available && !unknownDates && end ? selected.length : null;
    const effectiveAgreements = agreements !== null && !pendingAgreements ? knownEffectiveAgreements : null;
    return { effectiveAgreements, knownEffectiveAgreements, pendingAgreements,
      effectiveAgreementRate: agreements > 0 && effectiveAgreements !== null ? effectiveAgreements / agreements : null };
  };
  const matrixSummary = selected => {
    const terminalSummary = summarize(selected), agreements = summarizeAgreements(selected);
    return { ...terminalSummary, ...agreements, effectiveCount: agreements.effectiveAgreements,
      knownEffectiveCount: agreements.knownEffectiveAgreements, pendingCount: agreements.pendingAgreements, effectiveRate: agreements.effectiveAgreementRate };
  };
  const observed = new Set(allTerminalRows.map(row => `${contractSeries(row).matrixKey}:${star(row.star)}`).filter(key => !key.endsWith(':null')));
  const rows = keys.map((key, index) => {
    const selected = records.filter(row => contractSeries(row).matrixKey === key), totals = matrixSummary(selected);
    return { key, name: names[index], ...totals,
      cells: Array.from({ length: 8 }, (_, column) => {
        const rank = column + 1, items = selected.filter(row => star(row.star) === rank);
        return { star: rank, ...matrixSummary(items), share: totals.agreements === null ? null : totals.agreements > 0 ? items.length / totals.agreements : 0, observed: observed.has(`${key}:${rank}`) };
      }) };
  }).sort((a, b) => a.key === 'other' ? 1 : b.key === 'other' ? -1 : (b.agreements || 0) - (a.agreements || 0));
  const totals = { ...summarize(records), ...summarizeAgreements(records) };
  const beforeSigningStart = Boolean(end && end < start);
  // The global source determines which months are observed. A narrowed
  // organization may legitimately have no new protocols in an observed month.
  const sourceDates = allTerminalRows.map(row => date(row.signDate || row.date)).filter(Boolean).sort();
  const signingSourceEnd = sourceDates.at(-1) || null;
  const currentMonthAgreements = available && end && !unknownDates && signingSourceEnd && month <= signingSourceEnd.slice(0, 7)
    ? terminalRows.filter(row => date(row.signDate || row.date)?.slice(0, 7) === month).length : null;
  const monthly = [];
  if (signingSourceEnd && signingSourceEnd >= start) {
    const last = signingSourceEnd.slice(0, 7);
    for (let year = 2026, index = 7; `${year}-${String(index).padStart(2, '0')}` <= last; index === 12 ? (year++, index = 1) : index++) {
      const key = `${year}-${String(index).padStart(2, '0')}`;
      const selected = terminalRows.filter(row => { const when = date(row.signDate || row.date); return when && when.slice(0, 7) <= key; });
      const countKnown = available && !unknownDates;
      const terminalCount = countKnown && selected.every(row => clean(row.terminalCode))
        ? new Set(selected.map(row => clean(row.terminalCode))).size : null;
      monthly.push({ month: key, agreements: countKnown ? selected.filter(row => date(row.signDate || row.date).slice(0, 7) === key).length : null, terminalCount });
    }
  }
  const highestPending = countPending || terminals.some(item => item.highest === null);
  const highest = Array.from({ length: 8 }, (_, index) => ({ star: index + 1,
    count: available && !highestPending ? terminals.filter(item => item.highest === index + 1).length : null,
    share: available && !highestPending && terminals.length ? terminals.filter(item => item.highest === index + 1).length / terminals.length : null }));
  const seriesUnknown = terminals.some(item => item.series.some(series => !series.mapped));
  const multi = { single: null, two: null, threePlus: null, inconsistent: null };
  if (available && !countPending && !seriesUnknown) {
    multi.single = terminals.filter(item => item.seriesCount === 1).length;
    multi.two = terminals.filter(item => item.seriesCount === 2).length;
    multi.threePlus = terminals.filter(item => item.seriesCount >= 3).length;
    multi.inconsistent = highestPending ? null : terminals.filter(item => item.inconsistent).length;
  }
  const sample = terminals.find(item => item.seriesCount >= 2 && item.inconsistent) || terminals.find(item => item.seriesCount >= 2) || terminals[0];
  const example = sample ? { terminalCode: sample.code, terminalName: sample.name, series: sample.series,
    highest: sample.highest, seriesCount: sample.seriesCount, span: sample.span } : null;
  const groupMap = new Map();
  for (const row of records) { const name = grouping(row); if (!groupMap.has(name)) groupMap.set(name, []); groupMap.get(name).push(row); }
  const organizations = [...groupMap].map(([name, selected]) => {
    const details = new Map(terminalDetails(selected).map(item => [item.code, item]));
    return { name, ...summarize(selected, details) };
  }).sort((a, b) => (b.terminalCount || 0) - (a.terminalCount || 0));
  const typeMap = new Map(), typesByCode = new Map();
  for (const row of records) {
    const name = clean(row.type) || '未提供网点类型', code = clean(row.terminalCode);
    if (!typeMap.has(name)) typeMap.set(name, []);
    typeMap.get(name).push(row);
    if (code) { if (!typesByCode.has(code)) typesByCode.set(code, new Set()); typesByCode.get(code).add(name); }
  }
  const outletTypes = [...typeMap].map(([name, selected]) => ({ name, ...summarize(selected) }))
    .sort((a, b) => (b.terminalCount || 0) - (a.terminalCount || 0) || a.name.localeCompare(b.name, 'zh-CN'));
  if ([...typesByCode.values()].some(types => types.size > 1)) {
    notes.push('同一终端存在多个来源网点类型时分别保留；各类型终端数不直接相加作为总终端数。');
  }
  const topTerminals = [...terminals].sort((a, b) => finite(a.cases) && finite(b.cases) ? b.cases - a.cases || a.code.localeCompare(b.code, 'zh-CN')
    : finite(a.cases) ? -1 : finite(b.cases) ? 1 : a.code.localeCompare(b.code, 'zh-CN'));
  if (seriesUnknown) notes.push('部分协议品系尚未得到可靠映射，保留在“其他”并标记待确认；不同原品系不合并凑足 1 件。');
  if (highestPending && records.length) notes.push('存在未提供或无法识别的星级，最高星级分布保持待确认。');
  if (totals.pendingAgreements) notes.push(`${totals.pendingAgreements} 份协议的本品系有效性尚不能完整判定，有效协议数及相关矩阵有效率保持待确认。`);
  if (beforeSigningStart) notes.push('FY27 协议自 7 月起签约');
  if (totals.pendingCount) notes.push(`${totals.pendingCount} 家终端的来源、日期、品系或件数不足以完整判定，保持待确认。`);
  const unknownStarAgreements = records.filter(row => !star(row.star)).length;
  if (unknownStarAgreements) notes.push(`${unknownStarAgreements} 份协议星级未识别，计入品系合计，但不分配到一至八星。`);
  return { rows, totals, columns: Array.from({ length: 8 }, (_, index) => ({ star: index + 1, agreements: available && !unknownDates && end ? records.filter(row => star(row.star) === index + 1).length : null })),
    highest, multi, example, terminals, organizations, outletTypes, topTerminals, monthly, currentMonthAgreements, beforeSigningStart, signingSourceEnd, unknownStarAgreements,
    state: !available ? 'unavailable' : countPending || totals.pendingCount || totals.pendingAgreements || seriesUnknown || highestPending ? 'pending' : 'available',
    notes, window: { start, end, sourceEnd }, knownAgreementCount: records.length };
}
