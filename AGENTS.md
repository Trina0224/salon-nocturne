# Agent Instructions

## Read first

Read [README.md](README.md), [SPEC.md](SPEC.md), and any more specific instructions in the files you will touch. Inspect the current branch and working tree before making changes; preserve existing content and concurrent work.

This repository is currently **documentation-only**. The application, UI, credentials, infrastructure, and deployment are not implemented. The current task does not authorize starting them. Do not turn a proposed architecture or an acceptance criterion into a claim that a feature exists.

Claude is the intended primary implementation assistant. Rei supports architecture and bug review. This is a planned working arrangement, not permission to contact another agent, run automated conversations, or assume another assistant is already working.

## Commit attribution

**Do not add `Co-authored-by` trailers or any artificial AI co-author attribution to commits in this repository.** Do not add Claude, Rei, another assistant, or a tool as a co-author. Use the normal configured commit author identity; do not impersonate the owner or rewrite existing commit history to change attribution.

## Product guardrails

- Public reading and human topic search are essential. Only authorized participants write; the owner participates through an authenticated admin/backend route.
- The owner manually opens and closes occasional, bounded sessions lasting a few hours. Require a server-enforced hard end time. Do not add daily attendance, cron conversations, self-reopening, or unbounded polling/reply loops.
- Treat closure and budgets as server-side correctness rules. Follow the proposed admission/idempotency/race invariants in SPEC.md when implementation is later approved. External clients must stop session work, but the server cannot force another platform to stop all compute.
- Never import or publish private conversations, the owner's personal matters, employer-internal information, credentials, or secrets. Use synthetic examples and fixtures.
- Each participant uses its own platform and authorized tools. Prioritize verification of permitted authenticated read/post and later upload paths; generic HTTP POST permission is insufficient. Do not add paid model inference, model-provider API keys, or a workaround for platform permissions. Integration feasibility is unverified.
- Use static imagery for the Tokyo jazz-bar atmosphere and prioritize smooth conversation. Defer web 3D and live voice. Layout, panel placement, colors, avatars, and actual artwork still require discussion with the owner.
- Prefer free-first/low-cost infrastructure without a rented VM. Workers/D1/R2 is a candidate, not an approved purchase or deployment. R2 has billing prerequisites and metered usage; never promise zero cost.
- Plan a downloadable conversation package preserving public authors, timestamps, reply links, and approved available images for later offline post-production. Do not implement speech generation or external media uploads from that requirement alone.
- Defer participant image uploads/drawings and live collaboration infrastructure until the relevant scope is approved; static bar artwork is a separate visual decision. Connect the existing custom domain last, with separate authorization.

## Change discipline

1. State the change's purpose and whether it concerns a confirmed requirement, proposal, or open decision. Ask about unresolved decisions that materially affect the authorized work.
2. Keep changes small and focused. Do not add application scaffolding, dependencies, credentials, workflows, accounts, infrastructure, or deployments to a documentation-only request.
3. Before modifying an existing remote file, read its current content and SHA. Immediately before committing, recheck branch/file state. Preserve unrelated changes and the existing license; never force-push over concurrent work.
4. Keep documentation consistent. A new decision should update its primary section in SPEC.md instead of creating competing specifications. Do not include private conversation links or unrelated personal information.
5. Use concise, factual commit messages without co-author trailers. Inspect the final diff and commit message, then verify the exact remote commit and changed files after publishing.

## Implementation and review, when authorized

- Start from the latest approved spec and scope; choose the smallest testable slice. Keep unresolved choices explicit.
- Follow the proposed single-post/incremental-read milestone before a short owner-controlled conversation trial. Obtain implementation/test-participation authority first; record unsupported platform operations as blockers. No such test has run in this documentation baseline.
- Validate input, enforce authorization and session admission server-side, use safe rendering/parameterized queries, and keep credentials out of public assets/logs.
- Review identity spoofing, cross-author edits, deadline races, stale sessions, duplicate writes, concurrent quota spending, unsafe content, incremental-read gaps, and redaction/search/cache/restore behavior.
- Keep schema migrations and recovery/export considerations with the feature. Test destructive changes in isolation and obtain any required approval.
- Discover actual project commands from the repository after code exists. Do not invent installation or test instructions for this documentation-only baseline.
- Run applicable tests, lint/type checks, and relevant end-to-end checks against the final changes. Report exactly what passed, failed, or was not run; a proposed test is not a passing test.
- Report bugs with severity, reproduction, expected/actual behavior, and a focused fix or recommendation. Distinguish suspected risks from verified defects.
- A code change does not itself authorize merging, deployment, new spending, credential provisioning, or contacting external agents. Obtain the necessary authorization for those actions.
