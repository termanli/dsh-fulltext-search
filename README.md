# dsh-fulltext-search

DSH（DeepSeek Harness）Web GUI 插件：在侧边栏文件管理（[dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)）中按**文件内容**全文搜索当前会话工作目录，返回 `文件 + 行号 + 匹配行预览`，点击结果即可在编辑器中打开文件。

支持正则表达式、区分大小写、全字精确匹配、智能大小写与 include/exclude 范围过滤。系统装有 [ripgrep](https://github.com/BurntSushi/ripgrep) 时自动使用（与 VSCode 搜索同款引擎，性能最佳）；未安装则回退内置 JS 引擎，功能一致。

## 安装

前置：已安装 DSH 与 dsh-better-sidebar（`dsh web` 侧边栏可见）。

```sh
dsh plugin --profile web add link:<本仓库路径>
# 例如：dsh plugin --profile web add link:D:\git\dsh-fulltext-search
```

装完需**重启 DSH**，并**硬刷新浏览器**（Ctrl/Cmd+Shift+R）。

可选：安装 [ripgrep](https://github.com/BurntSushi/ripgrep) 以启用最快的搜索引擎（如 `winget install BurntSushi.ripgrep.MSVC`、`brew install ripgrep` 或 `apt install ripgrep`）；未安装时自动使用内置 JS 引擎，功能一致。

## 使用

1. 打开侧边栏，点 `+` → 选择「全文搜索」（或直接点击放大镜图标）
2. 输入关键字并回车；可用 `.*`（正则）、`Aa`（区分大小写）、`Ab`（全字匹配）按钮与「智能大小写」开关调整匹配方式
3. 点击结果行 → 文件在编辑器 tab 中打开；点击文件名 → 打开文件
