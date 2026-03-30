## Context

Current ONES configuration UX is endpoint-first and creates a mismatch between setup actions and business outcomes. Support admins need a project-first flow that immediately exposes project-specific ticket types, field schema, and status mapping, then drives customer portal behavior without extra manual endpoint diagnostics.

Constraints:
- Must remain compatible with existing ONES OpenAPI connector and stored configuration records.
- Must preserve encrypted token handling and internal-only configuration APIs.
- Must support immediate runtime effect in customer portal after save.

Stakeholders:
- Support admin (config owner)
- Support agent (operational consumer of status mapping)
- Customer portal user (ticket creator and follower)

## Goals / Non-Goals

**Goals:**
- Reframe Configuration as a project-driven setup wizard:
  - Setup connection + project
  - Discover issue types from selected project work items
  - Configure per-type form schema and status mapping
- Make project selection the primary connectivity validation for progression.
- Persist per-project, per-issue-type exposure and mapping configuration.
- Ensure customer portal reads saved configuration as source of truth for form rendering and status display.

**Non-Goals:**
- Rebuilding ONES connector transport layer.
- Adding new ticket lifecycle states beyond current product state model.
- Full visual form designer (drag/drop) in this iteration.

## Decisions

1. Single "Setup & Project" stage replaces separate Connection/Endpoints as primary onboarding path.
- Rationale: aligns with actual user mental model and removes endpoint testing as required friction.
- Alternative considered: keep endpoint step mandatory; rejected due to low usability and high misconfiguration risk.

2. Project issue types derived from project work item list responses, then normalized and deduplicated server-side.
- Rationale: matches requested flow and ensures only in-project active types are exposed for configuration.
- Alternative considered: fetch global issue type catalog; rejected because it introduces irrelevant types and weak project scoping.

3. Per-issue-type config split into two explicit tabs:
- Field schema mapping (required/optional/form-visible/default/options)
- Status mapping (internal state -> customer-facing mapped state/label)
- Rationale: clear separation of payload contract vs lifecycle presentation.

4. Save semantics: "Save = effective" for customer portal reads.
- Rationale: required by business flow; avoids separate publish confusion for this stage.
- Alternative considered: publish gate; kept optional for future but not blocking this flow.

5. Endpoint test remains optional diagnostics only.
- Rationale: useful for troubleshooting but should not gate progression.

6. Customer portal runtime contract becomes config-driven by (projectKey, issueTypeKey).
- Rationale: deterministic rendering and validation for create/follow-up flows.

## Risks / Trade-offs

- [Project issue-type inference may miss dormant issue types] -> Mitigation: allow optional fallback fetch from issue type endpoint and merge strategy.
- [Save-immediate can propagate bad mappings quickly] -> Mitigation: validate required fields/status map before accept; show blocking errors.
- [Per-type config growth increases payload size] -> Mitigation: persist normalized JSON per issue type and lazy-load details in UI.
- [ONES response heterogeneity across tenants] -> Mitigation: central parser with multi-shape support and explicit error classification.

## Migration Plan

1. Data model extension for per-project issue-type configuration objects.
2. Backend API additions for:
- project-scoped issue type discovery
- per-type form/status config read/write
3. UI flow replacement in configuration page.
4. Customer portal switches to new config contract with backward-compatible fallback.
5. Rollback: feature flag to old configuration read path if severe runtime issue appears.

## Open Questions

- Whether project issue-type inference should be strictly from issues list or merged with explicit issue type catalog by default.
- Whether status mapping should support custom customer labels in this phase or keep one-to-one mapping only.
- Whether immediate effect needs lightweight version snapshots for one-click rollback in UI.
