import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';

const SOURCES = ['invoice', 'movement', 'opening'];

// Prefill organization names already seen in the active sources. Business
// values stay blank: the template never suggests or copies a target amount.
export async function targetOrganizations(dataDir, state) {
  const seen = new Map();
  for (const id of SOURCES) {
    const uploadId = state.active?.[id];
    if (typeof uploadId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(uploadId)) continue;
    try {
      const inspection = JSON.parse(await readFile(resolve(dataDir, 'uploads', uploadId, 'inspection.json'), 'utf8'));
      for (const org of inspection.organizations || []) {
        const names = (org.path || []).slice(3, 6).map(value => String(value ?? '').trim());
        if (names.length === 3 && names.every(Boolean)) seen.set(JSON.stringify(names), names);
      }
    } catch { /* An unchecked source simply contributes no names. */ }
  }
  return [...seen.values()].sort((a, b) => a.join('/').localeCompare(b.join('/'), 'zh-CN'));
}

export async function buildTargetTemplate({ organizations = [], month = new Date().toISOString().slice(0, 7) } = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('经营目标');
  sheet.columns = [['年月', 12], ['大区', 16], ['办事处', 18], ['主任单元', 22], ['发票目标（万元）', 18], ['动销目标（万元）', 18]].map(([header, width]) => ({ header, width }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const names of organizations) sheet.addRow([month, ...names, null, null]);
  if (!organizations.length) sheet.addRow([month, '', '', '', null, null]);
  sheet.getColumn(1).numFmt = '@';
  const guide = workbook.addWorksheet('填写说明');
  guide.columns = [{ header: '说明', width: 110 }];
  guide.getRow(1).font = { bold: true };
  for (const line of [
    '只读取“经营目标”工作表；第 1 行表头请勿修改。每行一个月份 × 组织，发票目标、动销目标分两列填写。',
    '年月写成 2026-11 这样的格式；同一组织不同月份请分行填写。',
    '金额单位为万元。如需按元填写，可把表头改成“发票目标（元）”“动销目标（元）”。需要开瓶目标时可加一列“开瓶目标（瓶）”。',
    '主任单元留空 = 目标填在办事处层级；办事处也留空 = 大区层级；三级都留空 = 全战区目标。上级目标不会自动拆分到下级，可以只填大区或部分办事处。',
    '大区、办事处、主任单元名称需与经营来源中的名称一致，对不上的目标不会计入。',
    '某一列留空表示该组织当月没有这项目标；整行都没填的可以保留也可以删除。同一年月、组织请只填一行；重复时该目标显示待确认。',
    '已预填的组织名称来自当前已上传的发票、动销、开瓶资料，目标值需自行填写。',
  ]) guide.addRow([line]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
