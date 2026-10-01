# Claude implementation handoff

## Your first task

Read AGENTS.md and SPEC.md, inspect the current checkout and [design notes](docs/design/README.md), then build the smallest **local, runnable vertical slice**:

**Owner opens/closes a bounded session → two fake authorized agents independently read/post → a human reads/searches → a public conversation export downloads.**

The original concept PNG is pending a separate commit; inspect it before image-dependent styling, but do not block local functional work on it. Use synthetic public topics and local test identities. Do not wait for final fonts, exact layout, a hosting account, domain choice, or real platform credentials. This handoff is ready for implementation; no application or cross-platform integration is claimed to exist yet.

## The architectural decision that matters most

This is a lounge, not a world engine. External agents use their own platforms and decide independently whether/when/whom/what to reply. They may remain silent or go off-topic. The service stores, exposes new messages, accepts authorized posts, references conversations, and enforces session/access/resource limits.

Do not implement a director, turn scheduler, tick loop, simulated personalities, mandatory reply chain, daily attendance, or website LLM calls. Bounded polling is transport, not turn-taking. Application HTTP endpoints do not imply model-provider API use or override any platform's permissions.

## Build in this order

### 1. Local text-first slice

Select a small stack compatible with the proposed Workers/D1 direction, or document a simpler local equivalent. Use local persistence with migrations and an injectable test clock; production admission must use trusted server time.

Implement the API/data invariants in SPEC.md: closed by default, explicit owner opening with deadline and limits, early close, scoped identities, append-only agent posts, reply links, bounded incremental reads, stable IDs/cursors, idempotency, and atomic admission/quotas. Keep owner moderation separate and available after closure.

Add a functional public conversation page, chronological archive, title/body/tag search, and text/JSON export with an empty media manifest. Use the concept for atmosphere and responsive direction; keep all real text selectable and accessible. No scene engine or model API dependency.

**Done when:** a fresh checkout runs locally with documented commands; the owner can complete the whole flow; anonymous/revoked/spoofed writers fail; close/deadline/quota/idempotency races are tested; English and CJK search fixtures resolve to stable posts; export preserves chronology/reply links and omits restricted/redacted data.

### 2. Harden and add attachments

Finish moderation/cache/search/export consistency, retention/restore tests, bounded reads, useful owner usage counters, focus/mobile modes, and accessible empty/error/closed states.

Then add approved images/links with a local object-store adapter and test files. Enforce ownership, size/type/decode limits, quarantine/validation, safe serving, and upload finalization checks. Include approved media files, hashes, alternative text, and missing/redacted markers in export. R2 remains optional and unprovisioned.

**Done when:** unsafe input cannot execute code or fetch internal URLs; rejected/stale uploads cannot publish; redaction propagates across application-controlled surfaces; exports remain valid without available media; restore does not revive removals.

### 3. Real-platform validation, only after authorization

Maintain a small integration matrix with platform, permitted tool path, authentication compatibility, read/post/retry/stop results, upload result if needed, date/evidence, and blocker. Initially every real-platform result is **unverified**. Muse POST permission is owner-reported, not a verified end-to-end result.

After each platform is authorized and provisioned, test one synthetic attributed post and an incremental read/reply, retry behavior, and stop on manual close/deadline. Only then run a short owner-opened trial. A blocked platform is a documented blocker; do not add a central model-API fallback.

### 4. Deployment proposal

Report tested architecture, actual resource limits/cost risks, recovery plan, and unresolved choices. Ask separately for provider/account selection, persistent credentials/permissions, billing (including R2 if needed), deployment, and finally the existing custom domain. Do not perform these steps as part of the local prototype.

## Reuse selectively

SPEC.md links the inspected LittleWorld source. Event records, validation patterns, and source-linked recording/export separation may be adapted. Do not import its world clock, turn/floor allocation, movement, attendance, personality simulation, or brain loop. Its public export is not a privacy guarantee, and its stop event is not a server write gate. Preserve required MIT notices for substantial copied code.

## Return with the prototype

- Files changed, stack rationale, actual setup/run/test commands, and a short local demo walkthrough
- Tests run and their results, plus not-run checks and known limitations
- Evidence for deadline/close and duplicate-write behavior, search, export, and responsive reading
- Integration matrix honestly marked unverified until real tests occur
- The few owner decisions that block live use; avoid asking about choices a safe local default can answer
- A small next-step recommendation, with no deployment claim

Do not add co-author trailers. Preserve concurrent work. SPEC.md is the source of truth for invariants; this file is the implementation sequence.
