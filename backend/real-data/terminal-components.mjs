// Serialized into the offline dashboard. Keep this factory self-contained.
export function createTerminalComponents({ T, g, model, shared }) {
  const el = (tag, props, ...children) => {
    const { key, ...attributes } = props || {};
    const render = children.length > 1 && T.jsxs ? T.jsxs : T.jsx;
    return render(tag, { ...attributes, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) }, key);
  };
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const { Kpis, Ranked, Heading } = shared;
  const metric = (label, value, unit, note = '') => ({ label, value, unit, note, state: finite(value) ? 'available' : 'pending', reason: finite(value) ? null : '当前来源不足以完整判定' });
  const number = (value, digits = 0) => finite(value) ? model.format(value, digits, digits) : '待确认';
  const percent = value => finite(value) ? `${model.format(value * 100, value === 1 ? 0 : 1, value === 1 ? 0 : 1)}%` : '待确认';
  const rateText = (value, denominator) => denominator === 0 ? '—' : percent(value);
  const width = value => `${finite(value) ? Math.max(0, Math.min(1, value)) * 100 : 0}%`;
  const stars = ['一星', '二星', '三星', '四星', '五星', '六星', '七星', '八星'];
  const starName = value => stars[value - 1] || '星级待确认';
  const starList = values => Array.isArray(values) && values.length ? values.map(starName).join(' / ') : '星级待确认';
  const labelFor = value => model.label ? model.label(value) : value;
  const terminalRows = structure => Array.isArray(structure?.terminals) ? structure.terminals : [];
  const seriesMatches = (terminal, selection) => !selection || (terminal.series || []).some(series => (series.matrixKey || series.key) === selection.key && (series.stars || []).includes(selection.star));
  const noSource = module => module.state === 'unavailable' || !module.source;
  const moveTab = (event, options, current, select) => {
    const index = options.indexOf(current);
    const next = event.key === 'ArrowRight' ? (index + 1) % options.length : event.key === 'ArrowLeft' ? (index + options.length - 1) % options.length : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); select(options[next]); event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[next]?.focus();
  };
  function SeriesTags({ series }) {
    return el('div', { className: 'terminal-series-tags' }, ...(series || []).map(item => el('span', { key: item.key || item.name }, `${item.name} ${starList(item.stars)}`)));
  }
  function EffectiveBar({ count, total, rate }) {
    return el('div', {},
      el('div', { className: 'terminal-effective-values' }, el('strong', {}, rateText(rate, total)), el('small', {}, `${number(count)} / ${number(total)} 份`)),
      el('div', { className: 'terminal-progress-track', 'aria-hidden': true }, el('i', { style: { width: width(rate) } })),
    );
  }
  function TerminalCardContent({ module }) {
    const structure = module.structure;
    if (!structure || noSource(module)) return el('div', { className: 'terminal-card-summary' }, el('p', { className: 'terminal-quality-note' }, '上传并校验签约与动销来源后展示签约结构及有效终端。'));
    const total = structure.totals || {};
    return el('div', { className: 'terminal-card-summary' },
      el('div', { className: 'terminal-card-effective' },
        el('div', {}, el('span', {}, '有效终端'), el('strong', { 'data-terminal-metric': 'effective-count' }, number(total.effectiveCount), finite(total.effectiveCount) && el('small', {}, ' 家'))),
        el('div', {}, el('span', {}, '有效率'), el('strong', { 'data-terminal-metric': 'effective-rate' }, rateText(total.effectiveRate, total.terminalCount))),
      ),
      el('div', { className: 'support-foot' }, `${number(total.agreements)} 份协议 · 不随产品筛选`),
      finite(total.pendingCount) && total.pendingCount > 0 && el('p', { className: 'terminal-quality-note' }, `${number(total.pendingCount)} 家终端的有效性待确认`),
    );
  }
  function Matrix({ structure, mode, setMode, selection, selectCell }) {
    const rows = structure.rows || [], totals = structure.totals || {};
    const maxCount = Math.max(1, ...rows.flatMap(row => (row.cells || []).map(cell => cell.agreements || 0)));
    const heat = share => {
      const opacity = finite(share) && share > 0 ? .08 + .92 * Math.sqrt(Math.min(1, share)) : .045;
      return { color: `rgb(${[135, 119, 83].map(channel => Math.round(255 + (channel - 255) * opacity)).join(',')})`, dark: opacity > .60 };
    };
    return el('section', { className: 'chart-section terminal-matrix-section', 'aria-label': '品系与星级协议矩阵' },
      el('div', { className: 'terminal-matrix-toolbar' },
        el('div', {}, el('h3', { className: 'terminal-section-title' }, '品系 × 星级矩阵'), el('p', { className: 'terminal-section-note' }, `${number(totals.agreements)} 份协议 · ${number(totals.terminalCount)} 家终端`)),
        el('div', { className: 'terminal-mode-tabs', role: 'tablist', 'aria-label': '矩阵显示指标' }, ...[['agreements', '协议数'], ['share', '行内占比'], ['effective', '有效率']].map(([id, title]) => el('button', { key: id, type: 'button', role: 'tab', 'aria-selected': mode === id, onClick: () => setMode(id), onKeyDown: event => moveTab(event, ['agreements', 'share', 'effective'], id, setMode) }, title))),
      ),
      el('div', { className: 'terminal-matrix-scroll', tabIndex: 0, 'aria-label': '矩阵，可横向滚动查看全部星级' },
        el('table', { className: 'terminal-matrix' },
          el('thead', {}, el('tr', {}, el('th', { scope: 'col', className: 'terminal-series-column' }, '品系'), ...stars.map(name => el('th', { key: name, scope: 'col' }, name)), el('th', { scope: 'col', className: 'terminal-total-column' }, '合计'), el('th', { scope: 'col', className: 'terminal-effective-column' }, '本品系有效协议'))),
          el('tbody', {}, ...rows.map(row => el('tr', { key: row.key },
            el('th', { scope: 'row', className: 'terminal-series-label' }, el('strong', {}, row.name), el('small', {}, `${number(row.terminalCount)} 家终端`)),
            ...stars.map((name, index) => {
              const cell = (row.cells || []).find(item => item.star === index + 1);
              if (cell && cell.observed === false) return el('td', { key: name }, el('div', { className: 'terminal-cell is-absent', title: `${row.name} · ${name}：来源未观察到此档`, 'aria-label': `${row.name}${name}，来源未观察到此档` }, '—'));
              const color = heat(mode === 'effective' ? cell?.effectiveAgreementRate : mode === 'share' ? cell?.share : cell?.agreements / maxCount), selected = selection?.key === row.key && selection.star === index + 1;
              const title = `${row.name} · ${name}；协议 ${number(cell?.agreements)} 份；本品系有效协议 ${number(cell?.effectiveAgreements)} / ${number(cell?.agreements)} 份；有效率 ${rateText(cell?.effectiveAgreementRate, cell?.agreements)}`;
              const value = mode === 'share' ? percent(cell?.share) : mode === 'effective' ? rateText(cell?.effectiveAgreementRate, cell?.agreements) : number(cell?.agreements);
              const pending = mode === 'share' ? !finite(cell?.share) : mode === 'effective' ? !finite(cell?.effectiveAgreementRate) && cell?.agreements !== 0 : !finite(cell?.agreements);
              return el('td', { key: name }, el('button', {
                type: 'button', className: `terminal-cell${color.dark ? ' is-dark' : ''}${pending ? ' is-pending' : ''}`,
                style: { '--cell-color': color.color }, title, 'aria-label': `${title}，点击筛选终端明细`, 'aria-pressed': selected,
                'data-terminal-cell': `${row.key}:${index + 1}`, onClick: () => selectCell({ key: row.key, name: row.name, star: index + 1 }),
              }, el('strong', {}, value), el('small', { title: '本品系有效协议及有效率' }, mode === 'effective' ? `${number(cell?.effectiveAgreements)} 份` : rateText(cell?.effectiveAgreementRate, cell?.agreements))));
            }),
            el('td', { className: 'terminal-total-cell' }, el('strong', {}, number(row.agreements)), el('small', {}, '份协议')),
            el('td', { className: 'terminal-effective-cell' }, el(EffectiveBar, { count: row.effectiveAgreements, total: row.agreements, rate: row.effectiveAgreementRate })),
          ))),
          el('tfoot', {}, el('tr', {}, el('th', { scope: 'row' }, '列合计'), ...stars.map((name, index) => el('td', { key: name }, number((structure.columns || []).find(item => item.star === index + 1)?.agreements))), el('td', {}, number(totals.agreements)), el('td', { className: 'terminal-effective-cell', title: '各品系终端有重叠，按终端编码重新去重' }, `${number(totals.terminalCount)} 家去重终端`))),
        ),
      ),
      rows.length === 0 && el('p', { className: 'terminal-empty' }, '当前组织与月份范围没有可展示的签约协议。'),
      el('div', { className: 'terminal-legend' },
        el('span', { className: 'terminal-legend-item' }, '颜色深浅', el('span', { className: 'terminal-legend-scale', 'aria-hidden': true }, ...[.02, .12, .25, .45, .7, 1].map(value => el('i', { key: value, style: { background: heat(value).color } }))), mode === 'effective' ? '= 本品系有效率' : mode === 'share' ? '= 本行协议占比' : '= 协议数 / 最大格协议数'),
        el('span', { className: 'terminal-legend-item' }, el('i', { className: 'terminal-legend-hatch', 'aria-hidden': true }), '来源未观察到此档'),
        el('span', {}, '点击格子 → 筛选下方终端明细'),
        el('span', {}, '有效 = 该终端在本品系 7 月以来动销净件数 ≥ 1 件'),
      ),
      el('p', { className: 'terminal-caution' }, '同一星级在不同品系代表的规模不同，请按行阅读。列合计仅供数量参考，不代表同等规模；斜纹表示当前上传来源未观察到此档，不据此判断业务上未设该星级。'),
    );
  }
  function HighestCard({ structure }) {
    const highest = structure.highest || [], max = Math.max(...highest.map(row => finite(row.count) ? row.count : 0), 1);
    return el('section', { className: 'terminal-subcard', 'aria-label': '终端综合档位' },
      el('h3', { className: 'terminal-section-title' }, '终端综合档位 · 按最高星级'),
      el('p', { className: 'terminal-section-note' }, `每家终端取所有品系协议中的最高星级 · ${number(structure.totals?.terminalCount)} 家终端`),
      el('div', { className: 'terminal-highest-list' }, ...stars.map((name, index) => {
        const row = highest.find(item => item.star === index + 1);
        return el('div', { key: name, className: 'terminal-highest-row' }, el('span', {}, name), el('div', { className: 'terminal-bar-track', 'aria-hidden': true }, el('i', { style: { width: width(finite(row?.count) ? row.count / max : null) } })), el('span', { className: 'terminal-highest-value' }, el('b', {}, number(row?.count)), el('small', {}, percent(row?.share))));
      })),
    );
  }
  function MultiCard({ structure }) {
    const example = structure.example, multi = structure.multi || {};
    return el('section', { className: 'terminal-subcard', 'aria-label': '多品系签约' },
      el('h3', { className: 'terminal-section-title' }, '多品系签约'),
      el('p', { className: 'terminal-section-note' }, '终端签约的品系数量，以及各品系星级是否一致'),
      el('div', { className: 'terminal-multi-stats' }, ...[['single', '单品系'], ['two', '2 个品系'], ['threePlus', '3 个及以上'], ['inconsistent', '星级不一致']].map(([key, label]) => el('div', { key }, el('span', {}, label), el('strong', {}, number(multi[key]))))),
      example ? el('div', { className: 'terminal-example' },
        el('p', { className: 'terminal-example-label' }, `当前范围示例 · ${example.terminalCode}${example.terminalName ? ` · ${example.terminalName}` : ''}`),
        el(SeriesTags, { series: example.series }),
        el('p', { className: 'terminal-example-summary' }, `综合档位：${starName(example.highest)} · 签约 ${number(example.seriesCount)} 个品系 · 星级跨度 ${number(example.span)} 档`),
      ) : el('p', { className: 'terminal-empty' }, '当前范围暂无可展示的终端示例。'),
    );
  }
  function SigningTrend({ structure, filters, drill }) {
    const points = structure.monthly || [], w = 760, left = 55, right = 60, top = 38, bottom = 200;
    const maxAgreements = Math.max(1, ...points.map(p => finite(p.agreements) ? p.agreements : 0));
    const maxTerminals = Math.max(1, ...points.map(p => finite(p.terminalCount) ? p.terminalCount : 0));
    const step = (w - left - right) / Math.max(points.length, 1), x = index => left + step * (index + .5);
    const y = (value, max) => bottom - value / max * (bottom - top);
    const line = []; let segment = [];
    points.forEach((point, index) => { if (finite(point.terminalCount)) segment.push(`${x(index)},${y(point.terminalCount, maxTerminals)}`); else if (segment.length) { line.push(segment); segment = []; } });
    if (segment.length) line.push(segment);
    return el('section', { className: 'chart-section terminal-trend', 'aria-label': '签约节奏' },
      el(Heading, { title: '签约节奏', note: '每月新签协议 · 截至各月末累计签约终端' }),
      structure.beforeSigningStart && el('p', { className: 'terminal-quality-note' }, 'FY27 协议自 7 月起签约'),
      points.length ? el('svg', { className: 'terminal-trend-chart', viewBox: `0 0 ${w} 240`, role: 'group', 'aria-label': '月度新签协议柱图与累计签约终端折线' },
        el('text', { x: left, y: 16, className: 'v10-axis-label' }, '新签协议 / 份'),
        el('text', { x: w - right, y: 16, textAnchor: 'end', className: 'v10-axis-label' }, '累计终端 / 家'),
        ...[0, .5, 1].map(fraction => el('g', { key: fraction },
          el('line', { x1: left, x2: w - right, y1: y(fraction, 1), y2: y(fraction, 1), stroke: '#e6ebf0', strokeDasharray: '3 5' }),
          el('text', { x: left - 8, y: y(fraction, 1) + 4, textAnchor: 'end', className: 'v10-axis-label' }, number(maxAgreements * fraction)),
          el('text', { x: w - right + 8, y: y(fraction, 1) + 4, className: 'v10-axis-label' }, number(maxTerminals * fraction)),
        )),
        ...points.map((point, index) => {
          const selected = point.month === filters.month, barWidth = Math.min(60, step * .45), label = `${Number(point.month.slice(5))}月`;
          const title = `${label}：新签 ${number(point.agreements)} 份协议，累计签约 ${number(point.terminalCount)} 家终端，点击切换月份`;
          return el('g', { key: point.month, role: 'button', tabIndex: 0, 'aria-label': title, 'aria-pressed': selected, 'data-terminal-month': point.month,
            onClick: () => drill('month', point.month), onKeyDown: event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); drill('month', point.month); } }, className: 'terminal-trend-month' },
            el('title', {}, title), el('rect', { x: x(index) - step / 2 + 2, y: top - 10, width: step - 4, height: bottom - top + 43, fill: selected ? '#87775308' : 'transparent', rx: 8 }),
            finite(point.agreements) && el('rect', { x: x(index) - barWidth / 2, y: y(point.agreements, maxAgreements), width: barWidth, height: Math.max(1, bottom - y(point.agreements, maxAgreements)), rx: 4, fill: selected ? '#877753' : '#c4b898' }),
            el('text', { x: x(index), y: bottom + 22, textAnchor: 'middle', className: 'v10-axis-label', fill: selected ? '#877753' : undefined }, label),
            el('text', { x: x(index), y: bottom - 10, textAnchor: 'middle', fontSize: 11, fill: point.agreements > maxAgreements * .15 ? '#fff' : '#657382', pointerEvents: 'none' }, number(point.agreements)),
          );
        }),
        ...line.map((part, index) => el('polyline', { key: index, points: part.join(' '), fill: 'none', stroke: '#547fa3', strokeWidth: 2, pointerEvents: 'none' })),
        ...points.map((point, index) => finite(point.terminalCount) && el('g', { key: point.month, pointerEvents: 'none' },
          el('circle', { cx: x(index), cy: y(point.terminalCount, maxTerminals), r: 4, fill: '#547fa3', stroke: '#fff', strokeWidth: 2 }),
          el('text', { x: x(index), y: y(point.terminalCount, maxTerminals) - 11, textAnchor: 'middle', fontSize: 11, fill: '#547fa3' }, number(point.terminalCount)),
        )),
      ) : el('p', { className: 'terminal-empty' }, '当前来源没有可展示的签约月份。'),
      el('div', { className: 'inv-legend' }, el('span', {}, el('i', { style: { background: '#c4b898' } }), '新签协议'), el('span', {}, el('i', { style: { background: '#547fa3' } }), '累计签约终端'), el('b', {}, '点击柱子切换月份 · 终端按编码去重')),
      el('p', { className: 'v10-chart-caption' }, `签约来源截至 ${structure.signingSourceEnd || '未提供'}；当前月份按已有记录展示，不外推月末。`),
    );
  }
  function OrganizationRanking({ structure, module, filters, drill }) {
    const items = (structure.organizations || []).map(row => ({ ...metric(labelFor(row.name), row.terminalCount, '家'), key: row.name, name: labelFor(row.name), share: row.effectiveRate, shareText: `有效率 ${rateText(row.effectiveRate, row.terminalCount)}`, note: `有效终端 ${number(row.effectiveCount)} 家 · 有效率 ${rateText(row.effectiveRate, row.terminalCount)}` }));
    return el('section', { className: 'chart-section', 'aria-label': '终端签约组织排行' },
      el(Heading, { title: `${filters.unit === 'all' ? '下级组织' : '当前单元'} · 签约终端`, note: filters.unit === 'all' ? '点击一行联动组织筛选' : '按当前完整组织路径统计' }),
      el(Ranked, { items, color: '#877753', drill, groupField: module.groupField, leaf: filters.unit !== 'all' }),
    );
  }
  function OutletTypes({ structure }) {
    const items = (structure.outletTypes || []).map(row => ({ ...metric(row.name, row.terminalCount, '家'), key: row.name, name: row.name, share: row.effectiveRate, shareText: `有效率 ${rateText(row.effectiveRate, row.terminalCount)}`, note: `有效终端 ${number(row.effectiveCount)} 家` }));
    return el('section', { className: 'chart-section', 'aria-label': '网点类型' },
      el(Heading, { title: '网点类型 · 终端', note: '各类型内按终端编码去重，附终端有效率' }),
      el(Ranked, { items, color: '#877753', secondary: true }),
      el('p', { className: 'v10-chart-caption' }, '使用签约来源网点类型；同一终端跨类型出现时分别观察，分类数量不直接相加。'),
    );
  }
  function TopTerminals({ structure }) {
    const rows = (structure.topTerminals || []).filter(row => finite(row.cases)).slice(0, 10);
    return el('section', { className: 'chart-section terminal-block', 'aria-label': '签约品系动销 Top 终端' },
      el(Heading, { title: '签约品系动销 Top 终端', note: '按已签品系动销净件数排序 · 前 10 家' }),
      el('div', { className: 'preview-table-wrap' }, el('table', { className: 'terminal-data-table terminal-top-table' },
        el('colgroup', {}, ...['name', 'office', 'series', 'star', 'cases'].map(key => el('col', { key, className: `terminal-col-${key}` }))),
        el('thead', {}, el('tr', {}, ...['终端', '办事处', '签约品系与星级', '综合档位', '净件数'].map(label => el('th', { key: label, scope: 'col' }, label)))),
        el('tbody', {}, ...rows.map(row => el('tr', { key: row.code },
          el('td', { className: 'terminal-detail-code' }, el('strong', {}, row.name), el('small', {}, row.code)),
          el('td', { className: 'terminal-org-cell' }, el('span', { className: 'terminal-org-text', title: row.orgLabel }, row.officeLabel || '未提供')),
          el('td', {}, el(SeriesTags, { series: row.series })), el('td', {}, starName(row.highest)), el('td', { className: 'terminal-number' }, number(row.cases, 1)),
        ))),
      )),
      !rows.length && el('p', { className: 'terminal-empty' }, '当前范围没有件数完整、可参与排名的终端。'),
      el('p', { className: 'v10-chart-caption' }, '净件数只汇总已签品系，保留来源负值；件数待确认的终端不参与排名，有效性仍按每个品系分别判断。'),
    );
  }
  function TerminalTable({ structure, selection, clear, tableRef }) {
    const [page, setPage] = g.useState(0), pageSize = 40;
    const rows = terminalRows(structure).filter(row => seriesMatches(row, selection));
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize)), safePage = Math.min(page, pageCount - 1);
    g.useEffect(() => setPage(0), [structure, selection?.key, selection?.star]);
    return el('section', { ref: tableRef, className: 'chart-section terminal-block', 'aria-label': '终端明细', tabIndex: -1 },
      el('div', { className: 'terminal-block-heading' }, el('h3', {}, '终端明细'), el('span', { className: 'terminal-section-note', 'aria-live': 'polite' }, `${number(rows.length)} 家终端 · 件数仅计已签约品系`)),
      selection && el('div', { className: 'terminal-filter-chip' }, `${selection.name} · ${starName(selection.star)}`, el('button', { type: 'button', className: 'terminal-clear', onClick: clear }, '清除筛选')),
      el('div', { className: 'preview-table-wrap' }, el('table', { className: 'terminal-data-table terminal-detail-table' },
        el('colgroup', {}, ...['name', 'org', 'series', 'star', 'status', 'cases'].map(key => el('col', { key, className: `terminal-col-${key}` }))),
        el('thead', {}, el('tr', {}, ...['终端', '组织', '签约品系与星级', '综合档位', '是否有效', '签约品系动销净件数'].map(label => el('th', { key: label, scope: 'col', className: label === '签约品系动销净件数' ? 'terminal-number' : undefined }, label)))),
        el('tbody', {}, ...rows.slice(safePage * pageSize, (safePage + 1) * pageSize).map(row => el('tr', { key: row.code },
          el('td', { className: 'terminal-detail-code' }, el('strong', {}, row.name || row.code || '终端名称未提供'), el('small', {}, row.code || '终端编码未提供')),
          el('td', { className: 'terminal-org-cell' }, el('span', { className: 'terminal-org-text', title: row.orgLabel || '组织未提供' }, row.orgShortLabel || '组织未提供')),
          el('td', {}, el(SeriesTags, { series: row.series })), el('td', {}, starName(row.highest)),
          el('td', {}, el('span', { className: `terminal-status${row.effective === true ? ' is-effective' : row.effective === false ? '' : ' is-pending'}`, title: row.effective === false ? '所有已签约品系的净扫码件数均未达到 1 件' : undefined }, row.effective === true ? '有效' : row.effective === false ? '无效' : '待确认')),
          el('td', { className: 'terminal-number' }, number(row.cases, 1)),
        ))),
      )),
      rows.length === 0 && el('p', { className: 'terminal-empty' }, selection ? '当前矩阵筛选下没有终端记录。' : '当前组织与月份范围没有终端记录。'),
      rows.length > pageSize && el('div', { className: 'terminal-pagination' },
        el('span', {}, `${safePage * pageSize + 1}–${Math.min((safePage + 1) * pageSize, rows.length)} / ${number(rows.length)}`),
        el('button', { type: 'button', className: 'terminal-page-button', disabled: safePage === 0, onClick: () => setPage(safePage - 1) }, '上一页'),
        el('button', { type: 'button', className: 'terminal-page-button', disabled: safePage >= pageCount - 1, onClick: () => setPage(safePage + 1) }, '下一页'),
      ),
      el('p', { className: 'terminal-section-note' }, '有效性按单一已签约品系分别判断；不同品系的净件数不合并凑足 1 件。'),
    );
  }
  function Definitions({ module, structure }) {
    const window = structure?.window || {};
    const notes = [...new Set([...(structure?.notes || []), ...(module.pending || [])])];
    return el('section', { className: 'terminal-block definitions' },
      el('h3', { className: 'terminal-section-title' }, '指标口径'),
      el('ul', { className: 'terminal-definition-list' },
        el('li', {}, '签约表仅使用 A 列至 AJ 列，AJ 为星级；AJ 列之后的字段不使用。'),
        el('li', {}, '签约协议按签约日期截至所选月末累计，跟随组织筛选，不跟随产品筛选。协议数量与网点编码去重后的终端数量分别展示。'),
        el('li', {}, '品系主要根据协议名称识别。矩阵统计协议，星级仅在同一品系内比较；终端综合档位取其全部签约品系的最高星级。'),
        el('li', {}, `有效终端计算窗口为 ${window.start || '2026-07-01'} 至 ${window.end || '所选月末'}，按网点编号匹配售点编码，扫码件数采用采购减退货的净额。`),
        el('li', {}, '只统计该终端已签约的品系；其中任意一个品系净扫码件数达到 1 件，即计为有效终端。不把不同品系相加凑足 1 件。'),
        el('li', {}, '终端有效率 = 有效终端数 ÷ 去重签约终端数；组织和网点类型使用终端级规则。矩阵及有效协议只看协议本品系是否达到 1 件，有效率 = 本品系有效协议数 ÷ 对应协议数。来源不完整或关联无法确定时显示“待确认”，不补零。'),
        el('li', {}, '矩阵颜色随模式变化：协议数相对当前最大格协议数着色，行内占比按本行协议数着色，有效率按本品系有效协议比例着色。斜纹统一表示“来源未观察到此档”，不代表业务未设置。'),
        el('li', {}, '组织列缩写只影响显示，关联仍使用完整路径。明细与排名件数显示 1 位小数，是否达到 1 件使用来源原精度。'),
      ),
      notes.length > 0 && el('div', { className: 'rules-pending' }, el('h3', {}, '当前来源状态'), ...notes.map((note, index) => el('p', { key: index }, note))),
      el('div', { className: 'preview-provenance' }, el('h3', {}, '本次来源版本'),
        module.source ? el('dl', {}, el('dt', {}, '文件'), el('dd', {}, module.source.originalName), el('dt', {}, '上传版本'), el('dd', {}, module.source.uploadId), el('dt', {}, 'SHA-256'), el('dd', {}, module.source.sha256), el('dt', {}, '签约范围'), el('dd', {}, module.period), el('dt', {}, '动销截止'), el('dd', {}, window.sourceEnd || '未提供')) : el('p', {}, '当前没有有效上传来源。'),
        el('p', {}, `生成时间：${model.payload.generatedAt}`),
      ),
    );
  }
  function TerminalDetails({ module, filters, drill }) {
    const [mode, setMode] = g.useState('agreements'), [selection, setSelection] = g.useState(null);
    const tableRef = g.useRef(null), structure = module.structure;
    g.useEffect(() => setSelection(null), [filters.month, filters.region, filters.office, filters.unit]);
    const selectCell = value => {
      setSelection(previous => previous?.key === value.key && previous.star === value.star ? null : value);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    };
    const totals = structure?.totals || {}, multi = structure?.multi || {};
    const kpis = [
      metric('签约终端', totals.terminalCount, '家', '截至所选月末 · 网点编号去重'),
      metric('签约协议', totals.agreements, '份', '截至所选月末 · 已确认去重'),
      metric('当月新签协议', structure?.currentMonthAgreements, '份', filters.month),
      metric('有效终端', totals.effectiveCount, '家', `有效率 ${rateText(totals.effectiveRate, totals.terminalCount)}`),
      metric('有效协议', totals.effectiveAgreements, '份', `占比 ${rateText(totals.effectiveAgreementRate, totals.agreements)} · 本品系达标`),
      metric('多品系终端', finite(multi.two) && finite(multi.threePlus) ? multi.two + multi.threePlus : null, '家', `星级不一致 ${number(multi.inconsistent)} 家`),
    ];
    return el('section', { className: 'details-panel v10-details v10-terminal', 'aria-label': '终端签约详细信息', style: { '--detail-accent': module.color } },
      el('div', { className: 'detail-title' }, el('div', {}, el('span', { className: 'eyebrow' }, 'TERMINAL NETWORK'), el('h2', {}, '终端签约分析'), el('p', {}, '签约节奏、品系星级结构、组织分布与已签品系动销。')), el('span', { className: 'scope-tag' }, '筛选联动')),
      el('div', { className: 'detail-context' }, el('span', {}, model.scope(filters)), el('span', {}, `签约截至 ${structure?.window?.end || filters.month}`), el('span', {}, '不随产品筛选')),
      (!structure || noSource(module)) && el('p', { className: 'terminal-empty' }, '当前没有可用的签约来源。请上传并校验签约数据后重新生成看板。'),
      structure && !noSource(module) && el('div', { className: 'analysis-content inv-analysis sg-analysis' },
        el(Kpis, { items: kpis }),
        el(SigningTrend, { structure, filters, drill }),
        el(Matrix, { structure, mode, setMode, selection, selectCell }),
        finite(structure.totals?.pendingCount) && structure.totals.pendingCount > 0 && el('p', { className: 'terminal-quality-note' }, `当前范围 ${number(structure.totals.pendingCount)} 家终端的有效性尚不能完整判断，相关有效数与有效率保留“待确认”。`),
        (filters.unit !== 'all' || filters.office !== 'all' || filters.region !== 'all') && el('button', { type: 'button', className: 'up-level v10-up-level', onClick: () => drill(filters.unit !== 'all' ? 'unit' : filters.office !== 'all' ? 'office' : 'region', 'all') },
          '‹ 返回上一级', el('small', {}, filters.unit !== 'all' ? model.label(filters.office) : filters.office !== 'all' ? model.label(filters.region) : '全战区')),
        el(OrganizationRanking, { structure, module, filters, drill }),
        el('section', { className: 'chart-section terminal-summary-grid' }, el(HighestCard, { structure }), el(MultiCard, { structure })),
        el(OutletTypes, { structure }),
        el(TopTerminals, { structure }),
        el(TerminalTable, { structure, selection, clear: () => setSelection(null), tableRef }),
      ),
    );
  }
  return { TerminalCardContent, TerminalDetails };
}
