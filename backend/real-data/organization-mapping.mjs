const ORG_FIELDS = ['marketingCompany', 'businessUnit', 'theater', 'region', 'office', 'unit'];
const MODULES = ['invoice', 'movement', 'opening', 'terminal', 'inventory', 'banquet'];
const validPath = path => Array.isArray(path) && path.length === 6 && path.every(value => typeof value === 'string' && value.length <= 1000);
const fullPath = path => validPath(path) && path.every(Boolean);
const key = path => JSON.stringify(path);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const shaMatches = (payload, moduleId, sha) => typeof sha === 'string' && /^[a-f0-9]{64}$/i.test(sha) && payload.sources[moduleId]?.sha256 === sha.toLowerCase() && payload.modules[moduleId]?.state !== 'unavailable';

/** Apply only enumerated, source-bound mappings. No suffix rewriting or fuzzy
 * organization matching is performed here. All original paths stay available
 * internally so a changed grouping can be traced back to the uploaded source.
 */
export function applyOrganizationMapping(payload, decision) {
  const report = { version: 1, status: 'not-configured', appliedSources: {}, referenceSourceMatches: {}, modules: {}, errors: [] };
  const observedTargets = new Set();
  for (const id of MODULES) for (const row of payload.modules[id].records) {
    row.originalOrgPath ??= [...row.orgPath];
    if (fullPath(row.orgPath)) observedTargets.add(key(row.orgPath));
  }
  if (!decision) return report;
  if (decision.version !== 1 || !isObject(decision.sources) || !isObject(decision.referenceSources)) {
    report.status = 'invalid'; report.errors.push('组织映射合同格式不受支持。'); return report;
  }
  const references = Object.entries(decision.referenceSources);
  report.referenceSourceMatches = Object.fromEntries(references.map(([id, sha]) => [id, shaMatches(payload, id, sha)]));
  if (!references.length || references.some(([id, sha]) => !MODULES.includes(id) || !shaMatches(payload, id, sha))) {
    report.status = 'stale'; report.errors.push('组织映射参考来源 SHA 已变化，未应用旧映射。'); return report;
  }
  report.status = 'confirmed';
  for (const [id, source] of Object.entries(decision.sources)) {
    if (!MODULES.includes(id)) { report.status = 'partial'; report.errors.push('组织映射含未知板块，已忽略。'); continue; }
    const detail = { sourceShaMatches: isObject(source) && shaMatches(payload, id, source.sourceSha256), appliedRows: 0, appliedPaths: 0, parentCompletionRows: 0, aliasRows: 0, unmatchedIncompletePaths: [], ambiguousPaths: [], rejectedMappings: 0, status: 'confirmed' };
    report.modules[id] = detail;
    if (!MODULES.includes(id) || !isObject(source) || !shaMatches(payload, id, source.sourceSha256) || !Array.isArray(source.mappings)) {
      detail.status = 'stale'; report.status = 'partial'; continue;
    }
    const candidates = new Map(), invalidKeys = new Set();
    for (const mapping of source.mappings) {
      const from = validPath(mapping?.from) ? key(mapping.from) : null;
      if (from === null || !fullPath(mapping.to) || !['parent-completion', 'confirmed-alias'].includes(mapping.kind) || !observedTargets.has(key(mapping.to))) {
        detail.rejectedMappings++; if (from !== null) invalidKeys.add(from); continue;
      }
      // Parent completion may fill only missing parents; explicit aliases may
      // change names, but only through the exact reviewed from/to pair.
      if (mapping.kind === 'parent-completion' && (mapping.from.slice(3).some((value, i) => value !== mapping.to[i + 3]) || mapping.from.slice(0, 3).some((value, i) => value && value !== mapping.to[i]))) {
        detail.rejectedMappings++; invalidKeys.add(from); continue;
      }
      if (mapping.kind === 'parent-completion') {
        const matches = [...observedTargets].map(path => JSON.parse(path)).filter(path => mapping.from.every((value, index) => !value || value === path[index]));
        if (matches.length !== 1) { detail.rejectedMappings++; invalidKeys.add(from); detail.ambiguousPaths.push(mapping.from); continue; }
      }
      const targets = candidates.get(from) ?? new Map();
      targets.set(key(mapping.to), mapping); candidates.set(from, targets);
    }
    for (const [from, targets] of candidates) if (targets.size !== 1) { invalidKeys.add(from); detail.ambiguousPaths.push(JSON.parse(from)); }
    detail.ambiguousPaths = [...new Map(detail.ambiguousPaths.map(path => [key(path), path])).values()];
    const applied = new Set(), incomplete = new Map();
    for (const row of payload.modules[id].records) {
      const from = key(row.originalOrgPath), targets = candidates.get(from);
      const mapping = !invalidKeys.has(from) && targets?.size === 1 ? [...targets.values()][0] : null;
      if (mapping) {
        row.orgPath = [...mapping.to]; row.org = Object.fromEntries(ORG_FIELDS.map((field, index) => [field, row.orgPath[index]])); row.orgKey = key(row.orgPath);
        row.organizationMapping = { version: 1, kind: mapping.kind, status: 'applied' };
        detail.appliedRows++; applied.add(from);
        if (mapping.kind === 'parent-completion') detail.parentCompletionRows++; else detail.aliasRows++;
      } else if (!fullPath(row.orgPath)) incomplete.set(from, row.orgPath);
    }
    detail.appliedPaths = applied.size; detail.unmatchedIncompletePaths = [...incomplete.values()];
    if (detail.rejectedMappings || detail.ambiguousPaths.length) { detail.status = 'partial'; report.status = 'partial'; }
    report.appliedSources[id] = source.sourceSha256.toLowerCase();
  }
  return report;
}

const RULES = {
  terminalIdentity: { status: 'confirmed', dependencies: ['terminal', 'movement'] },
  crossTableMetrics: { status: 'confirmed', dependencies: ['invoice', 'movement', 'opening', 'inventory'] },
  banquetOpeningSubset: { status: 'not-guaranteed', dependencies: ['banquet', 'opening'] },
};
/** Make source bindings explicit in the exported decision contract. A source
 * change disables its dependent rule even when an older decision file remains.
 */
export function buildDecisionContract(payload, decisions, mappingReport) {
  const contract = {
    version: 1, decisionId: typeof decisions?.decisionId === 'string' ? decisions.decisionId : null,
    confirmedAt: typeof decisions?.confirmedAt === 'string' ? decisions.confirmedAt : null,
    timeZone: typeof decisions?.timeZone === 'string' ? decisions.timeZone : null,
    organizationMapping: { status: mappingReport.status === 'confirmed' ? 'confirmed' : 'pending', version: 1, appliedSources: mappingReport.appliedSources },
    agreementFulfillment: { status: 'pending' }, banquetReward: { status: 'pending' }, inventoryValuationBasis: { status: 'pending' },
  };
  for (const [name, rule] of Object.entries(RULES)) {
    const configured = decisions?.businessRules?.[name];
    // Visit inventory has no amount/product relation. Its disabled estimate must
    // not invalidate unchanged invoice/movement/opening source-bound ratios.
    const dependencies = name === 'crossTableMetrics' && payload.modules.inventory.inventoryMode === 'visit-history'
      ? rule.dependencies.filter(id => id !== 'inventory') : rule.dependencies;
    const valid = configured?.status === rule.status && isObject(configured.sources) && dependencies.every(id => shaMatches(payload, id, configured.sources[id]));
    contract[name] = { status: valid ? rule.status : 'pending', sourceMatches: Object.fromEntries(dependencies.map(id => [id, shaMatches(payload, id, configured?.sources?.[id])])), sources: valid ? Object.fromEntries(dependencies.map(id => [id, configured.sources[id].toLowerCase()])) : {} };
    if (name === 'terminalIdentity') contract[name].key = 'original-code';
  }
  return contract;
}
