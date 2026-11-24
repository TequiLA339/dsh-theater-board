import { createV10Presentation } from './v10-presentation.mjs';
import { createV10OverviewData } from './v10-overview-data.mjs';

// Serialized into each offline dashboard. Keep rendering helpers in this factory.
export function createV10Overview({ T, g, model, Pn }) {
  const el = (tag, props, ...children) => {
    const { key, ...attributes } = props || {};
    return (children.length > 1 && T.jsxs ? T.jsxs : T.jsx)(tag, { ...attributes, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) }, key);
  };
  const presentation = createV10Presentation(model), adapter = createV10OverviewData(model, presentation);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const available = item => item?.state === 'available' && finite(item.value);
  const minus = text => String(text).replaceAll('-', '−');
  const number = (value, digits = 0) => minus(model.format(value, digits, digits));
  const metric = (value, unit, label = '') => ({ value, unit, label, state: finite(value) ? 'available' : 'pending', reason: finite(value) ? null : '当前来源不足以完整判定' });
  const stateText = () => '—';
  const valueText = (item, digits = 0) => available(item) ? number(item.unit === '元' ? item.value / 10000 : item.value, digits) : stateText(item);
  const reason = item => [item?.reason, ...(item?.notes || [])].filter(Boolean).join('；');
  const extra = (module, label) => module.extra.find(item => item.label === label);
  const cross = (module, key) => module.crossMetrics.find(item => item.key === key);
  const unitText = item => item?.unit === '元' ? '万元' : item?.unit || '';
  const negative = item => available(item) && item.value < 0;
  function Value({ item, digits = 0, unit = unitText(item), className = '' }) {
    return el('span', { className: `${className}${negative(item) ? ' is-negative' : ''}`, 'data-state': item?.state, title: reason(item), 'aria-label': available(item) ? undefined : reason(item) || '待确认' },
      valueText(item, digits), available(item) && unit && el('small', {}, unit));
  }
  function Growth({ item, label = '' }) {
    const text = available(item) ? `${item.value > 0 ? '↑ ' : item.value < 0 ? '↓ ' : ''}${number(Math.abs(item.value), 1)}%` : '—';
    return el('span', { className: 'ov-growth', title: [item?.label, reason(item)].filter(Boolean).join('；'), 'aria-label': `${item?.label || '同比'} ${available(item) ? text : reason(item) || '待确认'}`, 'data-state': item?.state },
      el('em', { className: available(item) ? item.value > 0 ? 'is-up' : item.value < 0 ? 'is-down' : 'is-flat' : 'is-pending' }, text), label && el('span', {}, label));
  }
  function Comparison({ item, opening = false }) {
    return el('span', { className: `ov-comparison${opening ? ' ov-comparison-inline' : ''}` },
      el(Growth, { item, label: '同比' }), el('span', { className: 'ov-previous', title: reason(item) }, opening ? '去年同期 ' : '去年同期 ',
        el(Value, { item: item?.previous, digits: opening ? 0 : 2, unit: opening ? '瓶' : '万' })));
  }
  function Stat({ label, name, item, digits = 0, unit, growth }) {
    return el('div', { title: [item?.label, reason(item)].filter(Boolean).join('；') }, el('span', {}, label),
      el('b', { 'data-hero-metric': name, 'data-state': item?.state, className: `${name === 'negative' ? 'ov-negative-amount' : negative(item) ? 'is-negative' : ''} ${!available(item) ? 'is-pending' : ''}` },
        el(Value, { item, digits, unit })), growth && el(Growth, { item: growth }));
  }
  function MonthlyChart({ points, kind, filters, drill }) {
    const valid = points.flatMap(item => [item.current, item.previous]).filter(available);
    const max = Math.max(0, ...valid.map(item => item.value)), min = Math.min(0, ...valid.map(item => item.value)), span = max - min || 1, zero = -min / span * 100;
    const negativeMax = Math.max(1, ...points.map(p => available(p.current) ? Math.abs(p.current.negative || 0) : 0));
    const year = Number(filters.month.slice(0, 4));
    const bar = (item, prior) => available(item) && el('i', { className: `${prior ? 'ov-prior-net' : 'ov-net'}${item.value < 0 ? ' is-negative' : ''}`,
      'data-value': item.value, style: { bottom: `${zero + Math.min(0, item.value) / span * 100}%`, height: `${Math.abs(item.value) / span * 100}%`, minHeight: '1px' } });
    return el(g.Fragment, {},
      el('div', { className: 'ov-chart-header', title: '净额保留正负方向，两年共用刻度；底部斜纹单独展示当年负金额，使用独立刻度，不与净额柱相加。缺失不补零。' },
        el('span', {}, min < 0 ? '月度对比 · 含负净额' : '月度对比'),
        el('span', { className: 'ov-chart-legend' }, el('span', {}, el('i', { className: 'ov-year-swatch' }), year), el('span', {}, el('i', { className: 'ov-prior-swatch' }), year - 1), el('span', {}, el('i', { className: 'ov-negative-swatch' }), '负金额'))),
      el('div', { className: 'ov-chart', 'aria-label': `${model.titles[kind]}月度对比；两年净额同刻度，底部负金额独立刻度` }, ...points.map(({ month: key, current: item, previous }) => {
        const month = Number(key.slice(5)), current = key === filters.month, pickable = model.months.includes(key), deduction = available(item) && finite(item.negative) && item.negative < 0;
        const title = `${key}：净额 ${valueText(item, 2)} 万元${!available(item) ? `（${reason(item)}）` : ''}；上年同期 ${valueText(previous, 2)} 万元；负金额 ${available(item) ? number((item.negative || 0) / 10000, 2) : '—'} 万元（底部独立刻度）${item.range ? `；当年期间 ${item.range.start} 至 ${item.range.end}` : ''}${previous.range ? `；去年期间 ${previous.range.start} 至 ${previous.range.end}` : ''}；${pickable ? '点击切换月份' : '本月无可选来源'}`;
        return el('button', { key, type: 'button', disabled: !pickable, className: `ov-month${current ? ' is-current' : ''}`, 'data-overview-month': key, 'aria-pressed': current, 'aria-label': title, title,
          onClick: event => { event.stopPropagation(); if (pickable) drill('month', key); } },
          el('span', { className: 'ov-column' },
            el('span', { className: 'ov-net-lane' }, el('span', { className: 'ov-zero', style: { bottom: `${zero}%` } }), bar(previous, true), bar(item, false),
              current && available(item) && el('b', { className: 'ov-net-label', style: { bottom: `${(item.value - min) / span * 100}%` } }, number(item.value / 10000))),
            el('span', { className: 'ov-negative-lane', 'aria-hidden': true }, deduction && el('i', { className: 'ov-deduction', 'data-value': item.negative, style: { height: `${Math.max(2, Math.abs(item.negative) / negativeMax * 22)}px` } }),
              current && deduction && el('b', { className: 'ov-negative-label' }, number(item.negative / 10000))),
            !available(item) && !available(previous) && el('span', { className: 'ov-missing', 'data-state': item.state }, '—')),
          el('span', { className: 'ov-month-label' }, `${month}月`));
      })), el('span', { className: 'ov-chart-note' }, '底部斜纹为负金额 · 独立刻度'));
  }
  function Hero({ kind, data, comparison, filters, open, drill }) {
    const module = data.modules[kind], view = presentation.describe(kind, data, filters), movement = kind === 'movement';
    const ytdRatio = cross(module, 'invoiceMovementYtdRatio');
    const ytd = extra(module, '当年截至所选月来源金额'), negativeAmount = extra(module, '负金额合计');
    return el('article', { className: `overview-card ov-${kind} ov-hero`, style: { '--hero-accent': module.color }, role: 'button', tabIndex: 0, 'aria-label': `查看${module.title}详情`,
      onClick: () => open(kind), onKeyDown: event => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); open(kind); } } },
      el('div', { className: 'ov-heading' }, el('i', { className: 'ov-dot', 'aria-hidden': true }), el('h2', {}, module.title), el('span', { className: 'ov-action' }, '详情 →')),
      el('p', { className: 'ov-label' }, module.main.label),
      el('div', { className: 'ov-hero-values' }, el('div', { className: 'ov-value', 'data-metric': kind }, el(Value, { item: module.main, digits: 2 })), el(Comparison, { item: comparison.yoy })),
      el('div', { className: 'ov-stats' },
        el(Stat, { label: '年累计', name: 'ytd', item: ytd, digits: 2, unit: '万', growth: comparison.ytdYoY }),
        el(Stat, { label: model.periodOf(filters).mode === 'range' ? '区间负金额' : '当月负金额', name: 'negative', item: negativeAmount, digits: 2, unit: '万' }),
        el(Stat, { label: movement ? '扫码终端' : '经销商', name: 'count', item: view.kpis[4], unit: '家' }),
        movement ? el(Stat, { label: '累计动销比', name: 'ratio', item: ytdRatio, digits: 1, unit: '%' })
          : el(Stat, { label: '达成率', name: 'attainment', item: view.kpis[5], digits: 1 })),
      el(MonthlyChart, { points: comparison.monthly, kind, filters, drill }));
  }
  function Auxiliary({ label, item, digits = 0, unit = '' }) {
    return el('span', { title: [item?.label, reason(item)].filter(Boolean).join('；') }, label,
      el('b', { className: negative(item) ? 'is-negative' : '', 'data-state': item?.state }, el(Value, { item, digits, unit })));
  }
  function Operations({ data, open }) {
    const terminal = data.modules.terminal, inventory = data.modules.inventory, banquet = data.modules.banquet;
    const inventoryVisit = inventory.inventoryMode === 'visit-history';
    const totals = terminal.structure?.totals || {};
    const terminalEffective = extra(terminal, '有效终端数'), terminalRate = extra(terminal, '有效率');
    const inventoryDifference = { label: '盘点减系统金额差额', unit: '元', value: null,
      state: inventory.state === 'unavailable' ? 'missing' : 'pending',
      reason: inventory.state === 'unavailable' ? '未接入有效库存来源' : '两类库存金额的计价与估值基础尚未确认，暂不计算金额差额' };
    const cover = model.payload.coverage.banquet;
    const fixedPeriod = cover?.start && cover?.end ? cover.start.slice(0, 4) === cover.end.slice(0, 4)
      ? `${Number(cover.start.slice(5, 7))}–${Number(cover.end.slice(5, 7))} 月固定`
      : `${cover.start.slice(0, 7)} 至 ${cover.end.slice(0, 7)} 固定` : '固定期间待确认';
    const entries = [
      { module: terminal, auxiliary: el(g.Fragment, {}, el(Auxiliary, { label: '有效终端', item: terminalEffective }),
        el('span', { className: 'ov-tag', title: reason(terminalRate) }, '有效率 ', el(Value, { item: terminalRate, digits: 1, unit: '%' }))), note: `${number(totals.agreements)} 份协议；不随产品筛选` },
      inventoryVisit ? { module: inventory, main: inventory.main, digits: 0,
        auxiliary: el(g.Fragment, {}, el(Auxiliary, { label: '系统', item: extra(inventory, '所选记录系统瓶数合计'), unit: '瓶' }),
          el(Auxiliary, { label: '盘点与系统差异', item: extra(inventory, '盘点减系统差异合计'), unit: '瓶' })),
        note: `${inventory.period}；最近一次已知盘点，单位瓶；不随品牌／品类筛选` }
      : { module: inventory, main: extra(inventory, '所选记录盘点金额合计'), digits: 2,
        auxiliary: el(g.Fragment, {}, el(Auxiliary, { label: '系统', item: extra(inventory, '所选记录系统金额合计'), digits: 2, unit: '万' }),
        el(Auxiliary, { label: '差额', item: inventoryDifference }), el(Auxiliary, { label: '可销', item: cross(inventory, 'inventorySellableMonths'), digits: 1, unit: '月' })), note: `${inventory.period}；盘点金额与系统金额按来源分别展示，单位万元` },
      { module: banquet, auxiliary: el(g.Fragment, {}, el(Auxiliary, { label: '开瓶', item: extra(banquet, '固定期间宴席开瓶') }),
        el(Auxiliary, { label: '场均', item: extra(banquet, '场均开瓶'), digits: 1, unit: '瓶' }), el('span', { title: banquet.period }, fixedPeriod)), note: banquet.period },
    ];
    return el('section', { className: 'overview-card ov-operations', 'aria-label': '签约、库存与宴席' },
      ...entries.map(({ module, main = module.main, digits = 0, auxiliary, note }) => el('button', { key: module.id, type: 'button', className: `ov-operation ov-${module.id}`, onClick: () => open(module.id), 'aria-label': `查看${module.title}详情`, title: note },
        el('span', { className: 'ov-operation-heading' }, el('i', { className: 'ov-dot', style: { background: module.color } }), module.title, el('span', { className: 'ov-action' }, '→')),
        el('span', { className: 'ov-secondary-value', 'data-metric': module.id }, el(Value, { item: main, digits })), el('span', { className: 'ov-kv' }, auxiliary))));
  }
  function DayChange({ item }) {
    const day = date => date ? `${Number(date.slice(5, 7))}/${Number(date.slice(8))}` : '—';
    const bottles = value => finite(value) ? `${number(value)} 瓶` : '—';
    const diff = finite(item?.difference) ? `${item.difference > 0 ? '+' : ''}${number(item.difference)} 瓶` : '';
    const label = `${day(item?.date)} 较 ${day(item?.previousDate)}`;
    const detail = [`${item?.date || '末日'}：${bottles(item?.current)}`, `${item?.previousDate || '昨日'}：${bottles(item?.previous)}`, diff && `变化 ${diff}`, reason(item)].filter(Boolean).join('；');
    return el('span', { className: 'ov-day-change', 'data-state': item?.state, title: detail, 'aria-label': `较昨日开瓶 ${detail}` },
      el(Growth, { item, label }), el('span', { className: 'ov-day-values' }, bottles(item?.current), el('small', {}, ` / 昨日 ${bottles(item?.previous)}`)));
  }
  function Opening({ data, description, open }) {
    const module = data.modules.opening, points = description.openingDaily, previous = description.openingPreviousDaily;
    const valid = [...points, ...previous].filter(available), max = Math.max(0, ...valid.map(item => item.value)), min = Math.min(0, ...valid.map(item => item.value)), range = max - min || 1;
    const x = index => 3 + index * 394 / Math.max(points.length - 1, 1), y = value => 74 - (value - min) / range * 68, baseline = y(0);
    const paths = (series, prior) => {
      const segments = []; let segment = [];
      series.forEach((item, index) => { if (available(item)) segment.push({ item, index }); else if (segment.length) { segments.push(segment); segment = []; } });
      if (segment.length) segments.push(segment);
      return segments.map((part, index) => {
        const line = part.map(({ item, index: i }, at) => `${at ? 'L' : 'M'} ${x(i)} ${y(item.value)}`).join(' ');
        return el('g', { key: `${prior}-${index}` },
          !prior && el('path', { d: `${line} L ${x(part.at(-1).index)} ${baseline} L ${x(part[0].index)} ${baseline} Z`, fill: 'url(#ov-opening-fill)' }),
          el('path', { d: line, fill: 'none', stroke: prior ? '#aab3bd' : '#4a6f94', strokeWidth: prior ? 1.2 : 1.6, strokeDasharray: prior ? '3 3' : undefined, vectorEffect: 'non-scaling-stroke', 'data-opening-series': prior ? 'previous' : 'current' }),
          part.length === 1 && el('circle', { cx: x(part[0].index), cy: y(part[0].item.value), r: 1.5, fill: prior ? '#aab3bd' : '#4a6f94' }));
      });
    };
    const first = points[0]?.date, last = points.at(-1)?.date, year = first?.slice(0, 4);
    const ticks = [...new Set([first && Number(first.slice(8)), 10, 20, last && Number(last.slice(8))])].filter(day => first && day >= Number(first.slice(8)) && day <= Number(last.slice(8))).sort((a, b) => a - b);
    return el('button', { type: 'button', className: 'overview-card ov-opening', 'aria-label': '查看消费者开瓶详情', onClick: () => open('opening') },
      el('span', { className: 'ov-heading' }, el('i', { className: 'ov-dot' }), el('span', {}, module.title), el('span', { className: 'ov-action' }, '→')),
      el('span', { className: 'ov-opening-value' }, el('span', { className: 'ov-secondary-value', 'data-metric': 'opening' }, el(Value, { item: module.main }))),
      el(Comparison, { item: description.openingYoY, opening: true }),
      el(DayChange, { item: description.openingGrowth }),
      valid.length ? el('svg', { className: 'ov-sparkline', viewBox: '0 0 400 80', preserveAspectRatio: 'none', role: 'img', 'aria-label': `${description.openingPeriod}每日开瓶；两年按相同日期比较，缺日断开` },
        el('defs', {}, el('linearGradient', { id: 'ov-opening-fill', x1: '0', y1: '0', x2: '0', y2: '1' }, el('stop', { offset: '0', stopColor: '#4a6f94', stopOpacity: .16 }), el('stop', { offset: '1', stopColor: '#4a6f94', stopOpacity: 0 }))),
        ...paths(previous, true), ...paths(points, false)) : el('span', { className: 'ov-spark-empty' }, '—'),
      el('span', { className: 'ov-day-axis', title: description.openingPeriod }, ...ticks.map(day => el('span', { key: day }, `${day}日`))),
      el('span', { className: 'ov-opening-legend', title: `${description.openingPeriod}；${reason(description.openingYoY)}；组织口径，不随产品筛选` },
        el('span', {}, el('i', {}), year || '本年'), el('span', { className: previous.some(available) ? '' : 'is-pending' }, el('i', { className: 'is-prior' }), year ? Number(year) - 1 : '上年'), el('span', {}, '不随产品筛选')));
  }
  function Regions({ items, filters, groupField, drill }) {
    const modes = [['movement', '动销/发票'], ['terminal', '签约有效率'], ['opening', '开瓶']];
    const [mode, setMode] = g.useState('movement'), listRef = g.useRef(null);
    const scopeKey = JSON.stringify([filters.month, filters.period, filters.start, filters.end, filters.region, filters.office, filters.unit, filters.product]);
    g.useLayoutEffect(() => { listRef.current?.scrollTo({ top: 0, behavior: 'instant' }); }, [scopeKey]);
    const rows = [...items].sort((a, b) => (available(b.invoice) ? b.invoice.value : -Infinity) - (available(a.invoice) ? a.invoice.value : -Infinity) || a.name.localeCompare(b.name, 'zh-CN'));
    const title = filters.unit !== 'all' ? '当前单元经营' : filters.region !== 'all' ? '下级经营一览' : '区域经营一览';
    const level = groupField === 'region' ? '大区' : groupField === 'office' ? '办事处' : '主任单元';
    const range = rows.find(row => row.openingTotal.range?.end >= row.openingTotal.range?.start)?.openingTotal.range;
    const openingPeriod = range ? `${range.start} 至 ${range.end}` : '共同期间待确认';
    const subtitle = mode === 'opening' ? `年累计 · ${openingPeriod}` : mode === 'terminal' ? `${model.periodOf(filters).mode === 'range' ? `截至 ${model.periodOf(filters).end}` : '截至所选月末'} · 按终端去重` : `${model.periodOf(filters).mode === 'range' ? model.periodOf(filters).label : `${Number(filters.month.slice(5)) || '当前'} 月`} · 点击${level}下钻`;
    const pairs = mode === 'terminal' ? [['signed', '签约'], ['effectiveCount', '有效']] : [['invoice', '发票'], ['movement', '动销']];
    const values = rows.flatMap(row => pairs.map(([key]) => row[key]).filter(available).map(item => item.value));
    const max = Math.max(0, ...values), min = Math.min(0, ...values), span = max - min || 1, zero = -min / span * 100;
    const field = (row, key, digits = 0, unit = '', alert = false) => el('span', { className: `ov-number${alert ? ' is-alert' : ''}`, 'data-region-metric': key }, el(Value, { item: row[key], digits, unit }), ['invoice', 'movement', 'openingTotal'].includes(key) && el(Growth, { item: row[key === 'openingTotal' ? 'openingYoY' : `${key}YoY`] }));
    const bar = row => el('span', { className: 'ov-region-bars', 'aria-label': pairs.map(([key, label]) => `${label} ${valueText(row[key], mode === 'movement' ? 2 : 0)} ${available(row[key]) ? unitText(row[key]) : reason(row[key])}`).join('；') },
      ...pairs.map(([key, label]) => el('span', { key, className: 'ov-region-bar-track', title: `${label}：${valueText(row[key], mode === 'movement' ? 2 : 0)} ${available(row[key]) ? unitText(row[key]) : reason(row[key])}` },
        min < 0 && el('s', { style: { left: `${zero}%` } }), available(row[key])
          ? el('i', { className: `ov-${key}-bar${negative(row[key]) ? ' is-negative' : ''}`, style: { left: `${row[key].value >= 0 ? zero : zero + row[key].value / span * 100}%`, width: `${Math.abs(row[key].value) / span * 100}%`, minWidth: row[key].value === 0 ? '1px' : undefined } })
          : el('em', { 'data-state': row[key].state }, '—'))));
    function onTabKey(event, index) {
      const next = event.key === 'ArrowRight' ? (index + 1) % modes.length : event.key === 'ArrowLeft' ? (index + modes.length - 1) % modes.length : event.key === 'Home' ? 0 : event.key === 'End' ? modes.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); setMode(modes[next][0]); event.currentTarget.parentElement.children[next].focus();
    }
    return el('section', { className: `overview-card ov-regional ov-region-${mode}`, 'aria-label': title, 'data-region-view': mode },
      el('div', { className: 'ov-region-header' }, el('div', { className: 'ov-heading' }, el('i', { className: 'ov-dot' }), el('h2', {}, title), el(UpLevel, { filters, drill, compact: true })),
        el('span', { className: 'ov-region-note', title: subtitle }, subtitle),
        el('div', { className: 'ov-region-tabs', role: 'tablist', 'aria-label': '区域经营视图' }, ...modes.map(([key, label], index) => el('button', {
          key, id: `ov-region-tab-${key}`, type: 'button', role: 'tab', tabIndex: mode === key ? 0 : -1,
          'aria-selected': mode === key, 'aria-controls': 'ov-region-panel', onClick: () => setMode(key), onKeyDown: event => onTabKey(event, index),
        }, label)))),
      el('div', { className: 'ov-region-columns' }, el('span', {}), el('span', {}, level),
        ...(mode === 'opening' ? [el('span', { key: 'total' }, '总开瓶数 / 瓶'), el('span', { key: 'rate' }, '总开瓶率')]
          : [el('span', { key: 'legend', className: 'ov-pair-legend' }, ...pairs.map(([key, label]) => el('span', { key }, el('i', { className: `ov-${key}-bar` }), label))),
            el('span', { key: 'first' }, mode === 'terminal' ? '签约数 / 家' : '发票 / 万元'), el('span', { key: 'second' }, mode === 'terminal' ? '有效数 / 家' : '动销 / 万元'), el('span', { key: 'rate' }, mode === 'terminal' ? '签约有效率' : '动销/发票')])),
      el('div', { className: 'ov-region-list', ref: listRef, id: 'ov-region-panel', role: 'tabpanel', tabIndex: 0, 'aria-labelledby': `ov-region-tab-${mode}`, 'aria-label': `${level}列表，可纵向滚动查看全部组织` },
        ...rows.map((row, index) => el('button', { key: row.key, type: 'button', className: 'ov-region-row', disabled: !row.drillable, 'data-region-key': row.key,
          'aria-label': `${row.drillable ? '筛选' : '查看'}${row.name}`, title: row.fullName, onClick: () => row.drillable && drill(groupField, row.key) },
          el('span', { className: 'ov-rank' }, String(index + 1).padStart(2, '0')),
          el('span', { className: 'ov-region-name', title: row.fullName }, el('strong', {}, row.name),
            mode === 'movement' ? el('small', { title: reason(row.invoiceShare) }, '发票占比 ', el(Value, { item: row.invoiceShare, digits: 1, unit: '%' }))
              : el('small', {}, mode === 'terminal' ? '签约终端 · 家' : '年累计 · 共同期间')),
          ...(mode === 'opening' ? [field(row, 'openingTotal'), field(row, 'openingRate', 1, '%')]
            : [bar(row), field(row, pairs[0][0], mode === 'movement' ? 2 : 0), field(row, pairs[1][0], mode === 'movement' ? 2 : 0),
              mode === 'terminal' ? field(row, 'effectiveRate', 1, '%') : field(row, 'ratio', 0, '%', available(row.ratio) && row.ratio.value > 300)]))),
        !rows.length && el('p', { className: 'ov-empty' }, '当前范围暂无组织来源记录')),
      el('div', { className: 'ov-region-foot' }, el('span', {}, mode === 'opening' ? '累计同比 · 不随产品筛选 · — 表示待确认或缺失' : '金额下方为同比 · — 表示待确认或缺失'),
        rows.length > 3 && el('span', {}, '向下滚动查看更多')));
  }
  const shiftDay = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  // One step up the organization drill: unit → office → region → all, then a
  // selected product. Shown wherever a drill can narrow the scope.
  function upLevel(filters) {
    if (filters.unit !== 'all') return { key: 'unit', label: model.label(filters.office) };
    if (filters.office !== 'all') return { key: 'office', label: model.label(filters.region) };
    if (filters.region !== 'all') return { key: 'region', label: '全战区' };
    if (filters.product && filters.product !== 'all') return { key: 'product', label: '全部产品' };
    return null;
  }
  function UpLevel({ filters, drill, compact = false }) {
    const step = upLevel(filters);
    if (!step) return null;
    return el('button', { type: 'button', className: `up-level${compact ? ' is-compact' : ''}`, title: `返回上一级：${step.label}`, 'aria-label': `返回上一级：${step.label}`,
      onClick: event => { event.stopPropagation(); drill(step.key, 'all'); } }, '‹ 返回上一级', !compact && el('small', {}, step.label));
  }
  // Date range bar: start, end, quick picks, apply and reset. Month mode is
  // the default; the inputs then show the selected month's days.
  function PeriodFilter({ filters, drill, detail }) {
    const period = model.periodOf(filters), bounds = model.dateBounds, range = period.mode === 'range';
    const shown = period.mode === 'fixed' ? { start: '', end: '' } : { start: period.start, end: bounds ? [period.end, bounds.max].sort()[0] : period.end };
    const [draft, setDraft] = g.useState(shown);
    const key = JSON.stringify([period.mode, period.start, period.end]);
    g.useEffect(() => setDraft(shown), [key]);
    const clamp = start => bounds ? [start, bounds.min].sort().at(-1) : start;
    const max = bounds?.max;
    const quick = max ? [['近7天', clamp(shiftDay(max, -6)), max], ['近30天', clamp(shiftDay(max, -29)), max], ['本月', clamp(`${max.slice(0, 7)}-01`), max]] : [];
    const issue = !isDate(draft.start) || !isDate(draft.end) ? '请选择开始和结束日期' : draft.start > draft.end ? '开始日期不能晚于结束日期'
      : bounds && (draft.end < bounds.min || draft.start > bounds.max) ? `超出来源日期 ${bounds.min} 至 ${bounds.max}` : null;
    const changed = draft.start !== shown.start || draft.end !== shown.end || !range;
    const apply = value => { const next = value || draft; if (isDate(next.start) && isDate(next.end) && next.start <= next.end) drill('range', next); };
    const active = item => range && period.start === item[1] && period.end === item[2];
    const field = (label, keyName) => el('label', { className: 'period-date' }, el('span', {}, label),
      el('input', { type: 'date', value: draft[keyName], min: bounds?.min, max, onChange: event => {
        const next = { ...draft, [keyName]: event.target.value };
        setDraft(next);
        if (detail && isDate(next.start) && isDate(next.end) && next.start <= next.end && next.start >= bounds?.min && next.end <= max) apply(next);
      }, onKeyDown: event => { if (!detail && event.key === 'Enter' && !issue) apply(); } }));
    return el('div', { className: `period-bar${range ? ' is-range' : ''}`, role: 'group', 'aria-label': '时间范围' },
      el('span', { className: 'period-title' }, el('svg', { viewBox: '0 0 24 24', 'aria-hidden': true }, el('rect', { x: 3, y: 5, width: 18, height: 16, rx: 2 }), el('path', { d: 'M3 10h18M8 3v4m8-4v4' })), '时间'),
      el('div', { className: 'period-range' }, field('开始', 'start'), el('span', { className: 'period-arrow', 'aria-hidden': true }, '→'), field('结束', 'end')),
      el('div', { className: 'period-quick', role: 'group', 'aria-label': '快捷时间' }, ...quick.map(item => el('button', { key: item[0], type: 'button', className: active(item) ? 'is-active' : '', 'aria-pressed': active(item), onClick: () => apply({ start: item[1], end: item[2] }) }, item[0])),
        !detail && el('button', { key: 'default', type: 'button', className: `period-reset${!range && filters.month === model.defaults.month ? ' is-active' : ''}`, 'aria-pressed': !range && filters.month === model.defaults.month, onClick: () => { setDraft(shown); drill('month', model.defaults.month); } }, '恢复默认')),
      !detail && el('button', { type: 'button', className: 'period-apply', disabled: Boolean(issue) || !changed, title: issue || undefined, onClick: () => apply() }, '应用'),
      el('button', { type: 'button', className: 'period-clear', title: '全部重置：时间回到最新月份，组织和产品回到全部', 'aria-label': '全部重置', onClick: () => { drill('region', 'all'); drill('product', 'all'); drill('month', model.defaults.month); } }, '↺'),
      el('span', { className: `period-note${issue && changed ? ' is-error' : ''}`, 'aria-live': 'polite' }, issue && changed ? issue : range ? `${period.days} 天 · 签约、库存取末日状态` : `${period.label}${bounds ? ` · 数据至 ${bounds.max.slice(5)}` : ''}`));
  }
  function Overview({ data, filters, open, drill }) {
    const description = g.useMemo(() => adapter.describe(data, filters), [data, filters]);
    return el('div', { className: 'overview-shell', 'aria-label': '战区经营总览六板块' },
      el(Hero, { kind: 'invoice', data, comparison: description.heroes.invoice, filters, open, drill }), el(Hero, { kind: 'movement', data, comparison: description.heroes.movement, filters, open, drill }),
      el(Operations, { data, open }), el(Opening, { data, description, open }),
      el(Regions, { items: description.regional, filters, groupField: data.groupField, drill }));
  }
  return { Overview, PeriodFilter, UpLevel };
}
