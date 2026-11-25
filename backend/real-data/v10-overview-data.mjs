// Serialized into each offline dashboard. Keep this factory self-contained.
export function createV10OverviewData(model, presentation) {
  const cache = new WeakMap(), regionalCache = new Map();
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const text = value => typeof value === 'string' && value.trim().length > 0;
  // Pure per string; memoized because comparisons re-check every row's date.
  const validDates = new Map();
  const validDate = value => {
    if (typeof value !== 'string') return false;
    let result = validDates.get(value);
    if (result === undefined) {
      result = /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
      validDates.set(value, result);
    }
    return result;
  };
  const keyFor = filters => JSON.stringify([filters.month, filters.period, filters.start, filters.end, filters.region, filters.office, filters.unit, filters.product]);
  const periodOf = filters => model.periodOf ? model.periodOf(filters) : { mode: 'month', start: `${filters.month}-01`, end: null, month: filters.month };
  const pending = (label, unit, reason, state = 'pending') => ({ label, unit, value: null, state, reason });
  const copy = item => ({ ...item, ...(item?.notes ? { notes: [...item.notes] } : {}), ...(item?.range ? { range: { ...item.range } } : {}) });
  const ready = item => item?.state === 'available' && finite(item.value);
  const partsFor = key => { try { const result = JSON.parse(key); return Array.isArray(result) ? result : []; } catch { return []; } };
  const fullName = key => partsFor(key).map(value => text(value) ? value : '未提供').join(' / ') || '未提供组织';
  const defaultFilters = filters => { const f = { ...model.defaults, ...filters }, p = periodOf(f); return p.mode === 'range' ? { ...f, month: p.month } : f; };
  const childFilters = (filters, level, key) => ({ ...filters, [level]: key,
    ...(level === 'region' ? { office: 'all', unit: 'all' } : level === 'office' ? { unit: 'all' } : {}) });
  const monthEnd = month => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const priorDate = (date, fullMonthEnd = false) => {
    const month = `${Number(date.slice(0, 4)) - 1}${date.slice(4, 7)}`, last = monthEnd(month);
    return fullMonthEnd ? last : `${month}-${String(Math.min(Number(date.slice(8)), Number(last.slice(8)))).padStart(2, '0')}`;
  };
  const sum = values => {
    let value = 0, correction = 0;
    for (const item of values) { const next = item - correction, updated = value + next; correction = (updated - value) - next; value = updated; }
    return value;
  };
  function windowMetric(id, module, start, end, requireMonths = false) {
    const field = id === 'opening' ? 'bottles' : 'amount', unit = id === 'opening' ? '瓶' : '元';
    const fail = (reason, state = 'missing') => ({ ...pending('同期来源合计', unit, reason, state), range: { start, end } });
    const source = model.payload.modules[id], cover = model.payload.coverage[id];
    if (source.state === 'unavailable') return fail('未接入有效来源');
    if (!validDate(start) || !validDate(end) || start > end) return fail('比较期间无效');
    if (!validDate(cover?.start) || !validDate(cover?.end) || cover.start > start || cover.end < end) return fail('来源未覆盖完整比较期间');
    if (source.metrics?.[field]?.status === 'pending') return fail('来源数值口径待确认', 'pending');
    const scoped = module.scopedRows || [];
    if (scoped.some(row => !validDate(row.date))) return fail('存在缺失或无效日期，无法完整分期', 'pending');
    const rows = scoped.filter(row => row.date >= start && row.date <= end);
    if (!rows.length) return fail('当前范围缺少同期记录，不推定为零');
    if (requireMonths) {
      const months = new Set(rows.map(row => row.date.slice(0, 7)));
      for (let date = `${start.slice(0, 7)}-01`; date <= end; date = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 1)).toISOString().slice(0, 10)) {
        if (!months.has(date.slice(0, 7))) return fail('累计比较期间缺月，不能补零');
      }
    }
    if (rows.some(row => !finite(row[field]))) return fail('比较期间存在缺失或不可用数值', 'pending');
    const value = sum(rows.map(row => row[field]));
    if (!finite(value)) return fail('来源合计超出可表示范围', 'pending');
    return { label: '同期来源合计', unit, value, state: 'available', reason: null, range: { start, end },
      negative: id === 'opening' ? null : sum(rows.filter(row => row.amount < 0).map(row => row.amount)) };
  }
  function yearComparison(id, module, filters, cumulative = false, fixedRange = null) {
    const p = periodOf(filters), range = p.mode === 'range';
    const label = cumulative ? '累计同比' : range ? '区间同比' : '当月同比', cover = model.payload.coverage[id];
    const month = range ? p.month : filters.month, validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month || '');
    const start = fixedRange?.start || (validMonth ? cumulative ? `${month.slice(0, 4)}-01-01` : range ? p.start : `${month}-01` : null);
    const end = fixedRange?.end || (validMonth && validDate(cover?.end) ? [range ? p.end : monthEnd(month), cover.end].sort()[0] : null);
    const current = windowMetric(id, module, start, end, cumulative);
    const previous = windowMetric(id, module, validDate(start) ? priorDate(start) : null,
      validDate(end) ? priorDate(end, end === monthEnd(end.slice(0, 7))) : null, cumulative);
    let reason = !ready(current) ? `本期：${current.reason}` : !ready(previous) ? `去年同期：${previous.reason}` : previous.value <= 0 ? '去年同期为零或负数，不计算增长率' : null;
    const value = reason ? null : (current.value - previous.value) / previous.value * 100;
    if (!reason && !finite(value)) reason = '同比超出可表示范围';
    return { label, unit: '%', value: reason ? null : value, state: reason ? 'pending' : 'available', reason,
      current, previous, range: { start, end }, notes: validDate(start) && validDate(end) ? [`${start} 至 ${end}；对比 ${previous.range.start} 至 ${previous.range.end}`] : [] };
  }
  function yearMonths(id, module, filters) {
    const year = Number(filters.month.slice(0, 4)), selected = Number(filters.month.slice(5));
    if (!Number.isInteger(year) || !selected) return [];
    return Array.from({ length: 12 }, (_, index) => {
      const month = `${year}-${String(index + 1).padStart(2, '0')}`;
      const compare = yearComparison(id, module, { ...filters, period: 'month', month });
      const previousMonth = `${year - 1}-${String(index + 1).padStart(2, '0')}`;
      // A partial current month compares the same days in the background bar.
      // Future slots may still show the prior year's complete month.
      const previous = index + 1 <= selected && validDate(compare.current.range?.end) && compare.current.range.end >= `${month}-01`
        ? compare.previous : windowMetric(id, module, `${previousMonth}-01`, monthEnd(previousMonth));
      return { month, current: index + 1 <= selected ? compare.current : pending('净额', '元', '所选月之后尚不展示', 'missing'), previous };
    });
  }
  function previousOpeningDays(module, comparison, currentPoints) {
    const cover = model.payload.coverage.opening, previous = comparison.previous;
    if (!validDate(previous.range.start) || !validDate(previous.range.end) || !validDate(cover?.start) || !validDate(cover?.end)
      || cover.start > previous.range.start || cover.end < previous.range.end) return [];
    const scoped = module.scopedRows || [], byDay = new Map();
    const blocked = scoped.some(row => !validDate(row.date)) || model.payload.modules.opening.metrics?.bottles?.status === 'pending';
    for (const row of scoped) if (row.date >= previous.range.start && row.date <= previous.range.end) {
      if (!byDay.has(row.date)) byDay.set(row.date, []); byDay.get(row.date).push(row.bottles);
    }
    return currentPoints.map(point => {
      const date = priorDate(point.date), values = byDay.get(date) || [];
      const value = !blocked && date.slice(5) === point.date.slice(5) && values.length && values.every(finite) ? sum(values) : null;
      return { date, value: finite(value) ? value : null, state: finite(value) ? 'available' : 'missing', reason: finite(value) ? null : '去年当日缺少有效记录，保留断点' };
    });
  }
  function openingTotal(filters, module, ratio) {
    const label = '总开瓶数（年累计共同期间）', unit = '瓶';
    if (ready(ratio) && finite(ratio.numerator)) return { label, unit, value: ratio.numerator, state: 'available', reason: null, range: { ...ratio.range }, notes: [...ratio.notes] };
    // Keep a known numerator visible when only the denominator is unusable.
    // The window and source binding remain the confirmed cross-source contract.
    const rule = model.payload.decisionContract?.crossTableMetrics, ids = ['opening', 'movement'];
    if (model.payload.decisionContract?.version !== 1 || rule?.status !== 'confirmed' || ids.some(id => !rule.sources?.[id] || rule.sources[id] !== model.payload.sources[id]?.sha256))
      return pending(label, unit, '这两个来源版本的共同期间关系尚未确认');
    if (ids.some(id => model.payload.modules[id].state === 'unavailable')) return pending(label, unit, '缺少来源，无法确认共同截止日', 'missing');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(filters.month || '')) return pending(label, unit, '所选月份无效，无法定位累计期间');
    const covers = ids.map(id => model.payload.coverage?.[id]);
    if (covers.some(cover => !validDate(cover?.start) || !validDate(cover?.end) || cover.start > cover.end)) return pending(label, unit, '来源期间缺失或无效，无法确认共同截止日');
    const p = periodOf(filters), start = `${filters.month.slice(0, 4)}-01-01`, monthEnd = p.mode === 'range' ? p.end : new Date(Date.UTC(Number(filters.month.slice(0, 4)), Number(filters.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const end = [monthEnd, ...covers.map(cover => cover.end)].sort()[0], range = { start, end };
    const fail = (reason, state = 'pending') => ({ ...pending(label, unit, reason, state), range });
    if (end < start) return fail('来源截止日尚未覆盖所选年度', 'unavailable');
    const source = model.payload.modules.opening;
    if (covers[0].start.slice(0, 7) > start.slice(0, 7)) return fail('开瓶来源月份未覆盖累计窗口', 'unavailable');
    if (source.records.some(row => !validDate(row.date))) return fail('开瓶来源存在日期缺失或无效，无法完整分期');
    if (source.metrics?.bottles?.status === 'pending') return fail('开瓶瓶数来源规则或口径待确认');
    for (let month = 1; month <= Number(end.slice(5, 7)); month++) {
      const key = `${start.slice(0, 4)}-${String(month).padStart(2, '0')}`;
      if (!source.records.some(row => row.date.slice(0, 7) === key && row.date <= end)) return fail('开瓶计算窗口有月份无来源记录，不能补零', 'unavailable');
    }
    const rows = (module.scopedRows || []).filter(row => row.date >= start && row.date <= end);
    if (!rows.length) return fail('当前组织在共同期间没有开瓶来源记录', 'missing');
    if (rows.some(row => !finite(row.bottles))) return fail('计算窗口存在缺失或不可用开瓶瓶数');
    let value = 0, correction = 0;
    for (const row of rows) { const next = row.bottles - correction, updated = value + next; correction = (updated - value) - next; value = updated; }
    return finite(value) ? { label, unit, value, state: 'available', reason: null, range } : fail('开瓶合计超出可表示范围');
  }
  function regionalMetrics(filters, supplied) {
    const key = keyFor(filters);
    if (regionalCache.has(key)) return regionalCache.get(key);
    const data = supplied || model.select(filters), modules = data.modules;
    const terminal = modules.terminal, totals = terminal.structure?.totals;
    const rate = totals?.effectiveRate;
    const effectiveRate = terminal.state === 'unavailable'
      ? pending('签约有效率', '%', '未接入有效签约来源', 'missing')
      : finite(rate) ? { label: '签约有效率', unit: '%', value: rate * 100, state: 'available', reason: null,
        numerator: totals.effectiveCount, denominator: totals.terminalCount }
        : pending('签约有效率', '%', totals?.terminalCount === 0 ? '当前范围无签约终端，无法计算有效率' : '来源、日期、品系、件数或身份关联不足以完整判定');
    const openingRate = copy(modules.opening.crossMetrics?.find(item => item.key === 'openingMovementRatio') || pending('总开瓶率', '%', '当前来源未确认该跨表指标'));
    const result = { invoice: copy(modules.invoice.main), movement: copy(modules.movement.main), opening: copy(modules.opening.main), effectiveRate,
      signed: copy(terminal.main), effectiveCount: copy(terminal.extra?.find(item => item.label === '有效终端数') || pending('有效终端数', '家', '有效终端尚未完整判定')),
      openingRate, openingTotal: openingTotal(filters, modules.opening, openingRate),
      ratio: copy(modules.movement.crossMetrics?.find(item => item.key === 'invoiceMovementMonthRatio')
        || pending('当月动销 / 开票', '%', '当前来源未确认该跨表指标')) };
    result.invoiceYoY = yearComparison('invoice', modules.invoice, filters);
    result.movementYoY = yearComparison('movement', modules.movement, filters);
    result.openingYoY = ready(result.openingTotal) && result.openingTotal.range
      ? yearComparison('opening', modules.opening, filters, true, result.openingTotal.range)
      : pending('累计开瓶同比', '%', result.openingTotal.reason || '共同期间未确认');
    // Cache only small display metrics, not each selection's full source arrays.
    regionalCache.set(key, result);
    if (regionalCache.size > 96) regionalCache.delete(regionalCache.keys().next().value);
    return result;
  }
  function openingTrend(data, filters) {
    const source = model.payload.modules.opening, scoped = data.modules.opening.scopedRows || data.modules.opening.rows || [];
    const coverage = model.payload.coverage?.opening;
    const result = { openingDaily: [], openingPeriod: '来源期间未提供', openingState: { state: 'missing', reason: '未接入有效开瓶来源' } };
    if (source.state === 'unavailable') return result;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(filters.month || '')) {
      result.openingState = { state: 'pending', reason: '所选月份无效，无法定位单月日度期间' };
      return result;
    }
    if (!validDate(coverage?.start) || !validDate(coverage?.end) || coverage.start > coverage.end) {
      result.openingState = { state: 'pending', reason: '开瓶来源覆盖期间缺失或无效，无法定位日度期间' };
      return result;
    }
    const p = periodOf(filters), monthStart = p.mode === 'range' ? p.start : `${filters.month}-01`;
    const monthEnd = p.mode === 'range' ? p.end : new Date(Date.UTC(Number(filters.month.slice(0, 4)), Number(filters.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const start = [monthStart, coverage.start].sort().at(-1), end = [monthEnd, coverage.end].sort()[0];
    if (start > end) {
      result.openingPeriod = '所选期间无来源覆盖';
      result.openingState = { state: 'missing', reason: '所选期间不在开瓶来源覆盖期间内' };
      return result;
    }
    result.openingPeriod = `${start} 至 ${end}`;
    const unknownDate = scoped.some(row => !validDate(row.date));
    const blocked = unknownDate ? '存在缺失或无效日期，无法完整分期' : source.metrics?.bottles?.status === 'pending' ? '开瓶瓶数来源规则或口径待确认' : null;
    const byDay = new Map();
    for (const row of scoped) {
      if (!validDate(row.date) || row.date < start || row.date > end) continue;
      if (!byDay.has(row.date)) byDay.set(row.date, []);
      byDay.get(row.date).push(row.bottles);
    }
    for (let day = start; day <= end; day = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
      const values = byDay.get(day) || [];
      let value = null, state = 'pending', reason = blocked;
      if (!blocked && !values.length) { state = 'missing'; reason = '当日无来源记录，不推定为零'; }
      else if (!blocked && values.some(item => !finite(item))) reason = '当日存在缺失或不可用开瓶瓶数';
      else if (!blocked) {
        let sum = 0, correction = 0;
        for (const item of values) { const next = item - correction, updated = sum + next; correction = (updated - sum) - next; sum = updated; }
        if (finite(sum)) { value = sum; state = 'available'; reason = null; } else reason = '当日合计超出可表示范围';
      }
      result.openingDaily.push({ date: day, value, state, reason });
    }
    const points = result.openingDaily;
    result.openingState = blocked ? { state: 'pending', reason: blocked }
      : points.some(item => item.state === 'pending') ? { state: 'pending', reason: '部分日期瓶数不完整，图中保留断点' }
      : points.some(item => item.state === 'available') ? { state: 'available', reason: points.some(item => item.state === 'missing') ? '缺日保留断点，不补零' : null }
      : { state: 'missing', reason: '当前组织与期间内无开瓶来源记录' };
    return result;
  }
  function describe(data, filters = model.defaults) {
    const f = defaultFilters(filters), supplied = data || model.select(f), cacheKey = keyFor(f);
    let byFilters = cache.get(supplied);
    if (byFilters?.has(cacheKey)) return byFilters.get(cacheKey);
    const groupField = ['region', 'office', 'unit'].includes(supplied.groupField) ? supplied.groupField : f.region === 'all' ? 'region' : f.office === 'all' ? 'office' : 'unit';
    const keys = [...new Set((supplied.grouped || []).map(item => item.name))];
    const expectedParts = groupField === 'region' ? 4 : groupField === 'office' ? 5 : 6;
    const parentInvoice = supplied.modules.invoice.main;
    const regional = keys.map(key => {
      const selection = childFilters(f, groupField, key), parts = partsFor(key);
      const metrics = regionalMetrics(selection, keyFor(selection) === cacheKey ? supplied : null);
      const invoiceShare = ready(metrics.invoice) && ready(parentInvoice) && parentInvoice.value > 0 && finite(metrics.invoice.value / parentInvoice.value * 100)
        ? { label: '发票占比', unit: '%', value: metrics.invoice.value / parentInvoice.value * 100, state: 'available', reason: null,
          numerator: metrics.invoice.value, denominator: parentInvoice.value }
        : pending('发票占比', '%', '当前组织或父范围发票净额不完整，或父范围合计不大于零');
      return { key, name: model.label(key), fullName: fullName(key),
        drillable: f.unit === 'all' && parts.length === expectedParts && parts.every(text) && model.organizations.some(item => item[groupField] === key),
        ...Object.fromEntries(Object.entries(metrics).map(([name, item]) => [name, copy(item)])), invoiceShare };
    });
    const sourceEnds = Object.fromEntries(model.ids.filter(id => model.payload.modules[id].state !== 'unavailable')
      .map(id => [id, validDate(model.payload.coverage?.[id]?.end) ? model.payload.coverage[id].end : null]));
    const ends = [...new Set(Object.values(sourceEnds))];
    const result = { regional, groupField, ...openingTrend(supplied, f),
      openingGrowth: (({ groups, ...total }) => total)(supplied.modules.opening.dayChange || { ...pending('较昨日开瓶', '%', '当前数据未提供日度比较'), precision: 1 }),
      sourceEndLabel: ends.length === 1 && ends[0] ? `截至 ${ends[0]}` : !ends.length || ends.every(value => value === null) ? '来源截止日期未提供' : '各来源截止不同', sourceEnds };
    result.heroes = Object.fromEntries(['invoice', 'movement'].map(id => [id, {
      monthly: yearMonths(id, supplied.modules[id], f), yoy: yearComparison(id, supplied.modules[id], f),
      ytdYoY: yearComparison(id, supplied.modules[id], f, true),
    }]));
    result.openingYoY = yearComparison('opening', supplied.modules.opening, f);
    result.openingPreviousDaily = previousOpeningDays(supplied.modules.opening, result.openingYoY, result.openingDaily);
    if (!byFilters) { byFilters = new Map(); cache.set(supplied, byFilters); }
    byFilters.set(cacheKey, result);
    return result;
  }
  return { describe };
}
