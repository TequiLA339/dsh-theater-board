// Minimal streaming reader for one worksheet, built on the same yauzl + saxes
// stack as the upload validator (exceljs' streaming reader rejects some real
// exports). Values: string, number, boolean, Date (date-formatted cells) or null.
import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';
import { posix } from 'node:path';

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const localName = node => node.name.split(':').at(-1);

export function isDateFormat(code) {
  if (!code) return false;
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmyhs]/i.test(stripped) && !/^[#0.,%\s]*$/.test(stripped);
}
export function excelToDate(serial, date1904 = false) {
  return new Date(Math.round((serial - 25569 + (date1904 ? 1462 : 0)) * 86400000));
}

function openArchive(path) {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(new Error('文件不是可读取的 XLSX 工作簿。'));
      const entries = new Map();
      zip.on('error', reject);
      zip.on('entry', entry => { entries.set(entry.fileName, entry); zip.readEntry(); });
      zip.on('end', () => resolve({ zip, entries }));
      zip.readEntry();
    });
  });
}
async function parseXml(archive, path, handlers, required = true) {
  const entry = archive.entries.get(path);
  if (!entry) { if (required) throw new Error('工作簿缺少必需的内部内容。'); return; }
  const stream = await new Promise((resolve, reject) => archive.zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw new Error('工作簿含不支持的 XML 文档声明。'); });
  let pending = null;
  for (const [name, handler] of Object.entries(handlers)) if (name !== 'flush') parser.on(name, handler);
  stream.setEncoding('utf8');
  try {
    for await (const chunk of stream) {
      parser.write(chunk);
      if (handlers.flush) { pending = handlers.flush(); if (pending) await pending; }
    }
    parser.close();
    if (handlers.flush) { pending = handlers.flush(); if (pending) await pending; }
  } finally { stream.destroy(); }
}

/**
 * Stream the rows of the named sheet. onRow(rowNumber, values) may be async.
 * Returns { date1904 }.
 */
export async function streamSheetRows(file, sheetName, onRow, ref = {}) {
  const archive = await openArchive(file);
  try {
    let date1904 = false;
    const sheets = [], relationships = new Map();
    await parseXml(archive, 'xl/workbook.xml', { opentag(node) {
      const name = localName(node);
      if (name === 'workbookPr') date1904 = ['1', 'true'].includes(String(node.attributes.date1904 ?? '').toLowerCase());
      if (name === 'sheet') sheets.push({ name: node.attributes.name, relId: Object.entries(node.attributes).find(([key]) => key.endsWith(':id'))?.[1] });
    } });
    ref.value = date1904;
    await parseXml(archive, 'xl/_rels/workbook.xml.rels', { opentag(node) {
      if (localName(node) === 'Relationship' && /\/worksheet$/.test(node.attributes.Type ?? '')) {
        const target = node.attributes.Target ?? '';
        relationships.set(node.attributes.Id, posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('xl', target)));
      }
    } });
    const sheet = sheets.find(item => item.name === sheetName);
    const path = sheet && relationships.get(sheet.relId);
    if (!path) throw new Error('已验证的工作表无法读取。');

    const sharedStrings = [];
    {
      let value = '', inText = false, inString = false, phonetic = 0;
      await parseXml(archive, 'xl/sharedStrings.xml', {
        opentag(node) { const name = localName(node); if (name === 'si') { value = ''; inString = true; } if (name === 'rPh') phonetic++; if (name === 't' && inString && !phonetic) inText = true; },
        text(text) { if (inText) value += text; },
        closetag(node) { const name = localName(node); if (name === 't') inText = false; if (name === 'rPh') phonetic--; if (name === 'si') { sharedStrings.push(value); inString = false; } },
      }, false);
    }
    const formats = new Map(), dateStyles = new Set();
    {
      let inCellXfs = false, index = 0;
      await parseXml(archive, 'xl/styles.xml', {
        opentag(node) {
          const name = localName(node);
          if (name === 'numFmt') formats.set(Number(node.attributes.numFmtId), node.attributes.formatCode ?? '');
          if (name === 'cellXfs') { inCellXfs = true; index = 0; }
          if (name === 'xf' && inCellXfs) {
            const id = Number(node.attributes.numFmtId ?? 0);
            if (BUILTIN_DATE_FORMATS.has(id) || isDateFormat(formats.get(id))) dateStyles.add(index);
            index++;
          }
        },
        closetag(node) { if (localName(node) === 'cellXfs') inCellXfs = false; },
      }, false);
    }

    const queue = [];
    let rowNumber = 0, previousRow = 0, values = null, cell = null, capture = false, previousCol = 0;
    await parseXml(archive, path, {
      opentag(node) {
        const name = localName(node);
        if (name === 'row') {
          rowNumber = node.attributes.r === undefined ? previousRow + 1 : Number(node.attributes.r);
          previousRow = rowNumber; previousCol = 0; values = [];
        } else if (name === 'c') {
          const letters = node.attributes.r?.match(/^([A-Z]+)\d+$/)?.[1];
          const column = letters ? [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) : previousCol + 1;
          previousCol = column;
          cell = { column, type: node.attributes.t ?? 'n', style: Number(node.attributes.s ?? 0), raw: '', inline: '' };
        } else if ((name === 'v' || name === 't') && cell) capture = name;
      },
      text(text) { if (capture === 'v') cell.raw += text; else if (capture === 't') cell.inline += text; },
      closetag(node) {
        const name = localName(node);
        if (name === 'v' || name === 't') capture = false;
        else if (name === 'c' && cell) {
          let value = null;
          if (cell.type === 's') value = sharedStrings[Number(cell.raw)] ?? null;
          else if (cell.type === 'inlineStr') value = cell.inline;
          else if (cell.type === 'str') value = cell.raw;
          else if (cell.type === 'b') value = cell.raw === '1' || cell.raw.toLowerCase() === 'true';
          else if (cell.type === 'e') value = null;
          else if (cell.type === 'd') value = cell.raw ? new Date(cell.raw) : null;
          else if (cell.raw !== '') {
            const number = Number(cell.raw);
            value = !Number.isFinite(number) ? cell.raw : dateStyles.has(cell.style) ? excelToDate(number, date1904) : number;
          }
          values[cell.column - 1] = value;
          cell = null;
        } else if (name === 'row' && values) {
          queue.push([rowNumber, Array.from(values, value => value === undefined ? null : value)]);
          values = null;
        }
      },
      async flush() { while (queue.length) { const [row, cells] = queue.shift(); await onRow(row, cells); } },
    });
    return { date1904 };
  } finally { archive.zip.close(); }
}
