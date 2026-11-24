// DSH tool definitions for the read-only board queries (docs/DSH插件.md §5).
// Kept apart from DSH imports: defineTool / HarnessError are passed in.
import { BoardToolError } from './tools.mjs';

const json = { type: 'json' };
const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];

export function toolDefinitions(queries, { HarnessError } = {}) {
  const fail = error => {
    if (!(error instanceof BoardToolError)) throw error;
    const message = Object.keys(error.detail || {}).length ? `${error.message}\n${JSON.stringify(error.detail)}` : error.message;
    if (HarnessError) throw new HarnessError(message, error.code.toUpperCase());
    throw Object.assign(new Error(message), { code: error.code });
  };
  const run = fn => async args => { try { return await fn(args || {}); } catch (error) { return fail(error); } };
  const shared = '只读：不上传、不修改数据、不生成看板。数据来自最近一次成功生成的战区看板；指标 state 为 available 时 value 才是数值，pending/unavailable/missing 时须照 reason 说明，不能当作 0 或自行估算。';
  return [
    {
      name: 'theater_board_status',
      description: `战区经营看板：查看七类资料（发票、动销、开瓶、签约、库存、宴席、经营目标）的当前文件、上传时间、数据起止日、是否超期待更新，以及最近一次生成的看板时间和打开链接。${shared}`,
      parameters: {},
      output: { schema: json, render },
      isConcurrencySafe: () => true,
      timeoutMs: 60_000,
      execute: run(() => queries.status()),
    },
    {
      name: 'theater_board_summary',
      description: `战区经营看板：按月份或日期区间、大区/办事处/主任单元，返回发票销售、终端动销、消费者开瓶的主指标、当年累计和经营目标达成率（与看板同一口径）。三个板块分别统计，不要自行计算它们之间的比例。组织名称请先用 theater_board_organizations 确认。${shared}`,
      parameters: {
        month: { type: 'string', description: '月份 YYYY-MM；与 start/end 二选一；都不填为看板默认最近月份' },
        start: { type: 'string', description: '区间开始 YYYY-MM-DD（需与 end 同时给出）' },
        end: { type: 'string', description: '区间结束 YYYY-MM-DD' },
        region: { type: 'string', description: '大区显示名称（看板下拉中的名称）' },
        office: { type: 'string', description: '办事处显示名称' },
        unit: { type: 'string', description: '主任单元显示名称' },
      },
      output: { schema: json, render },
      isConcurrencySafe: () => true,
      timeoutMs: 120_000,
      execute: run(args => queries.summary(args)),
    },
    {
      name: 'theater_board_organizations',
      description: `战区经营看板：列出可查询的组织名称（不填参数列大区；给 region 列其办事处；再给 office 列主任单元），含完整组织路径和出现于哪些板块。同名组织按完整路径区分，不要合并。${shared}`,
      parameters: {
        region: { type: 'string', description: '大区显示名称' },
        office: { type: 'string', description: '办事处显示名称' },
      },
      output: { schema: json, render },
      isConcurrencySafe: () => true,
      timeoutMs: 120_000,
      execute: run(args => queries.organizations(args)),
    },
  ];
}
