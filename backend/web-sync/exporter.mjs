import { readFile, writeFile, mkdir, realpath, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { buildSourcePayload } from '../real-data/source-payload.mjs';
import { applyOrganizationMapping, buildDecisionContract } from '../real-data/organization-mapping.mjs';
import { packV10Payload, sanitizeV10Payload } from '../real-data/v10-template.mjs';

const IDS = ['invoice', 'movement', 'opening', 'terminal', 'inventory', 'banquet'];
const ORG = ['marketingCompany', 'businessUnit', 'theater', 'region', 'office', 'unit'];
const sha = value => createHash('sha256').update(value).digest('hex');
const validSegment = value => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 200
  && !/[\u0000-\u001f]/.test(value) && !['未提供', '未知', '未分配', '组织待确认'].includes(value);
const fullPath = path => Array.isArray(path) && path.length === 6 && path.every(validSegment);
const ready = module => module && ['ready', 'partial'].includes(module.state);
const clone = value => structuredClone(value);
export const websiteScopeId = path => sha(JSON.stringify(path));

function validScope(path) {
  return Array.isArray(path) && [0, 3, 4, 5].includes(path.length)
    && path.every(validSegment);
}

/** Prefixes are compared as path segments, never display labels or text prefixes. */
export function websiteScopeMatches(path, scope) {
  if (!validScope(scope)) throw new Error('网站授权组织路径格式无效。');
  return !scope.length || fullPath(path) && scope.every((part, index) => path[index] === part);
}

export function websiteScopes(payload) {
  const scopes = new Map([[websiteScopeId([]), []]]);
  for (const id of IDS) for (const row of payload.modules[id].records) {
    if (!fullPath(row.orgPath)) continue;
    for (const length of [3, 4, 5]) {
      const path = row.orgPath.slice(0, length);
      scopes.set(websiteScopeId(path), path);
    }
  }
  return [...scopes].map(([id, path]) => ({ id, path }));
}

/** Keep only the exact authorized rows. Never send raw diagnostics, filenames,
 * global totals, or an unfiltered organization dictionary to the browser.
 * Unknown identity inputs remain a conservative rule gate, not leaked rows.
 */
export function scopeWebsitePayload(input, scopePath) {
  if (!validScope(scopePath)) throw new Error('网站授权组织路径格式无效。');
  return scopeSanitizedPayload(sanitizeV10Payload(input), scopePath);
}

function scopeSanitizedPayload(input, scopePath) {
  const clean = { ...input, sources: Object.fromEntries(Object.entries(input.sources).map(([id, value]) => [id, { ...value }])),
    modules: { ...input.modules }, ...(input.decisionContract ? { decisionContract: clone(input.decisionContract) } : {}) };
  if (scopePath.length) {
    const allMovement = clean.modules.movement.records;
    const allModules = clean.modules;
    clean.modules = Object.fromEntries(IDS.map(id => [id, {
      ...allModules[id], records: allModules[id].records.filter(row => websiteScopeMatches(row.orgPath, scopePath)),
    }]));
    const terminalCodes = new Set(clean.modules.terminal.records.map(row => row.terminalCode).filter(Boolean));
    // The existing terminal builder treats missing scan identity as unknown.
    // Filtering away that evidence must not make a scoped effective count zero.
    const uncertainIdentity = allMovement.some(row => !row.terminalCode
      || !fullPath(row.orgPath) && terminalCodes.has(row.terminalCode));
    if (uncertainIdentity && clean.decisionContract?.terminalIdentity) {
      clean.decisionContract.terminalIdentity = { status: 'pending', key: 'original-code' };
    }
    // Whole-source missing dates can invalidate common-period calculations.
    // Preserve that gate when its evidence is outside the authorized payload.
    if (['invoice', 'movement', 'opening', 'inventory'].some(id => allModules[id].records.some(row => !row.date))
        && clean.decisionContract?.crossTableMetrics) {
      clean.decisionContract.crossTableMetrics = { status: 'pending' };
    }
  }
  for (const source of Object.values(clean.sources)) source.originalName = '已授权数据来源';
  return clean;
}

// This is the same exact-product-code uniqueness rule used by source-payload.
// A mixed-version release must resolve inventory classification from its actual
// selected invoice/movement records rather than the failed candidate's sources.
function refreshInventoryClassification(payload) {
  const products = new Map();
  for (const id of ['invoice', 'movement']) for (const row of payload.modules[id].records) {
    if (!row.productCode || !row.brand || !row.category) continue;
    const candidates = products.get(row.productCode) ?? new Map();
    candidates.set(JSON.stringify([row.brand, row.category]), { brand: row.brand, category: row.category });
    products.set(row.productCode, candidates);
  }
  for (const row of payload.modules.inventory.records) {
    const candidates = products.get(row.productCode);
    if (candidates?.size === 1) {
      Object.assign(row, [...candidates.values()][0]); row.classificationStatus = 'unique-product-code';
    } else {
      row.brand = null; row.category = null; row.classificationStatus = candidates?.size > 1 ? 'conflict' : 'unmapped';
    }
  }
}

/** Merge only successful candidate modules; all fallback provenance is local.
 * Reapply current source-bound mappings/rules to the resulting combination.
 */
export function mergeWebsiteModules(candidate, previous, decisions = {}, previousManifest = null) {
  const payload = clone(candidate), modules = {}, localFailures = {};
  payload.mode = 'real';
  for (const id of IDS) {
    const next = payload.modules[id];
    const failed = !ready(next);
    if (failed) {
      localFailures[id] = next?.reason || '该板块没有通过校验和计算。';
      if (ready(previous?.modules?.[id]) && previous.sources?.[id]) {
        payload.modules[id] = clone(previous.modules[id]);
        payload.sources[id] = clone(previous.sources[id]);
        payload.coverage[id] = clone(previous.coverage[id]);
      } else {
        delete payload.sources[id];
        payload.modules[id] = { state: 'unavailable', records: [], metrics: {}, unavailable: [], warnings: [] };
        payload.coverage[id] = { start: null, end: null, semantics: null };
      }
    }
    const source = payload.sources[id];
    const same = source && previous?.sources?.[id]?.sha256 === source.sha256
      && previous.sources[id].uploadId === source.uploadId;
    modules[id] = {
      status: !source || !ready(payload.modules[id]) ? 'unavailable' : failed || same ? 'retained' : 'updated',
      uploadId: source?.uploadId ?? null,
      updatedAt: same || failed && source ? previousManifest?.modules?.[id]?.updatedAt ?? previous?.generatedAt ?? payload.generatedAt : payload.generatedAt,
      ...(failed ? { error: source ? '本次处理未成功，继续展示上次成功数据。' : '暂无有效数据，请在本地后台检查。' } : {}),
    };
  }
  // Remove a previous source-bound mapping before reevaluating the mixed set.
  for (const id of IDS) for (const row of payload.modules[id].records) {
    if (Array.isArray(row.originalOrgPath)) {
      row.orgPath = [...row.originalOrgPath];
      row.org = Object.fromEntries(ORG.map((key, index) => [key, row.orgPath[index]]));
      row.orgKey = JSON.stringify(row.orgPath);
    }
    delete row.organizationMapping;
  }
  const organizationMapping = applyOrganizationMapping(payload, decisions?.organizationMapping);
  payload.decisionContract = buildDecisionContract(payload, decisions, organizationMapping);
  refreshInventoryClassification(payload);
  if (!IDS.some(id => ready(payload.modules[id]) && payload.modules[id].records.length)) {
    throw new Error('没有可供网站展示的有效数据；已保留线上版本。');
  }
  return { payload, modules, localFailures, organizationMapping };
}

async function optionalBytes(file) {
  try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function previousFrom(value) {
  if (!value) return null;
  const previous = typeof value === 'string' ? JSON.parse(await readFile(value, 'utf8')) : value;
  if (!previous.payload || !previous.manifest) throw new Error('上次网站版本缺少本地回退资料。');
  if (previous.payloadSha256 && sha(JSON.stringify(previous.payload)) !== previous.payloadSha256) throw new Error('上次网站版本的本地回退资料校验失败。');
  return previous;
}

/** Local-only preparation. No network calls and no source-store mutations.
 * outputDir must be new; an interrupted/incomplete directory is never reused.
 * previousRelease is a returned result or the previous local release.json path.
 */
export async function prepareWebsiteRelease({ dataDir, outputDir, previousRelease = null, baseRevision, uploadAttempts = {}, onStage = () => {} } = {}) {
  if (!dataDir || !outputDir) throw new Error('必须提供本地数据目录和新的网站验收目录。');
  dataDir = await realpath(resolve(dataDir)); outputDir = resolve(outputDir);
  if (outputDir === dataDir || ['uploads', 'generations'].some(name => outputDir === resolve(dataDir, name) || outputDir.startsWith(`${resolve(dataDir, name)}${sep}`))) throw new Error('网站验收目录不能覆盖上传或历史成品目录。');
  const stateFile = resolve(dataDir, 'state.json');
  const stateBefore = await readFile(stateFile);
  const decisionsFile = resolve(dataDir, 'generation-decisions.json');
  const decisionBefore = await optionalBytes(decisionsFile);
  let decisions = {};
  if (decisionBefore) {
    try { decisions = JSON.parse(decisionBefore); if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) throw new Error(); }
    catch { throw new Error('本机业务决定文件无效，未创建网站新版本。'); }
  }
  const previous = await previousFrom(previousRelease);
  onStage('正在读取各板块最新上传并独立校验、计算');
  const built = await buildSourcePayload({ dataDir, decisionsFile: decisionBefore ? decisionsFile : undefined });
  if (built.report.activeChangedDuringRead || built.report.decisionError) throw new Error('读取期间来源或业务决定发生变化，请重新准备网站版本。');
  const merged = mergeWebsiteModules(built.payload, previous?.payload, decisions, previous?.manifest);
  // The original upload server records successful installations only. The
  // website controller supplies its latest per-module attempt, so an invalid
  // upload that left active unchanged is still visible as a retained version.
  const sourceState = JSON.parse(stateBefore);
  const uploadFailures = {};
  for (const id of IDS) {
    const attempt = uploadAttempts[id];
    const active = sourceState.uploads.find(item => item.id === sourceState.active[id] && item.moduleId === id);
    if (attempt?.status !== 'failed' || !Number.isFinite(Date.parse(attempt.attemptAt))) continue;
    if (active?.uploadedAt && Date.parse(active.uploadedAt) > Date.parse(attempt.attemptAt)) continue;
    const info = merged.modules[id];
    info.status = info.uploadId ? 'retained' : 'unavailable';
    info.error = info.uploadId ? '本次上传未通过，继续使用上一有效版本。' : '本次上传未通过，暂无有效数据。';
    uploadFailures[id] = { status: 'failed', attemptAt: attempt.attemptAt };
  }
  const generatedAt = new Date().toISOString(), revision = randomUUID();
  merged.payload.generatedAt = generatedAt;
  const snapshot = () => {
    const state = JSON.parse(stateBefore);
    return JSON.stringify({ active: state.active, uploads: state.uploads.map(({ id, moduleId, sha256, validationContract }) => ({ id, moduleId, sha256, validationContract })) });
  };
  const expectedSnapshot = snapshot();
  const verify = async () => {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    const current = JSON.stringify({ active: state.active, uploads: state.uploads.map(({ id, moduleId, sha256, validationContract }) => ({ id, moduleId, sha256, validationContract })) });
    if (current !== expectedSnapshot) throw new Error('准备网站版本期间上传资料发生变化，未生成可同步版本。');
    const now = await optionalBytes(decisionsFile);
    if ((now ? sha(now) : null) !== (decisionBefore ? sha(decisionBefore) : null)) throw new Error('准备网站版本期间业务决定发生变化，未生成可同步版本。');
    // Recheck successfully-read new bytes. Cached retained modules have already
    // been verified as a prior accepted local release and need no old-file read.
    for (const id of IDS) if (ready(built.payload.modules[id])) {
      const source = built.payload.sources[id];
      const file = await realpath(resolve(dataDir, 'uploads', source.uploadId, 'source.xlsx'));
      if (!file.startsWith(`${resolve(dataDir, 'uploads')}${sep}`) || sha(await readFile(file)) !== source.sha256) throw new Error('准备网站版本期间来源文件发生变化，未生成可同步版本。');
    }
  };
  await verify();
  await mkdir(outputDir, { mode: 0o700 });
  try {
    await mkdir(resolve(outputDir, 'objects'), { mode: 0o700 });
    const manifest = { revision, baseRevision: baseRevision === undefined ? previous?.manifest?.revision ?? null : baseRevision,
      generatedAt, modules: merged.modules, scopes: [] };
    const objects = [];
    const scopes = websiteScopes(merged.payload);
    if (scopes.length > 2000) throw new Error('授权组织范围超过网站清单上限，请调整范围后再同步。');
    const sanitized = sanitizeV10Payload(merged.payload);
    for (let index = 0; index < scopes.length; index++) {
      const scope = scopes[index];
      onStage(`正在生成授权范围数据 ${index + 1}/${scopes.length}`);
      const scoped = scopeSanitizedPayload(sanitized, scope.path);
      const bytes = gzipSync(Buffer.from(JSON.stringify(packV10Payload(scoped))), { level: 6 });
      if (bytes.length > 64 * 1024 * 1024) throw new Error('单个授权范围数据超过网站同步上限，请缩小数据范围。');
      const info = { ...scope, sha256: sha(bytes), bytes: bytes.length };
      const file = resolve(outputDir, 'objects', `${scope.id}.json.gz`);
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      manifest.scopes.push(info); objects.push({ ...info, file });
    }
    await verify();
    const report = { ...built.report, localFailures: merged.localFailures, uploadFailures, organizationMapping: merged.organizationMapping,
      decisionContract: merged.payload.decisionContract,
      summary: Object.fromEntries(IDS.map(id => [id, { state: merged.payload.modules[id].state, ...merged.payload.modules[id].metrics }])),
      rejectedOrganizationRows: Object.fromEntries(IDS.map(id => [id, merged.payload.modules[id].records.filter(row => !fullPath(row.orgPath)).length])) };
    const payload = merged.payload;
    const sourceVersions = Object.fromEntries(Object.entries(payload.sources).map(([id, source]) => [id, { uploadId: source.uploadId, sha256: source.sha256 }]));
    const release = { schemaVersion: 1, payload, payloadSha256: sha(JSON.stringify(payload)), sourceVersions, manifest };
    const manifestPath = resolve(outputDir, 'manifest.json'), releasePath = resolve(outputDir, 'release.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    await writeFile(resolve(outputDir, 'diagnostics.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    await writeFile(releasePath, JSON.stringify(release), { flag: 'wx', mode: 0o600 });
    onStage('网站数据已准备完成，等待本地验收后同步');
    return { ...release, report, manifestPath, releasePath, objects };
  } catch (error) {
    // This function created this otherwise-new directory, so cleanup cannot
    // remove a previous release or a user-owned output.
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}
