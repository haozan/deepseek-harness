---
kind: upgrade-guide
description: "Earlier readers reject Sessions that contain review screenshot recognition requests."
---

# Open Sessions containing screenshot recognition

English | [中文](guide.zh.md)

## Change

Recognizing a screenshot in Desktop review records a required `document-review/recognition-request` event. Readers from v0.2.2-rc.2 and earlier refuse to open Sessions containing that event. [Persistence change record](../../../persistence-changes/2026-11-18-review-recognition.md)

## Migration

1. Update Desktop and any CLI or SDK runtime that opens the same Session data to a release containing the event.
2. Reopen the Session in Desktop. Its conversation and review transcript are available from the Session and the right sidebar.
