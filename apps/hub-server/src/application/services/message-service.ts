import {
  AppError,
  MAX_MESSAGE_BODY_BYTES,
  type Message,
  type MessageHistoryFilters,
  type MessageHistoryPage,
  type MessageHistoryPosition,
  type SendMessageInput,
  SendMessageInputSchema,
  containsObviousSecret,
  createMessageHistoryFilterKey,
  decodeMessageHistoryCursor,
  encodeMessageHistoryCursor,
  generateId,
  nowUtc,
} from "@agents-hub/shared";
import type { DomainEvents, MessageRepository } from "../ports/persistence.js";

export class MessageService {
  constructor(
    private readonly repository: MessageRepository,
    private readonly eventBus: DomainEvents,
  ) {}

  public sendMessage(projectId: string, senderId: string, rawInput: SendMessageInput): Message {
    if (
      typeof rawInput?.body === "string" &&
      Buffer.byteLength(rawInput.body, "utf8") > MAX_MESSAGE_BODY_BYTES
    )
      throw new AppError("MESSAGE_TOO_LARGE", "Message body exceeds 16 KiB");
    const parsed = SendMessageInputSchema.safeParse(rawInput);
    if (!parsed.success)
      throw new AppError(
        "INVALID_INPUT",
        parsed.error.errors[0]?.message ?? "Invalid message input",
      );
    const input = parsed.data;
    if (containsObviousSecret(input.body))
      throw new AppError("INVALID_INPUT", "Remove credentials from the message before sending");
    const message: Message = {
      message_id: generateId(),
      project_id: projectId,
      sender_id: senderId,
      recipient_agent_ids: input.recipient_agent_ids ?? [],
      channel: input.channel,
      body: input.body,
      priority: input.priority ?? "normal",
      ...(input.correlation_id ? { correlation_id: input.correlation_id } : {}),
      created_at: nowUtc(),
    };
    return this.eventBus.transaction(() => {
      for (const recipient of message.recipient_agent_ids)
        if (!this.repository.recipientExists(projectId, recipient))
          throw new AppError("INVALID_INPUT", "Recipient is not an agent in this project");
      this.repository.insert(message);
      this.eventBus.recordEvent(projectId, senderId, "message.created", {
        message_id: message.message_id,
        sender_id: senderId,
        recipient_agent_ids: message.recipient_agent_ids,
        channel: input.channel,
        body: input.body,
        priority: message.priority,
        correlation_id: input.correlation_id ?? null,
      });
      return message;
    });
  }

  public getMessages(projectId: string, agentId?: string, channel?: string, limit = 50): Message[] {
    return this.repository
      .listByProject(projectId, channel, limit)
      .filter(
        (message) =>
          !agentId ||
          message.recipient_agent_ids.length === 0 ||
          message.sender_id === agentId ||
          message.recipient_agent_ids.includes(agentId),
      );
  }

  public getHistory(
    projectId: string,
    agentId: string,
    beforeCursor?: string,
    filters: MessageHistoryFilters = {},
    limit = 50,
  ): MessageHistoryPage {
    const filterKey = createMessageHistoryFilterKey(filters);
    let before: MessageHistoryPosition | undefined;
    if (beforeCursor) {
      const decoded = decodeMessageHistoryCursor(beforeCursor);
      if (!decoded) throw new AppError("CURSOR_INVALID", "Invalid history cursor");
      if ((decoded.filter_key ?? "") !== filterKey)
        throw new AppError("CURSOR_INVALID", "History cursor does not match the active filters");
      before = decoded;
    }
    const rows = this.repository.listVisibleHistory(projectId, agentId, before, filters, limit + 1);
    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;
    const oldest = messages[messages.length - 1];
    return {
      messages,
      next_cursor:
        hasMore && oldest
          ? encodeMessageHistoryCursor(
              {
                created_at: oldest.created_at,
                message_id: oldest.message_id,
              },
              filterKey,
            )
          : null,
      has_more: hasMore,
    };
  }
}
