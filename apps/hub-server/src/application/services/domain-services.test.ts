import type { DatabaseSync } from "node:sqlite";
import { AppError } from "@agents-hub/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../infrastructure/db/database.js";
import { SqliteEventBus } from "../../infrastructure/event-bus/event-bus.js";
import { LockService } from "./lock-service.js";
import { MessageService } from "./message-service.js";
import { ProjectService } from "./project-service.js";
import { SessionService } from "./session-service.js";
import { StatusService } from "./status-service.js";
import { WsTicketService } from "./ws-ticket-service.js";

describe("Hub Server Domain Services (Phase 2)", () => {
  let db: DatabaseSync;
  let eventBus: SqliteEventBus;
  let projectService: ProjectService;
  let sessionService: SessionService;
  let messageService: MessageService;
  let statusService: StatusService;
  let lockService: LockService;

  beforeEach(() => {
    db = createDatabase(":memory:");
    eventBus = new SqliteEventBus(db);
    projectService = new ProjectService(db, eventBus);
    sessionService = new SessionService(db, eventBus);
    messageService = new MessageService(db, eventBus);
    statusService = new StatusService(db, eventBus);
    lockService = new LockService(db, eventBus);
  });

  describe("Projects & Memberships", () => {
    it("creates project, assigns owner role, and emits project.created event", () => {
      const { project, membership } = projectService.createProject("Core App", "user-123", "alice");
      expect(project.name).toBe("Core App");
      expect(membership.role).toBe("owner");

      const fetched = projectService.getProject(project.project_id);
      expect(fetched.project_id).toBe(project.project_id);

      const events = eventBus.getEventsAfter(project.project_id, 0);
      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe("project.created");
    });

    it("throws PROJECT_NOT_FOUND for non-existent project", () => {
      expect(() => projectService.getProject("fake-uuid")).toThrow(AppError);
    });
  });

  describe("Sessions & Presence", () => {
    it("manages agent joining, heartbeats, cursor update and disconnect", () => {
      const { project } = projectService.createProject("Agents Room", "u-1");
      const session = sessionService.joinProject(project.project_id, "agent-alice", "u-1");
      expect(session.status).toBe("active");

      sessionService.heartbeat(project.project_id, "agent-alice");
      sessionService.updateCursor(project.project_id, "agent-alice", "cursor-10");

      const active = sessionService.getActiveSessions(project.project_id);
      expect(active.length).toBe(1);
      expect(active[0]?.last_cursor).toBe("cursor-10");

      sessionService.disconnect(project.project_id, "agent-alice");
      expect(sessionService.getActiveSessions(project.project_id).length).toBe(0);
    });
  });

  describe("Messages & Target Routing", () => {
    it("sends message and records event transactionally", () => {
      const { project } = projectService.createProject("Chat Room", "u-1");
      const msg = messageService.sendMessage(project.project_id, "agent-alice", {
        body: "Hello Bob!",
        recipient_agent_ids: ["agent-bob"],
        channel: "general",
        priority: "normal",
      });

      expect(msg.body).toBe("Hello Bob!");
      expect(msg.recipient_agent_ids).toEqual(["agent-bob"]);

      // Bob can see it
      const forBob = messageService.getMessages(project.project_id, "agent-bob");
      expect(forBob.length).toBe(1);

      // Charlie cannot see targeted message between Alice and Bob
      const forCharlie = messageService.getMessages(project.project_id, "agent-charlie");
      expect(forCharlie.length).toBe(0);

      // Events recorded
      const events = eventBus.getEventsAfter(project.project_id, 0);
      expect(events.some((e) => e.type === "message.created")).toBe(true);
    });
  });

  describe("Status Reports", () => {
    it("publishes status and retrieves latest status per agent", () => {
      const { project } = projectService.createProject("Status Room", "u-1");
      statusService.reportStatus(project.project_id, "agent-alice", {
        objective: "Build Auth API",
        progress: "in_progress",
        decision: "Use JWT tokens",
      });

      statusService.reportStatus(project.project_id, "agent-alice", {
        objective: "Build Auth API",
        progress: "completed",
        decision: "JWT tokens with 15m expiration",
      });

      const latest = statusService.getLatestStatuses(project.project_id);
      expect(latest.length).toBe(1);
      expect(latest[0]?.progress).toBe("completed");
      expect(latest[0]?.decision).toBe("JWT tokens with 15m expiration");
    });
  });

  describe("Workspace Locks (Concurrency & Prefix Rules)", () => {
    it("claims and releases locks cleanly", () => {
      const { project } = projectService.createProject("Lock Room", "u-1");
      const lock = lockService.claimLock(project.project_id, "agent-alice", {
        paths: ["src/api/users.ts"],
        reason: "Refactor users controller",
      });
      expect(lock.paths).toEqual(["src/api/users.ts"]);

      const active = lockService.getActiveLocks(project.project_id);
      expect(active.length).toBe(1);

      const released = lockService.releaseLock(project.project_id, "agent-alice", [
        "src/api/users.ts",
      ]);
      expect(released).toEqual(["src/api/users.ts"]);
      expect(lockService.getActiveLocks(project.project_id).length).toBe(0);
    });

    it("prevents conflict when another agent claims exact same file", () => {
      const { project } = projectService.createProject("Lock Conflict", "u-1");
      lockService.claimLock(project.project_id, "agent-alice", {
        paths: ["src/api/users.ts"],
        reason: "Alice working",
      });

      expect(() => {
        lockService.claimLock(project.project_id, "agent-bob", {
          paths: ["src/api/users.ts"],
          reason: "Bob trying to edit",
        });
      }).toThrowError(/LOCK_CONFLICT/);
    });

    it("prevents conflict when path is a parent directory (prefix conflict)", () => {
      const { project } = projectService.createProject("Prefix Conflict", "u-1");
      lockService.claimLock(project.project_id, "agent-alice", {
        paths: ["src/api"],
        reason: "Alice locking whole API dir",
      });

      expect(() => {
        lockService.claimLock(project.project_id, "agent-bob", {
          paths: ["src/api/users.ts"],
          reason: "Bob trying to edit subfile",
        });
      }).toThrowError(/LOCK_CONFLICT/);
    });

    it("prevents non-owner from releasing another agent's lock", () => {
      const { project } = projectService.createProject("Lock Ownership", "u-1");
      lockService.claimLock(project.project_id, "agent-alice", {
        paths: ["src/api/users.ts"],
        reason: "Alice lock",
      });

      expect(() => {
        lockService.releaseLock(project.project_id, "agent-bob", ["src/api/users.ts"]);
      }).toThrowError(/LOCK_NOT_OWNER/);
    });
  });

  describe("Project Isolation", () => {
    it("isolates data completely between two different projects", () => {
      const proj1 = projectService.createProject("Project Alpha", "u-1").project;
      const proj2 = projectService.createProject("Project Beta", "u-2").project;

      lockService.claimLock(proj1.project_id, "agent-1", {
        paths: ["shared.ts"],
        reason: "Lock in Alpha",
      });

      // Agent in Beta can lock same path 'shared.ts' without conflict
      expect(() => {
        lockService.claimLock(proj2.project_id, "agent-2", {
          paths: ["shared.ts"],
          reason: "Lock in Beta",
        });
      }).not.toThrow();

      expect(lockService.getActiveLocks(proj1.project_id).length).toBe(1);
      expect(lockService.getActiveLocks(proj2.project_id).length).toBe(1);
    });
  });

  describe("WsTicketService (Ephemeral WebSocket Tickets)", () => {
    let wsTicketService: WsTicketService;
    let testUserId: string;
    let testProjectId: string;
    let testSessionId: string;

    beforeEach(() => {
      wsTicketService = new WsTicketService(db);
      testUserId = "user-ticket-tester";
      db.prepare("INSERT INTO users (user_id, username, created_at) VALUES (?, ?, ?)").run(
        testUserId,
        "ticket-user",
        new Date().toISOString(),
      );

      const proj = projectService.createProject("Ticket Room", testUserId).project;
      testProjectId = proj.project_id;

      const session = sessionService.joinProject(testProjectId, "ag-ticket", testUserId);
      testSessionId = session.session_id;
    });

    it("rejects an expired ticket", () => {
      // 1. Ticket expirado
      const rawTicket = wsTicketService.createTicket(testUserId, testProjectId, testSessionId, -5);
      expect(() =>
        wsTicketService.consumeTicket(rawTicket, testProjectId, testSessionId),
      ).toThrowError(/UNAUTHENTICATED/);
    });

    it("ensures exactly one consumer succeeds when two consume attempts happen concurrently", async () => {
      // 2. Dos consumos simultáneos del mismo ticket: exactamente uno debe tener éxito
      const rawTicket = wsTicketService.createTicket(testUserId, testProjectId, testSessionId, 30);

      const results = await Promise.allSettled([
        Promise.resolve().then(() =>
          wsTicketService.consumeTicket(rawTicket, testProjectId, testSessionId),
        ),
        Promise.resolve().then(() =>
          wsTicketService.consumeTicket(rawTicket, testProjectId, testSessionId),
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      if (fulfilled[0]?.status === "fulfilled") {
        expect(fulfilled[0].value).toEqual({
          userId: testUserId,
          projectId: testProjectId,
          sessionId: testSessionId,
        });
      }
      if (rejected[0]?.status === "rejected") {
        expect(rejected[0].reason).toBeInstanceOf(AppError);
        expect((rejected[0].reason as AppError).code).toBe("UNAUTHENTICATED");
      }
    });

    it("rejects a valid ticket when expected project_id does not match", () => {
      // 3. Ticket válido con project_id incorrecto
      const rawTicket = wsTicketService.createTicket(testUserId, testProjectId, testSessionId, 30);
      expect(() =>
        wsTicketService.consumeTicket(rawTicket, "proj-different", testSessionId),
      ).toThrowError(/FORBIDDEN/);
    });

    it("rejects a valid ticket when expected session_id does not match", () => {
      // 4. Ticket válido con session_id incorrecto
      const rawTicket = wsTicketService.createTicket(testUserId, testProjectId, testSessionId, 30);
      expect(() =>
        wsTicketService.consumeTicket(rawTicket, testProjectId, "sess-different"),
      ).toThrowError(/FORBIDDEN/);
    });
  });
});
