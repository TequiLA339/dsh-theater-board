import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';
import { posix } from 'node:path';
import { moduleById, moduleDefinitions, normalizeHeader } from './modules.mjs';
import { createRecognitionResult, addIssue, mapFields } from './recognition/result.mjs';
import { uploadLimits as limits, formatUploadMB } from './recognition/upload-limits.mjs';

class WorkbookValidationError extends Error {
  constructor(message, code = 'WORKBOOK_UNREADABLE') { super(message); this.code = code; }
}

function expansionError(entry, bytes, totalBytes) {
  if (bytes > limits.entryBytes) {
    const label = /^xl\/worksheets\/[^/]+\.xml$/i.test(entry.fileName) ? '单张工作表' : '单个工作簿内部文件';
    return new WorkbookValidationError(`${label}解压后大小为 ${formatUploadMB(bytes)}，超过 ${limits.entryBytes / 1048576} MB 上限。请整理文件后重试；多次上传不会合并。`, 'WORKBOOK_ENTRY_TOO_LARGE');
  }
  if (totalBytes > limits.totalBytes) return new WorkbookValidationError(`工作簿累计解压内容为 ${formatUploadMB(totalBytes)}，超过整本 ${limits.totalBytes / 1048576} MB（1 GB）上限。请整理文件后重试；多次上传不会合并。`, 'WORKBOOK_TOTAL_TOO_LARGE');
  return null;
}

// Scan and decompress without extracting files. Checking actual bytes also catches
// forged ZIP sizes before the spreadsheet parser sees the archive.
async function checkArchive(path) {
  await new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(new WorkbookValidationError('文件不是可读取的 XLSX 工作簿，可能已损坏或加密。'));
      let ended = false, entryCount = 0, declaredBytes = 0, actualBytes = 0;
      const names = new Set();
      const fail = error => { if (!ended) { ended = true; zip.close(); reject(error); } };
      zip.on('error', () => fail(new WorkbookValidationError('XLSX 压缩内容不完整或已损坏。')));
      zip.on('entry', entry => {
        if (ended) return;
        entryCount++;
        declaredBytes += entry.uncompressedSize;
        if (entryCount > limits.entries) return fail(new WorkbookValidationError(`工作簿内部文件已超过 ${limits.entries} 个（当前至少 ${entryCount} 个），请整理无用内容后重试。`, 'WORKBOOK_TOO_MANY_ENTRIES'));
        const declaredError = expansionError(entry, entry.uncompressedSize, declaredBytes);
        if (declaredError) return fail(declaredError);
        if (names.has(entry.fileName)) return fail(new WorkbookValidationError('工作簿包含重复的内部文件，无法可靠校验。'));
        names.add(entry.fileName);
        if (/vbaProject\.bin$/i.test(entry.fileName)) return fail(new WorkbookValidationError('此入口仅支持不含宏的 .xlsx 文件。'));
        if (entry.generalPurposeBitFlag & 1) return fail(new WorkbookValidationError('暂不支持加密工作簿，请另存为未加密的 .xlsx 文件。'));
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(new WorkbookValidationError('XLSX 压缩内容无法读取。'));
          let entryBytes = 0;
          stream.on('data', chunk => {
            entryBytes += chunk.length; actualBytes += chunk.length;
            const actualError = expansionError(entry, entryBytes, actualBytes);
            if (actualError) {
              stream.destroy();
              fail(actualError);
            }
          });
          stream.on('error', () => fail(new WorkbookValidationError('XLSX 压缩内容不完整或已损坏。')));
          stream.on('end', () => { if (!ended) zip.readEntry(); });
        });
      });
      zip.on('end', () => {
        if (ended) return;
        ended = true;
        if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) {
          reject(new WorkbookValidationError('文件缺少 XLSX 工作簿结构，请用 Excel 另存为 .xlsx 后重试。'));
        } else resolve();
      });
      zip.readEntry();
    });
  });
}

async function openArchive(path) {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = new Map();
      zip.on('error', reject);
      zip.on('entry', entry => { entries.set(entry.fileName, entry); zip.readEntry(); });
      zip.on('end', () => resolve({ zip, entries }));
      zip.readEntry();
    });
  });
}

async function parseXml(archive, path, handlers) {
  const entry = archive.entries.get(path);
  if (!entry) throw new WorkbookValidationError('工作簿缺少必需的内部工作表内容。');
  const stream = await new Promise((resolve, reject) => archive.zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw new WorkbookValidationError('工作簿含不支持的 XML 文档声明，请另存为标准 XLSX。'); });
  for (const [name, handler] of Object.entries(handlers)) parser.on(name, handler);
  stream.setEncoding('utf8');
  try { for await (const chunk of stream) parser.write(chunk); parser.close(); }
  finally { stream.destroy(); }
}

const localName = node => node.name.split(':').at(-1);
const sourceFormats = module => module.sourceFormats ?? [module];
const acceptsSheet = (format, sheet) => format.sheetNames.some(name => normalizeHeader(name) === normalizeHeader(sheet));

async function readStructure(filePath, module) {
  const archive = await openArchive(filePath);
  try {
    const sheets = [], relationships = new Map(), sharedStrings = [];
    await parseXml(archive, 'xl/workbook.xml', { opentag(node) {
      if (localName(node) === 'sheet') {
        if (!node.attributes.name || node.attributes.name.length > 128) throw new WorkbookValidationError('工作表名称为空或过长。');
        const relId = Object.entries(node.attributes).find(([name]) => name.endsWith(':id'))?.[1];
        sheets.push({ name: node.attributes.name, relId });
      }
    } });
    await parseXml(archive, 'xl/_rels/workbook.xml.rels', { opentag(node) {
      if (localName(node) === 'Relationship' && /\/worksheet$/.test(node.attributes.Type ?? '')) {
        if (node.attributes.TargetMode === 'External') throw new WorkbookValidationError('主工作表不能是外部链接。');
        const target = node.attributes.Target ?? '';
        const path = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('xl', target));
        if (!path.startsWith('xl/')) throw new WorkbookValidationError('工作簿内部工作表路径无效。');
        relationships.set(node.attributes.Id, path);
      }
    } });
    if (archive.entries.has('xl/sharedStrings.xml')) {
      let value = '', inText = false, inString = false, totalCharacters = 0;
      await parseXml(archive, 'xl/sharedStrings.xml', {
        opentag(node) { const name = localName(node); if (name === 'si') { value = ''; inString = true; } if (name === 't' && inString) inText = true; },
        text(text) { if (inText) { value += text; totalCharacters += text.length; if (value.length > 1_000_000 || totalCharacters > 64 * 1024 * 1024) throw new WorkbookValidationError('工作簿文字内容过大，请整理无用文字或格式后重试；多次上传不会合并。'); } },
        closetag(node) { const name = localName(node); if (name === 't') inText = false; if (name === 'si') { sharedStrings.push(value); inString = false; if (sharedStrings.length > 1_000_000) throw new WorkbookValidationError('工作簿文字条目过多，请整理无用内容后重试；多次上传不会合并。'); } },
      });
    }
    const output = [];
    for (const sheet of sheets) {
      const path = relationships.get(sheet.relId);
      if (!path) continue; // Chart sheets have no business rows.
      const result = { sheet: sheet.name, headers: [], rowCount: 0 };
      const format = sourceFormats(module).find(format => acceptsSheet(format, sheet.name));
      const isMain = Boolean(format);
      const sourceColumnLimit = format?.sourceColumnLimit ?? module.sourceColumnLimit;
      let rowNumber = 0, previousRow = 0, nonempty = false, cell = null, capture = false, previousCol = 0;
      await parseXml(archive, path, {
        opentag(node) {
          const name = localName(node);
          if (name === 'row') {
            rowNumber = node.attributes.r === undefined ? previousRow + 1 : Number(node.attributes.r);
            if (!Number.isInteger(rowNumber) || rowNumber <= previousRow || rowNumber > limits.rows + 1) throw new WorkbookValidationError('工作表行号无效或超过 100 万行，请整理后再上传。');
            previousRow = rowNumber; previousCol = 0; nonempty = false;
          }
          if (name === 'c') {
            const reference = node.attributes.r;
            const address = reference?.match(/^([A-Z]+)([1-9][0-9]*)$/);
            const letters = address?.[1];
            const column = reference === undefined ? previousCol + 1 : letters ? [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) : 0;
            if (!rowNumber || !column || column <= previousCol || column > limits.columns || (address && Number(address[2]) !== rowNumber)) throw new WorkbookValidationError('工作表单元格位置无效或超过 512 列，请保留业务表后再上传。');
            previousCol = column; cell = { type: node.attributes.t, column, value: '', formula: false };
          }
          if (name === 'f' && cell) cell.formula = true;
          if ((name === 't' || name === 'v') && cell) capture = true;
        },
        text(text) { if (capture && cell) { cell.value += text; if (cell.value.length > 1_000_000) throw new WorkbookValidationError('单元格文字过大，请整理后再上传。'); } },
        closetag(node) {
          const name = localName(node);
          if (name === 't' || name === 'v') capture = false;
          if (name === 'c' && cell) {
            // Business recognition is bounded by the module's reviewed source
            // columns. Archive integrity and resource limits still apply above.
            if (isMain && sourceColumnLimit && cell.column > sourceColumnLimit) { cell = null; return; }
            let value = cell.value;
            if (cell.type === 's') {
              const index = Number(value);
              if (!value.trim() || !Number.isInteger(index) || index < 0 || index >= sharedStrings.length) throw new WorkbookValidationError('工作簿文字引用损坏，请另存为 XLSX 后重试。');
              value = sharedStrings[index];
            }
            if (value.trim() !== '' || cell.formula) nonempty = true;
            if (isMain && rowNumber === 1) {
              if (cell.formula || cell.type === 'e') throw new WorkbookValidationError('第 1 行表头需为普通文字，不能使用公式或错误值。');
              if (value.length > 256) throw new WorkbookValidationError('第 1 行含过长表头，请确认第 1 行是字段名称。');
              while (result.headers.length < cell.column) result.headers.push('');
              result.headers[cell.column - 1] = value.trim();
            }
            cell = null;
          }
          if (name === 'row' && rowNumber > 1 && nonempty) result.rowCount++;
        },
      });
      output.push(result);
    }
    return output;
  } finally { archive.zip.close(); }
}

export async function validateWorkbook(filePath, moduleId) {
  const result = createRecognitionResult(moduleId);
  const module = moduleById.get(moduleId);
  if (!module) { addIssue(result, 'error', 'UNSUPPORTED_MODULE', '不支持的板块。'); return result; }
  try {
    await checkArchive(filePath);
    const structure = await readStructure(filePath, module);
    result.sheets = structure.map(sheet => ({ name: sheet.sheet, rowCount: sheet.rowCount }));
    const matches = structure.flatMap(sheet => sourceFormats(module).filter(format => acceptsSheet(format, sheet.sheet)).map(format => ({ sheet, format })));
    if (matches.length !== 1) {
      addIssue(result, 'error', matches.length ? 'AMBIGUOUS_SHEET' : 'MISSING_SHEET', matches.length ? '存在多个名称等价的主工作表，请只保留一份待校验主表。' : `未找到主工作表“${module.sheetNames[0]}”，请检查是否选错板块或文件。`);
      return result;
    }
    const { sheet, format } = matches[0];
    Object.assign(result, sheet);
    if (format.sourceFormat) result.sourceFormat = format.sourceFormat;
    result.fieldMappings = mapFields(format.fields, result.headers);
    const normalized = result.headers.map(normalizeHeader);
    const seen = new Set(), duplicates = new Set();
    normalized.filter(Boolean).forEach(header => { if (seen.has(header)) duplicates.add(header); else seen.add(header); });
    const headerLocation = { sheet: result.sheet, row: result.headerRow };
    const missing = result.fieldMappings.filter(mapping => !mapping.matches.length);
    result.missingHeaders = missing.map(mapping => mapping.expectedHeader);
    if (!result.headers.length) addIssue(result, 'error', 'EMPTY_HEADER', '第 1 行没有表头，请将字段名称放在第 1 行。', headerLocation);
    if (missing.length) addIssue(result, 'error', 'MISSING_HEADER', `缺少必需字段：${result.missingHeaders.join('、')}。`, { ...headerLocation, field: missing.length === 1 ? missing[0].field : null });
    for (const header of duplicates) {
      const columns = normalized.flatMap((value, index) => value === header ? [index + 1] : []);
      const field = format.fields.find(field => normalizeHeader(field.header) === header)?.key ?? null;
      addIssue(result, 'error', 'DUPLICATE_HEADER', `存在重复表头：${header}。`, { ...headerLocation, columns, field });
    }
    const extra = typeof module.headerCheck === 'function' && result.headers.length ? module.headerCheck(result.headers) : null;
    if (extra) addIssue(result, 'error', 'MISSING_HEADER', extra, headerLocation);
    if (!result.rowCount) addIssue(result, 'error', 'EMPTY_DATA', '主工作表只有表头或为空，没有非空数据行。', { sheet: result.sheet });
    const blankColumns = result.headers.flatMap((header, index) => header ? [] : [index + 1]);
    if (blankColumns.length) addIssue(result, 'warning', 'BLANK_HEADER', '表头中存在空白列；后续计算只会使用明确命名的字段。', { ...headerLocation, columns: blankColumns });
    if (result.sheets.length > 1) addIssue(result, 'warning', 'OTHER_SHEETS_IGNORED', `共识别 ${result.sheets.length} 个工作表，仅以“${result.sheet}”进行板块表头校验，其他表不参与汇总。`, { sheet: result.sheet });
    for (const note of format.notes ?? module.notes) addIssue(result, 'warning', 'MODULE_NOTE', note, { sheet: result.sheet });
    result.ok = result.errors.length === 0;
    return result;
  } catch (error) {
    addIssue(result, 'error', error instanceof WorkbookValidationError ? error.code : 'WORKBOOK_UNREADABLE', error instanceof WorkbookValidationError ? error.message : '无法解析此工作簿，请确认文件完整，并在 Excel 中另存为 .xlsx 后重试。');
    return result;
  }
}

// Identify which board a workbook belongs to from its sheet names only. This is
// a quick suggestion for batch uploads; the full structure check still runs on
// upload, and an ambiguous or unknown workbook must be assigned by the person.
export async function identifyWorkbook(filePath) {
  try {
    await checkArchive(filePath);
    const archive = await openArchive(filePath);
    const sheets = [];
    try {
      await parseXml(archive, 'xl/workbook.xml', { opentag(node) {
        if (localName(node) === 'sheet' && typeof node.attributes.name === 'string' && node.attributes.name.length <= 128) sheets.push(node.attributes.name);
      } });
    } finally { archive.zip.close(); }
    const matches = moduleDefinitions.filter(module => sheets.some(sheet => sourceFormats(module).some(format => acceptsSheet(format, sheet)))).map(module => module.id);
    return { ok: true, sheets, matches, moduleId: matches.length === 1 ? matches[0] : null,
      reason: matches.length === 1 ? null : matches.length ? '工作表同时符合多个板块，请手动选择' : '工作表名称不符合任何板块，请手动选择' };
  } catch (error) {
    return { ok: false, sheets: [], matches: [], moduleId: null, reason: error instanceof WorkbookValidationError ? error.message : '无法读取此工作簿，请确认是有效的 .xlsx 文件' };
  }
}
