## UX Changes Implemented

- Converted chat mode to a unified full-height conversation workspace (single message stream + integrated bottom composer).
- Removed floating input behavior and kept Enter-to-send compatibility (Shift+Enter for newline).
- Improved message stream readability: constrained bubble width, role differentiation, scoped chat background glow, and refined loading/retry states.
- Reorganized answer details into actionable order: quick answer, action plan, validation checklist, and evidence sections.
- Reduced duplicate answer exposure between latest assistant bubble and detail card by showing a concise pointer in the latest bubble when structured card is present.
- Added language-consistent copy keys for zh/en across quick answer, escalation, ticket CTA, and status labels.
- Added textarea auto-height behavior in composer for multi-line input while preserving compact default height.

## Acceptance Checklist

- [x] Chat mode uses full-height flex conversation layout.
- [x] Input area is integrated at bottom of chat stage (non-floating), with clear send affordance.
- [x] Message list remains scrollable with stable min-height and custom slim scrollbar.
- [x] Assistant/user bubbles are visually distinct and readable.
- [x] Structured answer is rendered in fixed actionable order with fallback to plain answer.
- [x] Source/citation sections remain explicit and navigable.
- [x] UI copy follows query language (zh/en) in core answer and escalation paths.
- [x] Frontend and API compile successfully.

## Verification Status

- Frontend build: ✅ `npm run build -w apps/web`
- API build: ✅ `npm run build -w apps/api`
- API integration tests: ⚠️ blocked by safety guard (current DB URL is non-test; test runner refuses execution)
  - Error: `Refusing to run integration tests against non-test database`
- Web route tests: ⚠️ one unrelated pre-existing failure in route map expectation (`/support/admin/ones-sync` vs `/support/admin/configuration`), not introduced by this UI change.

## Remaining Work

- Run full core scenario verification for task 5.1 once a test-safe database URL is provided.
