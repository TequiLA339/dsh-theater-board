'use strict';

// Merged page: latest dashboard, the update page and generation history in
// one place. Dashboards stay independent offline HTML files.
const $ = selector => document.querySelector(selector);
const titles = { invoice: '发票', movement: '动销', opening: '开瓶', terminal: '签约', inventory: '库存', banquet: '宴席', target: '目标' };
let state = null, viewingId = null, known = null, followLatest = true, toastTimer = null;
const updateFrame = $('#update-frame');

function show(view) {
  document.querySelectorAll('.seg button').forEach(button => button.classList.toggle('on', button.dataset.view === view));
  document.querySelectorAll('.view').forEach(section => section.classList.toggle('on', section.id === `view-${view}`));
  if (view === 'update' && !updateFrame.src) updateFrame.src = '/admin?embed=1';
}
document.querySelectorAll('.seg button').forEach(button => button.addEventListener('click', () => show(button.dataset.view)));
document.addEventListener('click', event => { const go = event.target.closest('[data-go]'); if (go) show(go.dataset.go); });

const time = value => { const d = new Date(value); return Number.isFinite(d.valueOf()) ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '—'; };
function dataEnd(job) {
  // Latest date among the daily flow sources this version was generated from.
  const ends = Object.entries(job.sourceIds || {}).filter(([id]) => ['invoice', 'movement', 'opening'].includes(id))
    .map(([, uploadId]) => state.uploads?.find(upload => upload.id === uploadId)?.coverage?.end).filter(Boolean).sort();
  return ends.at(-1) ? ends.at(-1).slice(5) : '—';
}
const completed = () => (state?.generations || []).filter(job => job.status === 'completed');
const latestNormal = () => completed().find(job => !job.needsReview) || completed()[0] || null;

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}
function openVersion(job) {
  const frame = $('#board-frame');
  if (!job) { frame.hidden = true; $('#board-empty').hidden = false; viewingId = null; return; }
  if (viewingId !== job.id) { frame.src = job.viewUrl; viewingId = job.id; }
  frame.hidden = false; $('#board-empty').hidden = true;
}
function renderMeta() {
  const current = completed().find(job => job.id === viewingId);
  const latest = latestNormal();
  const running = (state.generations || []).find(job => job.status === 'running');
  $('#meta').innerHTML = '';
  const parts = [];
  if (running) parts.push(['正在生成新版本', '']);
  if (current) parts.push([current.id === latest?.id ? '当前版本' : '正在查看历史版本', `${time(current.finishedAt || current.createdAt)} 生成`], ['数据截至', dataEnd(current)]);
  else parts.push(['还没有生成过看板', '']);
  parts.forEach(([label, value], index) => {
    if (index) $('#meta').append(' · ');
    $('#meta').append(label);
    if (value) { const b = document.createElement('b'); b.textContent = ` ${value}`; $('#meta').append(b); }
  });
}
function renderHistory() {
  const body = $('#history'); body.replaceChildren();
  const jobs = (state.generations || []).filter(job => ['completed', 'failed', 'running'].includes(job.status));
  if (!jobs.length) { const row = body.insertRow(); const cell = row.insertCell(); cell.colSpan = 5; cell.className = 'muted'; cell.textContent = '还没有生成记录'; return; }
  const latest = latestNormal();
  for (const job of jobs.slice(0, 50)) {
    const row = body.insertRow(); if (job.id === viewingId) row.className = 'viewing';
    row.insertCell().textContent = time(job.finishedAt || job.createdAt);
    row.insertCell().textContent = job.status === 'completed' ? dataEnd(job) : '—';
    row.insertCell().textContent = Object.keys(job.sourceIds || {}).map(id => titles[id] || id).join('、') || '—';
    const status = row.insertCell(), pill = document.createElement('span');
    const kind = job.status === 'failed' ? ['failed', '生成失败'] : job.status === 'running' ? ['running', '生成中'] : job.needsReview ? ['pending', '待确认版本'] : job.id === latest?.id ? ['cur', '当前'] : ['old', '历史'];
    pill.className = `pill ${kind[0]}`; pill.textContent = kind[1]; status.append(pill);
    if (job.status === 'failed' && job.error) status.title = job.error;
    const actions = row.insertCell();
    if (job.status === 'completed') {
      const view = document.createElement('button'); view.type = 'button'; view.className = 'link'; view.textContent = '查看';
      view.addEventListener('click', () => { followLatest = job.id === latest?.id; openVersion(job); renderMeta(); renderHistory(); show('board'); });
      const download = document.createElement('a'); download.className = 'link'; download.href = job.downloadUrl; download.textContent = '下载'; download.setAttribute('download', '');
      actions.append(view, ' · ', download);
    }
  }
}
async function refresh() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    state = await response.json();
  } catch { $('#meta').textContent = '无法连接本机后台，请确认后台已启动'; return; }
  const done = completed();
  if (known === null) { known = new Set(done.map(job => job.id)); openVersion(latestNormal()); }
  else {
    const fresh = done.filter(job => !known.has(job.id));
    for (const job of fresh) known.add(job.id);
    const newest = fresh.find(job => !job.needsReview);
    if (newest && followLatest) {
      openVersion(newest); show('board');
      toast(`已生成新版本（${time(newest.finishedAt)}），看板已切换到最新数据`);
    } else if (newest) toast('已生成新版本，可在“历史版本”查看');
    else if (fresh.some(job => job.needsReview)) toast('已生成待确认版本，可在“历史版本”查看；当前看板未替换');
  }
  renderMeta(); renderHistory();
}
refresh();
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 3000);
