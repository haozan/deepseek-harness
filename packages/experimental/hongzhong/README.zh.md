---
description: "预览 DeepSeek Harness 工作区中的 Markdown，并同步到公众号草稿箱。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-hongzhong

[English](README.md) | 中文

## 概述

通过公众号自动发文预览 DSH 工作区中的 Markdown 和本地图片。可以绑定多个微信公众号，将同一份排版同步到选定账号的草稿箱。

<a id="table-of-contents"></a>
## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

构建源码后，在仓库根目录把插件包链接到 Web 配置，再启动 DeepSeek Harness。

```sh
pnpm dsh plugin --profile web add link:./packages/experimental/hongzhong
pnpm dsh web
```

在 DSH 侧栏打开**公众号自动发文**。从列表关联工作区，或通过**选择文件夹**登记本地目录。工作台打开该工作区的写作会话。请 AI 按下面的结构存放文章。

```text
2026-11-20_1902_周末散步/
├── article.md
├── cover.jpg
└── images/
    └── 海边.png
```

在对话旁打开文章。会话完成一轮回复后，工作台刷新文章。可以在编辑区修改 Markdown，点击**保存 Markdown**，再从预览区选择样式。用相对于 `article.md` 的路径引用图片，例如 `![海边](./images/海边.png)`。

展开**微信公众号**并点击**绑定公众号**，为每个要使用的账号填写名称、AppID 和 AppSecret。公众号需要开放对应的素材和草稿接口，并将 DSH 主机出口 IP 加入微信 IP 白名单。如果微信在白名单报错中返回 IP，编辑器会显示该地址。在账号旁点击**设为默认**，也可以只切换本次同步的账号。

封面使用同目录下的 `cover.jpg`、`cover.jpeg` 或 `cover.png`。微信草稿标题取 Markdown 的第一个一级标题，或取去掉日期和时间的文件夹名。选好账号后，点击**同步到草稿箱**，然后在微信后台查看或发布。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者说明</summary>

客户端保留 DSH 会话，在右侧栏打开编辑区。主机用文件版本保护 Markdown 保存，并用同一套内联样式生成预览和微信草稿。

主机通过 `ctx.credentials` 保存公众号凭据。同步前，主机核对文章和图片是否仍与预览版本一致，再向选定账号提交原始图片和草稿。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 当前文章

#### 模型看到什么

写作会话在运行时上下文获得写作指引。有文章打开时，指引包括相对于工作区根目录的文件路径。

##### 运行时上下文

```markdown
Save articles to the workspace so the editor can display them. For each new article, create a separate folder named YYYY-MM-DD_HHmm_Title at the workspace root and write article.md inside it. Keep images in the article folder and reference them by relative paths. Use cover.jpg or cover.png for a cover when supplied.

Save articles to the workspace so the editor can display them. For each new article, create a separate folder named YYYY-MM-DD_HHmm_Title at the workspace root and write article.md inside it. Keep images in the article folder and reference them by relative paths. Use cover.jpg or cover.png for a cover when supplied. When revising the open article, use this workspace-relative file: "<article folder>/article.md".
```

#### Token 影响

写作会话记录一段运行时上下文。切换文章时更新路径。

#### KV Cache 影响

路径变化追加运行时上下文快照，之前的请求前缀保持稳定。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 文章列表读取工作区的一级子目录。预览显示已保存的 Markdown。文件在编辑期间变化时，保存会保留你的修改供复制并提示冲突。
- 预览和同步支持文章文件夹中的 JPEG 和 PNG 图片。找不到参考文件时，请检查 Markdown 中的相对路径。
- 每次同步都会创建草稿。微信响应丢失时，先检查草稿箱再重试。草稿请求失败时，微信素材库可能保留已上传的图片。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者说明</summary>

无。

</details>
