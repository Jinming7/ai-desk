# AI Support Agent Rebuild Plan Part 06

Date: 2026-04-01

Status: implementation-ready design

Required pre-read:

1. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/AGENTS.md`
2. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`
3. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/21_AI_Support_Agent_Rebuild_Part_02_Single_DB_Build_Sync_Publish_And_Repair.md`
4. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/22_AI_Support_Agent_Rebuild_Part_03_Repository_Knowledge_Model_And_Retrieval_Units.md`
5. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/24_AI_Support_Agent_Rebuild_Part_04_Hybrid_Retrieval_And_Orchestration.md`
6. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/25_AI_Support_Agent_Rebuild_Part_05_OpenClaw_Runtime_And_Stage_Contracts.md`
7. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/agents/support-answer-composer.md`

This part must be implemented together with the constraints defined in `AGENTS.md`, Part 01, Part 02, Part 03, Part 04, and Part 05.

If this document appears to conflict with an earlier part, the earlier part wins unless explicitly revised first.

Scope:

- define the evaluation system for the AI support engineer agent
- define acceptance gates for KB build quality, retrieval quality, runtime behavior, and answer quality
- define offline, pre-release, and production-safe regression mechanisms
- define how to evaluate hybrid retrieval, grounding, specialists, and answer composition without relying on intuition
- define the minimum metrics required before enabling new retrieval or runtime behavior in production

---

## 1. Pre-Implementation Confirmation

Before implementing anything in this part, the developer must confirm all of the following.

### 1.1 Hard prerequisites

Confirm:

- Part 02 publication-based serving is the only runtime serving truth
- Part 03 repository knowledge artifacts exist in code and DB substrate
- Part 04 retrieval runtime exists behind controlled integration
- Part 05 shared support runtime stage contracts exist
- the project still operates against one shared DB

If any of the above is false or unknown, stop and re-check earlier parts before implementing evaluation or acceptance logic.

### 1.2 This part defines measurement and gates, not product behavior

This part defines:

- what to measure
- how to score it
- what minimum thresholds must be met
- what must block rollout
- how regressions are detected and surfaced

This part does **not** define:

- new KB build semantics
- new retrieval channels
- new specialist prompts
- historical data cleanup

Those belong to earlier or later parts.

### 1.3 Shared DB safety confirmation

Because the project uses a single shared DB:

- destructive evaluation runs must not target the shared runtime dataset
- integration evaluation that writes KB rows must use isolated DB or isolated `knowledge_space`
- production-safe evaluation must prefer read-only replay, diagnostics inspection, or feature-flagged shadow execution

If the execution path cannot guarantee those constraints, stop and redesign the evaluation flow before coding.

---

## 2. What This Part Delivers

This part answers one question:

> How do we know the AI support engineer agent is actually improving, and how do we prevent regressions while the system keeps evolving?

The answer is:

- not by subjective spot checks alone
- not by a single end-to-end demo
- not by prompt feel
- not by one query that now looks better

The rebuild needs a layered evaluation system:

1. KB build validation
2. retrieval evaluation
3. grounding evaluation
4. support runtime stage evaluation
5. answer quality evaluation
6. release gating
7. regression monitoring

---

## 3. Frozen Evaluation Principle

The support system remains AI-driven, so evaluation must reflect the actual AI-native stack.

Therefore:

- no acceptance based on one-off regex test cases
- no claiming improvement because one narrow question passes
- no rollout based only on offline embeddings looking plausible
- no answer-quality claims without checking grounding and citation behavior

The fixed measurement order is:

1. confirm KB snapshot quality
2. confirm retrieval quality
3. confirm evidence sufficiency
4. confirm runtime stage behavior
5. confirm customer-facing answer quality
6. decide release or block

If an earlier layer is failing, do not hide it behind later-layer prompt tuning.

---

## 4. Evaluation Layers

### 4.1 Layer A: KB build quality

Question:

> Did we build the right repository-derived knowledge snapshot cleanly and coherently?

Measure:

- build success or failure
- validation pass rate
- duplicated path rate
- artifact count stability by family
- citation-unit count stability
- memory-entry count stability
- cross-build linkage violations
- missing embedding rate for embedding-enabled families

This layer protects against:

- partial build pollution
- broken parsers
- cross-space contamination
- silent artifact-family drops

### 4.2 Layer B: retrieval quality

Question:

> Did the retrieval runtime bring back the right candidate evidence for the user question?

Measure:

- retrieval hit rate at top 1, top 3, top 5, top 10
- family hit rate
- exact-signal capture rate
- wrong-family over-ranking rate
- grounded-candidate availability rate
- hybrid vs baseline deltas

This layer protects against:

- wrong recall
- bad fusion
- bad rerank
- semantic mismatch between user phrasing and repository phrasing

### 4.3 Layer C: grounding quality

Question:

> Did retrieval abstractions correctly resolve into usable grounded citations?

Measure:

- candidate-to-citation resolution rate
- citation coverage per answer type
- broken grounding rate
- same-build coherence
- unsupported-claim rate

This layer protects against:

- memory-only answers
- dangling citations
- stale cross-build references

### 4.4 Layer D: runtime stage quality

Question:

> Did the multi-agent runtime follow the intended stage contracts and produce stable stage behavior?

Measure:

- stage completion rate
- stage fallback rate
- stage skip rate
- stage timeout rate
- contradictory verdict rate
- specialist-family selection accuracy
- clarification-need detection quality

This layer protects against:

- implicit legacy paths
- hidden retries
- wrong specialist routing
- silent fallback drift

### 4.5 Layer E: answer quality

Question:

> Did the final customer-facing answer solve the support task in the intended format?

Measure:

- direct-answer correctness
- grounded citation presence
- troubleshooting usefulness
- minimum-missing-info quality
- handoff appropriateness
- answer-type correctness
- hallucination rate
- customer-actionability score

This layer protects against:

- polished but unsupported answers
- wrong answer mode
- overly vague troubleshooting
- unnecessary clarification loops

---

## 5. Evaluation Datasets

The rebuild must use multiple dataset types. No single dataset is enough.

### 5.1 Seed retrieval set

A small, hand-curated set for fast iteration.

Each seed case must include:

- query text
- conversation context when relevant
- expected primary object family
- expected acceptable artifact ids or citation targets
- expected answer mode
- optional forbidden families

Recommended initial size:

- 40 to 80 high-signal cases

Coverage must include:

- API questions
- how-to questions
- behavior questions
- troubleshooting questions
- config questions
- docs vs code mismatch phrasing
- symptom-style phrasing

### 5.2 Build validation fixture set

A small repository fixture or sampled artifact subset used to detect parser/build regressions.

Coverage must include:

- markdown docs
- openapi
- code files
- config files
- schema files
- tests

This is not about answer quality. It is about artifact-family correctness and counts.

### 5.3 Runtime scenario set

Multi-turn and mode-sensitive support cases.

Each case should include:

- prior user messages
- assistant prior messages when relevant
- expected route
- expected specialist family
- expected clarification or no-clarification outcome
- expected answer mode

Recommended initial size:

- 20 to 40 scenarios

### 5.4 Golden answer set

A smaller but more expensive set for end-to-end answer judging.

Each case should include:

- support question
- expected answer type
- required claims
- required citation requirements
- forbidden hallucinations
- minimum operator/customer next step

Recommended initial size:

- 20 to 30 carefully reviewed cases

### 5.5 Regression replay set

A growing set of known historical failures.

Every time the team fixes:

- a retrieval miss
- a wrong-family ranking
- an unsupported answer
- a bad clarification decision
- a wrong specialist route

the failing case must be added to the regression replay set.

---

## 6. Metrics

### 6.1 Build metrics

Required metrics:

- `build_success_rate`
- `build_validation_pass_rate`
- `duplicate_active_path_rate`
- `artifact_count_delta_by_family`
- `citation_count_delta`
- `memory_entry_count_delta`
- `embedding_missing_rate`
- `cross_build_reference_violation_count`

Required rule:

- no new release if `cross_build_reference_violation_count > 0`

### 6.2 Retrieval metrics

Required metrics:

- `retrieval_hit_at_1`
- `retrieval_hit_at_3`
- `retrieval_hit_at_5`
- `retrieval_hit_at_10`
- `family_hit_at_3`
- `exact_signal_capture_rate`
- `wrong_family_top_3_rate`
- `groundable_candidate_rate`
- `kb_unavailable_false_positive_rate`

Required rule:

- every retrieval experiment must be compared against current baseline on the same seed set

### 6.3 Grounding metrics

Required metrics:

- `citation_resolution_rate`
- `answer_has_citation_rate`
- `unsupported_claim_rate`
- `same_build_grounding_rate`
- `dangling_citation_rate`

Required rule:

- no production enablement if `unsupported_claim_rate` or `dangling_citation_rate` regresses materially

### 6.4 Runtime metrics

Required metrics:

- `route_accuracy`
- `specialist_selection_accuracy`
- `clarification_precision`
- `clarification_recall`
- `stage_timeout_rate`
- `stage_fallback_rate`
- `stage_contract_violation_count`
- `verification_overturn_rate`

Required rule:

- if a stage starts failing or falling back much more often, rollout must pause even if final answers still appear acceptable

### 6.5 Answer metrics

Required metrics:

- `answer_mode_accuracy`
- `direct_answer_correctness`
- `customer_actionability_score`
- `citation_presence_rate`
- `hallucination_rate`
- `handoff_appropriateness`
- `minimum_missing_info_quality`

Required rule:

- no rollout if answer correctness improves only by sacrificing citation quality or hallucination control

---

## 7. Scoring Methods

### 7.1 Retrieval scoring

The retrieval evaluator must score:

- exact acceptable match
- acceptable-family match
- partially useful candidate
- wrong-family candidate
- no useful candidate

This should not rely on one binary label only.

Recommended scoring:

- exact acceptable candidate in top 3: full credit
- acceptable-family but not exact artifact in top 3: partial credit
- acceptable candidate only after top 10: low credit
- wrong-family in top 3 when acceptable exists lower: penalty
- no acceptable candidate: fail

### 7.2 Answer scoring

Use a rubric instead of free-form approval.

Per case, judge at least:

- answer type correctness
- claim correctness
- actionability
- citation sufficiency
- hallucination
- clarification correctness

Recommended labels:

- `pass`
- `pass_with_minor_issue`
- `needs_improvement`
- `fail`

### 7.3 Runtime scoring

The runtime evaluator must check:

- was the route correct
- was the specialist family correct
- was clarification needed
- did stage trace show the expected path
- did fallback occur for a valid reason

This ensures the team does not judge only final text while the runtime quietly degrades.

---

## 8. Acceptance Gates

### 8.1 Gate A: KB build gate

A build may be published only if:

- structural validation passes
- required artifact families are present
- duplicate path anomalies are within accepted bounds
- no cross-build grounding violations exist
- no missing critical indexes or embeddings for enabled features

### 8.2 Gate B: retrieval change gate

A retrieval change may move beyond isolated validation only if:

- it is benchmarked against baseline on the seed retrieval set
- `retrieval_hit_at_3` does not regress materially
- `wrong_family_top_3_rate` does not regress materially
- `kb_unavailable_false_positive_rate` does not regress materially
- diagnostics confirm publication-scoped reads

### 8.3 Gate C: runtime contract gate

A runtime/orchestration change may move forward only if:

- stage-trace expectations pass
- fallback behavior remains explicit
- no stage silently assumes another stage's responsibility
- triage/search/shared-runtime contract tests pass

### 8.4 Gate D: answer quality gate

A customer-facing answer change may move forward only if:

- golden answer set does not materially regress
- citation presence and grounding remain acceptable
- hallucination does not increase materially
- clarification and handoff behavior remain appropriate

### 8.5 Gate E: production enablement gate

A feature-flagged change may be enabled only if:

- earlier gates all pass
- shadow or isolated validation looks stable
- diagnostics are available for rollback decisions
- rollout can be disabled without DB repair

---

## 9. Regression Mechanisms

### 9.1 Required regression artifact types

The repository must keep regression assets for:

- seed retrieval cases
- runtime scenario cases
- golden answer cases
- historical failure replays
- build validation fixtures

### 9.2 Regression trigger sources

Add a regression case whenever the team sees:

- user-reported wrong answer
- internal review finding
- failed rollout
- retrieval miss reproduced locally
- missing citation
- wrong specialist route
- wrong clarification request

### 9.3 Regression ownership

Every meaningful support-quality fix must include one of:

- a new regression test
- a new replay case
- a new eval fixture

If not, the fix is incomplete.

### 9.4 Regression execution levels

Run regression checks at different levels:

- local focused tests for touched components
- offline eval scripts for retrieval/runtime/answers
- isolated DB validation before substrate-touching rollout
- feature-flagged shadow validation before production enablement

---

## 10. Evaluation Execution Modes

### 10.1 Fast local mode

Use for:

- parser changes
- rerank changes
- support-agent stage logic changes

Runs:

- focused unit tests
- focused retrieval seed subset
- focused runtime scenario subset

### 10.2 Isolated DB mode

Use for:

- Part 03 artifact persistence
- Part 04 retrieval integration
- Part 05 runtime integration that depends on published KB data

Runs:

- migration application
- build execution
- retrieval replay
- grounding replay
- stage contract replay

This mode must not target the shared production-visible data path.

### 10.3 Shared-DB safe shadow mode

Use for:

- production-safe observation before enabling a feature flag

Runs:

- read-only query replay
- side-by-side retrieval diagnostics
- shadow stage execution without customer-facing cutover

### 10.4 Production mode

Use only after earlier modes pass.

Runs:

- controlled flag rollout
- live diagnostics
- rollback-ready monitoring

---

## 11. Storage And Reporting

The evaluation system should persist structured results.

Recommended result groups:

- build validation results
- retrieval experiment results
- runtime replay results
- answer scoring results
- rollout observation summaries

Recommended storage options:

- dedicated DB tables for experiment summaries
- checked-in seed and golden datasets in repository
- machine-readable JSON artifacts for CI or local review

At minimum, every evaluation run should record:

- git revision
- feature flags
- knowledge space
- repo and branch scope
- published build version
- dataset version
- score summary
- top failures

---

## 12. Release Decision Rules

### 12.1 What may ship with partial validation

May ship behind flag:

- diagnostics-only changes
- internal trace cleanup
- evaluator-only code
- rerank path that is fully disabled by default

### 12.2 What must not ship with partial validation

Must not ship to customer-facing path with incomplete validation:

- new retrieval stack replacing baseline
- new grounding logic
- new specialist-routing logic
- new answer-mode logic
- changes that can turn `no_results` into `kb_unavailable` or the reverse

### 12.3 Baseline comparison rule

Every behavior-changing retrieval or runtime change must be compared against the current baseline.

Do not accept:

- "looks better in logs"
- "feels smarter"
- "one problem case now works"

without paired baseline comparison.

---

## 13. Recommended Initial Thresholds

The project may tune thresholds later, but must begin with explicit defaults.

Recommended initial defaults:

- no build publication if structural validation fails
- no rollout if `cross_build_reference_violation_count > 0`
- no rollout if `dangling_citation_rate > 0` on golden cases
- no rollout if `kb_unavailable_false_positive_rate` increases materially
- no rollout if `wrong_family_top_3_rate` increases materially
- no rollout if `hallucination_rate` increases materially
- no rollout if `citation_presence_rate` drops materially

The exact percentage thresholds should be set in implementation config, not hardcoded into this design document.

---

## 14. What This Part Explicitly Defers

This part does not yet define:

- historical KB data cleanup procedures
- customer feedback loop storage design
- automatic online learning from tickets
- production auto-rollbacks

Those may be added in later parts or dedicated operational plans.

---

## 15. Implementation Shape

Recommended implementation modules:

- evaluation dataset loader
- retrieval evaluator
- runtime scenario evaluator
- answer rubric evaluator
- build validation summarizer
- experiment comparison reporter
- rollout decision helper

Recommended repository areas:

- `apps/api/src/modules/ai/evals/*`
- `apps/api/src/modules/github-kb/evals/*`
- `apps/api/src/tests/evals/*`
- `docs/` for human-reviewed golden/rubric documentation

The exact final file layout may follow repository conventions, but responsibilities should remain separated.

---

## 16. Development Dependency Conclusion

### 16.1 Can start immediately in parallel

The following work may start now and may be developed in parallel:

- evaluation dataset schemas
- seed retrieval set format
- runtime scenario set format
- golden answer rubric format
- retrieval evaluator
- answer scorer
- stage-trace validator
- experiment diff reporter
- diagnostics summarizer

### 16.2 Can be developed now but must not yet control rollout

The following may be implemented now, but must not yet become release gates for production behavior:

- offline eval scripts
- shadow comparison tools
- candidate answer judges
- retrieval baseline comparison jobs

These must first prove they are stable and correctly scoped.

### 16.3 Must wait for prior work before full execution

The following must wait for prior conditions before they can be fully executed:

- DB-backed retrieval evaluation on live-like data
- production shadow replay for new retrieval stack
- rollout decisions based on new Part 04 retrieval path
- rollout decisions based on new Part 05 runtime tightening

Required preconditions:

- Part 03 isolated DB validation is complete
- Part 04 runtime path is stable under controlled validation
- Part 05 shared runtime contract changes are stable

### 16.4 Must not be bundled into this part

Do not bundle the following into Part 06:

- historical KB cleanup
- new retrieval channels
- production feature enablement
- unrelated prompt rewrites

Those are separate workstreams.

