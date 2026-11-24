// Build the DSH custom plugin index (format 1) for a Git distribution.
// Rules follow DSH docs/user/guide/plugin-market: https Git URL without
// credentials or fragment, 40-hex commit, exact SemVer, Unix-second timestamp.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function gitSource({ repo, commit, path }) {
  let url;
  try { url = new URL(repo); } catch { throw new Error(`仓库地址无效：${repo}`); }
  if (url.protocol !== 'https:') throw new Error('Git 仓库地址必须是 https。');
  if (url.username || url.password) throw new Error('仓库地址不能包含用户名或密码；私有仓库的访问凭据由使用者本机的 Git 保存。');
  if (url.hash || url.search) throw new Error('仓库地址不能包含 # 片段或查询参数。');
  if (!/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('commit 必须是 40 位小写十六进制完整提交号。');
  const clean = repo.replace(/\.git$/, '').replace(/\/$/, '');
  const dir = typeof path === 'string' ? path.replace(/^\/+|\/+$/g, '') : '';
  if (dir && (dir.split('/').includes('..') || /\\/.test(dir))) throw new Error(`包目录无效：${path}`);
  return { type: 'git', url: clean, commit, ...(dir ? { path: dir } : {}) };
}

/**
 * @param manifest - the built package.json (name, version, description, engines).
 * @param source - git source from gitSource().
 * @param previous - an existing index to extend (keeps earlier versions).
 */
export function buildIndex({ manifest, source, publishTimestamp = Math.floor(Date.now() / 1000), previous = null, icon = 'icons/theater-board.svg', homepage }) {
  if (!SEMVER.test(manifest.version)) throw new Error(`版本号不是 SemVer：${manifest.version}`);
  if (icon.startsWith('data:') && Buffer.byteLength(icon) > 32 * 1024) throw new Error('内嵌图标超过 32 KiB。');
  const version = { version: manifest.version, publishTimestamp, source, ...(manifest.engines?.dsh ? { engines: { dsh: manifest.engines.dsh } } : {}) };
  const base = previous ?? { format: 1, title: { en: 'Theater board plugins', zh: '战区看板插件' }, plugins: [] };
  if (base.format !== 1 || !Array.isArray(base.plugins)) throw new Error('已有索引格式无效。');
  const existing = base.plugins.find(plugin => plugin.name === manifest.name);
  const versions = [...(existing?.versions || []).filter(item => item.version !== manifest.version), version]
    .sort((a, b) => b.publishTimestamp - a.publishTimestamp);
  const plugin = {
    name: manifest.name,
    title: { en: 'Theater Board', zh: '战区看板' },
    description: { en: 'Local theater sales dashboard inside DeepSeek Harness, with read-only board query tools.', zh: '在 DeepSeek Harness 中打开本机战区经营看板（看板 / 更新数据 / 历史版本），并提供只读看板查询工具。' },
    icon,
    author: '战区看板项目',
    ...(homepage ? { homepage } : {}),
    repository: { url: source.url, ...(source.path ? { directory: source.path } : {}) },
    versions,
  };
  return { ...base, plugins: [...base.plugins.filter(item => item.name !== manifest.name), plugin] };
}
