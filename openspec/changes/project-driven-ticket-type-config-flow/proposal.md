## Why

Current Configuration is endpoint-centric and does not match the real operational flow. Support admins need a project-driven setup flow where selecting a project leads directly to ticket-type exposure, form-field configuration, and status mapping that immediately controls customer portal behavior.

## What Changes

- Merge "Connection" and "Endpoints" into one setup stage focused on usable ONES connectivity and project selection.
- Make "Project selection" the effective connection proof for onboarding (project list fetch succeeds + project selected).
- Add project-scoped ticket-type discovery using work-item list data (derive/aggregate issue types from project issues).
- Add per-ticket-type enable/disable controls for customer portal exposure.
- Add per-ticket-type Configure workflow:
  - Field mapping/form schema configuration (required/optional grouped by ONES metadata).
  - Status mapping configuration (internal state to external workflow/status presentation).
- Make configuration save immediately effective for customer portal:
  - Visible creatable ticket types.
  - Dynamic ticket creation form schema and options.
  - Ticket status display mapping in customer timeline/list/detail.
- Remove dependency on manual endpoint-by-endpoint test steps as a primary UX path; keep endpoint test as optional diagnostics only.

## Capabilities

### New Capabilities
- `project-driven-ones-configuration-flow`: Unified configuration stage for auth/base URL/team + project selection as gate to next steps.
- `project-scoped-issue-type-discovery-and-exposure`: Discover project issue types from ONES work items and allow support-side exposure toggles for customer portal.
- `ticket-type-form-schema-and-field-mapping`: Per issue type form builder/mapping using ONES field metadata, including required/optional behavior.
- `ticket-status-mapping-and-customer-presentation`: Per issue type status mapping that controls customer-facing status labels and lifecycle display.
- `configuration-immediate-effect-on-customer-portal`: Saved configuration takes effect immediately for customer ticket creation and follow-up views.

### Modified Capabilities
- None.

## Impact

- Affected frontend:
  - `apps/web/src/pages/OnesSyncConfigPage.tsx` (major IA and flow redesign)
  - `apps/web/src/pages/PortalPage.tsx` (dynamic ticket type + dynamic form rendering + status presentation)
  - Related API client/types in `apps/web/src/lib/api.ts` and `apps/web/src/lib/types.ts`
- Affected backend:
  - `apps/api/src/modules/ones-sync/service.ts` and repository for new project/type/field/status config contract
  - `apps/api/src/modules/workflow/service.ts` for runtime creation/validation using configured schema
  - New/updated endpoints under `/api/v1/internal/configuration/*`
- Data model impact:
  - Extend persisted configuration for project-scoped issue-type enablement, per-type form schema mapping, per-type status mapping.
- System behavior impact:
  - Customer portal form and status rendering become config-driven from ONES integration state.
