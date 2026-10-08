const string = { type: "string" } as const;
const key = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  description: "Reuse this key only to retry the same command",
} as const;
export const tools = [
  {
    name: "join_project",
    description:
      "Join before project tools. Returns persisted confirmed cursor and collaboration rules.",
    properties: {
      project_id: string,
      agent_name: string,
      capabilities: { type: "array", items: string },
    },
    required: ["project_id", "agent_name"],
  },
  {
    name: "check_inbox",
    description:
      "Read visible events. Passing the cursor from a previously consumed page confirms that page before reading the next. Omit cursor to replay from confirmed checkpoint.",
    properties: { cursor: string, limit: { type: "integer", minimum: 1, maximum: 100 } },
    required: [],
  },
  {
    name: "ack_inbox",
    description: "Confirm a page only AFTER consuming its events; use its next_cursor.",
    properties: { cursor: string },
    required: ["cursor"],
  },
  {
    name: "get_inbox_recovery",
    description:
      "After CURSOR_EXPIRED, inspect authorized current state and resume_cursor. Does not acknowledge missing history.",
    properties: {},
    required: [],
  },
  {
    name: "resync_inbox",
    description:
      "After reviewing get_inbox_recovery, explicitly accept deleted history using its resume_cursor. Returns retained events without acknowledging that new page.",
    properties: { cursor: string, accept_history_gap: { type: "boolean", const: true } },
    required: ["cursor", "accept_history_gap"],
  },
  {
    name: "wait_for_messages",
    description:
      "Wait during an active session, cancellable and limited to 60 seconds. Same cursor confirmation contract as check_inbox.",
    properties: { cursor: string, timeout_seconds: { type: "integer", minimum: 1, maximum: 60 } },
    required: [],
  },
  {
    name: "send_team_message",
    description: "Send structured coordination, without credentials or private reasoning.",
    properties: {
      body: { type: "string", minLength: 1, maxLength: 4096 },
      channel: string,
      recipient_agent_ids: { type: "array", items: string },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      correlation_id: string,
      idempotency_key: key,
    },
    required: ["body"],
  },
  {
    name: "report_status",
    description: "Publish objective, progress, decision and blockers as a human summary.",
    properties: {
      objective: string,
      progress: { type: "string", enum: ["started", "in_progress", "blocked", "completed"] },
      decision: string,
      blocked_by: string,
      next_step: string,
      idempotency_key: key,
    },
    required: ["objective"],
  },
  {
    name: "claim_module_lock",
    description:
      "Claim relative paths with TTL. Key is generated once per call if omitted for compatibility; pass a stable key to retry a tool call.",
    properties: {
      paths: { type: "array", items: string },
      reason: string,
      ttl_seconds: { type: "integer", minimum: 1, maximum: 3600 },
      idempotency_key: key,
    },
    required: ["paths", "reason"],
  },
  {
    name: "release_module_lock",
    description: "Release a lock by lock_id. Legacy paths are accepted for existing clients.",
    properties: { lock_id: string, paths: { type: "array", items: string } },
    required: [],
  },
  {
    name: "get_team_status",
    description: "Read agents, status and active locks after joining.",
    properties: {},
    required: [],
  },
];
