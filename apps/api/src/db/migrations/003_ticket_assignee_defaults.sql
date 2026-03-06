ALTER TABLE tickets
  ALTER COLUMN assignee_type SET DEFAULT 'SUPPORT_TEAM',
  ALTER COLUMN assignee_name SET DEFAULT 'Support Team';

UPDATE tickets
SET assignee_type = 'SUPPORT_TEAM',
    assignee_name = 'Support Team'
WHERE assignee_type = 'AI_AGENT' OR assignee_name = 'AI Agent';
