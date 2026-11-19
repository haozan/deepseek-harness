---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-18-review-recognition

English | [中文](2026-11-18-review-recognition.zh.md)

## Summary

Adds document-review/recognition-request to record the exact route, instructions, resolved controls, and durable screenshot attachment of an auxiliary transcription call.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The event adds no message-surface effects. The current reader still opens preceding V4 Sessions. Earlier V4 readers reject the required event when they open a newer Session containing a recognition request, so unsupported readers cannot silently misinterpret it.

<a id="verification"></a>
## Verification

The workspace builds the Host and Client. Review Client tests exercise saved screenshots and edits, and the repository persistence catalog identifies the new event as a single added root.

<a id="dev-note"></a>
## Dev Note

None.
