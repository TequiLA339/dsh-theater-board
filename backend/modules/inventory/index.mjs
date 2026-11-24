import { defineModule } from '../../recognition/module-definition.mjs';
import { legacyFields } from './legacy-fields.mjs';

// Each worksheet name selects a complete, independent source contract. Fields
// are never combined across formats or guessed from similar business labels.
const visitFields = [
  ['dealerName', '经销商名称'], ['dealerCode', '经销商编码'], ['sourceOrgPath', '营销组织'],
  ['marketingCompany', '营销公司'], ['sourceBusinessUnit', '事业部'], ['region', '大区'],
  ['office', '办事处'], ['directorUnit', '客户主任单元'], ['submitter', '提交人'],
  ['submitterPhone', '手机号'], ['submittedAt', '提交时间'], ['dealerType', '经销商类型'],
  ['stocktakeCode', '盘点编码'], ['productName', '产品名称'], ['countedBottles', '库存瓶数'],
  ['systemStock', '提交时实时库存数'], ['systemStockAmount', '提交时实时库存数金额'],
  ['sourceDifferenceState', '差异'], ['varianceFlag', '是否存在盘点偏差'],
  ['varianceQuantity', '偏差数量（瓶）'], ['supplementRequested', '是否发起补录'],
  ['supplementStatus', '补录单数据状态'],
].map(([key, header]) => ({ key, header }));

const visitNotes = [
  '拜访采集表包含历史盘点；生成时按经销商编码和完整产品名称选择所选月末前最近一次提交，不跨盘点时点相加。',
  '同一最新时间有多条记录时保留候选并提示冲突，不自动删除疑似重复；编码、日期或数字缺失另行诊断，不补零。',
  '保留完整营销组织路径；事业部列可能填写战区，不直接套用旧组织层级，也不按短名称合并。',
  '新格式没有产品编码和盘点库存金额；盘点金额、金额差额、可销月份及统一品牌品类联动不可用，不用系统金额替代。',
  '盘点减系统差异、绝对差与源偏差分别保存。源差异分类不视为安全库存，最近一次盘点不视为统一时点实时库存。',
];
const legacyNotes = [
  '兼容经销商库存盘点明细；其他汇总工作表不重复计入，不跨盘点时点累加库存。',
  '组织需保留营销公司、事业部、战区、大区、办事处、单元完整路径；单元名称的业务含义与跨表关联待确认。',
  '已确认系统库存与盘点库存数量单位为瓶，两类库存金额单位为人民币元；安全库存仅定位源字段，不预设为数值阈值。',
  '旧格式源偏差沿用已确认绝对差口径；源负值和空值单独保留，不静默修正或补零。',
  '旧格式提交时间作为实际盘点时间，导出由系统筛选最新记录；该文件不代表完整历史。盘点编码不预设为明细唯一键。',
];
const sourceFormats = [
  { sourceFormat: 'visit-history', sheetNames: ['拜访采集-库存盘点'], fields: visitFields, notes: visitNotes },
  { sourceFormat: 'legacy-stocktake', sheetNames: ['经销商库存盘点明细'], fields: legacyFields, notes: legacyNotes },
];

export default defineModule({
  id: 'inventory',
  title: '库存盘点',
  description: '拜访采集-库存盘点（兼容原库存盘点明细）',
  sheetNames: sourceFormats.flatMap(format => format.sheetNames),
  fields: visitFields,
  notes: visitNotes,
  sourceFormats,
});
