---
kind: upgrade-guide
description: "较早的读取器拒绝打开包含阅卷截图识别请求的会话。"
---

# 打开包含截图识别的会话

[English](guide.md) | 中文

## 变更

桌面端的阅卷截图识别记录必读事件 `document-review/recognition-request`。v0.2.2-rc.2 及更早的读取器拒绝打开包含该事件的会话。[持久化变更记录](../../../persistence-changes/2026-11-18-review-recognition.zh.md)

## 迁移

1. 将桌面端以及会打开同一会话数据的 CLI 或 SDK 运行环境升级到包含该事件的版本。
2. 在桌面端重新打开会话。可以查看会话对话和右侧边栏中的阅卷笔录。
