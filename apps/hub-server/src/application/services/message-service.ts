import type { DatabaseSync } from "node:sqlite";
import {
  AppError,
  MAX_MESSAGE_BODY_BYTES,
  type Message,
  type SendMessageInput,
  SendMessageInputSchema,
  containsObviousSecret,
  generateId,
  nowUtc,
} from "@agents-hub/shared";
import type { SqliteEventBus } from "../../infrastructure/event-bus/event-bus.js";

export class MessageService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly eventBus: SqliteEventBus,
  ) {}

  public sendMessage(projectId: string, senderId: string, rawInput: SendMessageInput): Message {
    if (
      typeof rawInput?.body === "string" &&
      Buffer.byteLength(rawInput.body, "utf8") > MAX_MESSAGE_BODY_BYTES
    )
      throw new AppError("MESSAGE_TOO_LARGE", "Message body exceeds 16 KiB");
    const parsed = SendMessageInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const err = parsed.error.errors[0]?.message ?? "Invalid message input";
      throw new AppError("INVALID_INPUT", err);
    }
    const input = parsed.data;

    const messageId = generateId();
    const now = nowUtc();
    const recipientIds = input.recipient_agent_ids ?? [];
    if (containsObviousSecret(input.body))
      throw new AppError("INVALID_INPUT", "Remove credentials from the message before sending");
    const priority = input.priority ?? "normal";

    return this.eventBus.transaction(() => {
      for (const recipient of recipientIds) {
        if (
          !this.db
            .prepare(`SELECT 1 FROM agent_sessions s JOIN memberships m ON m.project_id = s.project_id AND m.user_id = s.user_id
          WHERE s.project_id = ? AND s.agent_id = ?`)
            .get(projectId, recipient)
        ) {
          throw new AppError("INVALID_INPUT", "Recipient is not an agent in this project");
        }
      }
      this.db
        .prepare(`
        INSERT INTO messages (message_id, project_id, sender_id, recipient_agent_ids, channel, body, priority, correlation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          messageId,
          projectId,
          senderId,
          JSON.stringify(recipientIds),
          input.channel,
          input.body,
          priority,
          input.correlation_id ?? null,
          now,
        );

      this.eventBus.recordEvent(projectId, senderId, "message.created", {
        message_id: messageId,
        sender_id: senderId,
        recipient_agent_ids: recipientIds,
        channel: input.channel,
        body: input.body,
        priority,
        correlation_id: input.correlation_id ?? null,
      });

      return {
        message_id: messageId,
        project_id: projectId,
        sender_id: senderId,
        recipient_agent_ids: recipientIds,
        channel: input.channel,
        body: input.body,
        priority,
        ...(input.correlation_id ? { correlation_id: input.correlation_id } : {}),
        created_at: now,
      };
    });
  }

  public getMessages(projectId: string, agentId?: string, channel?: string, limit = 50): Message[] {
    let sql = "SELECT * FROM messages WHERE project_id = ?";
    const params: Array<string | number | bigint | null> = [projectId];

    if (channel) {
      sql += " AND channel = ?";
      params.push(channel);
    }

    sql += " ORDER BY created_at ASC LIMIT ?";
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      message_id: string;
      project_id: string;
      sender_id: string;
      recipient_agent_ids: string;
      channel: string;
      body: string;
      priority: Message["priority"];
      correlation_id: string | null;
      created_at: string;
    }>;

    return rows
      .map((r) => {
        const recipients = JSON.parse(r.recipient_agent_ids) as string[];
        return {
          message_id: r.message_id,
          project_id: r.project_id,
          sender_id: r.sender_id,
          recipient_agent_ids: recipients,
          channel: r.channel,
          body: r.body,
          priority: r.priority,
          ...(r.correlation_id ? { correlation_id: r.correlation_id } : {}),
          created_at: r.created_at,
        };
      })
      .filter((m) => {
        if (!agentId) return true;
        // Include if broadcast (empty recipients) or agent is sender or recipient
        return (
          m.recipient_agent_ids.length === 0 ||
          m.sender_id === agentId ||
          m.recipient_agent_ids.includes(agentId)
        );
      });
  }
}
