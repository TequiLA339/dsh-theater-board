import { defineModule } from '../../recognition/module-definition.mjs';

// Header matching stays structural; confirmed business meanings are recorded in notes.
export default defineModule({
  "id": "movement",
  "title": "终端动销",
  "description": "掌柜宝售点扫码明细",
  "sheetNames": [
    "掌柜宝售点扫码明细表(历史数据+新系统）"
  ],
  "notes": [
    "联盟体统一称终端；分销商动销不在此入口接入。",
    "订单编码来源于发票，分批出货可产生多条动销记录，重复订单编码正常，不按订单编码去重；各编码保留前导零和分隔符，不推定跨表身份关联。",
    "净动销按源值正负相加，不按出入库名称再次反转符号；不同单品单位的数量分别统计。",
    "单品单位为盒时，扫码数量(瓶)表示实际礼盒数，产品价格(瓶)表示每盒价格；盒不折算为瓶，瓶数与盒数不混加。扫码件数保留源值，不自行重算。",
    "扫码金额单位为元、含税；采购和退货均按各自扫码日期归属统计月份。以上为已确认口径，当前仍仅执行结构校验，未接入真实指标计算。"
  ],
  "fields": [
    {
      "key": "scanDate",
      "header": "扫码日期"
    },
    {
      "key": "orderCode",
      "header": "订单编码"
    },
    {
      "key": "outletCode",
      "header": "售点编码"
    },
    {
      "key": "region",
      "header": "大区名称"
    },
    {
      "key": "office",
      "header": "办事处名称"
    },
    {
      "key": "directorUnit",
      "header": "主任单元名称"
    },
    {
      "key": "dealerCode",
      "header": "经销商编码"
    },
    {
      "key": "movementType",
      "header": "出入库名称"
    },
    {
      "key": "productCode",
      "header": "产品编码"
    },
    {
      "key": "scanBottles",
      "header": "扫码数量(瓶)"
    },
    {
      "key": "scanAmount",
      "header": "扫码金额"
    },
    {
      "key": "scanCases",
      "header": "扫码件数"
    }
  ]
});
