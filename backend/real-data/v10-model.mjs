import { buildTerminalStructure } from './terminal-structure.mjs';

// Both factories are serialized into the offline dashboard.
export function createV10Model(payload, terminalBuilder = buildTerminalStructure) {
  const inventoryHistory = payload.modules.inventory.inventoryMode === 'visit-history';
  const ids = ['invoice', 'movement', 'opening', 'terminal', 'inventory', 'banquet'];
  const titles = { invoice: '发票销售', movement: '终端动销', opening: '消费者开瓶', terminal: '终端签约', inventory: '库存盘点', banquet: '宴席执行' };
  const colors = { invoice: '#ab343c', movement: '#167d72', opening: '#547fa3', terminal: '#877753', inventory: '#687e88', banquet: '#9c7865' };
  const definitions = {
    invoice: ['当月发票净额', '元', 'amount'], movement: ['当月扫码金额净额', '元', 'amount'],
    opening: ['当月开瓶瓶数', '瓶', 'bottles'], terminal: ['截至所选月末累计签约终端', '家', 'terminalCount'],
    inventory: ['当前导出所选记录盘点数量', '瓶', 'counted'], banquet: ['来源固定期间执行场次', '场', 'events'],
  };
  const pending = {
    invoice: ['达成率使用“经营目标”来源，按组织名称对应，目标不分产品；主页同比按同组织、同产品与上年同期比较，期间或基数不足时保留原因；不显示期间覆盖尚未对齐的环比。'],
    movement: ['跨表指标按对应来源的确认状态显示；当月与年累计口径分别标明。本看板暂不显示环比。', '不同单位数量分开显示，不将未知单位当成瓶。'],
    opening: ['金额仅表示现金红包金额。开瓶与扫码的比例只表示来源量关系，不解释为消费者渗透率。'],
    terminal: ['签约终端按网点编号去重，按签约日期截至所选月末累计。', '有效终端按 2026-07-01 至所选月末任一已签约品系扫码净件数达到 1 件判断。'],
    inventory: ['本页是已上传导出的盘点记录视图，不是任意历史月份的库存快照。', '可销月数只对当前导出月份作来源估算，不重建历史库存，也不外推未提供日期。'],
    banquet: ['保持文件声明的固定期间，不响应月份或产品筛选。', '奖励合计继续待确认；宴席开瓶与消费者开瓶的包含关系不保证，不展示二者占比。'],
  };
  if (inventoryHistory) {
    definitions.inventory = ['最近一次已知盘点瓶数', '瓶', 'counted'];
    pending.inventory = ['按经销商编码＋完整产品名称，选择截至所选月末最近一次盘点；并列候选不自动删除或相加。',
      '各记录盘点时间不同，旧记录不自动清零，合计不是同一时点实时库存。',
      '新表组织层级与其他来源不同，跨板块组织映射尚未确认；按源完整路径独立筛选，不按短名称合并。',
      '新表缺少盘点金额、产品编码和安全库存依据；盘点金额、金额差额、可销月份及品牌品类联动不可用。'];
  }
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const format = (value, digits = 0, maxDigits = digits) => finite(value)
    ? new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: maxDigits }).format(value) : '—';
  const formatMetric = metric => metric.state === 'available'
    ? format(metric.value, metric.precision ?? (metric.unit.startsWith('元') || metric.unit.includes('/') ? 2 : 0), metric.precision ?? (metric.unit === '元' ? 2 : 6))
    : metric.state === 'pending' ? '待确认' : metric.state === 'unavailable' ? '不可用' : metric.reason === '未接入有效来源' ? '未接入' : '无记录';
  const sum = (rows, field) => {
    if (rows.some(row => !finite(row[field]))) return null;
    let total = 0, correction = 0;
    for (const row of rows) {
      const next = row[field] - correction, updated = total + next;
      correction = (updated - total) - next; total = updated;
    }
    return total;
  };
  const orgFields = ['marketingCompany', 'businessUnit', 'theater', 'region', 'office', 'unit'];
  const partsFor = row => row.orgPath || orgFields.map(key => row.org?.[key] || '');
  const labels = new Map(), fullLabels = new Map();
  const identity = parts => {
    const key = JSON.stringify(parts);
    const known = parts.slice(3).map(x => String(x ?? '').trim()).filter(Boolean);
    const short = known.join(' / ') || '未提供组织';
    labels.set(key, `${short}${parts.slice(0, 3).some(x => !x) ? '（上级未提供）' : ''}`);
    fullLabels.set(key, parts.map(value => value || '未提供').join(' / '));
    return key;
  };
  const orgMap = new Map(), categoryMap = new Map();
  for (const id of ids) for (const row of payload.modules[id].records) {
    const parts = partsFor(row);
    const region = identity(parts.slice(0, 4)), office = identity(parts.slice(0, 5)), unit = identity(parts);
    if (!orgMap.has(unit)) orgMap.set(unit, { id: unit, region, office, unit });
    if (['invoice', 'movement', 'inventory'].includes(id) && !(id === 'inventory' && inventoryHistory)) {
      const key = JSON.stringify([row.brand || '未映射品牌', row.category || '未映射品类']);
      if (!categoryMap.has(key)) categoryMap.set(key, { id: key, name: row.category || '未映射品类', brand: row.brand || '未映射品牌' });
    }
  }
  const organizations = [...orgMap.values()].sort((a, b) => a.unit.localeCompare(b.unit, 'zh-CN'));
  const categories = [...categoryMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const normalized = Object.fromEntries(ids.map(id => [id, payload.modules[id].records.map(row => {
    const parts = partsFor(row);
    return { ...row, region: identity(parts.slice(0, 4)), office: identity(parts.slice(0, 5)), unit: identity(parts),
      product: JSON.stringify([row.brand || '未映射品牌', row.category || '未映射品类']),
      month: row.date ? row.date.slice(0, 7) : null };
  })]));
  const monthSet = new Set();
  for (const id of ids) for (const row of normalized[id]) if (row.month) monthSet.add(row.month);
  if (!monthSet.size) for (const coverage of Object.values(payload.coverage)) if (coverage?.end) monthSet.add(coverage.end.slice(0, 7));
  const months = [...monthSet].sort();
  if (!months.length) months.push('fixed');
  const defaults = { month: months.at(-1), period: 'month', start: null, end: null, region: 'all', office: 'all', unit: 'all', product: 'all' };
  const matchesOrg = (row, filters) => ['region', 'office', 'unit'].every(key => filters[key] === 'all' || row[key] === filters[key]);
  const matchesProduct = (id, row, filters) => id === 'inventory' && inventoryHistory || !['invoice', 'movement', 'inventory'].includes(id) || filters.product === 'all' || row.product === filters.product;
  const period = (id, filters) => {
    const coverage = payload.coverage[id];
    if (id === 'banquet') return coverage?.start && coverage?.end ? `${coverage.start} 至 ${coverage.end}（来源固定期间）` : '来源固定期间未提供';
    const selected = filters.month, p = periodOf(filters);
    if (selected === 'fixed') return '来源未提供可筛选日期';
    const end = coverage?.end?.slice(0, 7) === selected ? coverage.end : `${selected} 月末`;
    if (id === 'inventory' && inventoryHistory) {
      const knownEnd = [p.end, coverage?.end].filter(Boolean).sort()[0];
      return `截至 ${knownEnd} 的最近一次已知盘点（非实时库存）`;
    }
    if (p.mode === 'range') return ['inventory', 'terminal'].includes(id) ? `已上传记录日期 ≤ ${[p.end, coverage?.end].filter(Boolean).sort()[0]}` : `${p.start} 至 ${p.end}；来源截止 ${coverage?.end || '未提供'}`;
    return ['inventory', 'terminal'].includes(id) ? `已上传记录日期 ≤ ${end}` : `${selected}；来源截止 ${coverage?.end || '未提供'}`;
  };
  const metric = (rows, field, module, label, unit, forcePending = false) => {
    if (module.state === 'unavailable') return { label, unit, value: null, state: module.reviewPending ? 'pending' : 'missing', reason: module.reviewReason || '未接入有效来源' };
    if (module.inventoryMode === 'visit-history') {
      if (field === 'countAmount') return { label, unit, value: null, state: 'unavailable', reason: '拜访采集表没有盘点库存金额' };
      if (!['records', 'agreementCount'].includes(field) && rows.some(row => row.inventoryConflict || row.inventoryDateUncertain)) return { label, unit, value: null, state: 'unavailable', reason: '最近盘点有同时间候选或无效提交时间，不能确定唯一库存' };
    }
    if (forcePending || module.metrics[field]?.status === 'pending') return { label, unit, value: null, state: 'pending', reason: '来源规则或口径待确认' };
    const value = ['records', 'agreementCount'].includes(field) ? rows.length : field === 'terminalCount' ? rows.some(row => !row.terminalCode) ? null : new Set(rows.map(row => row.terminalCode)).size : sum(rows, field);
    return { label, unit, value, state: value === null ? 'pending' : 'available', reason: value === null ? '存在缺失或不可用源值' : null };
  };
  const monthEnd = month => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const inventoryCutoff = end => /^\d{4}-\d{2}-\d{2}$/.test(end || '') && payload.coverage.inventory?.end
    ? [end, payload.coverage.inventory.end].sort()[0] : null;
  const offsetMonth = (month, offset) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + offset, 1)).toISOString().slice(0, 7);
  const ruleReady = (name, dependencies) => {
    const rule = payload.decisionContract?.[name];
    return payload.decisionContract?.version === 1 && rule?.status === 'confirmed'
      && (name !== 'terminalIdentity' || rule.key === 'original-code')
      && dependencies.every(id => rule.sources?.[id] && rule.sources[id] === payload.sources[id]?.sha256);
  };
  const failCross = (key, label, unit, reason, notes = [], state = 'unavailable') => ({ key, label, unit, value: null, state, reason, notes, precision: 2 });
  const commonCut = (dependencies, endDate) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate || '') || dependencies.some(id => payload.modules[id].state === 'unavailable' || !payload.coverage[id]?.end)) return null;
    return [endDate, ...dependencies.map(id => payload.coverage[id].end)].sort()[0];
  };
  const sourceWindowIssue = (dependencies, start, end) => {
    if (!end || end < start) return '来源截止日尚未覆盖所选期间';
    const required = [];
    for (let month = start.slice(0, 7); month <= end.slice(0, 7); month = offsetMonth(month, 1)) required.push(month);
    for (const id of dependencies) {
      const cover = payload.coverage[id];
      if (payload.modules[id].state === 'unavailable' || !cover?.start || !cover.end) return `${titles[id]}缺少可用来源期间`;
      if (cover.start.slice(0, 7) > start.slice(0, 7) || cover.end < end) return `${titles[id]}来源月份未覆盖计算窗口`;
      if (normalized[id].some(row => !row.date)) return `${titles[id]}存在日期缺失，无法完整分期`;
      if (required.some(month => !normalized[id].some(row => row.month === month && row.date <= end))) return `${titles[id]}计算窗口有月份无来源记录，不能补零`;
    }
    return null;
  };
  const windowRows = (id, filters, start, end, ignoreProduct = false) => normalized[id].filter(row => matchesOrg(row, filters) && (ignoreProduct || matchesProduct(id, row, filters)) && row.date && row.date >= start && row.date <= end);
  const ratioMetric = (key, label, unit, numerator, denominator, range, notes, scale = 100) => {
    if (!finite(numerator) || !finite(denominator)) return failCross(key, label, unit, '计算窗口存在缺失源值', notes);
    if (denominator <= 0) return failCross(key, label, unit, '分母不大于零，不能计算比例或估算', notes);
    const value = numerator / denominator * scale;
    if (!finite(value)) return failCross(key, label, unit, '计算结果超出可表示范围', notes);
    return { key, label, unit, value, state: 'available', reason: null, numerator, denominator, range, notes, precision: 2 };
  };
  function crossTableMetrics(filters) {
    const f = filters, p = periodOf(f), range = p.mode === 'range';
    const amountRatio = cumulative => {
      const key = cumulative ? 'invoiceMovementYtdRatio' : 'invoiceMovementMonthRatio', label = cumulative ? '年累计动销 / 开票' : range ? '区间动销 / 开票' : '当月动销 / 开票';
      const deps = ['invoice', 'movement'];
      if (!ruleReady('crossTableMetrics', deps)) return failCross(key, label, '%', '这两个来源版本的跨表关系尚未确认', [], 'pending');
      const end = commonCut(deps, p.end), start = cumulative ? `${f.month.slice(0, 4)}-01-01` : p.start;
      const notes = [`同组织、同产品；${start} 至 ${end || '未提供共同截止日'}。`, '扫码净额与发票净额分别来自各自来源；比例超过 100% 不解释为渗透率。'];
      const issue = sourceWindowIssue(deps, start, end);
      if (issue) return failCross(key, label, '%', issue, notes);
      const invoices = windowRows('invoice', f, start, end), movements = windowRows('movement', f, start, end);
      if (!invoices.length || !movements.length) return failCross(key, label, '%', '当前组织或产品范围缺少一侧来源记录', notes);
      if (deps.some(id => payload.modules[id].metrics.amount?.status === 'pending')) return failCross(key, label, '%', '来源金额规则尚未确认', notes, 'pending');
      return ratioMetric(key, label, '%', sum(movements, 'amount'), sum(invoices, 'amount'), { start, end }, notes);
    };
    const openingRatio = () => {
      const key = 'openingMovementRatio', label = '年累计开瓶 / 动销（瓶）', deps = ['opening', 'movement'];
      if (!ruleReady('crossTableMetrics', deps)) return failCross(key, label, '%', '这两个来源版本的跨表关系尚未确认', [], 'pending');
      const end = commonCut(deps, p.end), start = `${f.month.slice(0, 4)}-01-01`;
      const notes = [`同组织；${start} 至 ${end || '未提供共同截止日'}；分子与分母都不随产品筛选。`, '仅计单品单位为瓶的扫码数量；盒单位不混入。此值是来源量关系，不解释为消费者渗透率。'];
      const issue = sourceWindowIssue(deps, start, end);
      if (issue) return failCross(key, label, '%', issue, notes);
      const openings = windowRows('opening', f, start, end, true), movements = windowRows('movement', f, start, end, true);
      if (!openings.length || !movements.length) return failCross(key, label, '%', '当前组织缺少一侧来源记录', notes);
      if (movements.some(row => !['瓶', '盒'].includes(row.quantityUnit))) return failCross(key, label, '%', '扫码来源存在未确认单位，无法确认完整瓶数分母', notes);
      if (deps.some(id => payload.modules[id].metrics.bottles?.status === 'pending')) return failCross(key, label, '%', '来源瓶数规则尚未确认', notes, 'pending');
      const bottles = movements.filter(row => row.quantityUnit === '瓶');
      if (!bottles.length) return failCross(key, label, '%', '当前组织没有瓶单位扫码记录', notes);
      return ratioMetric(key, label, '%', sum(openings, 'bottles'), sum(bottles, 'bottles'), { start, end }, notes);
    };
    const inventoryMonths = () => {
      const key = 'inventorySellableMonths', label = '可销月数（来源估算）', deps = ['inventory', 'movement'];
      if (inventoryHistory) return failCross(key, label, '月', '拜访采集表缺少盘点金额和产品编码，无法计算可销月份');
      if (!ruleReady('crossTableMetrics', deps)) return failCross(key, label, '月', '这两个来源版本的跨表关系尚未确认', [], 'pending');
      if (range) return failCross(key, label, '月', '自定义区间不估算可销月数；请切换到按月查看');
      if (payload.coverage.inventory?.end?.slice(0, 7) !== f.month) return failCross(key, label, '月', '只对库存当前导出截止月份估算，不能还原历史月份库存');
      const end = commonCut(deps, p.end), start = `${offsetMonth(f.month, -2)}-01`;
      const partial = end && end < monthEnd(f.month);
      const notes = [`同组织、同产品；盘点金额采用截至 ${end || '未提供共同截止日'} 的当前导出记录。`, `分母为 ${start} 至 ${end || '未提供'} 的扫码净额合计 ÷ 3，窗口包含所选月及前两个月。`, partial ? '窗口含未完月，直接使用已提供的来源值；未折算全月，不作未来外推。' : '使用来源覆盖的三个连续月份；不补缺失月份。', '盘点估值与扫码交易金额属于不同业务量，这只是来源估算，不是库存历史快照或实际周转天数。'];
      const issue = sourceWindowIssue(['movement'], start, end);
      if (issue) return failCross(key, label, '月', issue, notes);
      const inventory = normalized.inventory.filter(row => matchesOrg(row, f) && matchesProduct('inventory', row, f) && row.date && row.date <= end);
      const movement = windowRows('movement', f, start, end);
      if (normalized.inventory.some(row => !row.date)) return failCross(key, label, '月', '盘点来源存在缺失日期', notes);
      if (!inventory.length || !movement.length) return failCross(key, label, '月', '当前组织或产品缺少盘点或扫码来源记录', notes);
      if (payload.modules.inventory.metrics.countAmount?.status === 'pending' || payload.modules.movement.metrics.amount?.status === 'pending') return failCross(key, label, '月', '来源金额规则尚未确认', notes, 'pending');
      const amount = sum(inventory, 'countAmount'), sales = sum(movement, 'amount');
      if (amount !== null && amount < 0) return failCross(key, label, '月', '盘点来源金额为负，无法作可销月数估算', notes);
      return ratioMetric(key, label, '月', amount, sales === null ? null : sales / 3, { start, end }, notes, 1);
    };
    return { movement: [amountRatio(false), amountRatio(true)], opening: [openingRatio()], inventory: [inventoryMonths()] };
  }
  const inventorySelections = new Map();
  const latestInventory = cutoff => {
    if (inventorySelections.has(cutoff)) return inventorySelections.get(cutoff);
    const groups = new Map();
    for (const row of normalized.inventory) {
      if (!row.month || row.date > cutoff) continue;
      const key = row.inventoryGroupKey || JSON.stringify([row.dealerCode, row.productName]);
      const current = groups.get(key), stamp = row.submittedAt || row.date;
      if (!current || stamp > current.stamp) groups.set(key, { stamp, rows: [row] });
      else if (stamp === current.stamp) current.rows.push(row);
    }
    const cutoffDate = inventoryCutoff(cutoff);
    const result = [...groups.values()].flatMap(group => group.rows.map(row => {
      const elapsed = cutoffDate && row.date ? (Date.parse(`${cutoffDate}T00:00:00Z`) - Date.parse(`${row.date}T00:00:00Z`)) / 86400000 : null;
      return { ...row, inventoryConflict: group.rows.length > 1 ? 1 : row.inventoryConflict || 0,
        daysSinceStocktake: Number.isInteger(elapsed) && elapsed >= 0 ? elapsed : null };
    }));
    inventorySelections.set(cutoff, result);
    if (inventorySelections.size > 2) inventorySelections.delete(inventorySelections.keys().next().value);
    return result;
  };
  const shiftDay = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  // Compares the last day of the selected period with the calendar day before it.
  // Missing days stay unknown; a zero previous day yields a difference but no rate.
  function dayChange(rows, end, name = '当前范围') {
    const source = payload.modules.opening, cover = payload.coverage.opening;
    const base = { label: '较昨日开瓶', unit: '%', name, date: end || null, previousDate: isDate(end) ? shiftDay(end, -1) : null,
      current: null, previous: null, difference: null, amountCurrent: null, amountPrevious: null, amountRate: null, value: null, precision: 1 };
    const fail = (reason, state = 'pending') => ({ ...base, state, reason });
    if (source.state === 'unavailable') return fail(source.reviewReason || '未接入有效来源', source.reviewPending ? 'pending' : 'missing');
    if (!isDate(end)) return fail('所选期间没有可定位的末日');
    if (!isDate(cover?.start) || cover.start > base.previousDate) return fail('昨日不在开瓶来源覆盖期间内', 'missing');
    if (source.metrics?.bottles?.status === 'pending') return fail('开瓶瓶数来源规则或口径待确认');
    if (rows.some(row => !isDate(row.date))) return fail('存在缺失或无效日期，无法定位当日');
    const today = rows.filter(row => row.date === end), yesterday = rows.filter(row => row.date === base.previousDate);
    const current = today.length ? sum(today, 'bottles') : null, previous = yesterday.length ? sum(yesterday, 'bottles') : null;
    const amountCurrent = today.length ? sum(today, 'amount') : null, amountPrevious = yesterday.length ? sum(yesterday, 'amount') : null;
    const known = { ...base, current, previous, amountCurrent, amountPrevious,
      amountRate: finite(amountCurrent) && finite(amountPrevious) && amountPrevious > 0 ? (amountCurrent - amountPrevious) / amountPrevious * 100 : null };
    if (!today.length) return { ...known, state: 'missing', reason: `${end} 无开瓶来源记录，不推定为零` };
    if (!yesterday.length) return { ...known, state: 'missing', reason: `${base.previousDate} 无开瓶来源记录，不计算变化` };
    if (!finite(current) || !finite(previous)) return { ...known, state: 'pending', reason: '当日或昨日存在缺失或不可用瓶数' };
    const difference = current - previous;
    if (previous <= 0) return { ...known, difference, state: 'pending', reason: '昨日开瓶不大于零，不计算变化率' };
    const value = difference / previous * 100;
    return finite(value) ? { ...known, difference, value, state: 'available', reason: null } : { ...known, difference, state: 'pending', reason: '变化率超出可表示范围' };
  }
  // Business targets are matched by region/office/unit names. The most senior
  // filled level at or below the selected scope is used; parents are never split.
  const targetSource = payload.targets?.state === 'ready' ? payload.targets : null;
  const targetRows = (targetSource?.records || []).map(row => {
    const names = [row.region, row.office, row.unit].map(value => String(value ?? '').trim());
    const depth = names.findIndex(value => !value) < 0 ? 3 : names.findIndex(value => !value);
    return { ...row, names, depth, valid: names.slice(depth).every(value => !value) };
  });
  const targetCounts = new Map();
  for (const row of targetRows) { const key = JSON.stringify([row.month, row.metric, row.names]); targetCounts.set(key, (targetCounts.get(key) || 0) + 1); }
  const targetUnit = kind => kind === 'opening' ? '瓶' : '元';
  const targetLevels = ['全战区', '大区', '办事处', '主任单元'];
  function targetValue(kind, filters, segments, label) {
    const months = segments.map(item => item.month);
    const unit = targetUnit(kind), fail = (reason, state = 'pending') => ({ label, unit, value: null, state, reason });
    if (!targetSource) return fail('未上传经营目标', 'missing');
    if (kind !== 'opening' && filters.product !== 'all') return fail('目标不分产品；选择全部产品后显示达成率', 'unavailable');
    if (!months.length || months.some(month => !/^\d{4}-\d{2}$/.test(month))) return fail('所选期间无法对应目标月份');
    const key = filters.unit !== 'all' ? filters.unit : filters.office !== 'all' ? filters.office : filters.region !== 'all' ? filters.region : null;
    let scope = [];
    if (key) { try { scope = JSON.parse(key).slice(3).map(value => String(value ?? '').trim()); } catch { scope = []; } }
    if (key && (!scope.length || scope.some(value => !value))) return fail('当前组织层级名称不完整，无法对应目标', 'unavailable');
    let total = 0; const levels = new Set(); let summed = false;
    for (const { month, weight } of segments) {
      const rows = targetRows.filter(row => row.valid && row.metric === kind && row.month === month);
      // A node uses its own row when filled; otherwise the sum of its filled
      // children. Levels may be mixed: one region filled at region level,
      // another only by some of its offices. Parents are never split down.
      const resolve = prefix => {
        const below = rows.filter(row => row.depth >= prefix.length && prefix.every((name, index) => row.names[index] === name));
        const own = below.filter(row => row.depth === prefix.length);
        if (own.length > 1) return { error: `${month} 目标表同一组织、指标重复，未自动相加` };
        if (own.length === 1) {
          if (!finite(own[0].value)) return { error: `${month} 目标值缺失或无效` };
          levels.add(prefix.length); return { value: own[0].value };
        }
        if (prefix.length >= 3) return null;
        const children = [...new Set(below.map(row => row.names[prefix.length]))];
        let value = 0, found = false;
        for (const child of children) {
          const result = resolve([...prefix, child]);
          if (result?.error) return result;
          if (result) { value += result.value; found = true; }
        }
        if (found && prefix.length === scope.length) summed = true;
        return found ? { value } : null;
      };
      const result = resolve(scope);
      if (result?.error) return fail(result.error);
      if (!result) {
        const parent = rows.find(row => row.depth < scope.length && row.names.slice(0, row.depth).every((name, index) => scope[index] === name));
        return fail(parent ? `${month} 只有${targetLevels[parent.depth]}目标，尚未拆分到当前组织` : `${month} 未填写当前组织的目标`, 'missing');
      }
      total += result.value * weight;
    }
    const prorated = segments.filter(item => item.weight !== 1);
    const note = `${months.length > 1 ? `${months[0]} 至 ${months.at(-1)}` : months[0]} 目标；取 ${[...levels].map(depth => targetLevels[depth]).join('、')} 层级${summed ? '合计（未填目标的下级不计入）' : ''}${prorated.length ? `；${prorated.map(item => `${item.month} 按 ${item.days}/${item.monthDays} 天折算`).join('，')}` : ''}。`;
    return { label, unit, value: total, state: 'available', reason: null, note, months: [...months], precision: unit === '瓶' ? 0 : 2 };
  }
  function attainment(actual, target, label) {
    const fail = (reason, state = 'pending') => ({ label, unit: '%', value: null, state, reason, target, precision: 1 });
    if (target.state !== 'available') return fail(target.reason, target.state);
    if (!actual || actual.state !== 'available' || !finite(actual.value)) return fail(actual?.reason || '实际值缺失或待确认', actual?.state === 'missing' ? 'missing' : 'pending');
    if (target.value <= 0) return fail('目标不大于零，不计算达成率');
    const value = actual.value / target.value * 100;
    return finite(value) ? { label, unit: '%', value, state: 'available', reason: null, target, actual: actual.value, precision: 1, note: `实际 ${format(actual.unit === '元' ? actual.value / 10000 : actual.value, target.unit === '元' ? 2 : 0)} / 目标 ${format(target.unit === '元' ? target.value / 10000 : target.value, target.unit === '元' ? 2 : 0)} ${target.unit === '元' ? '万元' : target.unit}` } : fail('达成率超出可表示范围');
  }
  // A custom range uses each overlapping month's target, prorated by calendar days.
  function targetSegments(start, end) {
    const segments = [];
    if (!isDate(start) || !isDate(end) || start > end) return segments;
    for (let month = start.slice(0, 7); month <= end.slice(0, 7); month = offsetMonth(month, 1)) {
      const first = [`${month}-01`, start].sort().at(-1), last = [monthEnd(month), end].sort()[0];
      const days = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86400000) + 1, monthDays = Number(monthEnd(month).slice(8));
      segments.push({ month, weight: days === monthDays ? 1 : days / monthDays, days, monthDays });
    }
    return segments;
  }
  function periodOf(filters = defaults) {
    const f = { ...defaults, ...filters };
    if (f.period === 'range' && isDate(f.start) && isDate(f.end) && f.start <= f.end)
      return { mode: 'range', start: f.start, end: f.end, month: f.end.slice(0, 7), label: `${f.start} 至 ${f.end}`, days: Math.round((Date.parse(`${f.end}T00:00:00Z`) - Date.parse(`${f.start}T00:00:00Z`)) / 86400000) + 1 };
    if (/^\d{4}-\d{2}$/.test(f.month || '')) return { mode: 'month', start: `${f.month}-01`, end: monthEnd(f.month), month: f.month, label: `${Number(f.month.slice(0, 4))} 年 ${Number(f.month.slice(5))} 月`, days: Number(monthEnd(f.month).slice(8)) };
    return { mode: 'fixed', start: null, end: null, month: f.month, label: '来源固定期间', days: null };
  }
  const yearMonths = month => /^\d{4}-\d{2}$/.test(month || '') ? Array.from({ length: Number(month.slice(5)) }, (_, index) => `${month.slice(0, 4)}-${String(index + 1).padStart(2, '0')}`) : [];
  const periodEnd = (id, filters) => {
    const p = periodOf(filters), cover = payload.coverage[id];
    if (p.mode === 'fixed' || !isDate(cover?.end)) return null;
    const end = [p.end, cover.end].sort()[0];
    return end >= p.start ? end : null;
  };
  function select(filters = defaults) {
    const f = { ...defaults, ...filters }, output = { modules: {}, grouped: [] }, p = periodOf(f);
    if (p.mode === 'range') f.month = p.month;
    output.period = p;
    const inWindow = row => p.mode === 'fixed' ? row.month === f.month : Boolean(row.date) && row.date >= p.start && row.date <= p.end;
    const upToEnd = row => p.mode === 'fixed' ? row.month <= f.month : Boolean(row.date) && row.date <= p.end;
    const yearToEnd = row => Boolean(row.month) && row.month.slice(0, 4) === f.month.slice(0, 4) && (p.mode === 'fixed' ? row.month <= f.month : row.date <= p.end);
    for (const id of ids) {
      const sourceModule = payload.modules[id], sourceRows = id === 'inventory' && inventoryHistory ? latestInventory(p.end || '9999-12-31') : normalized[id];
      const scoped = sourceRows.filter(row => matchesOrg(row, f) && matchesProduct(id, row, f));
      const rows = scoped.filter(row => id === 'banquet' || (row.month && (['inventory', 'terminal'].includes(id) ? upToEnd(row) : inWindow(row))));
      const [baseLabel, unit, field] = definitions[id];
      const label = p.mode === 'range' ? baseLabel.replace('当月', '区间').replace('截至所选月末', `截至 ${p.end}`) : baseLabel;
      const main = metric(rows, field, sourceModule, label, unit);
      const extra = [];
      if (id === 'invoice' || id === 'movement') {
        extra.push(metric(scoped.filter(yearToEnd), 'amount', sourceModule, '当年截至所选月来源金额', '元'));
        extra.push(metric(rows.filter(row => finite(row.amount) && row.amount > 0), 'amount', sourceModule, '正金额合计', '元', main.state !== 'available'));
        extra.push(metric(rows.filter(row => finite(row.amount) && row.amount < 0), 'amount', sourceModule, '负金额合计', '元', main.state !== 'available'));
      }
      if (id === 'movement') {
        extra.push(metric(rows.filter(row => row.quantityUnit === '瓶'), 'bottles', sourceModule, '扫码数量（瓶单位记录）', '瓶'));
        extra.push(metric(rows.filter(row => row.quantityUnit === '盒'), 'boxes', sourceModule, '扫码数量（盒单位记录）', '盒'));
        extra.push(metric(rows, 'cases', sourceModule, '来源扫码件数', '源件数'));
        extra.push({ label: '单位未确认记录数', unit: '条', value: sourceModule.state === 'unavailable' ? null : rows.filter(row => !['瓶', '盒'].includes(row.quantityUnit)).length, state: sourceModule.state === 'unavailable' ? 'missing' : 'available' });
      }
      const ratio = (numerator, denominator, ratioLabel, ratioUnit, allowed = true) => ({ label: ratioLabel, unit: ratioUnit, value: allowed && numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : null, state: allowed && numerator !== null && denominator !== null && denominator > 0 ? 'available' : 'pending', reason: '源值缺失、规则待确认或分母不大于零' });
      if (id === 'opening') {
        extra.push(metric(rows, 'amount', sourceModule, '现金红包金额', '元'));
        extra.push(ratio(sum(rows, 'amount'), sum(rows, 'bottles'), '瓶均现金红包', '元/瓶', main.state === 'available' && extra[0].state === 'available'));
      }
      if (id === 'terminal') {
        extra.push(metric(rows, 'agreementCount', sourceModule, '按已确认去重规则保留协议数', '份'));
      }
      if (id === 'inventory') {
        extra.push(metric(rows, 'system', sourceModule, '所选记录系统瓶数合计', '瓶'));
        extra.push(metric(rows, 'countAmount', sourceModule, '所选记录盘点金额合计', '元'));
        extra.push(metric(rows, 'systemAmount', sourceModule, '所选记录系统金额合计', '元'));
        extra.push(metric(rows, 'absoluteVariance', sourceModule, '逐条绝对差异合计', '瓶'));
        extra.push(metric(rows, 'signedVariance', sourceModule, '盘点减系统差异合计', '瓶'));
        extra.push({ label: '源偏差数量缺失记录', unit: '条', value: sourceModule.state === 'unavailable' ? null : rows.filter(row => row.sourceVariance === null).length, state: sourceModule.state === 'unavailable' ? 'missing' : 'available' });
        extra.push({ label: '产品品类未映射记录', unit: '条', value: sourceModule.state === 'unavailable' ? null : rows.filter(row => !row.brand || !row.category).length, state: sourceModule.state === 'unavailable' ? 'missing' : 'available' });
      }
      if (id === 'banquet') {
        extra.push(metric(rows, 'bottles', sourceModule, '固定期间宴席开瓶', '瓶'));
        extra.push(ratio(sum(rows, 'bottles'), sum(rows, 'events'), '场均开瓶', '瓶/场', main.state === 'available' && sourceModule.metrics.bottles?.status !== 'pending'));
        extra.push(metric(rows, 'reward', sourceModule, '售点推荐奖励', '元', true));
      }
      const hasSourcePeriod = normalized[id].some(row => id === 'banquet' || row.month && (['inventory', 'terminal'].includes(id) ? upToEnd(row) : inWindow(row)));
      if (!hasSourcePeriod && sourceModule.state !== 'unavailable') for (const item of [main, ...extra]) { item.value = null; item.state = 'missing'; item.reason = '该期间无来源记录'; }
      const monthly = months.filter(month => month !== 'fixed').map(month => {
        const monthRows = scoped.filter(row => row.month === month);
        const m = metric(monthRows, id === 'inventory' && inventoryHistory ? 'records' : id === 'terminal' ? 'agreementCount' : field, sourceModule, month, id === 'inventory' && inventoryHistory ? '条' : id === 'terminal' ? '条' : unit);
        if (!monthRows.length) { m.value = null; m.state = 'missing'; m.reason = '该月无来源记录'; }
        return { month, ...m };
      });
      const grouping = f.region === 'all' ? 'region' : f.office === 'all' ? 'office' : 'unit';
      const groupMap = new Map();
      for (const row of rows) { const key = row[grouping]; if (!groupMap.has(key)) groupMap.set(key, []); groupMap.get(key).push(row); }
      const groups = [...groupMap].map(([name, records]) => ({ name, records: records.length, ...metric(records, field, sourceModule, name, unit) })).sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
      const breakdowns = [];
      const distribution = (title, keyFor, labelFor, measure, measureUnit) => {
        const grouped = new Map();
        for (const row of rows) { const key = keyFor(row); if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(row); }
        const items = [...grouped.values()].map(items => ({ name: labelFor(items[0]), records: items.length, ...metric(items, measure, sourceModule, labelFor(items[0]), measureUnit) })).sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
        breakdowns.push({ title, unit: measureUnit, items });
      };
      if (['invoice', 'movement', 'inventory'].includes(id) && !(id === 'inventory' && inventoryHistory)) {
        const amountField = id === 'inventory' ? 'countAmount' : 'amount';
        distribution('品牌金额构成', row => row.brand || '', row => row.brand || '未映射品牌', amountField, '元');
        distribution('品类金额构成', row => JSON.stringify([row.brand, row.category]), row => `${row.brand || '未映射品牌'} / ${row.category || '未映射品类'}`, amountField, '元');
      }
      if (id === 'invoice') distribution('经销商编码汇总', row => row.dealerCode || '', row => row.dealerCode ? `${row.dealerCode} · ${row.dealerName || '未提供名称'}` : '未提供经销商编码（不推定身份）', 'amount', '元');
      if (id === 'opening') distribution('开瓶城市分布', row => row.city || '', row => row.city || '未提供城市', 'bottles', '瓶');
      if (id === 'terminal') distribution('协议记录星级分布', row => row.star || '', row => row.star || '未提供星级', 'agreementCount', '条');
      if (id === 'inventory' && !inventoryHistory) distribution('来源安全库存状态', row => row.safety || '', row => row.safety || '未提供状态', 'records', '条');
      const monthUnknown = id !== 'banquet' && scoped.some(row => !row.date);
      const unknownMessage = monthUnknown ? ['存在缺失日期的记录，无法完整分期；月份合计、月度图表和区域金额暂不计算。'] : [];
      if (normalized[id].some(row => partsFor(row).slice(0, 3).some(value => !value))) unknownMessage.push('来源部分上级组织字段未提供；仅完整路径相同才联动，尚未自动补齐或归并。');
      if (id === 'inventory' && !inventoryHistory) {
        const mismatched = rows.filter(row => finite(row.sourceVariance) && finite(row.absoluteVariance) && Math.abs(row.sourceVariance - row.absoluteVariance) > 1e-8).length;
        if (mismatched) unknownMessage.push(`${mismatched} 条记录的源偏差数量与逐条绝对差异不一致；两种值分别保留，不互相覆盖。`);
      }
      if (monthUnknown) for (const item of [main, ...extra, ...monthly, ...groups, ...breakdowns.flatMap(x => x.items)]) { item.value = null; item.state = 'pending'; item.reason = '存在缺失日期，无法完整分期'; }
      if (sourceModule.state === 'unavailable') for (const item of [main, ...extra]) { item.value = null; item.state = sourceModule.reviewPending ? 'pending' : 'missing'; item.reason = sourceModule.reviewReason || '未接入有效来源'; }
      if (sourceModule.reviewPending) unknownMessage.push(sourceModule.reviewReason);
      if (rows.length === 0 && sourceModule.state !== 'unavailable') for (const item of [main, ...extra]) { item.value = null; item.state = 'missing'; item.reason = '当前范围无来源记录；不推定为业务零值'; }
      output.modules[id] = { id, title: titles[id], color: colors[id], main, extra, rows, scopedRows: scoped, recordCount: rows.length, monthly, groups, breakdowns, groupField: grouping,
        state: sourceModule.state, period: period(id, f), pending: [...pending[id], ...unknownMessage], source: payload.sources[id] || null };
      if (id === 'inventory' && inventoryHistory) {
        const uncertain = (sourceModule.uncertaintyGroups || []).filter(group => (group.organizations || []).some(value => {
          const parts = value.orgPath;
          return Array.isArray(parts) && matchesOrg({ region: JSON.stringify(parts.slice(0, 4)), office: JSON.stringify(parts.slice(0, 5)), unit: JSON.stringify(parts) }, f);
        }));
        if (uncertain.length) for (const item of [main, ...extra, ...groups]) {
          item.value = null; item.state = 'unavailable'; item.reason = '当前组织有提交时间无效的盘点，不能保证最新记录选择完整';
        }
        const dates = rows.map(row => row.date).filter(Boolean).sort();
        output.modules[id].inventoryMode = 'visit-history';
        output.modules[id].inventoryStats = { ...(sourceModule.inventoryStats || {}),
          cutoffDate: inventoryCutoff(p.end),
          groupCount: new Set(rows.map(row => row.inventoryGroupKey)).size,
          conflictRows: rows.filter(row => row.inventoryConflict).length,
          uncertainGroups: uncertain.length, latestMinDate: dates[0] || null, latestMaxDate: dates.at(-1) || null,
          oldRecordCount: rows.filter(row => row.date && row.date.slice(0, 4) < f.month.slice(0, 4)).length };
        if (!rows.length && f.region !== 'all') for (const item of [main, ...extra]) {
          if (item.reason === '当前范围无来源记录；不推定为业务零值') item.reason = '当前完整组织路径没有库存记录；新库存与其他来源的组织映射尚未确认，请使用库存来源组织路径';
        }
      }
    }
    {
      const module = output.modules.opening, end = periodEnd('opening', f), grouping = output.modules.opening.groupField;
      const groups = new Map();
      for (const row of module.scopedRows) { const key = row[grouping]; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
      module.dayChange = { ...dayChange(module.scopedRows, end), groups: [...groups].map(([key, items]) => ({ key, ...dayChange(items, end, key) }))
        .sort((a, b) => (finite(b.current) ? b.current : -Infinity) - (finite(a.current) ? a.current : -Infinity)) };
    }
    for (const id of ['invoice', 'movement', 'opening']) {
      const module = output.modules[id], range = p.mode === 'range';
      const ytdActual = id === 'opening' ? metric(module.scopedRows.filter(yearToEnd), 'bottles', payload.modules.opening, '当年截至所选月开瓶', '瓶')
        : module.extra.find(item => item.label === '当年截至所选月来源金额');
      const monthTarget = targetValue(id, f, p.mode === 'fixed' ? [] : range ? targetSegments(p.start, p.end) : [{ month: f.month, weight: 1, days: null }], range ? '区间目标' : '当月目标');
      const ytdTarget = targetValue(id, f, p.mode === 'fixed' ? [] : range ? targetSegments(`${f.month.slice(0, 4)}-01-01`, p.end) : yearMonths(f.month).map(month => ({ month, weight: 1, days: null })), '年累计目标');
      module.targets = { available: Boolean(targetSource), month: monthTarget, ytd: ytdTarget,
        attainment: attainment(module.main, monthTarget, range ? '区间目标达成率' : '当月目标达成率'), ytdAttainment: attainment(ytdActual, ytdTarget, '年累计目标达成率') };
    }
    const crossMetrics = crossTableMetrics(f);
    for (const id of ids) output.modules[id].crossMetrics = crossMetrics[id] || [];
    output.groupField = f.region === 'all' ? 'region' : f.office === 'all' ? 'office' : 'unit';
    const structure = terminalBuilder({ terminalRows: normalized.terminal.filter(row => matchesOrg(row, f)),
      // The builder matches exact signed organization paths itself. Retain scans
      // with missing identities so narrowing a filter cannot turn unknowns into 0.
      movementRows: normalized.movement, allTerminalRows: normalized.terminal,
      month: f.month, endDate: p.end, groupField: output.groupField, terminalState: payload.modules.terminal.state,
      movementState: payload.modules.movement.state, identityState: ruleReady('terminalIdentity', ['terminal', 'movement']) ? 'confirmed' : 'pending',
      sourceEnd: payload.coverage.movement?.end || null });
    const terminalModule = output.modules.terminal;
    terminalModule.structure = structure;
    terminalModule.pending = structure.notes;
    const effectiveMetric = (label, value, unit, precision = 0) => ({ label, value, unit, precision,
      state: terminalModule.state === 'unavailable' ? 'missing' : value === null ? 'pending' : 'available',
      reason: value === null ? '来源、日期、品系或件数不足以完整判定' : null });
    terminalModule.extra.push(effectiveMetric('有效终端数', structure.totals.effectiveCount, '家'));
    terminalModule.extra.push(effectiveMetric('有效率', structure.totals.effectiveRate === null ? null : structure.totals.effectiveRate * 100, '%', 1));
    terminalModule.breakdowns = [];
    output.grouped = [...new Set(organizations.filter(row => matchesOrg(row, f)).map(row => row[output.groupField]))].map(name => {
      const groupValue = id => {
        const module = output.modules[id];
        if (module.state === 'unavailable' || module.main.state !== 'available') return null;
        const selected = module.rows.filter(row => row[output.groupField] === name);
        return selected.length ? sum(selected, 'amount') : null;
      };
      return { name, invoice: groupValue('invoice'), movement: groupValue('movement') };
    });
    return output;
  }
  // Distinct complete paths may share a short label. Add the known parent path
  // only for those collisions, without silently joining identities.
  const inventoryOnlyLabels = new Set();
  if (inventoryHistory) {
    const sharedKeys = new Set(ids.filter(id => id !== 'inventory').flatMap(id => normalized[id].flatMap(row => [row.region, row.office, row.unit])));
    for (const row of normalized.inventory) for (const key of [row.region, row.office, row.unit]) if (!sharedKeys.has(key)) inventoryOnlyLabels.add(key);
    // New inventory-only paths must not change labels on the other five boards.
    // Keep their exact filter identities; distinguish their display names here.
    for (const key of inventoryOnlyLabels) labels.set(key, `库存来源 · ${labels.get(key)}`);
  }
  const labelCounts = new Map();
  for (const [id, label] of labels) { const group = labelCounts.get(label) || []; group.push(id); labelCounts.set(label, group); }
  for (const matches of labelCounts.values()) if (matches.length > 1) for (const id of matches) labels.set(id, `${inventoryOnlyLabels.has(id) ? '库存来源 · ' : ''}${fullLabels.get(id)}`);
  const label = id => labels.get(id) || id;
  // Bounds for the custom range control: every dated flow source.
  const flowCoverage = ['invoice', 'movement', 'opening'].map(id => payload.modules[id].state !== 'unavailable' ? payload.coverage[id] : null).filter(cover => isDate(cover?.start) && isDate(cover?.end));
  const dateBounds = flowCoverage.length ? { min: flowCoverage.map(cover => cover.start).sort()[0], max: flowCoverage.map(cover => cover.end).sort().at(-1) } : null;
  return { ids, titles, colors, definitions, targetSource, periodOf, dateBounds, organizations, categories, months, defaults, payload, select, format, formatMetric, period, label,
    scope: filters => label(filters.unit !== 'all' ? filters.unit : filters.office !== 'all' ? filters.office : filters.region !== 'all' ? filters.region : '全战区'),
    previewNotice: '来自本次生成锁定的本机上传版本；未提供来源和待确认指标明确标示，不使用演示值。' };
}
