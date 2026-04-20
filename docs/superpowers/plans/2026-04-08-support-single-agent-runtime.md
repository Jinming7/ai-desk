# Support Single-Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the support-agent runtime answer real business questions through a live single OpenClaw `support-main` agent path, with grounded citations and production-quality behavior.

**Architecture:** Align runtime execution with the declared topology so that any environment configured with `support-main` actually executes the single-agent path. Keep retrieval in the backend published-KB pipeline, keep answer drafting inside `support-main`, and verify the live cloud runtime plus cloud `agent.md` constraints against real business questions before any production-readiness claim.

**Tech Stack:** TypeScript, Vitest/tsx tests, OpenClaw WebSocket adapter, live OpenClaw cloud gateway, published-KB retrieval pipeline

---

## File Map

- Modify: `apps/api/src/modules/ai/support-agent.ts`
  - Owns runtime branch selection between single-agent and legacy multi-agent support execution.
- Modify: `apps/api/src/modules/ai/agent-router.ts`
  - Owns topology exposure and shared enablement semantics for support agents.
- Modify: `apps/api/src/modules/ai/support-agent.test.ts`
  - Owns runtime branching regression coverage.
- Modify: `apps/api/src/infrastructure/openclaw/device-auth.ts`
  - Owns gateway device auth persistence and stale-token recovery.
- Modify: `apps/api/src/infrastructure/openclaw/ws-adapter.ts`
  - Owns live OpenClaw prompt execution and auth handshake integration.
- Modify: `apps/api/src/infrastructure/openclaw/ws-adapter.test.ts`
  - Owns gateway auth regression coverage.
- Verify live cloud config: OpenClaw cloud `support-main` `agent.md`
  - Must encode evidence/citation constraints consistent with backend contract.

## Phase 0: Preserve Current Baseline

- [ ] Inspect git status and isolate owned files from unrelated dirty state.
- [ ] Inspect the uncommitted OpenClaw auth diff and confirm `package-lock.json` stays out of scope.
- [ ] Record the current validated checkpoint commit and current dirty delta before new edits.

## Phase 1: Root Cause Closure

- [ ] Trace runtime selection from `service.ts -> runSupportSearchAgent() -> runSingleAgentSupportSearch()`.
- [ ] Compare topology exposure rules against runtime execution rules.
- [ ] Confirm the exact mismatch causing live environments to expose `support-main` while still executing legacy multi-agent stages.
- [ ] Confirm whether any secondary blockers remain after execution-path correction: retrieval, citation binding, support-main prompt contract, or cloud agent instructions.

## Phase 2: TDD Regression Coverage

- [ ] Add a failing test in `support-agent.test.ts` for this production bug:
  - When `OPENCLAW_AGENT_ID_SUPPORT_MAIN` is configured but `FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME` is false, `runSupportSearchAgent()` must still execute the single-agent path.
- [ ] Verify the new test fails for the current implementation and fails for the expected reason.
- [ ] Keep the existing explicit-flag test coverage intact.

## Phase 3: Minimal Runtime Fix

- [ ] Introduce one shared predicate for “single-agent runtime enabled” and reuse it in topology exposure and execution-path branching.
- [ ] Ensure single-agent execution only runs when `support-main` is actually callable (`planSupportMainAgent` and `draftSupportMainAgent` exist).
- [ ] Preserve legacy multi-agent fallback only for environments with no `support-main` runtime binding.
- [ ] Keep diffs minimal; do not change retrieval strategy or answer composition in the same patch unless fresh evidence demands it.

## Phase 4: Local Verification

- [ ] Run the focused support-agent test selection and confirm new regression coverage passes.
- [ ] Run OpenClaw auth tests and confirm no regression in gateway auth/device pairing logic.
- [ ] Run API build and confirm TypeScript stays green.
- [ ] If local business probes still answer incorrectly under true single-agent mode, stop and reopen root-cause analysis before any further fix.

## Phase 5: Live Cloud OpenClaw Runtime Alignment

- [ ] Verify the effective runtime now routes real support requests to `support-main` instead of the legacy multi-agent chain.
- [ ] Inspect live stage trace and orchestration trace for actual business probes.
- [ ] Update the live cloud `support-main` `agent.md` with the backend contract:
  - use only provided evidence
  - anchor factual claims only by backend-provided `reference_id`
  - do not retrieve inside draft stage
  - keep unknowns narrow
  - answer directly first
- [ ] Re-validate after the cloud instruction update.

## Phase 6: Business-Question Acceptance Gates

- [ ] Run multiple real business questions covering at least:
  - private deployment capacity expansion
  - API scope/endpoint lookup
  - behavior/capability confirmation
  - troubleshooting-style question
- [ ] For each question, review:
  - final answer usefulness
  - evidence relevance
  - citations
  - `runtime_mode`
  - stage trace
  - orchestration trace
- [ ] Reject production-readiness immediately if any case still grounds confidently on unrelated evidence.

## Phase 7: Milestones And Release Conclusion

- [ ] Commit the OpenClaw auth self-heal changes as a scoped milestone, excluding unrelated files.
- [ ] Commit the single-agent runtime alignment changes as a separate scoped milestone.
- [ ] Only after live business gates pass, produce the merge/handoff summary with explicit inclusion, exclusion, verification, risk, and latest validated checkpoint.
- [ ] If any live gate fails, do not claim production-ready; continue debugging from the failing evidence.
