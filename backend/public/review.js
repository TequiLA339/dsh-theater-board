'use strict';

// All workbook text is rendered with textContent. Draft choices stay in memory
// across polling; only an explicit save creates a persisted business decision.
window.ReviewUI = (() => {
  const pathLabels = ['营销公司', '事业部', '战区', '大区', '办事处', '单元'];
  const stateLabels = {missing: '待上传', unchecked: '尚未检查', ready: '可以使用', pending: '待确认', error: '需要核对'};
  const drafts = new Map();
  const organizationDrafts = new Map();
  let bridge;
  let review = null;
  let requestInFlight = null;
  let stateSignature = '';
  let renderSignature = '';
  let actionBusy = false;
  let fileBackup = null;

  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }
  const $ = selector => document.querySelector(selector);
  const readablePath = path => (path || []).map((part, index) => part || `未提供${pathLabels[index]}`).join(' / ');
  const pretty = value => value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const amount = value => Number(value).toLocaleString('zh-CN', {maximumFractionDigits: 2});
  const time = value => value ? new Date(value).toLocaleString('zh-CN', {hour12: false}) : '—';

  function notice(message, error = false) {
    const target = $('#review-notice');
    target.textContent = message;
    target.hidden = !message;
    target.className = `notice${error ? ' error' : ''}`;
  }

  function button(label, handler, className = 'button button-secondary') {
    const result = node('button', className, label);
    result.type = 'button';
    result.addEventListener('click', handler);
    result.dataset.reviewAction = 'true';
    return result;
  }

  function labelInput(label, input) {
    const result = node('label', 'review-label');
    // A select's option text must not become part of its accessible name.
    input.setAttribute('aria-label', label);
    result.append(node('span', '', label), input);
    return result;
  }

  function option(value, label) {
    const result = node('option', '', label);
    result.value = value;
    return result;
  }

  function field(type = 'text') {
    const input = node('input', 'review-input');
    input.type = type;
    return input;
  }

  function checkbox(text, checked, onChange) {
    const label = node('label', 'review-check');
    const input = field('checkbox');
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    label.append(input, node('span', '', text));
    return {label, input};
  }

  function download(name, data, type = 'application/json') {
    const url = URL.createObjectURL(new Blob([data], {type}));
    const link = node('a');
    link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function refresh(force = false) {
    if (requestInFlight) { await requestInFlight; return; }
    if (!bridge?.getState()?.token) return;
    requestInFlight = (async () => {
      try {
        const next = await bridge.request('/api/review');
        apply(next, force);
      } catch (error) {
        notice(`检查结果暂时无法读取：${error.message}`, true);
      } finally { requestInFlight = null; }
    })();
    await requestInFlight;
  }

  function controls() {
    const disabled = actionBusy || Boolean(bridge?.isBusy());
    document.querySelectorAll('[data-review-action]').forEach(item => { item.disabled = disabled; });
    $('#review-restore-confirm').disabled = disabled || !fileBackup;
    $('#generate-pending-button').disabled = disabled || !review?.modules?.some(module => module.uploadId);
    $('#review-check-button').disabled = disabled || !bridge?.getState()?.token;
  }

  async function mutate(path, payload, success) {
    if (actionBusy || bridge.isBusy() || !review) return false;
    actionBusy = true;
    controls();
    bridge.setWorking({kind: 'review', stage: '正在保存检查与处理结果'});
    notice('');
    try {
      const result = await bridge.request(path, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Local-Token': bridge.getState().token},
        body: JSON.stringify({revision: review.revision, ...payload}),
      });
      if (result.review) apply(result.review, true);
      if (result.state) bridge.applyState(result.state);
      if (!result.review) await refresh(true);
      notice(success);
      return true;
    } catch (error) {
      notice(error.message, true);
      if (error.data?.review) apply(error.data.review, true);
      else await refresh(true);
      return false;
    } finally {
      actionBusy = false;
      bridge.setWorking(null);
      controls();
    }
  }

  function apply(next, force = false) {
    if (!next || !Array.isArray(next.modules)) return;
    review = next;
    const signature = JSON.stringify(next);
    if (force || signature !== renderSignature) {
      renderSignature = signature;
      render();
    }
    controls();
  }

  function rememberDraft(module, group) {
    const key = `${module.uploadId}:${group.key}`;
    if (!drafts.has(key)) drafts.set(key, {
      keep: new Set(group.status === 'resolved' ? group.keepKeys || [] : []),
      remember: false,
      dirty: false,
    });
    // Read-only resolved groups always reflect the persisted decision, including
    // a change made by another open page or by restoring a settings backup.
    if (group.status === 'resolved') {
      drafts.get(key).keep = new Set(group.keepKeys || []);
      drafts.get(key).dirty = false;
    }
    return drafts.get(key);
  }

  function candidateGroup(module, group, index) {
    const box = node('details', `review-group ${group.status === 'resolved' ? 'resolved' : 'pending'}`);
    box.dataset.openKey = `group:${module.uploadId}:${group.key}`;
    box.open = group.status !== 'resolved';
    const summary = node('summary');
    summary.append(node('strong', '', `第 ${index + 1} 组 · ${group.rows.length} 条候选`), node('span', `status ${group.status === 'resolved' ? 'ready' : 'running'}`, group.status === 'resolved' ? group.reused ? '已复用决定' : '已处理' : '待确认'));
    box.append(summary);
    const content = node('div', 'review-group-body');
    content.append(node('p', 'review-help', group.reason || '请核对这些记录是否都应计入。'));
    if (group.status === 'resolved') content.append(node('p', 'review-help', `已保存：计入 ${group.keepKeys?.length ?? 0} 条。修改时请先撤销原决定，再重新选择。`));
    if (group.conflict || group.conflicts?.length) content.append(node('p', 'review-error', '保存的处理决定存在冲突。请在“处理记录”撤销冲突决定后重新确认。'));
    const draft = rememberDraft(module, group);
    const identity = module.id === 'invoice' ? ['业务日期', '单据类型', '单据编码', '单据行号', '发票金额', '计价数量', '计价单位'] : ['协议编号', '网点编号', '网点名称', '协议名称', '签约日期', '星级'];
    const columns = [...new Set([...identity, ...(group.differentFields || []), ...(module.id === 'invoice' ? ['销售大区', '办事处', '客户主任单元'] : ['大区', '办事处', '主任单元'])])].filter(key => group.rows.some(row => Object.hasOwn(row.values || {}, key)));
    const tableWrap = node('div', 'review-table-wrap');
    const table = node('table', 'review-table');
    const caption = node('caption', 'sr-only', `${module.title}第 ${index + 1} 组重复候选`);
    table.append(caption);
    const head = node('thead'); const header = node('tr');
    for (const title of ['计入', 'Excel 行号', ...columns]) { const th = node('th', '', title); th.scope = 'col'; header.append(th); }
    head.append(header); table.append(head);
    const body = node('tbody'); const checks = [];
    const preview = node('p', 'review-impact'); preview.setAttribute('aria-live', 'polite');
    const save = button('确认计入选中记录', async () => {
      if (!draft.keep.size) { notice('请至少选择一条应计入的记录；拿不准可以稍后处理。', true); return; }
      const ok = await mutate('/api/review/decisions', {uploadId: module.uploadId, groupKey: group.key, keepKeys: [...draft.keep], remember: draft.remember}, '这组处理已保存，原始 Excel 没有改动。');
      if (ok) drafts.delete(`${module.uploadId}:${group.key}`);
    }, 'button button-primary');
    function updateImpact() {
      const selected = group.rows.filter(row => draft.keep.has(row.key));
      let text = `本组 ${group.rows.length} 条，已选择 ${selected.length} 条计入，${group.rows.length - selected.length} 条不计入。`;
      if (!selected.length) text = '尚未选择。本组仍为待确认，不会把未选记录自动当作应排除。';
      else if (module.id === 'invoice') {
        const values = group.rows.map(row => row.amount ?? row.values?.发票金额);
        if (values.every(value => value !== null && value !== '' && Number.isFinite(Number(value)))) {
          const sum = selected.reduce((total, row) => total + Number(row.amount ?? row.values?.发票金额), 0);
          const all = values.reduce((total, value) => total + Number(value), 0);
          text += ` 本组计入 ${amount(sum)} 元；相比全部计入，金额变化 ${sum - all > 0 ? '+' : ''}${amount(sum - all)} 元。`;
        } else text += ' 金额含缺失或无法识别的值，不能预览完整金额。';
      } else text += ' 协议数按保留记录计算；终端家数仍按终端身份去重，有效率重新计算。';
      preview.textContent = text;
      save.dataset.emptySelection = selected.length ? '' : 'true';
    }
    for (const row of group.rows) {
      const tr = node('tr'); const choiceCell = node('td');
      const choice = field('checkbox'); choice.checked = draft.keep.has(row.key);
      choice.setAttribute('aria-label', `计入 Excel 第 ${row.row} 行`);
      choice.disabled = group.status === 'resolved';
      choice.addEventListener('change', () => { if (choice.checked) draft.keep.add(row.key); else draft.keep.delete(row.key); draft.dirty = true; updateImpact(); });
      checks.push([choice, row]); choiceCell.append(choice); tr.append(choiceCell, node('td', '', row.row));
      for (const column of columns) tr.append(node('td', group.differentFields?.includes(column) ? 'review-difference' : '', pretty(row.values?.[column])));
      body.append(tr);
    }
    table.append(body); tableWrap.append(table); content.append(tableWrap);
    const allFields = node('details', 'review-all-fields'); allFields.dataset.openKey = `fields:${module.uploadId}:${group.key}`;
    allFields.append(node('summary', '', '查看全部字段'));
    for (const row of group.rows) {
      const details = node('dl', 'review-fields');
      details.append(node('dt', '', 'Excel 行号'), node('dd', '', row.row));
      for (const [name, value] of Object.entries(row.values || {})) details.append(node('dt', '', name), node('dd', '', pretty(value)));
      allFields.append(details);
    }
    content.append(allFields, preview);
    if (group.status !== 'resolved') {
      const scope = checkbox('记住这一组决定，下次内容完全对应时继续使用', draft.remember, checked => { draft.remember = checked; draft.dirty = true; });
      const actions = node('div', 'review-actions');
      actions.append(button('全部计入', () => { for (const [choice, row] of checks) { choice.checked = true; draft.keep.add(row.key); } draft.dirty = true; updateImpact(); }), button('清空选择', () => { for (const [choice] of checks) choice.checked = false; draft.keep.clear(); draft.dirty = true; updateImpact(); }), save, button('暂不处理', () => { box.open = false; notice('这组仍为待确认。已确认的处理结果保存在本机，可从本次数据检查继续。'); }));
      content.append(scope.label, node('p', 'review-help', '不勾选时仅本次来源使用。保存前请核对上方影响；不会将本组决定扩大到其他业务。'), actions);
    } else if (group.decisionId) {
      content.append(button('撤销这组决定', () => revoke(group.decisionId)));
    } else content.append(node('p', 'review-help', '沿用此前与本文件绑定的已确认处理。可在处理记录中查看来源。'));
    updateImpact();
    box.append(content);
    return box;
  }

  function organizationEditor(module) {
    const section = node('details', 'review-organizations');
    section.dataset.openKey = `org:${module.uploadId}`;
    section.append(node('summary', '', `组织对应 · ${module.inspection.organizations?.length || 0} 条来源路径`));
    const content = node('div', 'review-group-body');
    content.append(node('p', 'review-help', '默认按原表完整路径统计。新增组织可以直接展示；只有改名、调区或合并需要统一统计时，才保存对应关系。同名不代表同一组织。'));
    const paths = module.inspection.organizations || [];
    if (!paths.length) { content.append(node('p', 'review-help', '当前来源没有可供确认的组织路径。')); section.append(content); return section; }
    const draftKey = module.uploadId;
    if (!organizationDrafts.has(draftKey)) organizationDrafts.set(draftKey, {fromIndex: '0', kind: 'alias', to: ['', '', '', '', '', ''], start: '', end: '', remember: false, period: 'all'});
    const draft = organizationDrafts.get(draftKey);
    const form = node('form', 'review-org-form');
    const from = node('select', 'review-input');
    paths.forEach((item, index) => from.append(option(String(index), `${readablePath(item.path)}（${item.count} 行）`)));
    from.value = draft.fromIndex; if (!from.value) from.value = '0';
    const kind = node('select', 'review-input');
    [['alias', '同一组织改名 / 名称对应'], ['transfer', '调整上级归属'], ['merge', '归入合并后的组织'], ['keep', '保持原表归属']].forEach(([value, label]) => kind.append(option(value, label)));
    kind.value = draft.kind;
    const target = node('select', 'review-input');
    target.append(option('', '选择已有完整路径，或在下方填写新路径'));
    const available = new Map();
    for (const source of review.modules) for (const org of source.inspection?.organizations || []) if (org.path?.length === 6 && org.path.every(Boolean)) available.set(JSON.stringify(org.path), org.path);
    for (const rule of review.organizationRules || []) if (!rule.revokedAt && rule.to?.every(Boolean)) available.set(JSON.stringify(rule.to), rule.to);
    for (const [key, path] of available) target.append(option(key, readablePath(path)));
    const targetFields = node('div', 'review-org-fields');
    const inputs = pathLabels.map((label, index) => {
      const input = field(); input.value = draft.to[index]; input.maxLength = 1000;
      input.addEventListener('input', () => { draft.to[index] = input.value; target.value = ''; preview(); });
      targetFields.append(labelInput(label, input)); return input;
    });
    const period = node('select', 'review-input');
    period.append(option('all', '本来源中符合原路径的记录'), option('range', '仅指定业务期间'));
    const canDate = ['invoice', 'movement', 'opening'].includes(module.id);
    period.disabled = !canDate; period.value = canDate ? draft.period : 'all';
    const start = field('date'); start.value = draft.start;
    const end = field('date'); end.value = draft.end;
    const dateFields = node('div', 'review-date-fields'); dateFields.append(labelInput('开始日期（含）', start), labelInput('结束日期（含）', end));
    const impact = node('p', 'review-impact'); impact.setAttribute('aria-live', 'polite');
    const remember = checkbox('记住这条对应关系，今后来源类型、原路径及期间仍匹配时使用', draft.remember, checked => { draft.remember = checked; preview(); });
    function preview() {
      const source = paths[Number(from.value)];
      const keep = kind.value === 'keep';
      target.disabled = keep;
      inputs.forEach(input => { input.disabled = keep; input.required = !keep; });
      dateFields.hidden = period.value !== 'range';
      start.required = end.required = period.value === 'range';
      let message = keep ? '保存后这条路径保持原表归属。' : `将“${readablePath(source.path)}”归入“${readablePath(inputs.map(input => input.value.trim()))}”。`;
      message += ` 仅作用于${module.title}，原路径共 ${source.count} 行。`;
      message += period.value === 'range' ? ` 仅 ${start.value || '未选开始日期'} 至 ${end.value || '未选结束日期'} 的记录参与对应；具体受影响行数以保存后的检查结果为准。` : ' 适用于本来源所有匹配该完整路径的记录。';
      message += ' 不删除记录，也不修改已经生成的历史看板。';
      impact.textContent = message;
    }
    from.addEventListener('change', () => { draft.fromIndex = from.value; preview(); });
    kind.addEventListener('change', () => { draft.kind = kind.value; preview(); });
    target.addEventListener('change', () => {
      if (target.value) { draft.to = JSON.parse(target.value); inputs.forEach((input, index) => { input.value = draft.to[index]; }); }
      preview();
    });
    period.addEventListener('change', () => { draft.period = period.value; preview(); });
    start.addEventListener('input', () => { draft.start = start.value; preview(); });
    end.addEventListener('input', () => { draft.end = end.value; preview(); });
    form.append(labelInput('原表中的完整组织路径', from), labelInput('这次要做什么', kind), labelInput('对应到哪个完整组织', target), targetFields, labelInput('适用范围', period), dateFields);
    if (!canDate) form.append(node('p', 'review-help', '这类来源不能仅凭签约或盘点日期推断历史归属，因此只支持明确的来源路径对应，不按日期自动调区。'));
    form.append(remember.label, impact);
    const save = button('确认并保存组织对应', () => form.requestSubmit(), 'button button-primary');
    form.append(save);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const source = paths[Number(from.value)];
      if (period.value === 'range' && start.value > end.value) { notice('开始日期不能晚于结束日期。', true); return; }
      await mutate('/api/review/organizations', {uploadId: module.uploadId, from: source.path, to: kind.value === 'keep' ? source.path : inputs.map(input => input.value.trim()), start: period.value === 'range' ? start.value : null, end: period.value === 'range' ? end.value : null, kind: kind.value, remember: draft.remember}, '组织对应已保存。仅应用于所选来源和适用期间，历史成品保持原内容。');
    });
    content.append(form, node('p', 'review-help', '组织拆分需要客户或终端归属依据；此处不提供按名称猜测或平均分配。若没有依据，请继续按原表统计。'));
    preview(); section.append(content); return section;
  }

  function sourceSelection(module) {
    const uploads = (bridge.getState()?.uploads || []).filter(item => item.moduleId === module.id);
    if (uploads.length < 2) return null;
    const holder = node('div', 'review-source-selection');
    const select = node('select', 'review-input');
    uploads.forEach(upload => select.append(option(upload.id, `${upload.filename} · ${time(upload.uploadedAt)}${upload.id === module.activeUploadId ? ' · 原有效版本' : ''}${upload.id === module.uploadId ? ' · 本次检查' : ''}`)));
    select.value = module.uploadId;
    holder.append(labelInput('本次使用的来源', select), button('选择这份来源', () => mutate('/api/review/select', {moduleId: module.id, uploadId: select.value}, '已选择来源，检查结果已更新。生成时将使用页面列出的版本。')));
    return holder;
  }

  function reviewModule(module) {
    const card = node('details', `review-module review-${module.status}`);
    card.dataset.openKey = `module:${module.id}`;
    card.open = ['pending', 'error'].includes(module.status);
    const summary = node('summary');
    summary.append(node('strong', '', module.title), node('span', `status ${module.status === 'ready' ? 'ready' : module.status === 'error' ? 'error' : 'running'}`, stateLabels[module.status] || module.status));
    const pending = module.inspection?.pendingCount ?? 0;
    if (pending) summary.append(node('span', 'review-count', `${pending} 组待确认`));
    card.append(summary);
    const content = node('div', 'review-module-body');
    content.append(node('p', 'review-source-name', module.filename || '尚未选择来源'));
    if (module.uploadId && module.activeUploadId && module.uploadId !== module.activeUploadId) content.append(node('p', 'review-help', '本次检查的是新来源；原有效来源仍保留。可在下方明确选择旧版本。'));
    const choose = sourceSelection(module); if (choose) content.append(choose);
    const inspection = module.inspection;
    if (!inspection) content.append(node('p', 'review-help', module.status === 'missing' ? '上传对应表格后会自动检查。' : '此来源尚未完成本轮检查，请点击“检查全部当前来源”。'));
    else {
      const coverage = inspection.coverage;
      content.append(node('p', 'review-help', `${inspection.sheet || '工作表未确认'} · ${Number(inspection.rowCount || 0).toLocaleString('zh-CN')} 行 · ${coverage?.start && coverage?.end ? `${coverage.start} 至 ${coverage.end}` : '期间待确认'} · 已处理 ${inspection.resolvedCount || 0} 组，待处理 ${pending} 组`));
      for (const error of inspection.errors || []) content.append(node('p', 'review-error', typeof error === 'string' ? error : error.message || pretty(error)));
      const groups = inspection.groups || [];
      if (!groups.length) content.append(node('p', 'review-help', '本轮未发现需要选择的重复候选。缺失指标与其他业务限制仍按原口径显示。'));
      groups.forEach((group, index) => content.append(candidateGroup(module, group, index)));
      content.append(organizationEditor(module));
    }
    card.append(content); return card;
  }

  async function revoke(id) {
    const affected = [];
    for (const module of review.modules) for (const group of module.inspection?.groups || []) {
      if (group.decisionId === id) affected.push(`${module.uploadId}:${group.key}`);
    }
    if (await mutate('/api/review/revoke', {id}, '已撤销。受影响来源已重新检查，历史成品与原始 Excel 保留。')) {
      // Revocation must return this group to an explicit choice, without
      // preselecting the old decision or discarding drafts for other groups.
      for (const key of affected) drafts.delete(key);
      apply(review, true);
    }
  }

  function renderRecords() {
    const host = $('#review-records'); host.replaceChildren();
    const decisions = review.decisions || [];
    const rules = review.organizationRules || [];
    if (!decisions.length && !rules.length) host.append(node('p', 'review-help', '尚未保存新的处理决定。每次确认和撤销都会在这里留记录。'));
    const title = moduleId => review.modules.find(module => module.id === moduleId)?.title || moduleId;
    for (const record of [...decisions.map(item => ({...item, type: 'duplicate'})), ...rules.map(item => ({...item, type: 'organization'}))].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
      const row = node('article', `review-record${record.revokedAt ? ' revoked' : ''}`);
      row.append(node('strong', '', `${title(record.moduleId)} · ${record.type === 'duplicate' ? '重复记录处理' : '组织对应'}`));
      row.append(node('p', 'review-help', record.type === 'duplicate' ? `计入 ${record.keepKeys?.length || 0} 条 · ${record.remember ? '同一组内容匹配时复用' : '仅本次来源'}` : `${readablePath(record.from)} → ${readablePath(record.to)}；${record.start || record.end ? `${record.start || '不限开始'} 至 ${record.end || '不限结束'}` : '不按日期限制'}；${record.remember ? '符合条件时复用' : '仅本次来源'}`));
      row.append(node('p', 'review-help', `${time(record.createdAt)}${record.revokedAt ? ` · 已于 ${time(record.revokedAt)} 撤销` : ''}`));
      if (!record.revokedAt) row.append(button('撤销此决定', () => revoke(record.id)));
      host.append(row);
    }
    if (review.history?.length) {
      const history = node('details', 'review-all-fields'); history.dataset.openKey = 'history-events';
      history.append(node('summary', '', `操作记录 · ${review.history.length} 条`));
      const list = node('ol', 'review-event-list');
      const names = {decision: '保存重复处理', organization: '保存组织对应', revoke: '撤销决定', restore: '恢复处理设置', check: '检查来源', select: '选择来源'};
      for (const event of [...review.history].reverse().slice(0, 100)) list.append(node('li', '', `${time(event.at || event.createdAt)} · ${event.message || names[event.type || event.action] || '更新处理记录'}`));
      history.append(list); host.append(history);
    }
  }

  function render() {
    const opened = new Map([...document.querySelectorAll('#review [data-open-key]')].map(item => [item.dataset.openKey, item.open]));
    const pending = review.modules.reduce((sum, module) => sum + (module.inspection?.pendingCount || 0), 0);
    const unchecked = review.modules.filter(module => module.status === 'unchecked').length;
    const errors = review.modules.filter(module => module.status === 'error').length;
    const resolved = review.modules.reduce((sum, module) => sum + (module.inspection?.resolvedCount || 0), 0);
    $('#review-summary').textContent = `${pending} 组待确认 · ${resolved} 组已处理${unchecked ? ` · ${unchecked} 类尚未检查` : ''}${errors ? ` · ${errors} 类需核对` : ''}`;
    const resume = $('#review-resume');
    resume.hidden = !pending && !unchecked && !errors;
    resume.textContent = `继续处理${pending ? ` ${pending} 组` : ''}${unchecked ? ' · 有来源尚未检查' : ''}${errors ? ' · 有来源需核对' : ''}`;
    $('#review-modules').replaceChildren(...review.modules.filter(module => module.uploadId || module.status !== 'missing').map(reviewModule));
    if (!review.modules.some(module => module.uploadId)) $('#review-modules').append(node('p', 'review-help', '先上传至少一类 Excel。软件会在上传后检查，并把待处理项集中列在这里。'));
    renderRecords();
    for (const item of document.querySelectorAll('#review [data-open-key]')) if (opened.has(item.dataset.openKey)) item.open = opened.get(item.dataset.openKey);
    controls();
  }

  function exportChecklist() {
    if (!review) return;
    const rows = [['板块', '来源文件', '候选组', '状态', 'Excel行号', '字段', '值']];
    for (const module of review.modules) for (const group of module.inspection?.groups || []) for (const row of group.rows || []) for (const [key, value] of Object.entries(row.values || {})) rows.push([module.title, module.filename, group.id, group.status === 'resolved' ? '已处理' : '待确认', row.row, key, pretty(value)]);
    // Prefix formula-leading source strings for safe opening in spreadsheet apps.
    const quote = value => `"${String(value ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
    download('待核对清单.csv', '\uFEFF' + rows.map(row => row.map(quote).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  }

  function init(adapter) {
    bridge = adapter;
    $('#review-check-button').addEventListener('click', () => mutate('/api/review/check', {}, '所有当前来源已完成检查，可在下方集中处理。'));
    $('#review-later').addEventListener('click', () => {
      notice('已经确认的结果保存在本机。尚未确认的勾选不会执行，回来后可从“继续处理”接着确认。');
      $('#sources').scrollIntoView({behavior: 'smooth'});
    });
    $('#review-export').addEventListener('click', exportChecklist);
    $('#review-backup').addEventListener('click', async () => {
      try { download('战区看板处理设置备份.json', JSON.stringify(await bridge.request('/api/review/backup'), null, 2)); notice('处理设置备份已下载。它不包含原始 Excel 和历史 HTML；完整资料仍需另行备份本机数据目录。'); }
      catch (error) { notice(error.message, true); }
    });
    $('#review-restore-file').addEventListener('change', async event => {
      const file = event.target.files?.[0]; fileBackup = null;
      $('#review-restore-name').textContent = '';
      try {
        if (!file) return;
        if (file.size > 32 * 1048576) throw new Error('处理设置备份超过 32 MB，请核对所选文件。');
        fileBackup = JSON.parse(await file.text());
        $('#review-restore-name').textContent = `已选择：${file.name}。恢复前请确认下方说明。`;
      } catch (error) { notice(`无法读取备份：${error.message}`, true); }
      finally { controls(); }
    });
    $('#review-restore-confirm').addEventListener('click', async () => {
      if (!fileBackup) return;
      if (await mutate('/api/review/restore', {backup: fileBackup}, '处理设置已恢复，当前来源已重新核对。请检查恢复后的处理记录。')) { fileBackup = null; $('#review-restore-file').value = ''; $('#review-restore-name').textContent = ''; controls(); }
    });
    $('#generate-pending-button').addEventListener('click', () => bridge.generate(true));
    controls();
  }

  function setState(state) {
    if (!bridge) return;
    const signature = JSON.stringify([state.reviewRevision, state.modules?.map(module => [module.id, module.activeUpload?.id, module.candidateUpload?.id, module.reviewStatus])]);
    if (signature !== stateSignature) { stateSignature = signature; refresh(); }
    controls();
  }
  return {init, setState, refresh, apply, controls};
})();
