import { describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  AppError,
  ClaimLockInputSchema,
  CursorSchema,
  EventEnvelopeSchema,
  MAX_MESSAGE_BODY_BYTES,
  MessageHistoryPageSchema,
  MessageSchema,
  NormalizedWorkspacePathSchema,
  ProjectSchema,
  StatusReportSchema,
  UtcIsoDateSchema,
  UuidSchema,
  decodeCursor,
  decodeMessageHistoryCursor,
  encodeCursor,
  encodeMessageHistoryCursor,
  generateId,
  nowUtc,
} from "./index.js";

describe("Shared Contracts & Validation (Phase 1)", () => {
  describe("IDs and Dates", () => {
    it("generates valid UUIDs", () => {
      const id = generateId();
      expect(UuidSchema.safeParse(id).success).toBe(true);
    });

    it("rejects non-UUID strings", () => {
      expect(UuidSchema.safeParse("not-a-uuid").success).toBe(false);
    });

    it("validates strict UTC ISO dates", () => {
      const date = nowUtc();
      expect(UtcIsoDateSchema.safeParse(date).success).toBe(true);
      expect(UtcIsoDateSchema.safeParse("2026-10-07 18:30:00").success).toBe(false);
      expect(UtcIsoDateSchema.safeParse("2026-10-07T18:30:00+02:00").success).toBe(false);
    });
  });

  describe("Pagination & Cursors", () => {
    it("encodes and decodes monotonic sequences safely", () => {
      const seq = 42;
      const cursor = encodeCursor(seq);
      expect(CursorSchema.safeParse(cursor).success).toBe(true);
      expect(decodeCursor(cursor)).toBe(seq);
    });

    it("returns null for invalid/malformed cursors", () => {
      expect(decodeCursor("invalid-base64---")).toBe(null);
      expect(decodeCursor(encodeCursor(-5))).toBe(null);
    });

    it("keeps history keyset cursors canonical and distinct from inbox cursors", () => {
      const position = {
        created_at: "2026-10-08T12:00:00.000Z",
        message_id: generateId(),
      };
      const cursor = encodeMessageHistoryCursor(position);
      expect(decodeMessageHistoryCursor(cursor)).toEqual(position);
      expect(decodeMessageHistoryCursor(encodeCursor(42))).toBe(null);
      expect(
        MessageHistoryPageSchema.safeParse({
          messages: [],
          next_cursor: null,
          has_more: false,
        }).success,
      ).toBe(true);
    });
  });

  describe("Errors", () => {
    it("formats standard AppError into valid ApiError", () => {
      const appError = new AppError(
        "LOCK_CONFLICT",
        "File is already claimed by agent-bob",
        "req-1",
        {
          file: "src/index.ts",
        },
      );
      const response = appError.toResponse();
      expect(ApiErrorSchema.safeParse(response).success).toBe(true);
      expect(response.code).toBe("LOCK_CONFLICT");
    });
  });

  describe("Message Validation & Limits", () => {
    const validProject = generateId();

    it("accepts valid message within 16 KiB", () => {
      const msg = {
        message_id: generateId(),
        project_id: validProject,
        sender_id: "agent-alice",
        recipient_agent_ids: ["agent-bob"],
        channel: "features",
        body: "Hello Bob, please review auth contract",
        priority: "normal",
        created_at: nowUtc(),
      };
      expect(MessageSchema.safeParse(msg).success).toBe(true);
    });

    it("rejects message body exceeding 16 KiB", () => {
      const largeBody = "x".repeat(MAX_MESSAGE_BODY_BYTES + 1);
      const msg = {
        message_id: generateId(),
        project_id: validProject,
        sender_id: "agent-alice",
        body: largeBody,
        created_at: nowUtc(),
      };
      expect(MessageSchema.safeParse(msg).success).toBe(false);
    });
  });

  describe("Workspace Locks & Path Normalization", () => {
    it("normalizes backslashes and redundant slashes", () => {
      const result = NormalizedWorkspacePathSchema.safeParse("src\\controllers//api.ts");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("src/controllers/api.ts");
      }
    });

    it("rejects path traversal (..) and absolute paths", () => {
      expect(NormalizedWorkspacePathSchema.safeParse("../secret.env").success).toBe(false);
      expect(NormalizedWorkspacePathSchema.safeParse("src/../../secret.env").success).toBe(false);
      expect(NormalizedWorkspacePathSchema.safeParse("/etc/hosts").success).toBe(false);
      expect(NormalizedWorkspacePathSchema.safeParse("C:\\Windows").success).toBe(false);
      expect(NormalizedWorkspacePathSchema.safeParse("foo\0bar").success).toBe(false);
    });

    it("accepts valid ClaimLockInput", () => {
      const input = {
        paths: ["src/api/users.ts", "src/models/user.ts"],
        reason: "Refactoring user auth schema",
        ttl_seconds: 600,
      };
      const parsed = ClaimLockInputSchema.safeParse(input);
      expect(parsed.success).toBe(true);
    });
  });

  describe("Event Envelopes", () => {
    it("validates event envelope with payload_version 1", () => {
      const envelope = {
        event_id: generateId(),
        project_id: generateId(),
        sequence: 1,
        type: "lock.acquired",
        actor_id: "agent-alice",
        occurred_at: nowUtc(),
        payload_version: 1,
        payload: { paths: ["src/index.ts"] },
      };
      expect(EventEnvelopeSchema.safeParse(envelope).success).toBe(true);
    });

    it("rejects invalid payload_version", () => {
      const envelope = {
        event_id: generateId(),
        project_id: generateId(),
        sequence: 1,
        type: "lock.acquired",
        actor_id: "agent-alice",
        occurred_at: nowUtc(),
        payload_version: 2,
        payload: {},
      };
      expect(EventEnvelopeSchema.safeParse(envelope).success).toBe(false);
    });
  });
});
