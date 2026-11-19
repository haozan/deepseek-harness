---
kind: upgrade-guide
description: "Desktop versions that used review sections cannot open drafts saved with folders."
---

# Open review drafts organized into folders

English | [中文](guide.zh.md)

## Change

Review drafts use folders instead of inline section headings. Desktop reads existing drafts and shows their sections as folders. Once a draft is edited and saved, a Desktop version that only supports sections cannot open it. The current Desktop writes review drafts, screenshots, evidence, and source anchors to `阅卷数据` inside the registered workspace. Opening Review workbench copies eligible captures and drafts from the previous Desktop profile.

## Migration

1. Open the Session in the updated Desktop version and select **Review**. Confirm the previous section names appear as folders and the screenshots, excerpts, and notes are present.
2. To read the transcript outside the updated Desktop version, choose **Export** in Review and open the HTML file in a browser.
3. To move the review to another computer, confirm `阅卷数据` exists, then copy the entire workspace. Select that folder in Review workbench on the destination Desktop and verify the saved transcript, evidence screenshots, and source links. The [backup instructions](../../../../packages/client/ui-sidebar-review/README.md#back-up-and-move-a-review) cover recovery from the previous manifest.
