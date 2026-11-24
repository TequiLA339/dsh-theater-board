import { defineModule } from '../../recognition/module-definition.mjs';

// Monthly business targets. Targets are a separate source and never replace
// agreement targets inside the terminal source.
//
// Preferred (wide) layout: one row per month and organization, one column per
// target, e.g. 发票目标（万元）、动销目标（万元）. The earlier long layout with
// 指标 + 目标值 columns stays accepted so existing files keep working.
const WIDE = [['发票目标', 'invoice', '发票金额'], ['动销目标', 'movement', '动销金额'], ['开瓶目标', 'opening', '开瓶瓶数']];
const compact = value => String(value ?? '').replace(/\s+/g, '').replace(/[()]/g, match => match === '(' ? '（' : '）');

/** Target value columns found in a header row: [{ index, header, metric, label }]. */
export function targetColumns(headers) {
  return headers.flatMap((header, index) => {
    const text = compact(header), match = text.match(/^(发票目标|动销目标|开瓶目标)(?:（(元|万元|瓶)）)?$/);
    if (!match) return [];
    const [, title, unit] = match, [, metric, name] = WIDE.find(([key]) => key === title);
    return [{ index, header, metric, label: `${name}${unit ? `（${unit}）` : ''}` }];
  });
}
const hasLong = headers => ['指标', '目标值'].every(name => headers.some(header => compact(header) === name));

export default defineModule({
  "id": "target",
  "title": "经营目标",
  "description": "按月份和组织填写的发票、动销目标",
  "sheetNames": [
    "经营目标"
  ],
  "notes": [
    "每行一个月份 × 组织，目标分列填写：发票目标（万元）、动销目标（万元），需要时可加开瓶目标（瓶）；不写单位的金额列按元读取。旧的“指标 + 目标值”写法继续兼容。",
    "主任单元留空表示目标填在办事处层级，办事处也留空表示大区层级，三级都留空表示全战区目标；上级目标不自动拆分到下级。",
    "组织按大区、办事处、主任单元名称与经营来源对应；名称对不上的目标不会计入。某一列留空表示该组织当月没有这项目标。",
    "同一年月、组织、指标出现多次时，该目标显示待确认，不自动相加。"
  ],
  "fields": [
    { "key": "month", "header": "年月" },
    { "key": "region", "header": "大区" },
    { "key": "office", "header": "办事处" },
    { "key": "unit", "header": "主任单元" }
  ],
  // Extra structure check: at least one target column must be present.
  "headerCheck": headers => targetColumns(headers).length || hasLong(headers) ? null
    : '缺少目标列：请至少填写“发票目标（万元）”或“动销目标（万元）”一列（旧格式需同时有“指标”和“目标值”）。'
});
