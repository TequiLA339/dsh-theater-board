import { createTerminalComponents } from './terminal-components.mjs';
import { createV10Presentation } from './v10-presentation.mjs';
import { createV10Details } from './v10-details.mjs';

// Factories are serialized as code; values always come from the locked payload.
export function createV10Components({ T, g, model, icons, Pn }) {
  const el = (tag, props, ...children) => T.jsx(tag, { ...props, children: children.length === 1 ? children[0] : children });
  const fmt = model.formatMetric;
  const presentation = createV10Presentation(model);
  const sharedDetails = createV10Details({ T, g, model, presentation });
  const { Details } = sharedDetails;
  const { TerminalCardContent, TerminalDetails } = createTerminalComponents({ T, g, model, shared: sharedDetails });
  const available = m => m?.state === 'available' && Number.isFinite(m.value);
  const money = m => available(m) ? model.format(m.value / 10000, 2) : fmt(m || {state:'pending'});
  const number = m => available(m) ? model.format(m.value, m.precision ?? 0, m.precision ?? 6) : fmt(m || {state:'pending'});
  function CardMonths({ module, view, compact, filters }) {
    const items = view.trend.monthly;
    const min = Math.min(0, ...items.filter(available).map(x => x.value));
    const max = Math.max(1, ...items.filter(available).map(x => x.value + Math.abs(x.negative || 0)));
    const range = max - min;
    const zero = -min / range * 100;
    return el('div', { className: 'card-chart inv-card-chart' },
      el('div', { className: `inv-months v10-card-months ${compact ? 'compact' : 'card'} ${module.id === 'movement' ? 'mv' : ''}`, style: {gridTemplateColumns:`repeat(${Math.max(items.length,1)},minmax(0,1fr))`}, 'aria-label': `${module.title}月度节奏` },
        ...items.map(item => el('div', { key:item.key || item.month, className:`inv-m ${[3,6,9,12].includes(Number(item.month?.slice(-2)))?'q':''} ${item.month === filters.month ? 'sel':''}`, title: `${item.label || item.month}：${money(item)}${available(item) ? ' 万元' : '；'+(item.reason || '当前月份没有完整来源')}` },
          el('div', { className:'bar', 'data-state':item.state },
            min < 0 && el('span', {className:'v10-zero',style:{bottom:`${zero}%`}}),
            available(item) && item.negative < 0 && item.value >= 0 && el('i',{className:'ded',style:{position:'absolute',bottom:`${zero+item.value/range*100}%`,height:`${Math.abs(item.negative)/range*100}%`}}),
            available(item) ? el('i', { className:`net ${item.value < 0 ? 'is-negative' : ''}`,style:{position:'absolute',bottom:`${item.value < 0 ? zero+item.value/range*100 : zero}%`,height:`${Math.abs(item.value)/range*100}%`,minHeight:item.value===0?'1px':undefined} }) : el('span',{className:'v10-no-bar'},'—')),
          el('span',{},item.month ? Number(item.month.slice(-2)) : item.label))),
        !items.length && el('span',{className:'inv-empty'},'当前来源没有可展示月份')));
  }
  function Sparkline({ view, color }) {
    const items = view.trend.daily, valid = items.filter(available);
    if (!valid.length) return el('div',{className:'mini-trend v10-spark-empty'},'当前范围无完整日度来源');
    const max=Math.max(...valid.map(x=>x.value),1),min=Math.min(...valid.map(x=>x.value),0),range=max-min;
    const px=i=>6+i*288/Math.max(items.length-1,1),py=v=>60-(v-min)/range*52;
    const segments=[]; let segment=[];
    items.forEach((m,i)=>{if(available(m))segment.push([px(i),py(m.value)]);else if(segment.length){segments.push(segment);segment=[];}});if(segment.length)segments.push(segment);
    return el('div',{className:'mini-trend'},el('svg',{viewBox:'0 0 300 70',role:'img','aria-label':'当月开瓶日度节奏',preserveAspectRatio:'none',style:{width:'100%',height:'100%'}},
      ...segments.map((points,i)=>el('g',{key:i},el('path',{d:`M${points[0][0]},${py(0)} L${points.map(p=>p.join(',')).join(' L')} L${points.at(-1)[0]},${py(0)} Z`,fill:color,fillOpacity:.09}),
        el('polyline',{points:points.map(p=>p.join(',')).join(' '),fill:'none',stroke:color,strokeWidth:1.5}),
        ...points.map((p,j)=>el('circle',{key:j,cx:p[0],cy:p[1],r:points.length===1?2:0,fill:color}))))));
  }
  function z4({ kind, data, filters, open, compact = false }) {
    const m=data.modules[kind],meta=Pn[kind],hero=['invoice','movement'].includes(kind);
    const v=kind==='terminal'?null:presentation.describe(kind,data,filters);
    const inventoryVisit=kind==='inventory'&&m.inventoryMode==='visit-history';
    const main=kind==='inventory'?(inventoryVisit?v.kpis.find(item=>item.key==='inventoryCounted'):{...v.kpis.find(item=>item.key==='inventoryCountAmount'),label:'当前导出所选记录盘点金额'}):m.main;
    const inventorySystem=kind==='inventory'?v.kpis.find(item=>item.key===(inventoryVisit?'inventorySystem':'inventorySystemAmount')):null;
    const inventoryDifference=kind==='inventory'?v.kpis.find(item=>item.key===(inventoryVisit?'inventoryQuantityDifference':'inventoryAmountDifference')):null;
    const display=main.unit==='元'?money(main):number(main);
    const ytd=hero?m.extra[0]:null;
    const foot = kind==='opening' ? '组织口径 · 不随产品筛选'
      :kind==='banquet' ? `${m.period} · 不随月份筛选`
      :kind==='inventory' ? inventoryVisit ? '最近一次已知盘点 · 单位：瓶' : '当前导出盘点记录 · 单位：万元'
      : m.period;
    const negative=hero?m.extra[2]:null;
    const count=hero?v.kpis[4]:null;
    const ratio=kind==='movement'?m.crossMetrics.find(x=>x.key==='invoiceMovementYtdRatio'):null;
    return el('article',{className:`metric-card ${hero?'hero-card':'support-card'} ${kind} ${compact?'compact-card':''}`,style:{'--accent':m.color},
      onClick:()=>open(kind),onKeyDown:event=>{if(event.target===event.currentTarget&&['Enter',' '].includes(event.key)){event.preventDefault();open(kind);}},role:compact?undefined:'button',tabIndex:compact?undefined:0,'aria-label':`查看${m.title}详情`},
      el('header',{className:'card-heading'},el('span',{className:'card-icon'},T.jsx(meta.icon,{size:20})),el('h2',{},m.title),el('span',{className:'card-arrow'},T.jsx(icons.arrow,{size:19}))),
      el('p',{className:'metric-label'},main.label),
      el('div',{className:'metric-value','data-metric':kind,'data-state':main.state},el('strong',{},display),el('span',{},available(main)?main.unit==='元'?'万元':main.unit:'')),
      hero && el(g.Fragment,{},
        el('div',{className:'inv-sub'},el('span',{className:'inv-ytd'},'年内截至所选月累计 ',el('b',{},money(ytd)),available(ytd)?' 万元':'')),
        el(CardMonths,{module:m,view:v,compact,filters}),
        el('div',{className:'card-bottom inv-bottom'},el('span',{},`${kind==='invoice'?'经销商':'扫码终端'} ${number(count)}${available(count)?' 家':''}`),
          el('span',{},`负金额 ${money(negative)}${available(negative)?' 万':''}`),
          kind==='invoice'?el('span',{className:'inv-pending'},'达成率 · 待接目标'):el('span',{},`累计动销/开票 ${number(ratio)}${available(ratio)?'%':''}`))),
      kind==='opening' && el(Sparkline,{view:v,color:m.color}),
      kind==='terminal' && el(TerminalCardContent,{module:m}),
      kind==='inventory' && el('div',{className:'stock-compare'},
        el('div',{},el('span',{},inventoryVisit?'提交时系统':'系统金额'),el('b',{'data-state':inventorySystem.state,title:inventorySystem.reason||''},inventoryVisit?number(inventorySystem):money(inventorySystem),available(inventorySystem)?inventoryVisit?' 瓶':' 万元':'')),
        el('div',{},el('span',{},inventoryVisit?'盘点与系统差异':'金额差额'),el('b',{'data-state':inventoryDifference.state,title:inventoryDifference.reason||''},inventoryVisit?number(inventoryDifference):money(inventoryDifference),available(inventoryDifference)?inventoryVisit?' 瓶':' 万元':''))),
      kind==='banquet' && el('div',{className:'banquet-secondary'},el('span',{},'宴席开瓶'),el('b',{},number(m.extra[0]),el('small',{},available(m.extra[0])?' 瓶':''))),
      !hero && kind!=='terminal' && el('div',{className:'support-foot',title:foot},foot),
      !available(main) && el('p',{className:'v10-card-state'},main.reason || '当前范围缺少可用来源'),
    );
  }
  function GZ({kind,d:data,f:filters,drill}) {
    return kind==='terminal' ? el(TerminalDetails,{module:data.modules.terminal,filters,drill}) : el(Details,{kind,data,filters,drill});
  }
  function VZ({ selected, onSelect }) {
    return el('div', { className: 'focus-tools' }, el('div', { className: 'module-dock' }, el('nav', { className: 'dock-track preview-fixed-dock', 'aria-label': '主导航' },
      ...model.ids.map(id => el('button', { key: id, 'data-module': id, className: selected === id ? 'active' : '', 'aria-label': model.titles[id], 'aria-current': selected === id ? 'page' : undefined, title: model.titles[id], onClick: () => onSelect(id) }, T.jsx(Pn[id].icon, { size: 22 }))),
    )), el('p', { className: 'dock-caption' }, el('span', {}, model.titles[selected]), el('span', {}, '点击图标切换板块')));
  }
  function KZ({ close }) {
    const ref = g.useRef(null);
    g.useEffect(() => {
      const previous = document.activeElement; ref.current?.focus();
      const listener = event => {
        if (event.key === 'Escape') close();
        if (event.key === 'Tab') {
          const buttons = [...ref.current.querySelectorAll('button')];
          if (event.shiftKey && (document.activeElement === buttons[0] || document.activeElement === ref.current)) { event.preventDefault(); buttons.at(-1)?.focus(); }
          if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
        }
      };
      document.addEventListener('keydown', listener);
      return () => { document.removeEventListener('keydown', listener); previous?.focus(); };
    }, []);
    return el('div', { className: 'modal-scrim', onClick: close }, el('section', { ref, tabIndex: -1, className: 'rules-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'rules-title', onClick: event => event.stopPropagation() },
      el('header', {}, el('h2', { id: 'rules-title' }, '指标口径与来源边界'), el('button', { className: 'icon-button', onClick: close, 'aria-label': '关闭口径说明' }, T.jsx(icons.close, { size: 22 }))),
      el('p', { className: 'preview-pending-line' }, model.previewNotice),
      ...model.ids.map(id => el('section', { key: id, className: 'rules-pending' }, el('h3', {}, model.titles[id]), ...model.select().modules[id].pending.map((text, index) => el('p', { key: index }, text)))),
      el('button', { className: 'primary-button', onClick: close }, '返回看板'),
    ));
  }
  return { z4, GZ, VZ, KZ };
}
