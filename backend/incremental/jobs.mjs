import { readSource, aggregate, aggregator, aggregateFile, keyMatcher, receipt, streamSource, composeFile, summarizeFile, isWholeModule } from './flow.mjs';
import { streamSheetRows } from './xlsx-rows.mjs';
import { sourceDate } from '../review-engine.mjs';
import { normalizeHeader } from '../modules.mjs';

const COVERAGE_DATE = { invoice: '业务日期', movement: '扫码日期', opening: '抽奖日期', terminal: '签约日期', inventory: '提交时间' };

/** Earliest and latest date of a source, for uploads saved before coverage was recorded. */
async function coverageOf(file, validation, moduleId) {
  const header = COVERAGE_DATE[moduleId], headerRow = validation.headerRow ?? 1, ref = { value: false };
  if (!header) return { start: null, end: null };
  let column = -1, start = null, end = null;
  await streamSheetRows(file, validation.sheet, (rowNumber, cells) => {
    if (rowNumber < headerRow) return;
    if (rowNumber === headerRow) { column = cells.findIndex(value => normalizeHeader(value instanceof Date ? '' : String(value ?? '').trim()) === normalizeHeader(header)); return; }
    if (column < 0) return;
    const day = sourceDate(cells[column], ref.value);
    if (day) { if (!start || day < start) start = day; if (!end || day > end) end = day; }
  }, ref);
  return { start, end };
}

/** Worker-side update operations. Each reads only files the server has already validated. */
export async function runFlowJob(job) {
  if (job.kind === 'aggregate') return aggregateFile(job.file, job.validation, job.moduleId);
  if (job.kind === 'coverage') return coverageOf(job.file, job.validation, job.moduleId);
  if (job.kind === 'analyze' && isWholeModule(job.moduleId)) {
    const part = await summarizeFile(job.partFile, job.partValidation, job.moduleId);
    const base = job.baseFile ? await summarizeFile(job.baseFile, job.baseValidation, job.moduleId) : null;
    return { part, base, existingByDate: {} };
  }
  if (job.kind === 'analyze') {
    const part = await readSource(job.partFile, job.partValidation, job.moduleId);
    const partAggregate = aggregate(part, job.moduleId);
    if (!job.baseFile) return { part: partAggregate, base: null, existingByDate: {} };
    const needAggregate = !job.baseAggregate, matcher = keyMatcher(job.moduleId, part);
    if (needAggregate || matcher) {
      const acc = needAggregate ? aggregator(job.moduleId) : null;
      await streamSource(job.baseFile, job.baseValidation, job.moduleId,
        info => { acc?.header(info); matcher?.header(info); }, row => { acc?.row(row); matcher?.row(row); });
      return { part: partAggregate, base: acc ? acc.result() : job.baseAggregate, existingByDate: matcher ? matcher.result() : {} };
    }
    return { part: partAggregate, base: job.baseAggregate, existingByDate: {} };
  }
  if (job.kind === 'compose') {
    const part = await readSource(job.partFile, job.partValidation, job.moduleId);
    const partAggregate = aggregate(part, job.moduleId);
    // Recheck against the files themselves rather than the earlier preview.
    const acc = aggregator(job.moduleId), matcher = keyMatcher(job.moduleId, part);
    await streamSource(job.baseFile, job.baseValidation, job.moduleId, info => { acc.header(info); matcher?.header(info); }, row => { acc.row(row); matcher?.row(row); });
    const checked = receipt({ moduleId: job.moduleId, base: acc.result(), part: partAggregate, mode: job.mode, start: job.start, end: job.end, existingByDate: matcher ? matcher.result() : {} });
    if (checked.blocked.length) throw new Error(checked.blocked.join(' '));
    if (checked.requiresConfirmation && !job.confirmMissing) throw new Error('有组织在新文件里缺失，请先核对并确认后再提交。');
    const composed = await composeFile({ baseFile: job.baseFile, baseValidation: job.baseValidation, part, mode: job.mode, start: job.start, end: job.end, outFile: job.outFile, moduleId: job.moduleId });
    return { receipt: checked, warnings: [...checked.warnings, ...composed.warnings], kept: composed.kept, appended: composed.appended, rows: composed.rows };
  }
  throw new Error('Unknown flow operation');
}
