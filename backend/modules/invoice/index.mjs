import { defineModule } from '../../recognition/module-definition.mjs';

// Source headers only. Notes record confirmed policy and remaining gaps, not executed checks.
// Keep identifiers opaque: the inspected source includes alphanumeric document lines.
export default defineModule({
  "id": "invoice",
  "title": "发票销售",
  "description": "销售收入明细与发票金额",
  "sheetNames": [
    "销售收入明细"
  ],
  "notes": [
    "已确认发票金额按源数值及原正负号计入，单位为元、含税，不应用拆分比例；XS、ZK3 均纳入发票销售。当前仅记录口径，未执行真实指标计算。",
    "业务日期可能为文本，单据行号可能含字母；编码需保留原文本与前导零。已确认特殊行号记录暂照常纳入，结构通过不表示日期或业务明细已校验。",
    "已确认的系统调整重复组暂保留非高端组织候选一条，仅适用于已确认重复组。当前仅记录规则，结构识别不执行去重，不改写原始 Excel。",
    "计价数量须连同计价单位核对，件与瓶不直接相加；数量是否应用拆分比例、单位换算及业务有效行数尚未确认或校验。"
  ],
  "fields": [
    {
      "key": "businessDate",
      "header": "业务日期"
    },
    {
      "key": "region",
      "header": "销售大区"
    },
    {
      "key": "office",
      "header": "办事处"
    },
    {
      "key": "directorUnit",
      "header": "客户主任单元"
    },
    {
      "key": "dealerCode",
      "header": "经销商编码"
    },
    {
      "key": "productCode",
      "header": "产品编码"
    },
    {
      "key": "pricingUnit",
      "header": "计价单位"
    },
    {
      "key": "pricingQuantity",
      "header": "计价数量"
    },
    {
      "key": "invoiceAmount",
      "header": "发票金额"
    },
    {
      "key": "documentType",
      "header": "单据类型"
    },
    {
      "key": "documentCode",
      "header": "单据编码"
    },
    {
      "key": "documentLine",
      "header": "单据行号"
    },
    {
      "key": "splitRatio",
      "header": "拆分比例"
    }
  ]
});
