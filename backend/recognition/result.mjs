import { normalizeHeader } from './headers.mjs';

export const VALIDATION_VERSION = 2;
const structureNotice = '仅完成工作表、表头和非空行结构校验；尚未校验业务值、重复记录、统计期间、单位或计算口径。上传数据不参与本次演示看板计算。';

export function createRecognitionResult(moduleId) {
  const result = {
    validationVersion: VALIDATION_VERSION, moduleId, ok: false, level: 'structure',
    sheet: null, headerRow: 1, headers: [], rowCount: 0, missingHeaders: [],
    errors: [], warnings: [], sheets: [], fieldMappings: [], issues: [],
    businessValidation: { status: 'not_run', validRowCount: null, invalidRowCount: null },
  };
  addIssue(result, 'warning', 'STRUCTURE_ONLY', structureNotice);
  return result;
}

// One issue produces both a machine-readable record and the legacy UI message.
export function addIssue(result, severity, code, message, location = {}) {
  result.issues.push({ severity, code, message, sheet: null, row: null, columns: [], field: null, ...location });
  result[severity === 'error' ? 'errors' : 'warnings'].push(message);
}

export function mapFields(fields, headers) {
  return fields.map(({ key, header }) => ({
    field: key,
    expectedHeader: header,
    matches: headers.flatMap((source, index) => normalizeHeader(source) === normalizeHeader(header) ? [{ column: index + 1, header: source }] : []),
  }));
}
