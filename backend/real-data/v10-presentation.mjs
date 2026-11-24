// Serialized into the offline HTML. Keep all presentation helpers inside this factory.
export function createV10Presentation(model) {
  const cache = new WeakMap();
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const orgFields = ['marketingCompany', 'businessUnit', 'theater', 'region', 'office', 'unit'];
  const parts = row => row.orgPath || orgFields.map(field => row.org?.[field] || '');
  const orgKey = (row, level) => JSON.stringify(parts(row).slice(0, level === 'region' ? 4 : level === 'office' ? 5 : 6));
  const fullIdentity = row => parts(row).length === 6 && parts(row).every(text);
  const sum = (rows, field) => {
    if (rows.some(row => !finite(row[field]))) return null;
    let value = 0, correction = 0;
    for (const row of rows) { const next = row[field] - correction, updated = value + next; correction = (updated - value) - next; value = updated; }
    return finite(value) ? value : null;
  };
  const pending = (label, unit, reason, state = 'pending', note = '') => ({ label, unit, value: null, state, reason, note });
  const copy = (item, changes = {}) => ({ ...item, reason: item?.reason || null, note: item?.note || item?.notes?.join(' ') || '', ...changes });
  const sortValues = items => items.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity) || a.name.localeCompare(b.name, 'zh-CN'));
  const emptySection = (key, name, metric) => [{ key, name, records: 0, share: null, drillable: false, ...copy(metric, { label: name }) }];
  function describe(kind, data, filters = model.defaults) {
    const f = { ...model.defaults, ...filters }, source = model.payload.modules[kind];
    const p = model.periodOf ? model.periodOf(f) : { mode: 'month', month: f.month };
    if (p.mode === 'range') f.month = p.month;
    const supplied = data || model.select(f), m = supplied.modules?.[kind] || supplied;
    let byKind = cache.get(supplied);
    const cacheKey = JSON.stringify([kind, f.month, f.period, f.start, f.end, f.region, f.office, f.unit, f.product]);
    if (byKind?.has(cacheKey)) return byKind.get(cacheKey);
    const rows = m.rows || [], scoped = m.scopedRows || rows;
    const inventoryVisit = kind === 'inventory' && m.inventoryMode === 'visit-history';
    const unknownDate = kind !== 'banquet' && scoped.some(row => !validDate(row.date));
    const unavailable = source.state === 'unavailable';
    const guard = (field, label, unit, selected = rows) => {
      if (unavailable) return pending(label, unit, '未接入有效来源', 'missing');
      if (unknownDate) return pending(label, unit, '存在缺失或无效日期，无法完整分期');
      if (inventoryVisit && field !== 'records' && m.inventoryStats?.uncertainGroups) return pending(label, unit, '组内存在无法确认的提交时间，不能判定实际最新库存', 'unavailable');
      if (inventoryVisit && field !== 'records' && selected.some(row => row.inventoryConflict)) return pending(label, unit, '最近提交时间存在并列或组内时间无法确认；保留候选，不合并库存', 'unavailable');
      if (source.metrics?.[field]?.status === 'pending') return pending(label, unit, '来源规则或口径待确认');
      if (!selected.length) return pending(label, unit, '当前范围无来源记录；不推定为业务零值', 'missing');
      return null;
    };
    const measure = (selected, field, label, unit, note = '') => {
      const blocked = guard(field, label, unit, selected);
      if (blocked) return { ...blocked, note };
      const value = field === 'records' ? selected.length : sum(selected, field);
      return value === null ? pending(label, unit, '存在缺失或不可用源值', inventoryVisit ? 'unavailable' : 'pending', note)
        : { label, unit, value, state: 'available', reason: null, note };
    };
    const distinct = (selected, field, label, unit = '家', complete = row => text(row[field])) => {
      const blocked = guard('records', label, unit, selected);
      if (blocked) return blocked;
      if (selected.some(row => !complete(row))) return pending(label, unit, '存在缺失来源编码或组织路径，不按名称推定身份');
      return { label, unit, value: new Set(selected.map(row => row[field])).size, state: 'available', reason: null, note: `按当前范围来源${field === 'city' ? '城市名称' : '标识'}去重` };
    };
    const existing = (label, fallbackUnit = '') => copy(m.extra.find(metric => metric.label === label) || pending(label, fallbackUnit, '当前来源未提供该指标'));
    const cross = (key, label, unit) => copy(m.crossMetrics?.find(metric => metric.key === key) || pending(label, unit, '当前来源未确认该跨表指标'));
    const group = (selected, keyFor, labelFor, field, unit, name, identity = () => true) => {
      const blocked = guard(field, name, unit, selected);
      if (blocked) return emptySection(`${kind}-${name}-empty`, name, blocked);
      if (selected.some(row => !identity(row))) return emptySection(`${kind}-${name}-unknown`, name,
        pending(name, unit, '存在缺失来源编码、分类或完整组织路径，无法完整分组排行'));
      const groups = new Map();
      for (const row of selected) { const key = keyFor(row); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
      const result = [...groups].map(([key, records]) => ({ key, name: labelFor(records[0]), records: records.length, drillable: true,
        ...measure(records, field, labelFor(records[0]), unit) }));
      const total = measure(selected, field, name, unit);
      const sharesReady = total.state === 'available' && total.value > 0 && result.every(item => item.state === 'available');
      for (const item of result) {
        const share = sharesReady ? item.value / total.value : null;
        item.share = finite(share) ? share : null;
        item.note = item.share !== null ? `分母为当前范围${name}合计 ${model.format(total.value, 0, 6)} ${unit}；保留源符号。` : '当前范围分母不完整、不大于零或比值不可表示，不计算占比。';
      }
      return sortValues(result);
    };
    const concentration = (items, denominatorLabel, bands = [1, 5, 10]) => {
      const total = items.length && items.every(item => item.state === 'available') ? sum(items, 'value') : null;
      return bands.map(n => {
        const label = `Top ${n}`, ratio = total !== null && total > 0 ? sum(items.slice(0, n), 'value') / total : null;
        const share = finite(ratio) && finite(ratio * 100) ? ratio : null;
        const metric = share === null ? pending(label, '%', '分组不完整或当前范围合计不大于零')
          : { label, unit: '%', value: share * 100, state: 'available', reason: null, precision: 1 };
        return { key: `${kind}-top-${n}`, name: label, n, records: items.slice(0, n).reduce((count, item) => count + item.records, 0),
          ...metric, share, note: `分母为${denominatorLabel}；按来源值降序。负值保留，比值可能超过 100%。` };
      });
    };
    const productKind = ['invoice', 'movement', 'inventory'].includes(kind) && !inventoryVisit;
    const amountField = kind === 'inventory' ? 'countAmount' : 'amount';
    const brands = productKind ? group(rows, row => row.brand, row => row.brand, amountField, '元', '品牌金额', row => text(row.brand)) : [];
    const products = inventoryVisit ? group(rows, row => row.productName, row => row.productName, 'counted', '瓶', '最近盘点瓶数', row => text(row.productName)).map(item => ({ ...item, product: null, drillable: false })) : productKind ? group(rows, row => row.product, row => `${row.brand} / ${row.category}`, amountField, '元', '品类金额', row => text(row.brand) && text(row.category))
      .map(item => {
        const category = model.categories.find(category => category.id === item.key);
        return { ...item, name: category?.name || item.name, brand: category?.brand || '', product: category ? item.key : null };
      }) : [];
    const organizations = kind === 'inventory'
      ? group(rows, row => row[m.groupField] || orgKey(row, m.groupField), row => inventoryVisit && !parts(row).slice(3).every(text) && text(row.sourceOrgPath)
        ? `${row.sourceOrgPath}（组织层级未解析）` : model.label(row[m.groupField] || orgKey(row, m.groupField)),
      inventoryVisit ? 'counted' : 'countAmount', inventoryVisit ? '瓶' : '元', inventoryVisit ? '最近盘点瓶数' : '盘点金额', inventoryVisit ? row => fullIdentity(row) || text(row.sourceOrgPath) : fullIdentity)
      : (m.groups || []).map(item => ({ ...copy(item), key: item.name, name: model.label(item.name), share: null, drillable: true }));
    if (inventoryVisit) for (const item of organizations) {
      if (rows.some(row => (row[m.groupField] || orgKey(row, m.groupField)) === item.key && !parts(row).slice(3).every(text))) {
        item.note = `${item.note || ''} 原完整营销组织单独成组，层级未解析，不按同名组织合并。`;
      }
    }
    if (!organizations.length) organizations.push(...emptySection(`${kind}-organizations-empty`, '组织来源汇总', guard('records', '组织来源汇总', m.main.unit) || pending('组织来源汇总', m.main.unit, '当前范围无来源记录', 'missing')));
    let dayChanges = [], ranking = { title: '来源排行', items: [], concentration: [] }, channels = [], cities = [], health = [], deviations = [], efficiency = [], invalidMetrics = [], inventoryReviewSummary = '';
    let kpis = [copy(m.main), ...(m.extra || []).map(item => copy(item))];
    const targetKpi = (item, label) => item ? copy(item, { label, displayPrecision: item.unit === '%' ? 1 : item.unit === '瓶' ? 0 : undefined, note: item.note || (item.target?.note ?? '') })
      : pending(label, '%', '未上传经营目标', 'missing');
    const dayKpi = change => {
      if (!change) return pending('较昨日开瓶', '%', '当前数据未提供日度比较');
      const day = date => date ? date.slice(5) : '—', bottles = value => finite(value) ? `${model.format(value)} 瓶` : '无记录';
      const diff = finite(change.difference) ? `，变化 ${change.difference > 0 ? '+' : ''}${model.format(change.difference)} 瓶` : '';
      return { label: '较昨日开瓶', unit: '%', value: change.value, state: change.state, reason: change.reason, displayPrecision: 1,
        date: change.date, previousDate: change.previousDate, current: change.current, previous: change.previous, difference: change.difference,
        note: `${day(change.date)} ${bottles(change.current)}；${day(change.previousDate)} ${bottles(change.previous)}${diff}` };
    };
    const notes = [...(m.pending || []), '金额保留为来源元值；界面换算显示不改变计算。缺少记录不补业务零值。'];
    const trend = { monthly: [], daily: [], cumulative: [], note: '' };
    if (kind !== 'banquet' && kind !== 'terminal') {
      const field = kind === 'opening' ? 'bottles' : kind === 'inventory' ? 'records' : 'amount', unit = kind === 'opening' ? '瓶' : kind === 'inventory' ? '条' : '元';
      trend.monthly = (m.monthly || []).map(item => {
        const selected = (inventoryVisit ? rows : scoped).filter(row => row.month === item.month);
        const metric = kind === 'inventory' ? measure(selected, field, item.month, unit) : copy(item);
        const negative = metric.state === 'available' && field === 'amount' ? sum(selected.filter(row => row.amount < 0), 'amount') : null;
        return { ...metric, key: item.month, month: item.month, label: item.month, negative, comparison: null,
          ...(kind === 'opening' ? { cashAmount: measure(selected, 'amount', '现金红包金额', '元', `${item.month}；与本柱开瓶瓶数使用相同组织和月份范围。`) } : {}) };
      });
      const dates = [], coverage = model.payload.coverage[kind];
      if (/^\d{4}-\d{2}$/.test(f.month) && validDate(coverage?.start) && validDate(coverage?.end)) {
        const monthEnd = p.mode === 'range' ? p.end : new Date(Date.UTC(Number(f.month.slice(0, 4)), Number(f.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
        const start = [coverage.start, p.mode === 'range' ? p.start : `${f.month}-01`].sort().at(-1), end = [coverage.end, monthEnd].sort()[0];
        for (let day = start; day <= end; day = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) dates.push(day);
      }
      trend.daily = dates.map(date => {
        const selected = rows.filter(row => row.date === date), metric = measure(selected, field, date, unit);
        return { ...metric, key: date, date, label: date, negative: metric.state === 'available' && field === 'amount' ? sum(selected.filter(row => row.amount < 0), 'amount') : null, comparison: null };
      });
      let accumulated = 0, negativeTotal = 0, known = true;
      trend.cumulative = trend.daily.map(item => {
        known = known && item.state === 'available';
        if (known) { accumulated += item.value; negativeTotal += item.negative || 0; known = finite(accumulated) && finite(negativeTotal); }
        return { ...item, value: known ? accumulated : null, negative: known && field === 'amount' ? negativeTotal : null,
          state: known ? 'available' : item.state === 'missing' ? 'missing' : 'pending', reason: known ? null : '此前或当日缺少来源记录或值，无法完整累计', note: '按所选月与来源覆盖期间的交集累计；遇到缺日或缺值保持未知，不补零。' };
      });
      if (!trend.daily.length) {
        const metric = guard(field, f.month, unit) || pending(f.month, unit, p.mode === 'range' ? '所选区间无可定位日期的来源记录' : '所选月无可定位日期的来源记录', 'missing');
        trend.daily = [{ ...metric, key: `${f.month}-empty`, date: null, label: f.month, comparison: null }];
        trend.cumulative = trend.daily.map(item => ({ ...item }));
      }
      trend.note = inventoryVisit ? '仅统计截至所选月最近一次盘点的提交日期分布；同一经销商产品只计最新候选，不表示各月库存趋势或全部历史提交次数。' : kind === 'inventory' ? '仅统计当前上传导出记录的提交日期分布；不重建各月历史库存或自动重新去重。' : '月度按已上传来源月份展示；日轴为所选月与来源覆盖期间的交集，缺日断开、不补零，累计遇到缺日或缺值保持未知，不推断季末集中或环比。';
      if (inventoryVisit) trend.inventoryMode = 'visit-history';
    } else trend.note = kind === 'banquet' ? '来源固定期间汇总，没有逐日日期，不构造月度或日度趋势。' : '签约结构遵循独立矩阵合同。';
    if (kind === 'invoice') {
      ranking.title = '经销商 · 当月发票净额';
      ranking.items = group(rows, row => row.dealerCode, row => `${row.dealerCode} · ${row.dealerName || '未提供名称'}`, 'amount', '元', '发票净额', row => text(row.dealerCode));
      ranking.concentration = concentration(ranking.items, '当前范围发票净额合计');
      kpis = [copy(m.main), existing('正金额合计', '元'), existing('负金额合计', '元'), existing('当年截至所选月来源金额', '元'),
        distinct(rows, 'dealerCode', '来源经销商数'), targetKpi(m.targets?.attainment, '目标达成率')];
      if (m.targets?.available) kpis.push(targetKpi(m.targets.ytdAttainment, '年累计目标达成率'), targetKpi(m.targets.month, p.mode === 'range' ? '区间目标' : '当月目标'), targetKpi(m.targets.ytd, '年累计目标'));
    }
    if (kind === 'movement') {
      ranking.title = '扫码终端 · 当月扫码净额';
      ranking.items = group(rows, row => row.terminalCode, row => `${row.terminalCode} · ${row.terminalName || '未提供名称'}`, 'amount', '元', '扫码净额', row => text(row.terminalCode));
      ranking.concentration = concentration(ranking.items, '当前范围扫码净额合计', [10, 50, 100]);
      channels = group(rows, row => row.channel, row => row.channel, 'amount', '元', '来源渠道净额', row => text(row.channel));
      kpis = [copy(m.main), existing('扫码数量（瓶单位记录）', '瓶'), existing('负金额合计', '元'), existing('当年截至所选月来源金额', '元'),
        distinct(rows, 'terminalCode', '来源扫码终端数'), cross('invoiceMovementYtdRatio', '年累计动销 / 开票', '%')];
      if (m.targets?.available) kpis.push(targetKpi(m.targets.attainment, '目标达成率'), targetKpi(m.targets.ytdAttainment, '年累计目标达成率'), targetKpi(m.targets.month, p.mode === 'range' ? '区间目标' : '当月目标'));
      notes.push(...['扫码数量（盒单位记录）', '来源扫码件数'].map(label => { const metric = existing(label); return `${label}：${model.formatMetric(metric)}${metric.state === 'available' ? ` ${metric.unit}` : ''}。`; }));
      notes.push('负金额合计只按源金额符号汇总，不将所有负金额推定为退货出库。');
      const rule = model.payload.decisionContract?.crossTableMetrics, deps = ['invoice', 'movement'];
      const confirmed = model.payload.decisionContract?.version === 1 && rule?.status === 'confirmed'
        && deps.every(id => rule.sources?.[id] && rule.sources[id] === model.payload.sources[id]?.sha256);
      const completeSource = confirmed && deps.every(id => model.payload.modules[id].state !== 'unavailable'
        && model.payload.coverage[id]?.start && model.payload.coverage[id]?.end
        && model.payload.modules[id].metrics?.amount?.status !== 'pending'
        && model.payload.modules[id].records.every(row => validDate(row.date)));
      if (completeSource) {
        const invoiceRows = supplied.modules?.invoice?.scopedRows || model.payload.modules.invoice.records.filter(row => ['region', 'office', 'unit'].every(level => f[level] === 'all' || orgKey(row, level) === f[level])
          && (f.product === 'all' || JSON.stringify([row.brand || '未映射品牌', row.category || '未映射品类']) === f.product));
        for (const item of trend.monthly) {
          if (item.state !== 'available') continue;
          const start = `${item.month}-01`, endOfMonth = new Date(Date.UTC(Number(item.month.slice(0, 4)), Number(item.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
          const end = [endOfMonth, ...deps.map(id => model.payload.coverage[id].end)].sort()[0];
          if (end < start || deps.some(id => model.payload.coverage[id].start.slice(0, 7) > item.month)) continue;
          if (deps.some(id => !model.payload.modules[id].records.some(row => row.date >= start && row.date <= end))) continue;
          const monthMovement = scoped.filter(row => row.month === item.month);
          if (monthMovement.some(row => row.date > end)) continue;
          const invoices = invoiceRows.filter(row => row.date >= start && row.date <= end);
          if (!invoices.length) continue;
          const amount = sum(invoices, 'amount');
          if (amount !== null) { item.comparison = amount; item.note = `同组织、同产品、${start} 至 ${end} 的发票净额对照。`; }
        }
      }
      trend.note += '发票对照仅在来源关系已确认且组织、产品、实际期间一致时显示；空白对照不补零。';
    }
    if (kind === 'opening') {
      cities = group(rows, row => row.city, row => row.city, 'bottles', '瓶', '城市开瓶瓶数', row => text(row.city));
      ranking = { title: '开瓶城市 · 消费地', items: cities, concentration: concentration(cities, '当前范围开瓶瓶数合计') };
      const yearRows = scoped.filter(row => validDate(row.date) && row.date.slice(0, 4) === f.month.slice(0, 4) && (p.mode === 'range' ? row.date <= p.end : row.date.slice(0, 7) <= f.month));
      kpis = [copy(m.main), existing('现金红包金额', '元'), distinct(rows, 'city', '来源开瓶城市', '个'),
        measure(yearRows, 'bottles', '当年截至所选月来源开瓶', '瓶', '只累计当前上传中已有的当年记录，不推断未提供月份。'),
        cross('openingMovementRatio', '年累计开瓶 / 动销（瓶）', '%'), dayKpi(m.dayChange)];
      if (m.targets?.available) kpis.push(targetKpi(m.targets.attainment, '目标达成率'), targetKpi(m.targets.ytdAttainment, '年累计目标达成率'), targetKpi(m.targets.month, p.mode === 'range' ? '区间目标' : '当月目标'));
      dayChanges = (m.dayChange?.groups || []).map(item => ({ ...dayKpi(item), key: item.key, name: model.label(item.key) }));
      notes.push('较昨日开瓶：所选期间末日与其前一天的开瓶瓶数比较；任一天无来源记录时不计算，不补零。宴席开瓶与消费者开瓶的包含关系不保证，不计算宴席开瓶占比。');
      const yearAmount = measure(yearRows, 'amount', '当年来源现金红包金额', '元');
      notes.push(`${yearAmount.label}：${model.formatMetric(yearAmount)}${yearAmount.state === 'available' ? ' 元' : ''}。`, '城市只按来源城市字段分组，不推定城市编码或消费者身份。');
    }
    if (kind === 'inventory') {
      ranking.title = inventoryVisit ? '经销商 · 最近盘点瓶数' : '经销商 · 当前导出盘点金额';
      ranking.items = group(rows, row => row.dealerCode, row => `${row.dealerCode} · ${row.dealerName || '未提供名称'}`, inventoryVisit ? 'counted' : 'countAmount', inventoryVisit ? '瓶' : '元', inventoryVisit ? '最近盘点瓶数' : '盘点金额', row => text(row.dealerCode));
      ranking.concentration = concentration(ranking.items, inventoryVisit ? '当前范围最近盘点瓶数合计' : '当前导出所选记录盘点金额合计');
      health = ['安全库存正常', '低于安全库存', '高于安全库存', '库存健康判定'].map((name, index) => ({ key: `inventory-health-${index}`, name, records: rows.length, share: null,
        ...pending(name, '条', '安全库存分类与健康判定规则未确认；保留源状态但不自行分类') }));
      const differenceReady = !guard('signedVariance', '存在盘点差异记录', '条') && rows.every(row => finite(row.signedVariance));
      const difference = differenceReady ? { label: '存在盘点差异记录', unit: '条', value: rows.filter(row => row.signedVariance !== 0).length, state: 'available', reason: null, note: '按逐条盘点减系统差异不等于零计数，不等同于源偏差字段。' }
        : guard('signedVariance', '存在盘点差异记录', '条') || pending('存在盘点差异记录', '条', '部分盘点或系统源值缺失', inventoryVisit ? 'unavailable' : 'pending');
      kpis = [
        copy(existing('所选记录盘点金额合计', '元'), { key: 'inventoryCountAmount', label: '盘点金额' }),
        { key: 'inventoryAmountDifference', ...pending('金额差额', '元', unavailable ? '未接入有效库存来源' : '两类库存金额的计价与估值基础尚未确认，暂不计算金额差额', unavailable ? 'missing' : 'pending') },
        copy(cross('inventorySellableMonths', '可销月数（来源估算）', '月'), { label: '可销月份', displayPrecision: 1 }),
        copy(existing('所选记录系统金额合计', '元'), { key: 'inventorySystemAmount', label: '系统金额', note: '来源系统库存金额。' }),
        copy(difference, { key: 'inventoryDifferenceRecords', label: '差异记录', note: '盘点数量与系统数量不一致的记录。' }),
        pending('低于安全库存', '条', '安全库存分类规则未确认'),
      ];
      if (inventoryVisit) {
        kpis = [
          copy(measure(rows, 'counted', '最近盘点瓶数', '瓶'), { key: 'inventoryCounted' }),
          copy(measure(rows, 'system', '提交时系统瓶数', '瓶'), { key: 'inventorySystem' }),
          copy(measure(rows, 'signedVariance', '盘点与系统差异', '瓶'), { key: 'inventoryQuantityDifference' }),
          copy(distinct(rows, 'dealerCode', '盘点经销商数'), { key: 'inventoryDealerCount' }),
          copy(difference, { key: 'inventoryDifferenceRecords', label: '差异记录' }),
          copy(measure(rows, 'systemAmount', '提交时系统金额', '元'), { key: 'inventorySystemAmount', note: '各条最近盘点提交当时的系统金额，不是当天实时库存金额。' }),
        ];
        invalidMetrics = [
          pending('盘点库存金额', '元', '新表没有盘点库存金额，不能用系统金额或假定单价替代', 'unavailable'),
          pending('金额差额', '元', '缺盘点库存金额；两类金额估值关系也未确认', 'unavailable'),
          pending('可销月份', '月', '缺盘点库存金额和产品编码关联，无法计算库存金额与扫码金额比', 'unavailable'),
          pending('品牌／品类筛选与金额构成', '', '新表没有产品编码、品牌和品类；库存不随统一品牌／品类筛选', 'unavailable'),
          pending('跨板块组织联动', '', '新旧来源完整组织路径存在事业部层级差异，尚未确认映射；按源完整路径独立筛选，不按同名组织合并', 'unavailable'),
          pending('安全库存与健康分类', '', '源“差异”不是安全库存阈值，不能据此判定低于安全库存', 'unavailable'),
          pending('库存覆盖率、周转与每日实时库存', '', '缺完整覆盖分母、库存流转和每日同一时点数据', 'unavailable'),
        ];
        health = invalidMetrics.slice(0, 3).map((item, index) => ({ key: `inventory-unavailable-${index}`, name: item.label, records: rows.length, share: null, ...item }));
        notes.push('最近盘点按经销商编码＋完整产品名称选择，保留最大提交时间的并列候选；不把不同盘点时间直接累加。',
          '统一品牌／品类筛选不作用于本格式库存。产品构成按完整产品名称展示，不合并度数、规格或代际。',
          '各条最近盘点可能相隔多年，显示的集合不是同一天实时库存；没有新盘点不代表库存归零。',
          '源偏差单独保留；盘点与系统差异＝盘点瓶数−提交时系统瓶数，绝对差另算，不把源负偏差直接判为错误。',
          '较上次变化瓶数＝本次盘点瓶数−上次盘点瓶数；只有两次盘点唯一、日期明确且数量有效时才计算，不代表销量或同期经营增减。',
          ...invalidMetrics.map(item => `${item.label}不可用：${item.reason}。`));
        const stats = m.inventoryStats || {};
        notes.push(`距所选截止日天数的基准日：${validDate(stats.cutoffDate) ? stats.cutoffDate : '未提供'}；取所选月末与来源最大已知提交日期的较早者，按日历日期计算，不使用电脑今天日期。`);
        inventoryReviewSummary = [finite(stats.groupCount) ? `所选最近盘点 ${model.format(stats.groupCount)} 组` : '',
          finite(stats.oldRecordCount) ? `${model.format(stats.oldRecordCount)} 条盘点早于所选年` : '',
          finite(stats.missingDealerCodes) ? `全表 ${model.format(stats.missingDealerCodes)} 条缺经销商编码未纳入` : ''].filter(Boolean).join('；');
        if (inventoryReviewSummary) { inventoryReviewSummary += '。'; notes.push(inventoryReviewSummary); }
        if (finite(stats.sourceRows)) notes.push(`本次来源 ${model.format(stats.sourceRows)} 条记录；压缩后保留每组每月最近候选用于月份选择，完整历史与异常保留在本机。`);
        if (stats.latestMinDate && stats.latestMaxDate) notes.push(`当前范围最近盘点日期：${stats.latestMinDate} 至 ${stats.latestMaxDate}。`);
        if (stats.missingDealerCodes || stats.invalidDates || stats.invalidNumbers) notes.push(`本机核查：缺经销商编码 ${model.format(stats.missingDealerCodes || 0)} 条，日期异常 ${model.format(stats.invalidDates || 0)} 条，数字异常 ${model.format(stats.invalidNumbers || 0)} 个；未用零值补齐。`);
      }
      const deviationRows = rows.filter(row => !finite(row.signedVariance) || row.signedVariance !== 0);
      deviations = deviationRows.map((row, index) => ({ key: `inventory-deviation-${index}`, name: `${row.dealerCode || '未提供经销商编码'} · ${inventoryVisit ? row.productName || '未提供完整产品名称' : row.productCode || '未提供产品编码'}`, records: 1,
        ...measure([row], 'signedVariance', inventoryVisit ? '盘点与系统差异' : '盘点减系统差异', '瓶'), counted: row.counted, system: row.system, sourceVariance: row.sourceVariance, absoluteVariance: row.absoluteVariance,
        note: `盘点 ${model.format(row.counted, 0, 6)} 瓶；系统 ${model.format(row.system, 0, 6)} 瓶；源偏差 ${model.format(row.sourceVariance, 0, 6)} 瓶；绝对差 ${model.format(row.absoluteVariance, 0, 6)} 瓶。` }))
        .sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));
      if (!deviations.length) deviations = emptySection('inventory-deviations-empty', '盘点差异', differenceReady ? { label: '盘点差异', unit: '瓶', value: 0, state: 'available', reason: null, note: '当前所选来源记录的逐条盘点减系统差异均为 0。' } : difference);
      if (!inventoryVisit) notes.push('盘点经销商按来源编码识别，记录条数不等于去重 SKU 数；当前导出不重复选择所谓“最新快照”。');
    }
    if (kind === 'banquet') {
      ranking.title = '执行单元 · 来源固定期间';
      ranking.items = group(rows, row => row.unit || orgKey(row, 'unit'), row => model.label(row.unit || orgKey(row, 'unit')), 'events', '场', '执行场次', fullIdentity);
      ranking.concentration = concentration(ranking.items, '当前组织范围、来源固定期间执行场次合计');
      const byUnit = new Map();
      for (const row of rows) { const key = row.unit || orgKey(row, 'unit'); if (!byUnit.has(key)) byUnit.set(key, []); byUnit.get(key).push(row); }
      efficiency = ranking.items.map(item => {
        const selected = byUnit.get(item.key) || [], events = measure(selected, 'events', '执行场次', '场'), bottles = measure(selected, 'bottles', '宴席开瓶', '瓶');
        const ready = item.state === 'available' && events.state === 'available' && bottles.state === 'available' && events.value > 0 && finite(bottles.value / events.value);
        return { key: item.key, name: item.name, records: item.records, events: events.value, bottles: bottles.value,
          ...(ready ? { label: '场均开瓶', unit: '瓶/场', value: bottles.value / events.value, state: 'available', reason: null } : pending('场均开瓶', '瓶/场', item.reason || '来源场次、瓶数不完整或场次不大于零')),
          note: '同一完整单元路径、同一来源固定期间：开瓶瓶数 / 执行场次；不设未经确认的最低场次门槛。' };
      });
      sortValues(efficiency);
      const active = guard('events', '有执行的单元', '个') || (ranking.items.some(item => item.state !== 'available') ? pending('有执行的单元', '个', '完整单元路径或来源场次不足')
        : { label: '有执行的单元', unit: '个', value: ranking.items.filter(item => item.value > 0).length, state: 'available', reason: null, note: '完整单元路径汇总场次大于 0。' });
      kpis = [copy(m.main), existing('固定期间宴席开瓶', '瓶'), existing('场均开瓶', '瓶/场'), existing('售点推荐奖励', '元'), active,
        copy(ranking.concentration.find(item => item.n === 5), { label: 'Top 5 单元场次占比' })];
      notes.push('场均与执行排行仅按现有完整单元路径和固定期间汇总；奖励不求和，不计算宴席占消费者开瓶比例。');
    }
    const primaryNotes = p.mode === 'range' ? { invoice: `按业务日期净计 ${p.label} 源金额。`, movement: `按扫码日期净计 ${p.label} 源金额。`, opening: `按抽奖日期统计 ${p.label} 来源开瓶瓶数。`,
      inventory: inventoryVisit ? `截至 ${p.end}，每个经销商与完整产品名称的最近一次已知盘点；不是当天实时库存。` : `当前上传导出中截至 ${p.end} 的盘点记录。`, banquet: '按来源确认的固定期间汇总。', terminal: `按签约日期截至 ${p.end}；遵循最新矩阵规则。` } : { invoice: '按业务日期净计当月源金额。', movement: '按扫码日期净计当月源金额。', opening: '按抽奖日期统计当月来源开瓶瓶数。',
      inventory: inventoryVisit ? '截至所选月，每个经销商与完整产品名称的最近一次已知盘点；不是当天实时库存。' : '当前上传导出中截至所选月的盘点记录。', banquet: '按来源确认的固定期间汇总。', terminal: '按签约日期截至所选月末；遵循最新矩阵规则。' };
    for (let index = 0; index < kpis.length; index++) {
      const item = kpis[index];
      if (index === 0) item.note = primaryNotes[kind] || item.note;
      if (item.label === '正金额合计') item.note = '正数源金额合计。';
      if (item.label === '负金额合计') item.note = '已计入净额，不重新改变符号。';
      if (item.label.startsWith('当年截至所选月')) item.note = '当前上传中当年截至所选月的来源记录；缺月不补零。';
      if (['来源经销商数', '来源扫码终端数'].includes(item.label)) item.note = '按当前范围来源编码去重；缺编码保持待确认。';
      if (item.key === 'inventorySellableMonths') item.note = '库存金额 ÷ 近三月月均扫码金额；未折算全月。';
      if (item.key === 'openingMovementRatio') item.note = '同组织、同期间的开瓶瓶数 ÷ 动销瓶数。';
      if (item.key === 'invoiceMovementYtdRatio') item.note = '同组织、同产品、同期间的累计扫码净额 ÷ 发票净额。';
      if (item.label === '场均开瓶') item.note = '固定期间宴席开瓶瓶数 ÷ 执行场次。';
      if (item.label === 'Top 5 单元场次占比') item.note = '按完整单元路径汇总执行场次占比。';
    }
    if (p.mode === 'range') for (const item of kpis) if (item.label?.startsWith('当年截至所选月')) {
      item.label = item.label.replace('所选月', '区间末日'); item.note = `当年 1 月 1 日至 ${p.end} 的来源记录；缺月不补零。`;
    }
    const sourceRows = rows.map((row, index) => {
      const displayed = { ...row, key: `${kind}-row-${index}`, organization: parts(row).map(value => value || '未提供').join(' / ') };
      if (inventoryVisit) {
        displayed.organization = row.sourceOrgPath || displayed.organization;
        displayed.recordStatus = row.inventoryConflict ? '最近记录冲突，待核实' : row.inventoryIssues || '最近一次已知盘点';
        displayed.comparisonStatusLabel = ({ comparable: '可比较', 'no-previous': '无上次盘点', 'invalid-date': '日期无效，待核实',
          'current-conflict': '本次时间并列，待核实', 'previous-conflict': '上次时间并列，待核实',
          'missing-counted': '盘点瓶数缺失或无效', 'invalid-change': '变化无法计算' })[row.inventoryComparisonStatus] || '未提供';
      }
      if (kind === 'banquet') {
        const label = '场均开瓶', unit = '瓶/场', coverage = model.payload.coverage.banquet;
        const events = measure([row], 'events', '执行场次', '场'), bottles = measure([row], 'bottles', '宴席开瓶', '瓶');
        if (events.state !== 'available' || bottles.state !== 'available') {
          displayed.average = pending(label, unit, events.reason || bottles.reason || '来源场次或瓶数规则未确认');
        } else if (!validDate(coverage?.start) || !validDate(coverage?.end) || coverage.start > coverage.end || coverage.status === 'pending') {
          displayed.average = pending(label, unit, '来源固定期间未确认，不计算派生场均');
        } else if (events.value <= 0 || !finite(bottles.value / events.value)) {
          displayed.average = pending(label, unit, '来源场次不大于零或比值不可表示');
        } else {
          displayed.average = { label, unit, value: bottles.value / events.value, state: 'available', reason: null,
            note: `${coverage.start} 至 ${coverage.end}；本条来源开瓶瓶数 / 执行场次。` };
        }
      }
      return displayed;
    });
    const result = { kpis, dayChanges, trend, organizations, brands, products, ranking, channels, cities, health, deviations, efficiency, ...(inventoryVisit ? { invalidMetrics, inventoryMode: 'visit-history', inventoryReviewSummary } : {}),
      rows: sourceRows, notes: [...new Set(notes)] };
    if (!byKind) { byKind = new Map(); cache.set(supplied, byKind); }
    byKind.set(cacheKey, result);
    return result;
  }
  return { describe };
}
