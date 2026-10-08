import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("Read-only agent presence", () => {
  it("uses configured idle/lease thresholds without changing stored state or report timestamps", async () => {
    const app = buildApp({ SESSION_IDLE_SECONDS: 10, SESSION_EXPIRE_SECONDS: 30 });
    try {
      const owner = crypto.randomUUID();
      const project = app.ctx.projectService.createProject("Presence", owner).project.project_id;
      const session = app.ctx.sessionService.joinProject(project, "agent", owner);
      const report = app.ctx.statusService.reportStatus(project, "agent", {
        objective: "Declared work",
        progress: "in_progress",
      });
      const token = app.ctx.authService.createToken(owner, "agents-hub");
      const team = () =>
        app.inject({
          method: "GET",
          url: ["/v1/projects", project, "team-status"].join("/"),
          headers: { authorization: ["Bearer", token].join(" ") },
        });
      for (const [seconds, expected] of [
        [1, "active"],
        [15, "idle"],
        [35, "disconnected"],
      ] as const) {
        const seen = new Date(Date.now() - seconds * 1000).toISOString();
        app.ctx.db
          .prepare("UPDATE agent_sessions SET last_seen_at = ? WHERE session_id = ?")
          .run(seen, session.session_id);
        const count = app.ctx.eventBus.getMaxSequence(project);
        const response = await team();
        expect(response.statusCode).toBe(200);
        expect(response.json().data.known_agents).toEqual([
          { agent_id: "agent", status: expected, last_seen_at: seen },
        ]);
        expect(response.json().data.statuses[0].reported_at).toBe(report.reported_at);
        expect(app.ctx.sessionService.getSessionById(session.session_id).status).toBe("active");
        expect(app.ctx.eventBus.getMaxSequence(project)).toBe(count);
      }
      app.ctx.sessionService.disconnect(project, "agent");
      expect((await team()).json().data.known_agents[0].status).toBe("disconnected");
      const rejoined = app.ctx.sessionService.joinProject(project, "agent", owner);
      expect(rejoined.session_id).not.toBe(session.session_id);
      app.ctx.sessionService.heartbeat(project, "agent");
      const after = (await team()).json().data;
      expect(after.known_agents[0].status).toBe("active");
      expect(after.statuses[0]).toEqual(report);
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });
});
