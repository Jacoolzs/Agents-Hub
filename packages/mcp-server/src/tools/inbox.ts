import { setTimeout as sleep } from "node:timers/promises";
import {
  AckInboxInputSchema,
  CheckInboxInputSchema,
  EmptyInputSchema,
  InboxRecoverySchema,
  InboxResponseSchema,
  ResyncInboxInputSchema,
  WaitForMessagesInputSchema,
  decodeCursor,
} from "@agents-hub/shared";
import { content } from "./response.js";
import type { ToolRuntime } from "./runtime.js";

export async function executeInboxTool(
  name: string,
  args: Record<string, unknown>,
  runtime: ToolRuntime,
) {
  const { hubClient, room, signal, getConfirmed, setConfirmed } = runtime;
  const acknowledge = async (cursor?: string) => {
    if (cursor) {
      if (decodeCursor(cursor) === null) throw new Error("Invalid cursor");
      const ack = await hubClient.ackInbox(room.projectId, room.sessionId, cursor);
      setConfirmed(ack.cursor);
    }
  };
  const read = async (cursor: string, limit: number, readSignal: AbortSignal) =>
    InboxResponseSchema.parse(
      await hubClient.getInbox(room.projectId, room.sessionId, cursor, limit, readSignal),
    );
  switch (name) {
    case "get_inbox_recovery":
      EmptyInputSchema.parse(args);
      return content(
        InboxRecoverySchema.parse(await hubClient.getInboxRecovery(room.projectId, room.sessionId)),
      );
    case "resync_inbox": {
      const input = ResyncInboxInputSchema.parse(args);
      const ack = await hubClient.ackInbox(room.projectId, room.sessionId, input.cursor, true);
      setConfirmed(ack.cursor);
      return content(await read(getConfirmed(), 50, signal));
    }
    case "ack_inbox": {
      const input = AckInboxInputSchema.parse(args);
      await acknowledge(input.cursor);
      return content({ cursor: getConfirmed(), status: "confirmed" });
    }
    case "check_inbox": {
      const input = CheckInboxInputSchema.parse(args);
      await acknowledge(input.cursor);
      return content(await read(getConfirmed(), input.limit, signal));
    }
    case "wait_for_messages": {
      const input = WaitForMessagesInputSchema.parse(args);
      await acknowledge(input.cursor);
      const start = Date.now();
      const waitSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(input.timeout_seconds * 1000),
      ]);
      try {
        while (!waitSignal.aborted) {
          const inbox = await read(getConfirmed(), 50, waitSignal);
          if (inbox.events.length)
            return content({
              ...inbox,
              cursor: inbox.next_cursor,
              waited_ms: Date.now() - start,
            });
          await sleep(Math.min(1000, input.timeout_seconds * 1000), undefined, {
            signal: waitSignal,
          });
        }
      } catch (error) {
        if (!waitSignal.aborted || signal.aborted) throw error;
      }
      signal.throwIfAborted();
      return content({
        events: [],
        cursor: getConfirmed(),
        next_cursor: getConfirmed(),
        has_more: false,
        waited_ms: Date.now() - start,
      });
    }

    default:
      return undefined;
  }
}
