import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MessageHistoryPageSchema,
  MessageSchema,
  SendMessageInputSchema,
} from "@agents-hub/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./infrastructure/db/database.js";
import { MIGRATIONS } from "./infrastructure/db/migrations.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
    app.ctx.db.close();
  }
});
function setup() {
  const app = buildApp();
  apps.push(app);
  const owner = crypto.randomUUID();
  const token = app.ctx.authService.createToken(owner, "agents-hub");
  const project = app.ctx.projectService.createProject("Replies", owner).project.project_id;
  const sessions = Object.fromEntries(
    ["alice", "bob", "charlie"].map((name) => [
      name,
      app.ctx.sessionService.joinProject(project, name, owner),
    ]),
  );
  const send = (agent: string, body: Record<string, unknown>, key?: string, credential = token) =>
    app.inject({
      method: "POST",
      url: `/v1/projects/${project}/messages`,
      headers: {
        authorization: `Bearer ${credential}`,
        ...(key ? { "idempotency-key": key } : {}),
      },
      payload: { session_id: sessions[agent]?.session_id, ...body },
    });
  const history = (agent: string, query: string) =>
    app.inject({
      method: "GET",
      url: `/v1/projects/${project}/messages/history?session_id=${sessions[agent]?.session_id}&${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
  return { app, owner, token, project, sessions, send, history };
}

describe("Authorized correlated replies", () => {
  it("infers a private audience, rejects broadcast and outsiders, and narrows descendants", async () => {
    const { send } = setup();
    const parent = (
      await send("alice", {
        body: "Original privado",
        recipient_agent_ids: ["bob", "charlie"],
        correlation_id: "legacy-contract",
      })
    ).json().data;
    for (const recipient_agent_ids of [[], ["outsider"]]) {
      const rejected = await send("bob", {
        body: "No ampliar",
        reply_to_message_id: parent.message_id,
        recipient_agent_ids,
      });
      expect(rejected.statusCode).toBe(422);
    }
    const inferred = MessageSchema.parse(
      (await send("bob", { body: "Reply", reply_to_message_id: parent.message_id })).json().data,
    );
    expect(inferred.recipient_agent_ids).toEqual(["alice", "charlie"]);
    expect(inferred.thread_id).toBe(parent.message_id);
    expect(inferred.correlation_id).toBe("legacy-contract");
    const narrowed = (
      await send("bob", {
        body: "Only Alice",
        reply_to_message_id: inferred.message_id,
        recipient_agent_ids: ["alice"],
      })
    ).json().data;
    const descendant = await send("alice", {
      body: "Try to include Charlie",
      reply_to_message_id: narrowed.message_id,
      recipient_agent_ids: ["bob", "charlie"],
    });
    expect(descendant.statusCode).toBe(422);
    expect(
      (await send("alice", { body: "Continue", reply_to_message_id: narrowed.message_id })).json()
        .data.thread_id,
    ).toBe(parent.message_id);
  });

  it("does not reveal whether a reference is hidden, missing or from another project", async () => {
    const { app, owner, project, token, sessions, send } = setup();
    const hidden = (
      await send("alice", { body: "Secret context", recipient_agent_ids: ["bob"] })
    ).json().data;
    const other = app.ctx.projectService.createProject("Other", owner).project.project_id;
    const foreign = app.ctx.messageService.sendMessage(other, "alice", { body: "Foreign" });
    const failures = [];
    for (const messageId of [hidden.message_id, foreign.message_id, crypto.randomUUID()]) {
      const response = await send("charlie", { body: "Attempt", reply_to_message_id: messageId });
      expect(response.statusCode).toBe(422);
      failures.push(response.json().error.message);
      const lookup = await app.inject({
        method: "GET",
        url: `/v1/projects/${project}/messages/${messageId}?session_id=${sessions.charlie?.session_id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(lookup.statusCode).toBe(422);
      expect(lookup.json().error.message).toBe(failures[0]);
    }
    expect(new Set(failures).size).toBe(1);
    const writeOnly = app.ctx.authService.createToken(owner, "agents-hub", ["messages:write"]);
    expect(
      (
        await send(
          "bob",
          { body: "Missing read scope", reply_to_message_id: hidden.message_id },
          undefined,
          writeOnly,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await send("bob", {
          body: "Different channel",
          channel: "other",
          reply_to_message_id: hidden.message_id,
        })
      ).statusCode,
    ).toBe(422);
  });

  it("paginates a thread with privacy before LIMIT and leaves the inbox checkpoint unchanged", async () => {
    const { app, project, sessions, send, history } = setup();
    const root = (await send("alice", { body: "Public root" })).json().data;
    for (let index = 0; index < 5; index++) {
      const response = await send("alice", {
        body: `Private ${index}`,
        reply_to_message_id: root.message_id,
        recipient_agent_ids: ["bob"],
      });
      expect(response.statusCode).toBe(201);
    }
    const visible = (
      await send("alice", { body: "Visible reply", reply_to_message_id: root.message_id })
    ).json().data;
    // Deterministic timestamps rather than wall-clock ties.
    app.ctx.db
      .prepare("UPDATE messages SET created_at = ? WHERE message_id = ?")
      .run("2026-10-08T10:00:00.000Z", root.message_id);
    app.ctx.db
      .prepare("UPDATE messages SET created_at = ? WHERE message_id = ?")
      .run("2026-10-08T11:00:00.000Z", visible.message_id);
    const before = app.ctx.sessionService.getSessionById(
      sessions.charlie?.session_id ?? "",
    ).last_cursor;
    const first = MessageHistoryPageSchema.parse(
      (await history("charlie", `thread=${root.message_id}&limit=1`)).json().data,
    );
    expect(first.messages.map((message) => message.message_id)).toEqual([visible.message_id]);
    const second = MessageHistoryPageSchema.parse(
      (
        await history("charlie", `thread=${root.message_id}&limit=1&before=${first.next_cursor}`)
      ).json().data,
    );
    expect(second.messages.map((message) => message.message_id)).toEqual([root.message_id]);
    expect(second.has_more).toBe(false);
    expect(
      (await history("charlie", `thread=${crypto.randomUUID()}&before=${first.next_cursor}`))
        .statusCode,
    ).toBe(400);
    expect(
      app.ctx.sessionService.getSessionById(sessions.charlie?.session_id ?? "").last_cursor,
    ).toBe(before);
    expect(
      app.ctx.messageService.getHistory(project, "charlie", undefined, { thread: root.message_id })
        .messages,
    ).toHaveLength(2);
  });

  it("rolls back replies with audit failure and retries once even after parent retention", async () => {
    const { app, send } = setup();
    const root = (await send("alice", { body: "Root", recipient_agent_ids: ["bob"] })).json().data;
    const payload = { body: "Atomic reply", reply_to_message_id: root.message_id };
    const count = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n;
    const max = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n;
    app.ctx.db.exec(
      "CREATE TEMP TRIGGER reject_reply_audit BEFORE INSERT ON audit_entries WHEN NEW.action = 'message.create' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;",
    );
    expect((await send("bob", payload, "reply-retry")).statusCode).toBe(500);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n).toBe(count);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(max);
    app.ctx.db.exec("DROP TRIGGER reject_reply_audit");
    const accepted = (await send("bob", payload, "reply-retry")).json().data;
    app.ctx.db.prepare("DELETE FROM messages WHERE message_id = ?").run(root.message_id);
    const repeated = await send("bob", payload, "reply-retry");
    expect(repeated.statusCode).toBe(201);
    expect(repeated.json().data).toEqual(accepted);
    expect((await send("bob", payload, "new-reply")).statusCode).toBe(422);
    expect((await send("bob", { ...payload, body: "Changed" }, "reply-retry")).statusCode).toBe(
      409,
    );
  });

  it("keeps disconnected recipients eligible but rejects revoked membership", async () => {
    const { app, owner, project, token, send } = setup();
    app.ctx.sessionService.disconnect(project, "bob");
    const team = await app.inject({
      method: "GET",
      url: `/v1/projects/${project}/team-status`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(team.json().data.known_agents).toContainEqual({
      agent_id: "bob",
      status: "disconnected",
    });
    expect(
      (await send("alice", { body: "For offline Bob", recipient_agent_ids: ["bob"] })).statusCode,
    ).toBe(201);
    const revokedUser = crypto.randomUUID();
    app.ctx.db
      .prepare("INSERT INTO users VALUES (?, 'revoked', ?)")
      .run(revokedUser, new Date().toISOString());
    app.ctx.db
      .prepare("INSERT INTO memberships VALUES (?, ?, ?, 'collaborator', ?)")
      .run(crypto.randomUUID(), project, revokedUser, new Date().toISOString());
    app.ctx.sessionService.joinProject(project, "revoked-agent", revokedUser);
    app.ctx.db
      .prepare("DELETE FROM memberships WHERE project_id = ? AND user_id = ?")
      .run(project, revokedUser);
    expect(
      app.ctx.sessionService.getKnownAgents(project).map((agent) => agent.agent_id),
    ).not.toContain("revoked-agent");
    expect(
      (await send("alice", { body: "Cannot deliver", recipient_agent_ids: ["revoked-agent"] }))
        .statusCode,
    ).toBe(422);
    app.ctx.db
      .prepare("UPDATE memberships SET role = 'reader' WHERE project_id = ? AND user_id = ?")
      .run(project, owner);
    expect((await send("alice", { body: "Reader cannot write" })).statusCode).toBe(403);
  });

  it("upgrades schema 6 without reinterpreting legacy correlations and preserves replies on reopen", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agents-hub-replies-"));
    const file = path.join(directory, "upgrade.sqlite");
    const id = crypto.randomUUID();
    const project = crypto.randomUUID();
    const owner = crypto.randomUUID();
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file);
      db.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      for (const migration of MIGRATIONS.filter((item) => item.version <= 6)) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(
          migration.version,
          new Date().toISOString(),
        );
      }
      const date = new Date().toISOString();
      db.prepare("INSERT INTO users VALUES (?, 'owner', ?)").run(owner, date);
      db.prepare("INSERT INTO projects VALUES (?, 'Legacy', ?, ?, ?)").run(
        project,
        owner,
        date,
        date,
      );
      db.prepare(
        "INSERT INTO messages (message_id, project_id, sender_id, recipient_agent_ids, channel, body, priority, correlation_id, created_at) VALUES (?, ?, 'alice', '[]', 'general', 'Legacy', 'normal', 'not-a-message-uuid', ?)",
      ).run(id, project, date);
      db.close();
      db = undefined;
      db = createDatabase(file);
      expect(
        db.prepare("SELECT correlation_id, reply_to_message_id, thread_id FROM messages").get(),
      ).toEqual({
        correlation_id: "not-a-message-uuid",
        reply_to_message_id: null,
        thread_id: null,
      });
      db.prepare(
        "INSERT INTO messages (message_id, project_id, sender_id, recipient_agent_ids, channel, body, priority, created_at, reply_to_message_id, thread_id) VALUES (?, ?, 'bob', '[]', 'general', 'Reply', 'normal', ?, ?, ?)",
      ).run(crypto.randomUUID(), project, date, id, id);
      db.close();
      db = undefined;
      db = createDatabase(file);
      expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?").get(id)?.n).toBe(
        1,
      );
      expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      expect(
        SendMessageInputSchema.safeParse({ body: "Legacy", correlation_id: "anything" }).success,
      ).toBe(true);
      expect(
        SendMessageInputSchema.safeParse({ body: "Invalid", reply_to_message_id: "anything" })
          .success,
      ).toBe(false);
      expect(SendMessageInputSchema.safeParse({ body: "Forged", thread_id: id }).success).toBe(
        false,
      );
    } finally {
      db?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
