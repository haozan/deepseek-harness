---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-review-recognition

[English](2026-11-18-review-recognition.md) | 中文

## 概述

新增 document-review/recognition-request，记录辅助转写调用的准确路由、指令、已解析控制项及持久化截图附件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-review-recognition
baseline: false
changes:
  - root: "event:document-review/recognition-request"
    previous: null
    after: "0d8c54e8e6712d2e1727256831f601a60a84dab1201dce48cc48154d55c7d35f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该事件不改变会话消息。当前读取器仍能打开此前的 V4 Session。较早的 V4 读取器在打开包含识别请求的新 Session 时拒绝此必读事件，避免静默误读。

<a id="verification"></a>
## 验证

工作区通过 Host 和 Client 构建。阅卷 Client 测试覆盖已保存截图和编辑，仓库的持久化目录只识别到一个新增事件根。

<a id="dev-note"></a>
## 开发备注

无。
