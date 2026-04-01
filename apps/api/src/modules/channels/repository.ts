import { v4 as uuidv4 } from "uuid";
import { pool } from "../../db/client.js";

export async function upsertChannelThread(input: {
  channelType: string;
  tenantKey?: string;
  externalThreadId: string;
  externalUserId?: string | null;
  sessionId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const id = uuidv4();
  const tenantKey = input.tenantKey ?? "default";
  const result = await pool.query<{ id: string }>(
    `INSERT INTO channel_threads (
      id, channel_type, tenant_key, external_thread_id, external_user_id, session_id, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
    ON CONFLICT (channel_type, tenant_key, external_thread_id)
    DO UPDATE SET
      external_user_id = COALESCE(EXCLUDED.external_user_id, channel_threads.external_user_id),
      session_id = COALESCE(EXCLUDED.session_id, channel_threads.session_id),
      metadata = channel_threads.metadata || EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING id`,
    [
      id,
      input.channelType,
      tenantKey,
      input.externalThreadId,
      input.externalUserId ?? null,
      input.sessionId ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0].id;
}

export async function appendConversationEvent(input: {
  sessionId?: string | null;
  channelThreadId?: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  sourceType: string;
  sourceEventId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO conversation_events (
      id, session_id, channel_thread_id, role, content, source_type, source_event_id, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    ON CONFLICT (source_type, source_event_id)
    DO NOTHING`,
    [
      uuidv4(),
      input.sessionId ?? null,
      input.channelThreadId ?? null,
      input.role,
      input.content,
      input.sourceType,
      input.sourceEventId ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

