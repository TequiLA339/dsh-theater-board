# 本地网站数据包

此目录的导出器只读现有后台资料，生成本地待验收结果，不联网、不更改当前上传、不写入原有生成记录。调用方完成本地验收后才能执行云端同步。

```js
import { prepareWebsiteRelease } from './exporter.mjs';

const release = await prepareWebsiteRelease({
  dataDir: '/absolute/path/to/local-data',
  outputDir: '/absolute/path/to/new-release-directory',
  previousRelease: '/absolute/path/to/previous-release/release.json', // 可省略，也接受上次返回对象
  baseRevision: null, // 首次 null；否则明确填线上当前 revision，用于同步 CAS
  uploadAttempts: {
    invoice: { status: 'failed', attemptAt: '2026-11-01T01:00:00.000Z', error: '本次上传未通过' },
  }, // 可省略；原后台仅记录成功上传，新控制器记录每板块最新尝试
  onStage: text => { /* 本地展示任务阶段 */ },
});
```

`outputDir` 的父目录须存在，目标目录必须是全新目录。准备失败只清理本次创建的目标目录；已有目录拒绝覆盖。建议所有输出均放在仓库忽略目录 `本机后台数据/` 中。

返回字段：

- `payload`：完整本地处理结果，可供 `renderV10Dashboard(payload)` 生成管理员预览。
- `report`：仅本地使用的诊断，包括板块失败原因、混合来源规则状态、未确认组织归属记录数。
- `manifest`：云端同步清单，`revision / baseRevision / generatedAt / modules / scopes`。`modules[id]` 只有 `status / uploadId / updatedAt / error?`，不含业务总值、行数或源文件名。
- `objects`：各组织范围的 `{ id, path, sha256, bytes, file }`。`id` 是 `SHA256(JSON.stringify(path))`；`sha256` 和 `bytes` 针对 gzip 文件字节。文件解压后是 `packV10Payload(...)` 数据，前端用 `unpackV10Payload` 恢复。
- `manifestPath / releasePath`：清单和本地回退文件绝对路径。
- `sourceVersions`：实际采用的各板块上传 ID/SHA。

只允许向线上发送 `manifest` 和 `objects[].file`。`release.json` 保留用于下一次失败回退的完整本地数据和指纹，`diagnostics.json` 是内部诊断；这两者不应上传、打包进网站源码或进入 Git。

新板块处理失败时从上一份本地成功结果恢复该板块，其他成功板块正常推进。恢复后重新应用当前来源绑定组织映射，并校验跨表来源合同；过期规则保持待确认。首次无有效来源的失败板块不可用。原后台结构上传失败不会变更 active；调用方通过 `uploadAttempts` 明确这次失败，导出器因此将旧 active 标记为 retained。

组织作用域为管理员 `[]`、战区前三段、大区前四段、办事处前五段；每一段精确匹配。未确认归属、空缺和无效组织行只保留在管理员范围。普通范围不包含其他组织的数据、源文件名、内部字段或全局汇总。隐藏未知扫码身份后仍可能影响有效终端判断，因此相关规则保守置为 pending，避免把未知变成零。

独立验证：`node --test tests/web-sync-export.test.mjs`。测试使用临时合成 XLSX，不读取业务 Excel。
