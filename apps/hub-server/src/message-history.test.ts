import { MessageHistoryPageSchema, encodeCursor } from "@agents-hub/shared";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("Authorized message history", () => {
  it("filters private messages before pagination and never advances the inbox checkpoint", async () => {
    const app = buildApp();
    try {
      const owner = crypto.randomUUID();
      const token = app.ctx.authService.createToken(owner, "agents-hub");
      const project = app.ctx.projectService.createProject("History", owner).project.project_id;
      app.ctx.sessionService.joinProject(project, "alice", owner);
      app.ctx.sessionService.joinProject(project, "bob", owner);
      const charlie = app.ctx.sessionService.joinProject(project, "charlie", owner);
      const checkpointBeforeHistory = app.ctx.db
        .prepare("SELECT last_cursor, last_sequence FROM agent_sessions WHERE session_id = ?")
        .get(charlie.session_id);

      const oldVisible = app.ctx.messageService.sendMessage(project, "alice", {
        body: "Visible before private traffic",
        channel: "general",
      });
      app.ctx.db
        .prepare("UPDATE messages SET created_at = ? WHERE message_id = ?")
        .run("2026-10-08T10:00:00.000Z", oldVisible.message_id);
      for (let index = 0; index < 6; index++) {
        const hidden = app.ctx.messageService.sendMessage(project, "alice", {
          body: `Private ${index}`,
          channel: "general",
          recipient_agent_ids: ["bob"],
        });
        app.ctx.db
          .prepare("UPDATE messages SET created_at = ? WHERE message_id = ?")
          .run(`2026-10-08T10:00:${10 + index}.000Z`, hidden.message_id);
      }
      const newVisible = app.ctx.messageService.sendMessage(project, "alice", {
        body: "Visible after private traffic",
        channel: "general",
        recipient_agent_ids: ["charlie"],
      });
      app.ctx.db
        .prepare("UPDATE messages SET created_at = ? WHERE message_id = ?")
        .run("2026-10-08T10:00:09.000Z", newVisible.message_id);

      const first = await app.inject({
        method: "GET",
        url: `/v1/projects/${project}/messages/history?session_id=${charlie.session_id}&limit=1`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(first.statusCode).toBe(200);
      const firstPage = MessageHistoryPageSchema.parse(first.json().data);
      expect(firstPage.messages.map((message) => message.message_id)).toEqual([
        newVisible.message_id,
      ]);
      expect(firstPage.has_more).toBe(true);
      expect(firstPage.next_cursor).not.toBeNull();

      const second = await app.inject({
        method: "GET",
        url: `/v1/projects/${project}/messages/history?session_id=${charlie.session_id}&limit=1&before=${encodeURIComponent(firstPage.next_cursor as string)}`,
        headers: { authorization: `Bearer ${token}` },
      });
      const secondPage = MessageHistoryPageSchema.parse(second.json().data);
      expect(secondPage.messages.map((message) => message.message_id)).toEqual([
        oldVisible.message_id,
      ]);
      expect(secondPage.has_more).toBe(false);
      expect(secondPage.next_cursor).toBeNull();
      expect(
        app.ctx.db
          .prepare("SELECT last_cursor, last_sequence FROM agent_sessions WHERE session_id = ?")
          .get(charlie.session_id),
      ).toEqual(checkpointBeforeHistory);
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });

  it("uses a stable tie-breaker while messages arrive and rejects invalid or foreign cursors", async () => {
    const app = buildApp();
    try {
      const owner = crypto.randomUUID();
      const token = app.ctx.authService.createToken(owner, "agents-hub");
      const project = app.ctx.projectService.createProject("Stable history", owner).project
        .project_id;
      const reader = app.ctx.sessionService.joinProject(project, "reader", owner);
      const ids: string[] = [];
      for (let index = 0; index < 4; index++) {
        const message = app.ctx.messageService.sendMessage(project, "writer", {
          body: `Message ${index}`,
          channel: "general",
        });
        ids.push(message.message_id);
        app.ctx.db
          .prepare("UPDATE messages SET created_at = ? WHERE message_id = ?")
          .run("2026-10-08T11:00:00.000Z", message.message_id);
      }
      const expected = [...ids].sort().reverse();
      const first = MessageHistoryPageSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/v1/projects/${project}/messages/history?session_id=${reader.session_id}&limit=2`,
            headers: { authorization: `Bearer ${token}` },
          })
        ).json().data,
      );
      expect(first.messages.map((message) => message.message_id)).toEqual(expected.slice(0, 2));

      const incoming = app.ctx.messageService.sendMessage(project, "writer", {
        body: "Arrived during pagination",
        channel: "general",
      });
      app.ctx.db
        .prepare("UPDATE messages SET created_at = ? WHERE message_id = ?")
        .run("2026-10-08T12:00:00.000Z", incoming.message_id);
      const second = MessageHistoryPageSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/v1/projects/${project}/messages/history?session_id=${reader.session_id}&limit=2&before=${encodeURIComponent(first.next_cursor as string)}`,
            headers: { authorization: `Bearer ${token}` },
          })
        ).json().data,
      );
      expect(second.messages.map((message) => message.message_id)).toEqual(expected.slice(2));
      expect(second.messages.some((message) => message.message_id === incoming.message_id)).toBe(
        false,
      );

      for (const cursor of ["not-a-history-cursor", encodeCursor(1)]) {
        const invalid = await app.inject({
          method: "GET",
          url: `/v1/projects/${project}/messages/history?session_id=${reader.session_id}&before=${encodeURIComponent(cursor)}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json().error.code).toBe("CURSOR_INVALID");
      }

      const otherProject = app.ctx.projectService.createProject("Other", owner).project.project_id;
      const foreignSession = app.ctx.sessionService.joinProject(otherProject, "reader", owner);
      const foreign = await app.inject({
        method: "GET",
        url: `/v1/projects/${project}/messages/history?session_id=${foreignSession.session_id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(foreign.statusCode).not.toBe(200);

      const writeOnly = app.ctx.authService.createToken(owner, "agents-hub", ["messages:write"]);
      const forbidden = await app.inject({
        method: "GET",
        url: `/v1/projects/${project}/messages/history?session_id=${reader.session_id}`,
        headers: { authorization: `Bearer ${writeOnly}` },
      });
      expect(forbidden.statusCode).toBe(403);
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });

  it("combines literal filters before pagination without revealing private matches", async () => {
    const app = buildApp();
    try {
      const owner = crypto.randomUUID();
      const token = app.ctx.authService.createToken(owner, "agents-hub");
      const project = app.ctx.projectService.createProject("Filtered history", owner).project
        .project_id;
      app.ctx.sessionService.joinProject(project, "alice", owner);
      app.ctx.sessionService.joinProject(project, "bob", owner);
      const charlie = app.ctx.sessionService.joinProject(project, "charlie", owner);
      const add = (
        sender: string,
        body: string,
        channel: string,
        createdAt: string,
        recipients: string[] = [],
      ) => {
        const message = app.ctx.messageService.sendMessage(project, sender, {
          body,
          channel,
          recipient_agent_ids: recipients,
        });
        app.ctx.db
          .prepare("UPDATE messages SET created_at = ? WHERE message_id = ?")
          .run(createdAt, message.message_id);
        return message;
      };
      const literal = add(
        "alice",
        "Deploy 100%_safe release",
        "releases",
        "2026-10-08T10:00:00.000Z",
      );
      const visible = add(
        "alice",
        "Needle implementation plan",
        "plans",
        "2026-10-08T11:00:00.000Z",
        ["charlie"],
      );
      add("alice", "Needle private for Bob", "plans", "2026-10-08T12:00:00.000Z", ["bob"]);
      add("charlie", "Needle public follow-up", "plans", "2026-10-08T11:30:00.000Z");

      const get = async (filters: Record<string, string>) => {
        const params = new URLSearchParams({ session_id: charlie.session_id, ...filters });
        return app.inject({
          method: "GET",
          url: `/v1/projects/${project}/messages/history?${params.toString()}`,
          headers: { authorization: `Bearer ${token}` },
        });
      };
      const combined = MessageHistoryPageSchema.parse(
        (
          await get({
            text: "needle",
            channel: "plans",
            sender: "alice",
            recipient: "charlie",
            from: "2026-10-08T10:30:00.000Z",
            to: "2026-10-08T11:30:00.000Z",
          })
        ).json().data,
      );
      expect(combined.messages.map((message) => message.message_id)).toEqual([visible.message_id]);
      expect(combined.has_more).toBe(false);

      const literalResult = MessageHistoryPageSchema.parse(
        (await get({ text: "%_safe" })).json().data,
      );
      expect(literalResult.messages.map((message) => message.message_id)).toEqual([
        literal.message_id,
      ]);
      const hiddenOnly = MessageHistoryPageSchema.parse(
        (await get({ text: "private for bob", recipient: "bob" })).json().data,
      );
      expect(hiddenOnly).toEqual({ messages: [], next_cursor: null, has_more: false });

      const first = MessageHistoryPageSchema.parse(
        (await get({ text: "needle", limit: "1" })).json().data,
      );
      expect(first.has_more).toBe(true);
      const mismatched = await get({
        text: "release",
        before: first.next_cursor as string,
      });
      expect(mismatched.statusCode).toBe(400);
      expect(mismatched.json().error.code).toBe("CURSOR_INVALID");

      const invalidRange = await get({
        from: "2026-10-08T12:00:00.000Z",
        to: "2026-10-08T11:00:00.000Z",
      });
      expect(invalidRange.statusCode).toBe(422);
      expect(invalidRange.json().error.code).toBe("INVALID_INPUT");
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });
});
