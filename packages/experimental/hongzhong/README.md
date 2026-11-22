---
description: "Preview Markdown from a DeepSeek Harness workspace and sync it to WeChat draft boxes."
kind: "package-bundle"
---

# @deepseek-ai/dsh-hongzhong

English | [中文](README.zh.md)

## Summary

Preview Markdown and local images from a DSH workspace in WeChat article publishing. Bind multiple WeChat Official Accounts and sync the article layout to the selected account’s draft box.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

From a built checkout, link the bundle into the Web profile and start DeepSeek Harness from the repository root.

```sh
pnpm dsh plugin --profile web add link:./packages/experimental/hongzhong
pnpm dsh web
```

Open **WeChat article publishing** in the DSH sidebar. Select an existing workspace or choose a local folder. The workbench opens a writing conversation in that workspace. Ask AI to use the following article layout.

```text
2026-11-20_1902_周末散步/
├── article.md
├── cover.jpg
└── images/
    └── 海边.png
```

Choose an article beside the conversation. The workbench reloads articles when a turn ends. Edit the text and select **Save Markdown**, then choose the style in the preview. Reference images relative to `article.md`, for example `![海边](./images/海边.png)`.

Expand **WeChat accounts** and select **Bind account**. Enter a label, AppID, and AppSecret for each account you want to use. Enable the relevant material and draft interfaces on the account and add the DSH Host's outbound IP to its WeChat IP allowlist. If WeChat reports an IP in an allowlist error, the editor shows that address. Select **Make default** on an account to preselect it for future drafts. You can also choose a different destination for this sync.

Name the cover file `cover.jpg`, `cover.jpeg`, or `cover.png`. The first top-level Markdown heading supplies the WeChat title. When no heading is present, the title comes from the folder name without the date and time. Choose an account and select **Sync to draft box**, then open the draft in WeChat to review or publish.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details</summary>

The client opens the editor in the right sidebar beside a native DSH conversation. The Host guards Markdown saves by file version and uses the same inline styles for the preview and the WeChat draft.

The Host stores account credentials through `ctx.credentials`. Before syncing, the Host checks the article and image files against the previewed revision, then submits the original images and draft to the selected account.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Current article

#### What the model sees

Writing conversations receive authoring guidance as runtime context. When an article is open, the guidance includes its workspace-relative file path.

##### Runtime context

```markdown
Save articles to the workspace so the editor can display them. For each new article, create a separate folder named YYYY-MM-DD_HHmm_Title at the workspace root and write article.md inside it. Keep images in the article folder and reference them by relative paths. Use cover.jpg or cover.png for a cover when supplied.

Save articles to the workspace so the editor can display them. For each new article, create a separate folder named YYYY-MM-DD_HHmm_Title at the workspace root and write article.md inside it. Keep images in the article folder and reference them by relative paths. Use cover.jpg or cover.png for a cover when supplied. When revising the open article, use this workspace-relative file: "<article folder>/article.md".
```

#### Token effect

A writing conversation records one runtime-context paragraph. Changing the selected article updates its path.

#### KV Cache effect

A changed path appends a runtime-context snapshot and keeps the earlier request prefix stable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The article list covers direct workspace subfolders. The preview uses saved Markdown. If the file changes while you edit, the workbench keeps your edit available to copy and reports the conflict.
- Preview and sync accept JPEG and PNG files in the article folder. Check the Markdown’s relative paths when an image is missing.
- Each sync creates a draft. If WeChat's response is lost, check the draft box before retrying. A failed draft request can leave images in WeChat's media storage.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details</summary>

None.

</details>
