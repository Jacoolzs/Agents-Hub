import {
  ClaimLockInputSchema,
  EmptyInputSchema,
  IdempotencyKeySchema,
  MessageSchema,
  ReleaseLockInputSchema,
  ReportStatusInputSchema,
  SendMessageInputSchema,
  StatusReportSchema,
  UuidSchema,
  WorkspaceLockSchema,
  containsObviousSecret,
} from "@agents-hub/shared";
import { content } from "./response.js";
import type { ToolRuntime } from "./runtime.js";

export async function executeProjectCommand(
  name: string,
  args: Record<string, unknown>,
  runtime: ToolRuntime,
) {
  const { hubClient, room } = runtime;
  switch (name) {
    case "send_team_message": {
      const { idempotency_key, ...payload } = args;
      const input = SendMessageInputSchema.parse(payload);
      if (input.body.length > 4096 || containsObviousSecret(input.body))
        throw new Error("Message must contain at most 4096 characters and no credentials");
      const id = IdempotencyKeySchema.parse(idempotency_key ?? crypto.randomUUID());
      return content(
        MessageSchema.parse(await hubClient.sendMessage(room.projectId, room.sessionId, input, id)),
      );
    }
    case "report_status": {
      const { idempotency_key, ...payload } = args;
      return content(
        StatusReportSchema.parse(
          await hubClient.reportStatus(
            room.projectId,
            room.sessionId,
            ReportStatusInputSchema.parse(payload),
            IdempotencyKeySchema.parse(idempotency_key ?? crypto.randomUUID()),
          ),
        ),
      );
    }
    case "claim_module_lock": {
      const { idempotency_key, ...payload } = args;
      return content(
        WorkspaceLockSchema.parse(
          await hubClient.claimLock(
            room.projectId,
            room.sessionId,
            ClaimLockInputSchema.parse(payload),
            IdempotencyKeySchema.parse(idempotency_key ?? crypto.randomUUID()),
          ),
        ),
      );
    }
    case "release_module_lock": {
      if (args.lock_id !== undefined) {
        if (
          !UuidSchema.safeParse(args.lock_id).success ||
          Object.keys(args).some((k) => k !== "lock_id")
        )
          throw new Error("Invalid lock_id");
        return content(
          await hubClient.releaseLockById(
            room.projectId,
            room.sessionId,
            UuidSchema.parse(args.lock_id),
          ),
        );
      }
      const input = ReleaseLockInputSchema.parse(args);
      return content(await hubClient.releaseLock(room.projectId, room.sessionId, input.paths));
    }
    case "get_team_status":
      EmptyInputSchema.parse(args);
      return content(await hubClient.getTeamStatus(room.projectId));
    default:
      throw new Error("Unknown tool");
  }
}
