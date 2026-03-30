## ADDED Requirements

### Requirement: Conversation Window SHALL use a unified full-height chat layout
The system SHALL render the conversation page as a single full-height chat workspace in chat mode, with the message list and input area contained in one continuous interaction surface.

#### Scenario: Entering chat mode
- **WHEN** the user submits the first query
- **THEN** the page SHALL switch to a full-height chat layout with message list above and input area at the bottom

#### Scenario: Continuing multi-turn conversation
- **WHEN** the user sends subsequent messages
- **THEN** new user and assistant messages SHALL append in the same scrollable message list without layout jumps

### Requirement: Message list SHALL remain readable and scrollable
The system SHALL provide a scrollable message area with adequate spacing, bounded message width, and visual differentiation between user and assistant messages.

#### Scenario: Rendering assistant and user bubbles
- **WHEN** messages are displayed
- **THEN** assistant messages SHALL be left-aligned and user messages SHALL be right-aligned with distinct visual styles

#### Scenario: Long conversation history
- **WHEN** the number of messages exceeds viewport height
- **THEN** the message list SHALL remain scrollable and preserve message readability

### Requirement: Input area MUST provide consistent send feedback
The system MUST keep the input area available at the bottom of chat mode and provide clear interaction feedback for send, loading, and retry actions.

#### Scenario: Sending a message
- **WHEN** the user presses Enter (without Shift) or clicks send
- **THEN** the message SHALL be submitted and the input control SHALL show sending/loading feedback

#### Scenario: Request error and retry
- **WHEN** a search request fails
- **THEN** the assistant message SHALL include a retry action that resubmits the failed query
