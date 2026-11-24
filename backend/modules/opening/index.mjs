import { defineModule } from '../../recognition/module-definition.mjs';

// Source headers only. Content observations do not establish business-value rules.
export default defineModule({
  "id": "opening",
  "title": "消费者开瓶",
  "description": "消费者开瓶扫码汇总",
  "sheetNames": [
    "消费者开瓶扫码"
  ],
  "notes": [
    "原表没有产品编码和终端编码，后续不随这两个维度筛选。",
    "按抽奖日期归属开瓶统计期间，用于日期范围和月份筛选。",
    "组织归属使用产品所属的大区、办事处、主任单元完整路径；开瓶城市不能替代组织归属。",
    "当前按源表已有汇总数据读取；非空行数不能作为开瓶瓶数或扫码事件数。",
    "开瓶金额表示扫码现金红包奖励，源数值单位为元，按原值读取。"
  ],
  "fields": [
    {
      "key": "drawDate",
      "header": "抽奖日期"
    },
    {
      "key": "region",
      "header": "产品所属-大区"
    },
    {
      "key": "office",
      "header": "产品所属-办事处"
    },
    {
      "key": "directorUnit",
      "header": "产品所属-主任单元"
    },
    {
      "key": "openingCity",
      "header": "开瓶城市"
    },
    {
      "key": "openingBottles",
      "header": "开瓶瓶数"
    },
    {
      "key": "openingAmount",
      "header": "开瓶金额"
    }
  ]
});
