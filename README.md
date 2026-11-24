# 战区看板 DSH 插件（dsh-theater-board）

在 DeepSeek Harness 左侧栏加入「战区看板」，打开本机战区看板合并页（看板 / 更新数据 / 历史版本），并提供三个只读看板查询工具（资料状态、发票 / 动销 / 开瓶汇总及目标达成、组织名称）。后台只监听 127.0.0.1，默认端口 4181；数据默认放在用户数据目录（macOS `~/Library/Application Support/TheaterCommandBoard-DSH/data`，Windows `%APPDATA%\TheaterCommandBoard-DSH\data`），不在插件安装目录内。

## 安装

需要 Node.js ≥ 24.9、DeepSeek Harness 0.2.2-rc.5 以上（0.3 以下）、pnpm。

- 从团队插件索引：DSH「插件 → 实验性插件」打开“自定义插件索引”，在“发现”中添加团队提供的 `index.json` 网址，找到“战区看板”安装。
- 从安装包：`dsh plugin --profile web add ./dsh-theater-board-<版本>.tgz`

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: theater-board
  name: dsh-theater-board
  config:
    port: 4181        # 不能用 4180
    dataDir: ''       # 留空用默认目录；可填绝对路径沿用已有数据（同一目录同时只能有一个后台在用）
```

工具只读：不上传、不修改数据、不生成看板；回答依据最近一次生成的看板。
