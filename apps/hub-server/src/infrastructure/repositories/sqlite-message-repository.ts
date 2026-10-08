import type { DatabaseSync } from "node:sqlite";
import type { Message, MessageHistoryFilters, MessageHistoryPosition } from "@agents-hub/shared";
import type { MessageRepository } from "../../application/ports/persistence.js";

type MessageRow = Omit<
  Message,
  "recipient_agent_ids" | "correlation_id" | "reply_to_message_id" | "thread_id"
> & {
  recipient_agent_ids: string;
  correlation_id: string | null;
  reply_to_message_id: string | null;
  thread_id: string | null;
};

function serialize({
  recipient_agent_ids,
  correlation_id,
  reply_to_message_id,
  thread_id,
  ...row
}: MessageRow): Message {
  return {
    ...row,
    recipient_agent_ids: JSON.parse(recipient_agent_ids) as string[],
    ...(correlation_id ? { correlation_id } : {}),
    ...(reply_to_message_id ? { reply_to_message_id } : {}),
    ...(thread_id ? { thread_id } : {}),
  };
}

export class SqliteMessageRepository implements MessageRepository {
  constructor(private readonly db: DatabaseSync) {}

  public findVisibleById(
    projectId: string,
    agentId: string,
    messageId: string,
  ): Message | undefined {
    const row = this.db
      .prepare(`SELECT * FROM messages WHERE project_id = ? AND message_id = ?
      AND (json_array_length(recipient_agent_ids) = 0 OR sender_id = ?
      OR EXISTS (SELECT 1 FROM json_each(messages.recipient_agent_ids) WHERE value = ?))`)
      .get(projectId, messageId, agentId, agentId) as MessageRow | undefined;
    return row ? serialize(row) : undefined;
  }

  public recipientExists(projectId: string, agentId: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM agent_sessions s JOIN memberships m ON m.project_id = s.project_id AND m.user_id = s.user_id
      WHERE s.project_id = ? AND s.agent_id = ?`)
      .get(projectId, agentId);
  }

  public insert(message: Message): void {
    this.db
      .prepare(`INSERT INTO messages (message_id, project_id, sender_id, recipient_agent_ids, channel, body, priority, correlation_id, created_at, reply_to_message_id, thread_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        message.message_id,
        message.project_id,
        message.sender_id,
        JSON.stringify(message.recipient_agent_ids),
        message.channel,
        message.body,
        message.priority,
        message.correlation_id ?? null,
        message.created_at,
        message.reply_to_message_id ?? null,
        message.thread_id ?? null,
      );
  }

  public listByProject(projectId: string, channel: string | undefined, limit: number): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE project_id = ? ${channel ? "AND channel = ?" : ""} ORDER BY created_at ASC LIMIT ?`,
      )
      .all(projectId, ...(channel ? [channel] : []), limit) as MessageRow[];
    return rows.map(serialize);
  }

  public listVisibleHistory(
    projectId: string,
    agentId: string,
    before: MessageHistoryPosition | undefined,
    filters: MessageHistoryFilters,
    limit: number,
  ): Message[] {
    const clauses = [
      "project_id = ?",
      `(json_array_length(recipient_agent_ids) = 0
        OR sender_id = ?
        OR EXISTS (
          SELECT 1 FROM json_each(messages.recipient_agent_ids) recipient
          WHERE recipient.value = ?
        ))`,
    ];
    const parameters: Array<string | number> = [projectId, agentId, agentId];
    if (filters.thread) {
      clauses.push("(message_id = ? OR thread_id = ?)");
      parameters.push(filters.thread, filters.thread);
    }
    if (filters.text) {
      clauses.push("instr(lower(body), lower(?)) > 0");
      parameters.push(filters.text);
    }
    if (filters.channel) {
      clauses.push("channel = ?");
      parameters.push(filters.channel);
    }
    if (filters.sender) {
      clauses.push("sender_id = ?");
      parameters.push(filters.sender);
    }
    if (filters.recipient) {
      clauses.push(`EXISTS (
        SELECT 1 FROM json_each(messages.recipient_agent_ids) filtered_recipient
        WHERE filtered_recipient.value = ?
      )`);
      parameters.push(filters.recipient);
    }
    if (filters.from) {
      clauses.push("created_at >= ?");
      parameters.push(filters.from);
    }
    if (filters.to) {
      clauses.push("created_at < ?");
      parameters.push(filters.to);
    }
    if (before) {
      clauses.push("(created_at < ? OR (created_at = ? AND message_id < ?))");
      parameters.push(before.created_at, before.created_at, before.message_id);
    }
    parameters.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, message_id DESC
         LIMIT ?`,
      )
      .all(...parameters) as MessageRow[];
    return rows.map(serialize);
  }
}
