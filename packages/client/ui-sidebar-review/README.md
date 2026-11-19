---
description: "Assemble screenshots and editable text into a review transcript in Desktop."
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-sidebar-review

English | [中文](README.zh.md)

## Summary

Review workbench is an installable Desktop plugin. Collect file preview screenshots, recognize their text, and organize transcript cards into folders that become export headings.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Enable **Review workbench** in **Plugins** and select it in the left sidebar. **Start a review from a workspace** creates a new review conversation in the directory you choose. Its shortcuts appear directly above the composer. In an open review conversation, **New session** in the same workspace creates a fresh review conversation with those shortcuts. **Continue an existing review** lists registered workspaces with saved review content. Select a workspace to open its most recent review with saved content, or expand **Other review records** to reopen an earlier one. Archived reviews are hidden. Review files are saved under `阅卷数据` in the registered workspace. Each review has a `review.json` manifest and a `screenshots` directory. The manifest keeps the transcript, folders, card order, colors, evidence entries, and capture coordinates. Paths inside the workspace are relative to its root. To resume on another computer, copy the complete workspace and select it in Review workbench on a Desktop with the plugin enabled. The latest saved review opens on first association. Original files outside the workspace retain their original paths. AI conversation history remains in the Desktop profile.

Use **Open review transcript** or **Open evidence directory** above the conversation to open the right sidebar with Files on the left and both review tabs on the right. The sidebar’s **Fullscreen** button expands the workspace. **Use the transcript with AI** fills an empty composer with an editable prompt and focuses the input. Replace the bracketed fields with the folder or transcript scope and a task, such as checking the evidence in Contract performance / Payments or drafting a legal document. If you already have a draft, the button focuses it. AI reads the saved transcript in this review conversation and can inspect a screenshot if the saved text is insufficient. To distinguish folders with the same name, give their full path. To ask about an earlier review, open it from **Other review records** or specify it in your question.

Open a file in the right sidebar, select **Capture to review transcript**, then drag a rectangle over the preview. Release to save and open the **Review transcript** tab, which uses the same region icon. Press Escape to cancel. With room for two panes, capturing opens the transcript beside the file preview. In a narrow sidebar, use the tabs or widen it before the next capture.

Select the list icon labeled **Capture to evidence directory** to save the selected region to a separate **Evidence directory** tab. Select an evidence screenshot to jump to its source, or select the source frame to jump back to the screenshot.

New transcript screenshots appear in **Unfiled** in capture order. **Review transcript** is the root of the tree. The **Unfiled** inbox sits below the folders, matching the transcript order. Open the root's **⋯** menu and choose **New folder** to create a top-level folder. The menu on a custom folder lets you create a child folder or rename it. The tree appears beside the cards in a wide pane. In a narrow one, use the folder selector above the list.

Select **Review transcript** to read the outline. Folder names become heading nodes. Indentation and vertical guides show which cards and subheadings belong to each chapter. Select a heading or its arrow to collapse or expand the branch. Each card is a leaf node showing the screenshot while its text is empty. Click the screenshot to type directly. A card with text displays an editable field that grows with its contents. The HTML export includes collapsed chapters. **Unfiled** appears last when there are unfiled cards and other headings. Drag within a chapter to change its card order. To change chapters, move the card to another folder.

Use the drag handle to the left of a card to reorder it or drop it on a folder. To move a batch, use **Select cards**, choose the cards, then use **Move to** or drag one of the selected cards onto the target folder. Cards append to the destination in their current order. With a handle focused, use Up, Down, Home, or End to reorder its card.

Use **Move up** or **Move down** in a folder's **⋯** menu to reorder it among its siblings. You can also drag the folder name or use Alt+Up or Alt+Down when the name has focus. The folder, its cards, and its descendants move together. The saved order determines the order of headings in the export.

Choose **Delete folder** in a custom folder's **⋯** menu and confirm to remove the folder and its descendants. Their cards move to **Unfiled**. Screenshots, source links, and card text are kept.

Folder counts are aligned on the right. With a mouse, the adjacent menu button appears on hover, focus, or while the menu is open. Long titles use an ellipsis. Hover or focus a clipped title to read its full name.

In a wide review pane, use the panel icon in the card toolbar to hide or show the tree. When the tree is hidden, hover over the icon to see the current folder. Drag the divider to resize it, or focus the divider and press Left or Right. Showing the tree again restores its width within the current review pane.

PDF, image, and text previews show the saved screenshot outlines in red for the open file. Choose **Locate source** on the card to reopen the source in the companion pane when available and scroll to its outline. Click an outline to scroll to its card and briefly highlight it with a pale red background. A shared edge opens a choice in capture order. Review expands the card's chapter and any collapsed parent chapters. Text inside the outlines remains selectable. Older captures, spreadsheet previews, and HTML previews open the source file. Outlines appear only in the preview.

The card tools appear when you hover over the card or focus it. On touch screens the tools stay visible. **Recognize text** handles one card. **Recognize all** handles visible cards that still need recognition and reads **All recognized** when those cards all have recognized text. The result appends to any text in the field. The button shows **Text recognized** while the card retains text after recognition. Clearing the field or getting an empty result makes the card eligible for recognition again, including through **Recognize all**. **Discuss with AI** adds the full card text and screenshot to the current conversation draft. In fullscreen review, this action also reveals the conversation. Ask your question and send it from the composer. **Change color** marks the left edge of the card content with a straight line with one of five colors or clears the mark. When the text field has focus, the mark forms the left edge of its focus ring.

**Auto OCR** defaults to on and uses the vision model to recognize new screenshots saved to the review transcript. Turn it off in the Review toolbar to keep recognition manual. The preference is stored in the current application profile. Turning the switch off skips automatic requests that have yet to be sent. Requests already sent can finish. Turning it on briefly displays the vision model and token usage notice. Hover over the switch to see the notice again. Automatic recognition applies to future captures.

Turn on **Show source** to display the source filename in `【】` at the start of each card, with the final extension removed. This switch also controls source labels in the export.

Open **Export** and choose **Text and images** or **Text only** to save the whole transcript as a self-contained HTML file. **Text and images** embeds all screenshots and text. **Text only** keeps the screenshot for any card whose screenshot has no recognized text. Folder names become headings in tree order, and unfiled cards appear last. Open the file in a browser to read or print it. Organization, text, colors, and card order persist locally across Desktop restarts.

<a id="back-up-and-move-a-review"></a>
### Back up and move a review

Before closing or copying a review, wait for pending edits to finish saving. If the capture toolbar offers **Retry saving capture**, use it while the source preview is open. Both the transcript and evidence open saved screenshots from the same portable workspace archive.

Once writing has settled, copy the **whole workspace** to a separate drive or another computer. On the destination, open it in Review workbench and check a saved transcript card and an evidence screenshot, including their source links. Keep an independent copy. One running Host should edit a given workspace at a time across computers.

Each replacement of `review.json` retains the previous committed manifest as `review.previous.json`. If the current manifest is damaged, quit Desktop and make a separate copy of the workspace. In the copy, keep the damaged file under another name and copy `review.previous.json` to `review.json` in the same archive directory. Open the copied workspace and verify both tabs. The restored manifest contains the previous revision. Keep the original workspace for recovery of later edits or captures.

### Load the plugin from a source checkout

This bundle uses the capture API in the matching Desktop build. In the checkout, run `pnpm install --frozen-lockfile` and `pnpm run dev:desktop`. In that Desktop build, open **Plugins**, install from the absolute path to `packages/client/ui-sidebar-review` in the checkout, and enable it. Keep the checkout at that path for later upgrades.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The installed bundle mounts the recognition service and its Desktop client. The document preview supplies the visible body bounds, and Electron captures the selected viewport pixels after the selection closes. The workspace archive stores every PNG by content hash and commits a manifest with the file address, folders, assignments, order, text, colors, and recognition status. The client imports eligible older drafts and PNGs from IndexedDB when it opens an archive. Older extracts and notes appear together in the text field, with the extract first. A nonempty legacy extract counts as recognized. Legacy section headings become folders, and explicitly ordered cards under each heading join that folder. Screenshots without an explicit assignment remain unfiled.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Transcript questions

#### What the model sees

The [`review_transcript` tool](src/review-tool.ts) is available in review conversations attached to a registered workspace. It reads saved folders, card text, and individual screenshots from the selected archive. Folder and card lists are paged. Tool results record the selected text and image attachment references in the Session log. Source links open files in the workspace.

#### Token effect

Folder and text reads consume input tokens for the results returned. A screenshot read also consumes image tokens and requires an image-capable conversation model.

#### KV Cache effect

Each tool result joins the conversation history. The archive itself stays on disk and changes appear on the next read.

### Screenshot recognition

#### What the model sees

An explicitly selected screenshot and the [transcription instructions](src/index.ts). The Host records the exact inputs in the `document-review/recognition-request` Session event before dispatch. The route, request deadline and output-token limit are configured by the Desktop profile.

#### Token effect

Each recognition attempt makes an independent vision request. The request consumes image and input tokens plus up to the configured output cap.

#### KV Cache effect

The auxiliary call uses an independent message list. **Discuss with AI** prepares an ordinary draft with the full card text and screenshot. When you send it, the conversation receives that content with your question.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- Transcript citations open the original workspace file. To open a saved crop, select its card in the review transcript.

<a id="dev-note"></a>
### Dev Note

The [Desktop capture handler](../../../apps/desktop/src/page-capture.ts) bounds the selection to the application viewport. The [Client store](src/client/clip-store.ts) commits the image and source as one record.
