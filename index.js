// Host face of the DSH plugin: start the existing local backend on a plugin
// port while the row is enabled, and close it when the row is disposed.
import http from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_PORT, dshOrigins, problemPage, resolveSettings, startupProblem } from './lib/settings.mjs';
import { createBoardQueries } from './lib/tools.mjs';
import { toolDefinitions } from './lib/tool-definitions.mjs';

export const name = 'dsh-theater-board';

const here = dirname(fileURLToPath(import.meta.url));
// DSH packages resolve from the running host (declared as optional peers).
let Schema, dshTools, dshLlm;
try { Schema = (await import('@deepseek-ai/schemastery')).default; } catch {}
try { dshTools = await import('@deepseek-ai/dsh-tools'); } catch {}
try { dshLlm = await import('@deepseek-ai/dsh-llm'); } catch {}

export const Config = Schema && Schema.object({
  port: Schema.natural().min(1024).max(65535).default(DEFAULT_PORT).volatile()
    .description('插件后台端口（只监听 127.0.0.1）。默认 4181，避开源码版的 4180。'),
  dataDir: Schema.string().default('')
    .description('数据目录（绝对路径）。留空使用用户数据目录下的 TheaterCommandBoard-DSH/data；可指向项目的「本机后台数据」以沿用现有数据，但同一目录同时只能有一个后台在用。'),
  extraFrameAncestors: Schema.array(Schema.string()).default([])
    .description('额外允许嵌入看板的本机页面来源（如 http://127.0.0.1:3080），一般不需要填写。'),
});

/** Backend location: bundled copy first (distribution), then the source checkout. */
export function backendEntry() {
  for (const candidate of [resolve(here, 'backend/server.mjs'), resolve(here, '../战区看板原型/backend/server.mjs')]) if (existsSync(candidate)) return candidate;
  throw new Error('找不到战区看板后台源码（backend/server.mjs）。');
}

/** Start the backend, or a static explanation page on the same port when it cannot start. */
/** Volatile config fields arrive as refs with get(); plain values pass through. */
const plain = config => Object.fromEntries(Object.entries(config || {}).map(([key, value]) => [key, typeof value?.get === 'function' ? value.get() : value]));

export async function startBoard(config = {}, { frameOrigins = () => [], log = console } = {}) {
  const settings = resolveSettings(plain(config));
  const ancestors = () => [...frameOrigins(), ...settings.extraFrameAncestors];
  try {
    const { createAdminServer } = await import(pathToFileURL(backendEntry()).href);
    const backend = await createAdminServer({ port: settings.port, dataDir: settings.dataDir, frameAncestors: ancestors });
    log.info?.(`[theater-board] 看板后台已启动 ${backend.url}（数据目录 ${settings.dataDir}）`);
    return { ok: true, url: backend.url, settings, close: () => backend.close() };
  } catch (error) {
    const problem = startupProblem(error, settings);
    log.warn?.(`[theater-board] ${problem.message}`);
    if (problem.code === 'port_in_use') return { ok: false, problem, settings, close: async () => {} };
    const page = problemPage(problem);
    const server = http.createServer((request, response) => {
      const hosts = [`127.0.0.1:${settings.port}`, `localhost:${settings.port}`];
      if (!hosts.includes(request.headers.host)) { response.writeHead(403); response.end(); return; }
      if (request.url.startsWith('/api/health')) {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ ready: false, problem }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' ${ancestors().join(' ')}`.trim() });
      response.end(page);
    });
    try {
      await new Promise((ok, fail) => { server.once('error', fail); server.listen(settings.port, '127.0.0.1', ok); });
    } catch (listenError) {
      return { ok: false, problem: startupProblem(listenError, settings), settings, close: async () => {} };
    }
    return { ok: false, problem, settings, close: () => new Promise(ok => { server.close(() => ok()); server.closeAllConnections?.(); }) };
  }
}

export function apply(ctx, config = {}) {
  let web = null;
  let current = null;
  ctx.inject?.(['webServer'], webCtx => {
    web = webCtx.webServer;
    webCtx.effect(() => () => { web = null; });
  });
  const frameOrigins = () => {
    if (!web) return [];
    try { return dshOrigins(web.getOrigin()); } catch { return []; }
  };
  // ctx.effect owns the backend: its disposer runs when the row is disabled,
  // uninstalled or hot-replaced, and waits for uploads/generation to settle.
  ctx.effect(() => {
    let disposed = false;
    const running = startBoard(config, { frameOrigins }).then(board => {
      if (disposed) return board.close().then(() => null);
      current = board;
      return board;
    }, error => { console.warn(`[theater-board] ${error.message}`); return null; });
    return async () => {
      disposed = true;
      current = null;
      const board = await running;
      if (board) { await board.close(); console.info('[theater-board] 看板后台已关闭'); }
    };
  });

  // Read-only AI tools (docs/DSH插件.md §5). Registered only when the host
  // offers a tool registry; failures here never affect the board itself.
  if (dshTools?.defineTool && ctx.inject) {
    let settings;
    try { settings = resolveSettings(plain(config)); } catch { return; }
    const queries = createBoardQueries({
      dataDir: settings.dataDir, backendDir: dirname(backendEntry()), port: settings.port,
      problem: () => (current && !current.ok ? current.problem : current ? null : { message: '战区看板后台尚未启动或已停用。' }),
    });
    ctx.inject(['tools'], toolCtx => {
      for (const definition of toolDefinitions(queries, { HarnessError: dshLlm?.HarnessError })) toolCtx.tools.register(dshTools.defineTool(definition));
    });
  }
}
