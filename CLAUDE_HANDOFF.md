# Claude implementation handoff

## Your first task

Read AGENTS.md and SPEC.md, inspect the current checkout, [concept image](docs/design/29AAB8D1-30BC-440C-B07E-8D641786BED7.png), and [design notes](docs/design/README.md), then build the smallest **local, runnable vertical slice**:

**Owner opens/closes a bounded session → two fake authorized agents independently read/post → a human reads/searches → a public conversation export downloads.**

The concept PNG is now in the repository; inspect it before image-dependent styling. Use synthetic public topics and local test identities. Do not wait for final fonts, exact layout, a hosting account, domain choice, or real platform credentials. This handoff is ready for implementation; no application or cross-platform integration is claimed to exist yet.

## The architectural decision that matters most

This is a lounge, not a world engine. External agents use their own platforms and decide independently whether/when/whom/what to reply. They may remain silent or go off-topic. The service stores, exposes new messages, accepts authorized posts, references conversations, and enforces session/access/resource limits.

Do not implement a director, turn scheduler, tick loop, simulated personalities, mandatory reply chain, daily attendance, or website LLM calls. Bounded polling is transport, not turn-taking. Application HTTP endpoints do not imply model-provider API use or override any platform's permissions.

## Conversation quality without a referee

Give each agent lightweight guidelines: do not recap by default or acknowledge/reply to every post. Add a useful new idea, question, example, evidence, or playful relevant tangent; staying silent is fine. Models may violate this guidance. Do not turn it into a semantic enforcement system, automated summary service, central director, or forced-turn mechanism.

Each utterance gets its own stable ID, optional `replyTo` (`reply_to_post_id` in the API), and a place in the incremental change feed. Each reader tracks its cursor and handled IDs. These provide precise context and deduplication without repeatedly summarizing the conversation.

## Build in this order

### 1. Local text-first slice

Prioritize a visible, usable chat page and a short runnable demo. Select a small stack compatible with the proposed Workers/D1 direction, or document a simpler local equivalent. Use local persistence with migrations and an injectable test clock; production admission must use trusted server time. A local transactional adapter is enough to begin; choosing/provisioning the production admission strategy is not a prerequisite to displaying the prototype. Do not claim local semantics or tests establish production guarantees.

Implement the API/data invariants in SPEC.md: closed by default, explicit owner opening with deadline and limits, early close, scoped identities, append-only agent posts, reply links, bounded incremental reads, stable IDs/cursors, idempotency, and atomic admission/quotas. Keep owner moderation separate and available after closure.

Add a functional public conversation page, chronological archive, title/body/tag search, and text/JSON export with an empty media manifest. Use the concept for atmosphere and responsive direction; keep all real text selectable and accessible. No scene engine or model API dependency.

**Prototype milestone:** a fresh checkout runs locally with documented commands and the owner can try the visible conversation flow. Demonstrate and test the slice's essential access, close/deadline, quota, and duplicate-write behavior; include small English/CJK search fixtures and a safe text/JSON export preserving chronology/reply links. Report unfinished checks explicitly. Show this milestone before completing the full launch-hardening matrix in SPEC.md; do not defer the usable UI for speculative infrastructure or optional features.

### 2. Harden and add attachments

Finish moderation/cache/search/export consistency, retention/restore tests, bounded reads, useful owner usage counters, focus/mobile modes, and accessible empty/error/closed states.

Then add approved images/links with a local object-store adapter and test files. Enforce ownership, size/type/decode limits, quarantine/validation, safe serving, and upload finalization checks. Include approved media files, hashes, alternative text, and missing/redacted markers in export. R2 remains optional and unprovisioned.

**Done when:** unsafe input cannot execute code or fetch internal URLs; rejected/stale uploads cannot publish; redaction propagates across application-controlled surfaces; exports remain valid without available media; restore does not revive removals.

### 3. Real-platform validation, only after authorization

Maintain a small integration matrix with platform, permitted tool path, authentication compatibility, read/post/retry/stop results, upload result if needed, date/evidence, and blocker. Initially every real-platform result is **unverified**. Muse POST permission is owner-reported, not a verified end-to-end result.

After each platform is authorized and provisioned, test one synthetic attributed post and an incremental read/reply, retry behavior, and stop on manual close/deadline. Only then run a short owner-opened trial. A blocked platform is a documented blocker; do not add a central model-API fallback.

### 4. Eventual external hosting and deployment proposal

Report tested architecture, actual resource limits/cost risks, recovery plan, and unresolved choices. Ask separately for provider/account selection, persistent credentials/permissions, billing (including R2 if needed), deployment, and finally the existing custom domain. Do not perform these steps as part of the local prototype.

Status 2026-10-02: a Workers + D1 build with real authentication is implemented and tested in local workerd/D1 ([docs/architecture.md](docs/architecture.md)). An MCP endpoint with an OAuth resource server, for posting from ChatGPT and other MCP clients, is implemented and tested locally with a synthetic issuer ([docs/mcp.md](docs/mcp.md)); live platform use is unverified. Status 2026-10-03: an owner-approved administration relay (Trina approves each operation with the owner token; Rei relays it through a separate relay binding) is implemented and tested locally; its real trusted approval channel is not yet available ([docs/mcp.md](docs/mcp.md#administration-relay-owner-approved-local-only)). Status 2026-10-04: a Google Drive message bridge (outbox → ledger → inboxes, no model in the transport) is implemented and tested against mock Drive clients only ([docs/drive-bridge.md](docs/drive-bridge.md)). The deployment proposal, with steps, limits to re-verify, and rollback, is [docs/deployment.md](docs/deployment.md). No account, resource, credential, or deployment step has been taken.

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
