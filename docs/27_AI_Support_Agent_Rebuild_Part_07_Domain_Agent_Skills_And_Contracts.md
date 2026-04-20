# AI Support Agent Rebuild Plan Part 07

Date: 2026-04-15

Status: implementation-ready design

Required pre-read:

1. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/AGENTS.md`
2. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`
3. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/22_AI_Support_Agent_Rebuild_Part_03_Repository_Knowledge_Model_And_Retrieval_Units.md`
4. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/24_AI_Support_Agent_Rebuild_Part_04_Hybrid_Retrieval_And_Orchestration.md`
5. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/agents/support-answer-composer.md`

This part freezes how stage-map intent becomes executable support behavior.

Its purpose is to stop the implementation from drifting back into local heuristic logic.

Scope:

- define repository-driven support domains
- define the domain-agent execution chain
- define external skill/contract files as the runtime source of truth
- explicitly forbid local TypeScript from re-implementing routing, query expansion, rerank, and answer repair logic
- define which responsibilities belong to supervisor, domain agents, evidence judge, and answer composer

---

## 1. Why The Previous Implementation Failed

The repository already had the right product philosophy:

- one AI-driven support pipeline
- retrieval as a subsystem, not the product
- grounded answers with citations
- no regex/router hacks as the main quality fix

But the runtime implementation drifted in the opposite direction.

The main failure pattern was:

1. route and case semantics were partly inferred by the model
2. then rewritten locally in TypeScript
3. retrieval queries were then rewritten locally again
4. evidence ranking was then patched locally again
5. draft recovery was then patched locally again
6. final answers were then composed from already distorted evidence

This created a system where:

- stage contracts existed on paper but not in execution
- the local runtime silently overrode stage outputs
- business correctness depended on hard-to-audit heuristics
- narrow query fixes accumulated in code instead of in reusable agent contracts

This part freezes the correction.

From this point onward, the stage map is not just conceptual documentation.

It is the executable contract model.

---

## 2. Frozen Implementation Principle

The support runtime must be `contract-driven`.

That means:

- stage behavior lives in external contract files
- domain behavior lives in domain-specific agent contracts
- local runtime code may orchestrate, validate, trace, and fail closed
- local runtime code must not secretly re-decide business semantics

### 2.1 Allowed local runtime logic

Local TypeScript may do only the following:

- load published snapshot data
- load external contract files and registry metadata
- extract exact signals generically from user input
- call OpenClaw stages with structured payloads
- validate JSON outputs against schema
- enforce fail-closed evidence gates
- record traces, diagnostics, and timing
- apply generic safety normalization such as dedupe, truncation, and bounds checks

### 2.2 Forbidden local runtime logic

The following are explicitly forbidden in runtime code:

- domain-specific query regex routing after supervisor output
- local case-frame rewrites for specific business questions
- local query expansion tables for narrow support questions
- local rerank bonuses/penalties targeted at one domain or one query family
- local draft recovery builders that fabricate a customer-facing answer from wrong evidence
- local semantic canonicalization that reinterprets planner free-text fields (for example `product_area` prose) into runtime domain decisions
- local title/path heuristics used as business-meaning substitutes
- local negative-answer synthesis from near-match documents

If the system needs different behavior, change the external contract file or the published knowledge metadata.

Do not add a new branch in TypeScript.

---

## 3. Repository-Derived Support Domains

Support domains must be defined from repository knowledge ownership, not from ad-hoc user wording.

The runtime must derive domain selection from:

- source families
- product areas
- doc kinds
- exact-signal object types
- evidence suitability rules

### 3.1 `openapi`

Owned repository knowledge:

- `openapi_spec`
- `doc_page` with `product_area=openapi`
- permission and OAuth-related doc pages

Primary question families:

- endpoint lookup
- method/path confirmation
- request or response field lookup
- scope/auth/token questions

Exact signals:

- HTTP method
- route path
- operation id
- scope
- field name
- token / OAuth terms

### 3.2 `deployment`

Owned repository knowledge:

- `runbook_file`
- `doc_page` with `product_area=deployment`
- `config_file` and `config_surface` tied to deployment/runtime configuration

Primary question families:

- private deployment how-to
- deployment prerequisites and constraints
- topology, isolation, architecture, externalization
- admin recovery and infra-operational questions

Exact signals:

- deployment component names
- topology terms
- infrastructure objects
- config keys
- version and environment requirements

### 3.3 `integrations`

Owned repository knowledge:

- `doc_page` with `product_area=integrations`
- integration runbooks
- config surfaces for callback, base URL, OAuth, webhook
- code/config evidence only when it is the same integration surface

Primary question families:

- callback errors
- redirect URI / webhook / OAuth integration setup
- integration-specific troubleshooting

Exact signals:

- callback URL
- redirect URI
- webhook route
- integration provider names
- auth app/base URL settings

### 3.4 `product`

Owned repository knowledge:

- `doc_page`
- `schema_file`
- `test_file`
- product rules/capability docs

Primary question families:

- product behavior and intended capability
- documented workflow behavior
- feature availability and limitation questions
- non-OpenAPI capability confirmation

Exact signals:

- product objects
- feature names
- rule language
- schema terms
- behavior/test assertions

### 3.5 `troubleshooting`

Owned repository knowledge:

- troubleshooting doc pages
- runbooks
- code/config/test evidence only when tied to the same failing object or symptom

Primary question families:

- error diagnosis
- failure triage
- direct checks to run now
- minimum blocking info requests

Exact signals:

- error codes
- error strings
- callback failures
- config keys
- failing object names
- version/environment mismatch terms

---

## 4. Runtime Execution Chain

The runtime must answer support questions through this chain:

1. `support-supervisor`
2. published-KB retrieval runtime
3. domain support agent
4. `support-evidence-judge`
5. `support-answer-composer`

### 4.1 `support-supervisor`

Responsibilities:

- choose `primary_domain`
- choose `question_type`
- choose `specialist_agent`
- produce the first `case_frame`
- produce `required_doc_kinds`
- decide whether a minimum clarification is needed

Must not:

- answer the question
- retrieve evidence
- decide citations
- rewrite itself based on later local heuristics

### 4.2 Published-KB retrieval runtime

Responsibilities:

- execute recall using the published snapshot only
- honor domain registry metadata before query similarity
- enforce source-family and product-area ownership
- return candidate evidence with metadata intact

Must not:

- fabricate query-specific answer logic
- change the domain selected by the supervisor
- invent negative conclusions from absence unless the judge can defend them

### 4.3 Domain support agent

Responsibilities:

- interpret the case through the chosen domain contract
- select primary and supplemental evidence from retrieved candidates
- produce a scenario-appropriate draft answer
- fail closed when exact or direct evidence is missing

Must not:

- borrow meaning from nearby domains
- use same-domain but irrelevant docs as substitutes
- treat migration notes, optional notes, or generic overviews as proof of capability

### 4.4 `support-evidence-judge`

Responsibilities:

- strip unsupported claims
- preserve only narrow supported conclusions
- downgrade to clarification or handoff when the core answer is unsupported

Must not:

- widen a claim beyond the evidence
- let the direct answer survive without direct support

### 4.5 `support-answer-composer`

Responsibilities:

- produce the final customer-facing structure
- preserve answer contract and citations

Must not:

- re-route the case
- invent missing evidence
- rewrite unsupported content into confident prose

---

## 5. External Contract Files Are Now Mandatory

Each runtime stage and domain must be backed by external prompt/contract files under `docs/agents/support-runtime/`.

The runtime must load these files instead of embedding stage rules in TypeScript string arrays.

Minimum required files:

- `docs/agents/support-runtime/registry.json`
- `docs/agents/support-runtime/support-supervisor.md`
- `docs/agents/support-runtime/support-openapi-agent.md`
- `docs/agents/support-runtime/support-deploy-docs-agent.md`
- `docs/agents/support-runtime/support-integrations-agent.md`
- `docs/agents/support-runtime/support-product-behavior-agent.md`
- `docs/agents/support-runtime/support-troubleshooting-agent.md`
- `docs/agents/support-runtime/support-evidence-judge.md`

The existing repository answer shape remains governed by:

- `docs/agents/support-answer-composer.md`

---

## 6. Required Contract Shape

Every domain contract file must contain all of the following sections:

1. `Role`
2. `Owned Knowledge`
3. `In-Scope Questions`
4. `Must Verify Before Answering`
5. `Evidence Priority`
6. `Near-Match Rejection Rules`
7. `Clarify / Handoff Rules`
8. `Draft Output Rules`
9. `Forbidden Moves`

If any of these sections is missing, the contract is incomplete.

---

## 7. Domain-Agent Quality Gates

### 7.1 Exactness gate

If the question asks about:

- a precise API
- a specific deployment topology
- a concrete integration callback/config
- a named product capability

then the domain agent must not answer from near-match evidence.

It must either:

- find direct evidence
- return a narrow negative conclusion that is itself evidence-backed
- ask for the minimum missing input
- hand off

### 7.2 Same-domain is not enough

Being from the same product area is not sufficient.

Example failures that must be rejected:

- deployment OS requirements used as proof of deployment topology
- migration documents used as proof of default architecture
- generic OpenAPI docs used as proof of runtime integration callback behavior
- generic troubleshooting docs used as proof of supported product capability

### 7.3 Direct-answer gate

The final direct answer must be supported by at least one surviving primary claim.

If not, the answer must be transformed into:

- `clarification`, or
- `handoff`, or
- a narrow evidence-backed negative conclusion

It must not remain a confident grounded answer.

---

## 8. How Retrieval Must Change

Retrieval must become domain-first, not heuristic-first.

Required order:

1. supervisor selects domain
2. runtime loads domain registry metadata
3. retrieval filters and weights by:
   - owned source families
   - owned product areas
   - preferred doc kinds
   - exact signal object types
4. domain agent chooses evidence
5. judge validates claims

This replaces:

- local case-frame stabilization patches
- local query expansion hacks
- local rerank branches for narrow domains

---

## 9. Migration Rule For Existing Support Code

The following existing logic categories must be removed or reduced to generic safety helpers:

- local supervisor-route reconciliation
- local domain stabilization
- local domain-specific retrieval query builders
- local domain-specific rerank functions
- local draft-recovery answer builders

If a helper cannot be described as a generic runtime safety or generic retrieval primitive, it does not belong in TypeScript.

---

## 10. Acceptance Criteria

This redesign is accepted only when all of the following are true:

1. preview validation is done against preview itself, not local only
2. support stage prompts are loaded from external contract files
3. domain selection is visible in diagnostics
4. local runtime no longer contains domain-specific answer synthesis branches
5. deployment architecture/isolation questions fail closed when direct evidence is absent
6. OpenAPI questions prefer exact operation evidence over same-domain noise
7. integration troubleshooting prefers callback/config evidence over generic OpenAPI noise
8. final answers remain aligned with `support-answer-composer.md`

---

## 11. Immediate Implementation Direction

The first implementation slice after this document must do three things:

1. add the external contract files and domain registry
2. add a prompt/contract loader in runtime code
3. replace embedded stage prompt strings with loaded contract text

Only after that may the remaining local heuristic logic be deleted in follow-up slices.
