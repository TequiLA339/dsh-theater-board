import { mkdir, readFile, writeFile, rename, unlink, open, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
}

export async function openStore(dataDir) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = resolve(dataDir, 'server.lock');
  const gate = resolve(dataDir, 'startup.lock');
  const owner = randomUUID();
  // mkdir is exclusive. Serialize stale-lock recovery so two launches cannot steal
  // a newly acquired lock. An interrupted gate is kept for explicit recovery.
  try { await mkdir(gate, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('另一个后台正在启动。若确认没有后台进程，请移除空的 startup.lock 目录后重试。'); throw error; }
  try {
  try { await writeFile(lock, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let old;
    try { old = JSON.parse(await readFile(lock, 'utf8')); }
    catch { throw new Error('后台数据目录中的运行锁无法读取，请检查 server.lock；原数据未改动。'); }
    if (!Number.isInteger(old.pid) || old.pid <= 0) throw new Error('后台运行锁无效，请检查 server.lock。');
    try { process.kill(old.pid, 0); throw new Error('此数据目录已有后台进程在使用。'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await unlink(lock);
    await writeFile(lock, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 });
  }
  } finally { await rmdir(gate); }
  const release = async () => { try { const current = JSON.parse(await readFile(lock, 'utf8')); if (current.owner === owner) await unlink(lock); } catch {} };
  try {
    for (const name of ['uploads', 'parts', 'generations', 'temp', 'logs']) await mkdir(resolve(dataDir, name), { recursive: true, mode: 0o700 });
    const manifestPath = resolve(dataDir, 'state.json');
    let state;
    try { state = JSON.parse(await readFile(manifestPath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('后台记录无法读取，已停止启动以保留原数据。请检查 state.json。');
      state = { schemaVersion: 1, uploads: [], active: {}, generations: [] };
    }
    if (state.schemaVersion !== 1 || !Array.isArray(state.uploads) || !Array.isArray(state.generations) || !state.active || typeof state.active !== 'object') throw new Error('后台记录格式不受支持，原数据已保留。');
    if (state.review && (state.review.version !== 1 || !Number.isSafeInteger(state.review.revision) || !Array.isArray(state.review.decisions) || !Array.isArray(state.review.organizationRules) || !Array.isArray(state.review.history))) throw new Error('检查处理记录格式不受支持，原数据已保留。');
    if (state.candidates && (typeof state.candidates !== 'object' || Array.isArray(state.candidates))) throw new Error('待处理来源记录格式无效，原数据已保留。');
    let queue = Promise.resolve();
    async function update(change) {
      const pending = queue.then(async () => {
        const next = structuredClone(state);
        await change(next);
        await atomicJson(manifestPath, next);
        state = next;
        return next;
      });
      queue = pending.catch(() => {});
      return pending;
    }
    await update(next => {
      for (const job of next.generations) if (job.status === 'running') Object.assign(job, { status: 'failed', stage: '生成中断', error: '上次后台退出时任务尚未完成，请重新生成。', finishedAt: new Date().toISOString() });
    });
    return { get state() { return state; }, update, release };
  } catch (error) { await release(); throw error; }
}
