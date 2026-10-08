import { encodeCursor } from "@agents-hub/shared";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("MVP closeout regressions", () => {
  it("prevents a teammate from joining, heartbeating or disconnecting another user's agent", async () => {
    const app = buildApp();
    try {
      const project = app.ctx.projectService.createProject("Shared", "alice").project;
      app.ctx.db
        .prepare("INSERT INTO users VALUES (?, ?, ?)")
        .run("bob", "bob", new Date().toISOString());
      app.ctx.db
        .prepare("INSERT INTO memberships VALUES (?, ?, ?, ?, ?)")
        .run(
          crypto.randomUUID(),
          project.project_id,
          "bob",
          "collaborator",
          new Date().toISOString(),
        );
      const session = app.ctx.sessionService.joinProject(
        project.project_id,
        "alice-agent",
        "alice",
      );
      const token = app.ctx.authService.createToken("bob", "agents-hub");
      const headers = { authorization: `Bearer ${token}` };
      const join = await app.inject({
        method: "POST",
        url: `/v1/projects/${project.project_id}/sessions`,
        headers,
        payload: { agent_id: "alice-agent" },
      });
      expect(join.statusCode).toBe(403);
      for (const method of ["POST", "DELETE"] as const) {
        const result = await app.inject({
          method,
          url: `/v1/sessions/${session.session_id}${method === "POST" ? "/heartbeat" : ""}`,
          headers,
          payload: { project_id: project.project_id, agent_id: session.agent_id },
        });
        expect(result.statusCode).toBe(403);
      }
      expect(app.ctx.sessionService.getSessionById(session.session_id).status).toBe("active");
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });

  it("denies reader writes even with a wildcard token", async () => {
    const app = buildApp();
    try {
      const project = app.ctx.projectService.createProject("Read only", "reader").project;
      const session = app.ctx.sessionService.joinProject(project.project_id, "observer", "reader");
      app.ctx.db
        .prepare("UPDATE memberships SET role = 'reader' WHERE project_id = ?")
        .run(project.project_id);
      const token = app.ctx.authService.createToken("reader", "agents-hub");
      const result = await app.inject({
        method: "POST",
        url: `/v1/projects/${project.project_id}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { session_id: session.session_id, body: "Forbidden write" },
      });
      expect(result.statusCode).toBe(403);
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });

  it("finds visible messages beyond a full batch of private messages", async () => {
    const app = buildApp();
    try {
      const project = app.ctx.projectService.createProject("Visibility", "owner").project;
      for (const agent of ["alice", "bob", "charlie"])
        app.ctx.sessionService.joinProject(project.project_id, agent, "owner");
      const charlie = app.ctx.sessionService
        .getActiveSessions(project.project_id)
        .find((s) => s.agent_id === "charlie");
      const after = app.ctx.eventBus.getMaxSequence(project.project_id);
      for (let i = 0; i < 210; i++)
        app.ctx.messageService.sendMessage(project.project_id, "alice", {
          body: "Private",
          channel: "general",
          priority: "normal",
          recipient_agent_ids: ["bob"],
        });
      app.ctx.messageService.sendMessage(project.project_id, "alice", {
        body: "Visible after private batch",
        channel: "general",
        priority: "normal",
      });
      const token = app.ctx.authService.createToken("owner", "agents-hub");
      const result = await app.inject({
        method: "GET",
        url: `/v1/projects/${project.project_id}/inbox?session_id=${charlie?.session_id}&after=${encodeCursor(after)}&limit=1`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().data.events).toHaveLength(1);
      expect(JSON.stringify(result.json().data.events)).toContain("Visible after private batch");
      expect(result.json().data.has_more).toBe(false);
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });
});
