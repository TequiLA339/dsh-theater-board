import { defineModule } from '../../recognition/module-definition.mjs';

// Source-backed column locations only; content observations do not define valid agreements.
export default defineModule({
  "id": "terminal",
  "title": "终端签约",
  "description": "终端协议签约明细",
  "sheetNames": [
    "联盟体协议签约明细表"
  ],
  "sourceColumnLimit": 36,
  "notes": [
    "用户已确认本表记录均为签约生效；终端数在统计范围内按网点编号去重。本接口仍只做结构校验，尚未执行业务计数。",
    "按每份协议记录的完整六级组织路径和签约经销商分别统计；同网点跨组织或经销商的记录保留各自归属。",
    "历史已确认的两条重复沿用原复核结论；不因只读取 A–AJ 就扩大重复合并范围，不将同网点的不同协议全部合并。",
    "仅使用 A–AJ（前 36 列），原表 AJ 为星级；按前 36 列中的精确表头识别，AJ 后的目标、收货、金额及达成字段全部忽略。",
    "签约经销商编码保留文本、前导零及分隔符。业务生成按已确认规则用网点编号关联动销售点编码；结构校验不执行跨表关联。",
    "有效终端按 2026-07-01 至所选月末、该终端已签约品系的净扫码件数判定：任一品系达到 1 件即有效。品系按协议名称识别；本接口不执行业务判定。"
  ],
  "fields": [
    {
      "key": "agreementCode",
      "header": "协议编号"
    },
    {
      "key": "siteCode",
      "header": "网点编号"
    },
    {
      "key": "siteName",
      "header": "网点名称"
    },
    {
      "key": "siteType",
      "header": "网点类型"
    },
    {
      "key": "siteLevel",
      "header": "网点等级"
    },
    {
      "key": "siteClassification",
      "header": "售点分类"
    },
    {
      "key": "marketingCompany",
      "header": "营销公司名称"
    },
    {
      "key": "businessUnit",
      "header": "事业部"
    },
    {
      "key": "theater",
      "header": "战区名称"
    },
    {
      "key": "region",
      "header": "大区"
    },
    {
      "key": "office",
      "header": "办事处"
    },
    {
      "key": "directorUnit",
      "header": "主任单元"
    },
    {
      "key": "agreementName",
      "header": "协议名称"
    },
    {
      "key": "signedDealerCode",
      "header": "签约经销商编码"
    },
    {
      "key": "signedDate",
      "header": "签约日期"
    },
    {
      "key": "agreementStartDate",
      "header": "协议开始日期"
    },
    {
      "key": "agreementEndDate",
      "header": "协议结束日期"
    },
    {
      "key": "signedTier",
      "header": "签约等级"
    },
    {
      "key": "approvalStatus",
      "header": "审批状态"
    },
    {
      "key": "signedVariety",
      "header": "签约品种"
    },
    {
      "key": "signingStatus",
      "header": "签约状态"
    },
    {
      "key": "manuallyClosed",
      "header": "是否手工关闭"
    },
    {
      "key": "star",
      "header": "星级"
    }
  ]
});
