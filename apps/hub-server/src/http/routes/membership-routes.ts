import {
  AcceptInvitationInputSchema,
  AppError,
  ChangeMemberInputSchema,
  UuidSchema,
} from "@agents-hub/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../../app.js";
import type { AuthContext } from "../auth/auth-service.js";

export function registerMembershipRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  user: (req: FastifyRequest, scope?: string) => string,
  auth: (req: FastifyRequest) => AuthContext,
) {
  const params = (req: FastifyRequest) =>
    req.params as { projectId: string; invitationId: string; userId: string };
  const requestId = (reqId: unknown) => String(reqId);

  app.post("/v1/projects/:projectId/invitations", async (req, reply) => {
    const actor = user(req, "members:write");
    return reply.code(201).send({
      data: ctx.membershipService.createInvitation(
        actor,
        params(req).projectId,
        req.body,
        requestId(reply.getHeader("x-request-id")),
      ),
      request_id: reply.getHeader("x-request-id"),
    });
  });
  app.get("/v1/projects/:projectId/invitations", async (req, reply) => ({
    data: ctx.membershipService.listInvitations(user(req, "members:read"), params(req).projectId),
    request_id: reply.getHeader("x-request-id"),
  }));
  app.delete("/v1/projects/:projectId/invitations/:invitationId", async (req, reply) => {
    const actor = user(req, "members:write");
    const p = params(req);
    ctx.membershipService.revokeInvitation(
      actor,
      p.projectId,
      p.invitationId,
      requestId(reply.getHeader("x-request-id")),
    );
    return { data: { revoked: true }, request_id: reply.getHeader("x-request-id") };
  });
  app.post("/v1/projects/:projectId/invitations/accept", async (req, reply) => {
    const actor = user(req, "projects:read");
    const p = params(req);
    const parsed = AcceptInvitationInputSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("INVALID_INPUT", "Invalid invitation token");
    try {
      return {
        data: ctx.membershipService.acceptInvitation(
          actor,
          p.projectId,
          parsed.data.token,
          requestId(reply.getHeader("x-request-id")),
        ),
        request_id: reply.getHeader("x-request-id"),
      };
    } catch (error) {
      ctx.auditService.logAction(
        actor,
        "invitation.accept",
        "invitation",
        "failure",
        requestId(reply.getHeader("x-request-id")),
        p.projectId,
      );
      throw error;
    }
  });
  app.get("/v1/projects/:projectId/members", async (req, reply) => ({
    data: ctx.membershipService.listMembers(user(req, "members:read"), params(req).projectId),
    request_id: reply.getHeader("x-request-id"),
  }));
  app.patch("/v1/projects/:projectId/members/:userId", async (req, reply) => {
    const actor = user(req, "members:write");
    const parsed = ChangeMemberInputSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("INVALID_INPUT", "Invalid membership role");
    const p = params(req);
    const result = ctx.membershipService.changeMember(
      actor,
      p.projectId,
      p.userId,
      parsed.data.role,
      requestId(reply.getHeader("x-request-id")),
    );
    ctx.wsHub.revalidate();
    return { data: result, request_id: reply.getHeader("x-request-id") };
  });
  app.delete("/v1/projects/:projectId/members/:userId", async (req, reply) => {
    const actor = user(req, "members:write");
    const p = params(req);
    const result = ctx.membershipService.changeMember(
      actor,
      p.projectId,
      p.userId,
      null,
      requestId(reply.getHeader("x-request-id")),
    );
    ctx.wsHub.revalidate();
    return { data: result, request_id: reply.getHeader("x-request-id") };
  });
  app.post("/v1/projects/:projectId/ownership", async (req, reply) => {
    const actor = user(req, "members:write");
    const target = (req.body as { user_id?: unknown })?.user_id;
    if (!UuidSchema.safeParse(target).success)
      throw new AppError("INVALID_INPUT", "Invalid target user ID");
    return {
      data: ctx.membershipService.transferOwnership(
        actor,
        params(req).projectId,
        String(target),
        requestId(reply.getHeader("x-request-id")),
      ),
      request_id: reply.getHeader("x-request-id"),
    };
  });
  const tokenProject = (req: FastifyRequest) => auth(req).projectId;
  app.get("/v1/tokens", async (req, reply) => {
    const actor = user(req);
    const project = tokenProject(req);
    const query =
      "SELECT token_id, project_id, scopes, expires_at, revoked_at FROM auth_tokens WHERE subject = ?";
    return {
      data: project
        ? ctx.db.prepare(`${query} AND project_id = ?`).all(actor, project)
        : ctx.db.prepare(query).all(actor),
      request_id: reply.getHeader("x-request-id"),
    };
  });
  app.delete("/v1/tokens/:tokenId", async (req, reply) => {
    const actor = user(req);
    const tokenId = (req.params as { tokenId: string }).tokenId;
    const project = tokenProject(req);
    if (
      project &&
      !ctx.db
        .prepare("SELECT 1 FROM auth_tokens WHERE token_id = ? AND subject = ? AND project_id = ?")
        .get(tokenId, actor, project)
    )
      throw new AppError("FORBIDDEN", "Token is bound to another project");
    if (!ctx.authService.revokeToken(tokenId, actor))
      throw new AppError("FORBIDDEN", "Cannot revoke this token");
    ctx.auditService.logAction(
      actor,
      "token.revoke",
      tokenId,
      "success",
      requestId(reply.getHeader("x-request-id")),
    );
    ctx.wsHub.revalidate();
    return { data: { revoked: true }, request_id: reply.getHeader("x-request-id") };
  });
}
