import { defineModule } from '../../recognition/module-definition.mjs';

// Headers and user-confirmed meanings apply to the inspected simplified source.
// Detailed sources still require review; this contract only validates structure.
export default defineModule({
  "id": "banquet",
  "title": "宴席执行",
  "description": "宴席固定期间组织汇总",
  "sheetNames": [
    "报表"
  ],
  "notes": [
    "当前规则按已核对的简化表建立，后续详细表需重新核对结构与粒度；简化表没有日期列、产品列、终端编号或场次编号，不构造日明细或产品维度。",
    "已核对简化表的固定统计期间包含首尾日期；该确认不代表新上传文件的统计期间已验证。",
    "简化表已确认售点推荐奖励单位为元、开瓶数量单位为瓶；执行场次为期间实际执行宴席数，零值表示实际为零。奖励数值含义及是否可直接累加仍待确认。",
    "已核对简化表中的上下级同名行属于组织占位，汇总时与其他单元一起计入；保留大区、办事处、主任单元的完整路径。新来源的同名层级性质需重新核对。",
    "非空行数不代表有效业务行数或执行场次；重复记录、组织汇总行和总计行仍需逐行核对，业务口径确认不等于业务校验已执行。",
    "宴席开瓶与消费者开瓶分开统计，不合并两者数量；两份来源是否重叠未作核实。"
  ],
  "fields": [
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
      "key": "outletReward",
      "header": "售点推荐奖励"
    },
    {
      "key": "eventCount",
      "header": "执行场次"
    },
    {
      "key": "openingQuantity",
      "header": "开瓶数量"
    }
  ]
});
