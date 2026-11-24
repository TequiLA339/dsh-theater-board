// Pure helpers for the DSH plugin host face; kept free of DSH imports so they
// can be tested with plain node:test.
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_PORT = 4181;
export const FORMAL_PORT = 4180;
export const DATA_FOLDER = 'TheaterCommandBoard-DSH';

/** Per-user application data directory (outside the plugin install directory). */
export function defaultDataDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  let base;
  if (platform === 'win32') base = env.APPDATA || join(home, 'AppData', 'Roaming');
  else if (platform === 'darwin') base = join(home, 'Library', 'Application Support');
  else base = env.XDG_DATA_HOME || join(home, '.local', 'share');
  return join(base, DATA_FOLDER, 'data');
}

/** Normalize the row config: port in range, data dir absolute. */
export function resolveSettings(config = {}, options) {
  const port = config.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`端口必须是 1024–65535 之间的整数：${port}`);
  if (port === FORMAL_PORT) throw new Error('端口 4180 留给源码版本机后台，请为插件选择其他端口。');
  const raw = typeof config.dataDir === 'string' ? config.dataDir.trim() : '';
  if (raw && !isAbsolute(raw)) throw new Error(`数据目录必须是绝对路径：${raw}`);
  const extra = Array.isArray(config.extraFrameAncestors) ? config.extraFrameAncestors : [];
  return { port, dataDir: raw ? resolve(raw) : defaultDataDir(options), extraFrameAncestors: extra };
}

/** Loopback forms of the DSH page origin, so 127.0.0.1 and localhost both embed. */
export function dshOrigins(origin) {
  if (!origin) return [];
  let url;
  try { url = new URL(origin); } catch { return []; }
  if (!['http:', 'https:'].includes(url.protocol)) return [];
  // Chrome rejects IPv6 literals in frame-ancestors, so only these two forms.
  const loopback = ['127.0.0.1', 'localhost'];
  if (![...loopback, '[::1]'].includes(url.hostname)) return [];
  const port = url.port ? `:${url.port}` : '';
  return loopback.map(host => `${url.protocol}//${host}${port}`);
}

/** Classify a startup failure into a message the panel shows instead of the board. */
export function startupProblem(error, { port, dataDir }) {
  const message = String(error?.message || error);
  if (error?.code === 'EADDRINUSE') return { code: 'port_in_use', message: `端口 ${port} 已被其他程序占用。请在插件配置中换一个端口后重新启用插件。` };
  if (/已有后台进程在使用|startup\.lock|另一个后台正在启动/.test(message)) {
    return { code: 'data_dir_locked', message: `数据目录正被另一个战区看板后台使用（例如源码版 http://127.0.0.1:${FORMAL_PORT}/ 或桌面版）。插件不会强行接管：请先关闭那个后台后重新启用插件，或在插件配置中改用其他数据目录。`, detail: `数据目录：${dataDir}` };
  }
  return { code: 'startup_failed', message: `战区看板后台启动失败：${message}`, detail: `数据目录：${dataDir}` };
}

const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Static explanation page served on the plugin port when the backend cannot start. */
export function problemPage(problem) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>战区看板未启动</title>
<body style="margin:0;font:14px/1.7 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2328;background:#f6f7f9">
<main style="max-width:560px;margin:72px auto;padding:24px 28px;background:#fff;border:1px solid #e5e7eb;border-radius:12px">
<h1 style="font-size:16px;margin:0 0 8px">战区看板暂未启动</h1>
<p style="margin:0 0 8px">${escape(problem.message)}</p>
${problem.detail ? `<p style="margin:0;color:#6b7280;font-size:12px">${escape(problem.detail)}</p>` : ''}
</main></body></html>`;
}
