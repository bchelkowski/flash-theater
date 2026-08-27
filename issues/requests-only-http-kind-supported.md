# `request` only supports `Kind: Http`

**Type:** Gap
**Area:** requests
**Status:** Open

## Problem

`request { Kind: ... }` only accepts `Http` — any other `Kind` value is a compile error
(`request/unknown-kind`). There's no support for other Roku transfer types (e.g. `roDatagramSocket`,
WebSocket-style connections, or streaming download kinds) through the same declarative `request {}`
surface.

## Impact

Any app needing something other than a request/response HTTP call (e.g. a persistent socket
connection, or a streaming download with progress callbacks) has to drop to hand-written raw
BrightScript passthrough (`findings/raw-brightscript-passthrough.md`) instead of using the `request`
feature at all.

## Where

- `GRAMMAR.md` requests section — `request/unknown-kind` diagnostic.
- `findings/requests-config.md` — `request Http {}` config/codegen, the only supported shape today.

## Suggested fix

Scope this to real demand before building — `Http` covers the overwhelming majority of Roku app
networking needs. If a second `Kind` is ever needed, the config/codegen split in
`findings/requests-config.md` and the runtime in `findings/requests-runtime.md` were both built
Http-specific; adding a second kind means generalizing both to dispatch on `Kind` rather than
assuming Http throughout, a moderate refactor rather than a small addition.

## Related

- `findings/requests-config.md`
- `findings/requests-runtime.md`
- `findings/raw-brightscript-passthrough.md`
