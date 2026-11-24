// Distribution safety check for the packed plugin (docs/DSH插件.md §7). The
// package must never carry business workbooks, data directories, generated
// dashboards, credentials or machine configuration.
const ALLOWED_ROOT = new Set(['package.json', 'package-lock.json', 'build-manifest.json', 'README.md', 'index.js', 'client.js', 'cordis.patch.yml']);
const ALLOWED_HTML = [/^backend\/public\/[^/]+\.html$/, /^backend\/web-sync\/local\.html$/, /^backend\/real-data\/v10-shell\.html$/];
const FORBIDDEN = [
  [/\.(xlsx|xlsm|xls|csv|tsv|zip|tgz|7z|rar|db|sqlite|log)$/i, '业务数据或压缩包'],
  [/(^|\/)(本机后台数据|销售看板数据|业务资料|看板归档|历史版本|网站版|node_modules|generations|uploads)(\/|$)/, '数据或依赖目录'],
  [/(^|\/)(\.env[^/]*|\.npmrc|\.git|\.claude|\.openai|credentials[^/]*|id_rsa[^/]*|[^/]*\.pem|[^/]*\.key)$/i, '凭据或机器配置'],
  [/(^|\/)(state|generation-decisions|review-settings)\.json$/i, '本机状态文件'],
];

/**
 * @param {{path: string, text?: string}[]} entries - package-relative POSIX paths, text for text files.
 * @returns {string[]} problems; empty when the package is clean.
 */
export function auditPackage(entries) {
  const problems = [];
  for (const { path, text } of entries) {
    for (const [pattern, reason] of FORBIDDEN) if (pattern.test(path)) problems.push(`${path}：${reason}`);
    const top = path.split('/')[0];
    if (!path.includes('/') && !ALLOWED_ROOT.has(path)) problems.push(`${path}：未登记的根目录文件`);
    if (path.includes('/') && !['lib', 'backend', 'assets'].includes(top)) problems.push(`${path}：未登记的目录`);
    if (path.endsWith('.html') && !ALLOWED_HTML.some(pattern => pattern.test(path))) problems.push(`${path}：只允许后台静态页面与去业务化的 v10 外壳`);
    if (path.startsWith('backend/') && !/\.(mjs|js|css|html|md)$/.test(path)) problems.push(`${path}：后台出现未审核文件类型`);
    if (typeof text === 'string') {
      if (/\/Users\/|[A-Z]:\\Users\\/.test(text)) problems.push(`${path}：包含本机用户目录路径`);
      // Generated dashboards embed a payload; shipped HTML must be static pages only.
      if (path.endsWith('.html') && /const ZQ_RD = |V10_PAYLOAD=/.test(text)) problems.push(`${path}：疑似包含看板业务快照`);
    }
  }
  return problems;
}
