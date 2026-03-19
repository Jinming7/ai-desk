## 1. Layout & Interaction Foundation

- [x] 1.1 Refactor chat-mode page container to full-height conversation workspace (`message list + bottom input`) with stable flex behavior.
- [x] 1.2 Replace floating input behavior with integrated bottom input area and keep send/enter interaction backward-compatible.
- [x] 1.3 Ensure chat scroll behavior is stable (`min-height: 0`, overflow handling, auto-scroll to latest message) across desktop/mobile.

## 2. Message Bubble & Visual Hierarchy

- [x] 2.1 Standardize assistant/user bubble width, alignment, spacing, corner rules, and readability constraints.
- [x] 2.2 Implement refined background/glow and scoped styling for chat mode without affecting non-chat portal states.
- [x] 2.3 Polish loading/error/retry visual states inside message stream to avoid split-state UX.

## 3. Answer Presentation Contract

- [x] 3.1 Render answer card with fixed order: quick answer summary, execution steps, validation checklist, sources.
- [x] 3.2 Add fallback rendering path when `structured_answer` is absent while preserving citations/references.
- [x] 3.3 Reduce duplicated content between latest assistant bubble and detailed answer card.

## 4. Language Consistency & Copy

- [x] 4.1 Normalize UI copy dictionaries for zh/en and remove mixed-language hardcoded strings in result region.
- [x] 4.2 Ensure answer/output language follows query language across quick answer, action plan, and escalation hints.

## 5. Verification & Regression

- [ ] 5.1 Validate core scenarios: grounded answer, low-confidence clarification, error+retry, and handoff CTA in chat mode.
- [x] 5.2 Run frontend build and smoke-check responsive behavior on common viewport sizes.
- [x] 5.3 Document UX changes and acceptance checklist in change notes for implementation review.
