// Serialized into the offline document. Keep this factory self-contained.
export function createV10Details({ T, g, model, presentation, charts }) {
  const el = (tag, props, ...children) => {
    const { key, ...attributes } = props || {};
    return (children.length > 1 && T.jsxs ? T.jsxs : T.jsx)(tag, { ...attributes, children: children.length === 1 ? children[0] : children }, key);
  };
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const list = value => Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
  const available = metric => metric && metric.state === 'available' && finite(metric.value);
  const metric = (value, unit = '', label = '') => typeof value === 'object' && value !== null ? value : { value, unit, label, state: finite(value) ? 'available' : 'pending' };
  const unit = item => item?.unit === '元' ? '万元' : item?.unit || '';
  const numeric = item => item?.unit === '元' ? item.value / 10000 : item.value;
  const valueText = item => available(item) ? model.format(numeric(item), item.displayPrecision ?? (item.unit === '元' || item.unit?.includes('/') || item.unit === '%' || item.unit === '月' ? 2 : 0), item.displayPrecision ?? (item.unit === '元' || item.unit?.includes('/') || item.unit === '%' || item.unit === '月' ? 2 : 6)) : item?.state === 'missing' ? '无记录' : item?.state === 'unavailable' ? '不可用' : '待确认';
  const reason = item => item?.reason || (available(item) ? '' : '当前来源未提供完整的计算依据');
  const name = item => item?.name || item?.label || '未提供名称';
  const english = { invoice: 'INVOICE SALES', movement: 'TERMINAL SALES', opening: 'CONSUMER OPENINGS', inventory: 'INVENTORY CHECK', banquet: 'BANQUET ACTIVITY' };
  const descriptions = {
    invoice: '当月净额与年累计、开票节奏、组织和产品贡献、经销商集中度。',
    movement: '扫码金额与开票对比、组织和产品贡献、终端渠道与集中度。',
    opening: '开瓶节奏、现金红包、开瓶与动销的来源数量比及城市分布。',
    inventory: '当前导出记录的盘点规模、提交节奏、差异与产品结构。',
    banquet: '来源固定期间的宴席场次、开瓶、场均开瓶及组织表现。',
  };
  const tones = { invoice: 'inv', movement: 'mv', opening: 'op', inventory: 'stk', banquet: 'bq' };
  const moveTab = (event, ids, current, select) => {
    const at = ids.indexOf(current);
    const next = event.key === 'ArrowRight' ? (at + 1) % ids.length : event.key === 'ArrowLeft' ? (at + ids.length - 1) % ids.length : event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); select(ids[next]); event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[next]?.focus();
  };
  function Empty({ text = '当前范围无可展示记录。' }) { return el('p', { className: 'inv-empty v10-empty' }, text); }
  function Heading({ title, note }) { return el('div', { className: 'section-title' }, el('h3', {}, title), note && el('span', {}, note)); }
  function MetricValue({ item, suffix = true }) {
    return el(g.Fragment, {}, valueText(item), suffix && available(item) && unit(item) && el('small', {}, unit(item)));
  }
  function Kpis({ items }) {
    return el('div', { className: 'detail-kpis inv-kpis' }, ...list(items).map((item, index) => el('div', { key: item.key || item.label || index, className: !available(item) ? 'pending' : index === 0 ? 'main' : item.value < 0 ? 'neg' : '', 'data-state': item.state },
      el('span', {}, item.label || item.name), el('strong', {}, el(MetricValue, { item })), el('em', { title: [item.reason, item.note, ...(item.notes || [])].filter(Boolean).join('；') }, available(item) ? item.note || '' : reason(item)),
    )));
  }
  function MonthlyChart({ points, kind, filters, drill }) {
    const entries = list(points), values = entries.flatMap(item => [available(item) ? item.value : null, finite(item.negative) ? item.negative : null, finite(item.comparison) ? item.comparison : null]).filter(finite);
    const positive = Math.max(0, ...values), negative = Math.min(0, ...values), range = positive - negative || 1;
    const zero = -negative / range * 100;
    const isMoney = entries.some(item => item.unit === '元');
    return el(g.Fragment, {},
      el('div', { className: `inv-months full v10-months ${kind === 'movement' ? 'mv' : ''}`, style: { '--month-count': Math.max(entries.length, 1) }, 'aria-label': kind === 'inventory' ? '盘点提交记录月度分布' : '月度来源趋势' },
        ...entries.map((item, index) => {
          const key = item.month || item.key, month = Number(String(key).slice(-2));
          const selected = key === filters.month, canPick = /^\d{4}-\d{2}$/.test(key || '');
          const multipleYears = new Set(entries.map(point => point.month?.slice(0, 4)).filter(Boolean)).size > 1;
          const label = canPick ? multipleYears ? `${key.slice(0,4)}/${month}` : `${month}月` : item.label || String(key || index + 1);
          const bar = (value, cls) => finite(value) && el('i', { className: cls, style: { bottom: `${value >= 0 ? zero : zero + value / range * 100}%`, height: `${Math.abs(value) / range * 100}%` } });
          return el('button', { key: key || index, type: 'button', className: `inv-m ${month % 3 === 0 ? 'q' : ''} ${selected ? 'sel' : ''} ${canPick ? 'pick' : ''} ${available(item) && item.value < 0 ? 'is-negative' : ''}`, disabled: !canPick, onClick: () => canPick && drill('month', key), 'aria-label': `${label}：${valueText(item)} ${available(item) ? unit(item) : reason(item)}${canPick ? '，点击切换月份' : ''}`, title: [label, `${valueText(item)} ${available(item) ? unit(item) : ''}`, item.note, reason(item)].filter(Boolean).join(' · ') },
            el('em', { 'data-state': item.state }, available(item) ? kind === 'opening' ? model.format(item.value / 10000, 1) : model.format(numeric(item), 0, isMoney ? 0 : 2) : '—'),
            el('div', { className: 'bar' }, el('span', { className: 'v10-zero', style: { bottom: `${zero}%` } }), available(item) && bar(item.value, 'net'), finite(item.negative) && item.negative !== 0 && bar(item.negative, 'ded'), finite(item.comparison) && el('s', { style: { bottom: `${zero + item.comparison / range * 100}%` }, title: `同月发票：${model.format(item.comparison / 10000, 2)} 万元` }), !available(item) && el('span', { className: 'v10-missing-mark' }, '—')),
            el('span', {}, label),
            kind === 'opening' && el('small', { title: `现金红包：${valueText(item.cashAmount)} ${available(item.cashAmount) ? unit(item.cashAmount) : reason(item.cashAmount)}`, 'data-state': item.cashAmount?.state }, valueText(item.cashAmount), available(item.cashAmount) ? ' 万元' : ''),
          );
        }),
      ),
      entries.length === 0 && el(Empty, {}),
      el('div', { className: `inv-legend ${kind === 'movement' ? 'mv' : ''}` },
        el('span', {}, el('i', { className: 'l-net' }), kind === 'inventory' ? '提交记录' : kind === 'opening' ? '开瓶瓶数' : '净额'),
        entries.some(item => finite(item.negative) && item.negative !== 0) && el('span', {}, el('i', { className: 'l-ded' }), kind === 'invoice' ? '负金额' : '负金额'),
        entries.some(item => finite(item.comparison)) && el('span', {}, el('i', { className: 'l-cmp' }), '同月发票净额'),
        el('b', {}, `单位：${kind === 'opening' ? '万瓶（柱顶）；万元（现金红包）' : unit(entries[0]) || '来源单位'} · 点击柱子切换月份；缺失不补零`),
      ),
    );
  }
  function DailyChart({ points, color, title }) {
    const entries = list(points), valid = entries.filter(available);
    if (!valid.length) return el(Empty, { text: entries.find(item => item.reason)?.reason || '当前范围没有可绘制的日期来源。' });
    const values = valid.map(numeric), max = Math.max(0, ...values), min = Math.min(0, ...values), span = max - min || 1;
    const width = 720, left = 54, right = 12, top = 15, bottom = 174, baseline = top + max / span * (bottom - top);
    const x = index => left + index / Math.max(entries.length - 1, 1) * (width - left - right);
    const y = item => top + (max - numeric(item)) / span * (bottom - top);
    const segments = []; let segment = [];
    entries.forEach((item, index) => { if (available(item)) segment.push({ item, index }); else if (segment.length) { segments.push(segment); segment = []; } });
    if (segment.length) segments.push(segment);
    const ticks = [...new Set([0, Math.floor((entries.length - 1) / 4), Math.floor((entries.length - 1) / 2), Math.floor((entries.length - 1) * .75), entries.length - 1])];
    return el('div', { className: 'v10-daily-chart' },
      el('svg', { viewBox: `0 0 ${width} 206`, role: 'img', 'aria-label': `${title}；单位${unit(valid[0])}；缺少来源的日期不连接` },
        el('title', {}, title),
        ...[0, .5, 1].map(fraction => {
          const yy = top + fraction * (bottom - top), value = max - fraction * span;
          return el('g', { key: fraction }, el('line', { x1: left, x2: width - right, y1: yy, y2: yy, stroke: '#e6ebf0', strokeDasharray: '3 5' }), el('text', { x: left - 7, y: yy + 4, textAnchor: 'end', className: 'v10-axis-label' }, model.format(value, 0)));
        }),
        el('line', { x1: left, x2: width - right, y1: baseline, y2: baseline, stroke: '#d8e0e6' }),
        ...segments.map((part, index) => {
          const line = part.map(({ item, index: i }, at) => `${at ? 'L' : 'M'} ${x(i)} ${y(item)}`).join(' ');
          return el('g', { key: index }, el('path', { d: `${line} L ${x(part.at(-1).index)} ${baseline} L ${x(part[0].index)} ${baseline} Z`, fill: color, fillOpacity: '.09' }), el('path', { d: line, fill: 'none', stroke: color, strokeWidth: '2' }));
        }),
        ...entries.filter(available).map(item => { const index = entries.indexOf(item); return el('circle', { key: item.key || item.date || index, cx: x(index), cy: y(item), r: '3', fill: color, tabIndex: 0 }, el('title', {}, `${item.date || item.label || item.key}：${valueText(item)} ${unit(item)}`)); }),
        ...ticks.map(index => el('text', { key: index, x: x(index), y: 197, textAnchor: 'middle', className: 'v10-axis-label' }, entries[index]?.label || entries[index]?.date?.slice(-2) || entries[index]?.key || '')),
      ),
      el('p', { className: 'v10-chart-caption' }, `单位：${unit(valid[0])}。缺失日期保留断点；累计值只按适用期间的来源计算。`),
    );
  }
  function Trend({ description, kind, filters, drill, color }) {
    const [mode, setMode] = g.useState('month');
    const inventory = kind === 'inventory';
    const labels = inventory ? description?.inventoryMode === 'visit-history' ? '最近盘点日期分布 · 按提交月份' : '盘点提交节奏 · 每月来源记录' : kind === 'invoice' ? '开票节奏' : kind === 'movement' ? '动销节奏 · 对比发票' : '开瓶节奏';
    return el('section', { className: 'chart-section', 'aria-label': labels },
      el('div', { className: 'section-title' }, el('h3', {}, inventory ? labels : `${mode === 'month' ? '月度' : mode === 'daily' ? '每日' : '当月累计'}${labels}`),
        !inventory && el('div', { className: 'segmented', role: 'group', 'aria-label': '趋势粒度' }, ...[['month', '月度'], ['daily', '每日'], ['cumulative', '累计']].map(([key, text]) => el('button', { key, type: 'button', className: mode === key ? 'active' : '', 'aria-pressed': mode === key, onClick: () => setMode(key) }, text))),
      ),
      mode === 'month' || inventory ? el(MonthlyChart, { points: description?.monthly, kind, filters, drill }) : el(DailyChart, { points: description?.[mode], color, title: `${filters.month} ${mode === 'daily' ? '每日' : '累计'}${labels}` }),
      description?.note && el('details', { className: 'v10-trend-note' }, el('summary', {}, '趋势口径'), el('p', { className: 'v10-chart-caption' }, description.note)),
    );
  }
  function Ranked({ items, color, drill, groupField, leaf = false, limit, secondary = false }) {
    const entries = limit ? list(items).slice(0, limit) : list(items), max = Math.max(...entries.filter(available).map(item => Math.abs(item.value)), 1);
    return entries.length ? el('div', { className: secondary ? 'inv-dealer-rows' : 'group-rows' }, ...entries.map((item, index) => {
      const canDrill = !secondary && !leaf && item.drillable !== false && model.organizations.some(organization => organization[groupField] === item.key);
      return el(canDrill ? 'button' : 'div', { key: item.key || item.name || index, className: secondary ? 'inv-dealer' : 'group-row', ...(canDrill ? { type: 'button', onClick: () => drill(groupField, item.key), 'aria-label': `筛选${name(item)}` } : {}), 'data-state': item.state },
        el('span', { className: 'rank' }, String(index + 1).padStart(2, '0')),
        el('div', { className: secondary ? '' : 'group-name' }, el('strong', { title: [name(item), item.note].filter(Boolean).join('；') }, name(item), secondary && item.records > 0 && el('small', {}, `${model.format(item.records)} 条来源记录`)), el('div', { className: 'track' }, available(item) && el('i', { style: { width: `${Math.abs(item.value) / max * 100}%`, background: item.value < 0 ? '#c99464' : color } }))),
        el('b', {}, el(MetricValue, { item }), !available(item) ? el('small', {}, reason(item)) : item.shareText ? el('small', {}, item.shareText) : finite(item.share) && el('small', {}, `${model.format(item.share * 100, 1)}%`)),
        canDrill && el('span', { className: 'v10-drill-arrow', 'aria-hidden': true }, '›'),
      );
    })) : el(Empty, {});
  }
  function Concentration({ items, tone }) {
    const entries = list(items);
    return entries.length ? el(g.Fragment, {}, el('div', { className: `inv-conc ${tone || ''}` }, ...entries.map((item, index) => el('div', { key: item.key || item.n || index, 'data-state': item.state, title: item.note || reason(item) },
      el('span', {}, item.name || item.label || `Top ${item.n}`), el('strong', {}, el(MetricValue, { item })),
      el('div', {}, available(item) && (finite(item.share) || item.unit === '%') && el('i', { style: { width: `${Math.max(0, Math.min(100, finite(item.share) ? item.share * 100 : item.value))}%` } })),
      !available(item) && el('small', {}, reason(item)),
    ))), entries[0].note && el('p', { className: 'v10-chart-caption' }, entries[0].note)) : null;
  }
  function Products({ description, filters, drill }) {
    const brands = list(description.brands), products = list(description.products);
    if (description.inventoryMode === 'visit-history') return el('section', { className: 'product-section' },
      el(Heading, { title: '产品构成 · 完整产品名称', note: '按最近盘点瓶数；不随品牌／品类筛选' }),
      el(Ranked, { items: products, color: '#687e88', secondary: true, limit: 12 }));
    const positiveTotal = brands.filter(available).reduce((total, item) => total + Math.max(0, item.value), 0);
    const negative = brands.some(item => available(item) && item.value < 0);
    const colors = ['#ab343c', '#8a6c79', '#547fa3', '#9c7865', '#879c87', '#b99e73'];
    return el('section', { className: 'product-section' },
      el(Heading, { title: '产品结构 · 品牌 → 品类', note: '点击品类联动筛选，再次点击取消' }),
      positiveTotal > 0 && !negative && brands.every(available) && el('div', { className: 'inv-brandbar', 'aria-label': '品牌金额构成' }, ...brands.map((item, index) => el('i', { key: item.key || index, style: { width: `${item.value / positiveTotal * 100}%`, background: item.color || colors[index % colors.length] }, title: `${name(item)}：${valueText(item)} ${unit(item)}` }))),
      el('div', { className: 'inv-brandlegend' }, ...brands.map((item, index) => el('span', { key: item.key || index }, el('i', { style: { background: item.color || colors[index % colors.length] } }), name(item), el('b', { title: `${valueText(item)} ${available(item) ? unit(item) : reason(item)}` }, available(item) && finite(item.share) && !negative ? `${model.format(item.share * 100, item.share < .01 ? 1 : 0)}%` : valueText(item))))),
      negative && el('p', { className: 'v10-chart-caption' }, '当前品牌含负净额，分别保留数值，不以正向占比条混合展示。'),
      el('div', { className: 'product-buttons inv-products' }, ...products.slice(0, 10).map((item, index) => {
        const key = item.product, canPick = item.drillable !== false && model.categories.some(category => category.id === key), selected = filters.product === key;
        return el('button', { key: key || index, type: 'button', className: selected ? 'selected' : '', disabled: !canPick, 'aria-pressed': selected, onClick: () => canPick && drill('product', selected ? 'all' : key) },
          el('i', { style: { background: item.color || colors[index % colors.length] } }), el('span', { title: name(item) }, name(item), item.brand && el('small', {}, item.brand)), el('b', { 'data-state': item.state }, el(MetricValue, { item })),
        );
      })),
      !products.length && el(Empty, {}),
    );
  }
  function SourceTable({ rows, kind, inventoryMode, cutoffDate }) {
    const [page, setPage] = g.useState(0), size = 24;
    const entries = list(rows), pages = Math.max(1, Math.ceil(entries.length / size)), current = Math.min(page, pages - 1);
    g.useEffect(() => setPage(0), [rows, kind]);
    const columns = {
      invoice: [['organization', '完整组织路径'], ['date', '业务日期'], ['dealerName', '经销商'], ['dealerCode', '经销商编码'], ['brand', '品牌'], ['category', '品类'], ['amount', '发票净额 / 万元', '元']],
      movement: [['organization', '完整组织路径'], ['date', '扫码日期'], ['terminalName', '终端'], ['terminalCode', '售点编码'], ['brand', '品牌'], ['category', '品类'], ['amount', '扫码净额 / 万元', '元'], ['bottles', '瓶单位数量', '瓶'], ['boxes', '盒单位数量', '盒'], ['cases', '来源扫码件数', '源件数']],
      opening: [['organization', '产品所属完整组织'], ['date', '抽奖日期'], ['city', '开瓶城市'], ['bottles', '开瓶 / 瓶', '瓶'], ['amount', '现金红包 / 万元', '元']],
      inventory: inventoryMode === 'visit-history'
        ? [['organization', '源完整营销组织'], ['dealerName', '经销商'], ['dealerCode', '经销商编码'], ['productName', '完整产品名称'], ['submittedAt', '盘点提交时间'], ['system', '提交时系统 / 瓶', '瓶'], ['counted', '盘点 / 瓶', '瓶'], ['signedVariance', '盘点与系统差异 / 瓶', '瓶'], ['previousSubmittedAt', '上次盘点时间'], ['previousCounted', '上次盘点瓶数 / 瓶', '瓶'], ['changeFromPrevious', '较上次变化瓶数 / 瓶', '瓶'], ['daysSinceStocktake', '距所选截止日天数 / 天', '天'], ['comparisonStatusLabel', '比较状态'], ['absoluteVariance', '绝对差 / 瓶', '瓶'], ['sourceVariance', '源偏差 / 瓶', '瓶'], ['systemAmount', '提交时系统金额 / 万元', '元'], ['recordStatus', '核查提示'], ['supplementRequested', '是否补录'], ['supplementStatus', '补录状态']]
        : [['organization', '完整组织路径'], ['dealerName', '经销商'], ['dealerCode', '经销商编码'], ['productCode', '产品编码'], ['productName', '产品'], ['date', '盘点提交日期'], ['system', '系统 / 瓶', '瓶'], ['counted', '盘点 / 瓶', '瓶'], ['sourceVariance', '源偏差 / 瓶', '瓶'], ['signedVariance', '盘点−系统 / 瓶', '瓶'], ['absoluteVariance', '绝对差 / 瓶', '瓶']],
      banquet: [['organization', '完整组织路径'], ['events', '执行 / 场', '场'], ['bottles', '开瓶 / 瓶', '瓶'], ['average', '场均 / 瓶', '瓶/场'], ['reward', '推荐奖励 / 元', '元']],
    }[kind] || [];
    const cell = (row, field, measureUnit) => {
      if (kind === 'banquet' && field === 'reward') return '待确认';
      const value = row[field];
      if (value && typeof value === 'object' && 'state' in value) return valueText(value);
      if (measureUnit) return finite(value) ? valueText(metric(value, measureUnit)) : '待确认';
      return typeof value === 'string' && value ? value : '未提供';
    };
    return el('div', { className: 'table-wrap v10-source-table' },
      el('p', { className: 'v10-chart-caption' }, `按当前筛选展示允许导出的来源记录；源空值保持未知，不补零。${kind === 'inventory' && inventoryMode === 'visit-history' ? `距所选截止日天数以 ${cutoffDate || '未提供'} 为基准；基准日取所选月末与来源最大已知提交日期的较早者，不使用电脑今天日期。较上次变化不代表销量。` : ''}`),
      el('div', { className: 'v10-table-scroll' }, el('table', {}, el('thead', {}, el('tr', {}, ...columns.map(([field, label]) => el('th', { key: field, scope: 'col' }, label)))), el('tbody', {}, ...entries.slice(current * size, (current + 1) * size).map((row, index) => el('tr', { key: row.key || index }, ...columns.map(([field, , measureUnit]) => el('td', { key: field, title: cell(row, field, measureUnit) }, cell(row, field, measureUnit)))))))),
      !entries.length && el(Empty, {}),
      el('div', { className: 'v10-pagination' }, el('span', {}, `共 ${model.format(entries.length)} 条来源记录 · 第 ${current + 1} / ${pages} 页`), el('button', { type: 'button', disabled: current === 0, onClick: () => setPage(current - 1) }, '上一页'), el('button', { type: 'button', disabled: current >= pages - 1, onClick: () => setPage(current + 1) }, '下一页')),
    );
  }
  function ObservationTable({ items, kind, inventoryMode }) {
    const entries = list(items);
    if (!entries.length) return el(Empty, {});
    if (entries.every(item => item.records === 0)) return el(Empty, { text: entries[0].note || reason(entries[0]) });
    if (entries.every(item => !available(item) && !finite(item.system))) return el(Empty, { text: reason(entries[0]) });
    return el('div', { className: `sg-series ${kind === 'inventory' ? 'stk-dev' : 'bq-eff'} v10-observation-table` },
      el('div', { className: 'sg-row head' }, el('span', {}, kind === 'inventory' ? '来源记录' : '单元'), el('span', {}, kind === 'inventory' ? '系统 / 瓶' : '执行 / 场'), el('span', {}, kind === 'inventory' ? '盘点 / 瓶' : '开瓶 / 瓶'), el('span', {}, kind === 'inventory' ? inventoryMode === 'visit-history' ? '盘点与系统差异 / 瓶' : '盘点−系统 / 瓶' : '场均 / 瓶')),
      ...entries.slice(0, 8).map((item, index) => el('div', { className: 'sg-row', key: item.key || index }, el('strong', { title: [name(item), item.note].filter(Boolean).join('；') }, name(item)),
        el('span', {}, valueText(metric(kind === 'inventory' ? item.system : item.events ?? item.sessions, kind === 'inventory' ? '瓶' : '场'))),
        el('span', {}, valueText(metric(kind === 'inventory' ? item.counted : item.bottles, '瓶'))),
        el('b', { className: available(item) && item.value < 0 ? 'minus' : '' }, el(MetricValue, { item, suffix: false })),
      )),
    );
  }
  function DayChangeTable({ items }) {
    const entries = list(items);
    if (!entries.length) return el(Empty, {});
    const first = entries.find(item => item.date) || {}, day = date => date ? date.slice(5) : '—';
    const bottles = value => finite(value) ? model.format(value) : '—';
    return el('div', { className: 'sg-series op-day v10-observation-table', 'aria-label': `${first.date || '末日'} 与 ${first.previousDate || '昨日'} 开瓶比较` },
      el('div', { className: 'sg-row head' }, el('span', {}, '组织'), el('span', {}, `${day(first.previousDate)} / 瓶`), el('span', {}, `${day(first.date)} / 瓶`), el('span', {}, '变化 / 瓶'), el('span', {}, '较昨日')),
      ...entries.map((item, index) => el('div', { className: 'sg-row', key: item.key || index }, el('strong', { title: name(item) }, name(item)),
        el('span', {}, bottles(item.previous)), el('span', {}, bottles(item.current)),
        el('span', { className: finite(item.difference) && item.difference < 0 ? 'minus' : finite(item.difference) && item.difference > 0 ? 'plus' : '' }, finite(item.difference) ? `${item.difference > 0 ? '+' : ''}${model.format(item.difference)}` : '—'),
        el('b', { className: available(item) && item.value < 0 ? 'minus' : available(item) && item.value > 0 ? 'plus' : '', title: reason(item) }, available(item) ? `${item.value > 0 ? '+' : ''}${model.format(item.value, 1, 1)}%` : '—'))),
    );
  }
  function Definitions({ module, description }) {
    const notes = [...new Set([...(description.notes || []), ...(module.pending || [])].filter(value => typeof value === 'string' && value))];
    return el('div', { className: 'definitions' },
      el('div', { className: 'source-label' }, module.source?.originalName || '当前板块没有有效上传来源'),
      ...notes.map((text, index) => el('div', { key: text, className: 'definition-row' }, el('strong', {}, `口径 ${index + 1}`), el('p', {}, text))),
      ...(module.crossMetrics || []).map(item => el('div', { key: item.key, className: 'definition-row' }, el('strong', {}, item.label), el('div', {}, item.reason && el('p', {}, item.reason), ...(item.notes || []).map((text, index) => el('p', { key: index }, text))))),
      el('div', { className: 'v10-source-proof' }, el('h3', {}, '本次来源版本'), module.source ? el('dl', {}, el('dt', {}, '上传版本'), el('dd', {}, module.source.uploadId), el('dt', {}, 'SHA-256'), el('dd', {}, module.source.sha256), el('dt', {}, '来源期间'), el('dd', {}, module.period)) : el('p', {}, '请先上传并校验对应来源。'), el('p', {}, `生成时间：${model.payload.generatedAt}`)),
    );
  }
  function UpLevel({ filters, drill }) {
    const step = filters.unit !== 'all' ? ['unit', model.label(filters.office)] : filters.office !== 'all' ? ['office', model.label(filters.region)] : filters.region !== 'all' ? ['region', '全战区'] : null;
    return step && el('button', { type: 'button', className: 'up-level v10-up-level', 'aria-label': `返回上一级：${step[1]}`, onClick: () => drill(step[0], 'all') }, '‹ 返回上一级', el('small', {}, step[1]));
  }
  function Details({ kind, data, filters, drill }) {
    const module = data.modules[kind];
    const inventoryVisit = kind === 'inventory' && module.inventoryMode === 'visit-history';
    const description = g.useMemo(() => presentation.describe(kind, data, filters), [kind, data, filters]);
    const tone = tones[kind];
    const section = (title, body, note) => el('section', { className: `product-section inv-dealers ${tone}` }, el(Heading, { title, note }), body);
    const ranking = description.ranking || {};
    return el('section', { className: `details-panel v10-details v10-${kind}`, 'aria-label': `${module.title}详细信息`, style: { '--detail-accent': module.color } },
      el('div', { className: 'detail-title' }, el('div', {}, el('span', { className: 'eyebrow' }, english[kind]), el('h2', {}, `${module.title}分析`), el('p', {}, inventoryVisit ? '经销商与完整产品名称的最近一次已知盘点、盘点与系统差异和记录时效。' : descriptions[kind])), el('span', { className: 'scope-tag' }, '筛选联动')),
      el('div', { className: 'detail-context' }, el('span', {}, model.scope(filters)), el('span', {}, module.period), el('span', {}, inventoryVisit ? '库存不随品牌／品类筛选' : ['invoice', 'movement', 'inventory'].includes(kind) ? filters.product === 'all' ? '全部产品' : model.categories.find(item => item.id === filters.product)?.name || '所选产品' : '不随产品筛选')),
      el('div', { className: `analysis-content inv-analysis ${tone}-analysis` },
          el(Kpis, { items: description.kpis }),
          inventoryVisit && el('p', { className: 'v10-method-note' }, `最近盘点日期：${module.inventoryStats?.latestMinDate || '未提供'} 至 ${module.inventoryStats?.latestMaxDate || '未提供'}。各条记录并非同一天盘点，不代表当天实时库存。距所选截止日天数的基准日：${module.inventoryStats?.cutoffDate || '未提供'}。${description.inventoryReviewSummary || ''}${module.inventoryStats?.conflictRows ? `有 ${model.format(module.inventoryStats.conflictRows)} 条最近候选待核实，相关数量不合并。` : ''}`),
          kind === 'banquet' ? el('p', { className: 'sg-note bq' }, `${module.period}。组织筛选有效；不随月份或产品筛选。奖励合计与场均奖励待确认。`) : el(Trend, { key: kind, description: description.trend, kind, filters, drill, color: module.color }),
          kind === 'inventory' && section(inventoryVisit ? '失效指标 · 缺少来源' : '库存健康 · 来源状态', el(Concentration, { items: description.health, tone: inventoryVisit ? 'stk' : 'stk four' }), inventoryVisit ? '缺少来源字段的指标不计算，不用其他字段替代' : '分类规则待确认时保持未知，不推断安全阈值'),
          el(UpLevel, { filters, drill }),
          el(Heading, { title: `${filters.unit === 'all' ? '下级组织' : '当前单元'} · ${kind === 'inventory' ? inventoryVisit ? '最近盘点瓶数' : '盘点库存金额' : kind === 'opening' ? '开瓶瓶数' : kind === 'banquet' ? '执行场次' : '当月净额'}`, note: filters.unit === 'all' ? '点击一行联动组织筛选' : '按当前完整组织路径统计' }),
          el(Ranked, { items: description.organizations, color: module.color, drill, groupField: module.groupField, leaf: filters.unit !== 'all' }),
          ['invoice', 'movement', 'inventory'].includes(kind) && el(Products, { description, filters, drill }),
          kind === 'movement' && section('终端渠道结构', el(Ranked, { items: description.channels, color: module.color, secondary: true, limit: 8 }), '按来源渠道展示扫码金额'),
          kind === 'opening' && section('下级组织 · 较昨日开瓶', el(DayChangeTable, { items: description.dayChanges }), '所选期间末日对比前一天；无记录显示 —，不补零'),
          kind === 'opening' && section('开瓶城市 · 消费地', el(g.Fragment, {}, el(Concentration, { items: description.cities?.concentration || ranking.concentration, tone: 'op' }), el(Ranked, { items: description.cities, color: module.color, secondary: true, limit: 10 })), '与产品所属组织独立观察'),
          ['invoice', 'movement', 'inventory', 'banquet'].includes(kind) && section(ranking.title || ({ invoice: '客户集中度 · 经销商', movement: '终端集中度 · 售点', inventory: '库存 Top 经销商', banquet: '执行 Top 单元' })[kind], el(g.Fragment, {}, el(Concentration, { items: ranking.concentration, tone }), el(Ranked, { items: ranking.items, color: module.color, secondary: true, limit: kind === 'banquet' ? 10 : 8 })), ranking.note),
          kind === 'inventory' && section(inventoryVisit ? '盘点与系统差异 · 逐条比较' : '盘点差异 · 逐条比较', el(ObservationTable, { items: description.deviations, kind, inventoryMode: module.inventoryMode }), '盘点减系统，按来源记录逐条比较'),
          kind === 'banquet' && section('场均开瓶排行', el(ObservationTable, { items: description.efficiency, kind }), '同一完整组织路径 · 来源固定期间'),
          el('div', { className: 'v10-method-note' }, '缺失、待确认和真实零值分别展示；“—”表示缺少来源或口径待确认，不补零。'),
        ),
    );
  }
  return { Details, Kpis, Ranked, Heading };
}
