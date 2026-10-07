import { z } from "zod";
import { UuidSchema } from "../ids.js";
import { UtcIsoDateSchema } from "../time.js";

export const ProjectSchema = z
  .object({
    project_id: UuidSchema,
    name: z.string().trim().min(1).max(100),
    created_by_user_id: UuidSchema,
    created_at: UtcIsoDateSchema,
    updated_at: UtcIsoDateSchema,
  })
  .strict();

export type Project = z.infer<typeof ProjectSchema>;

export const MembershipRoleSchema = z.enum(["owner", "maintainer", "collaborator", "reader"]);
export type MembershipRole = z.infer<typeof MembershipRoleSchema>;

export const MembershipSchema = z
  .object({
    membership_id: UuidSchema,
    project_id: UuidSchema,
    user_id: UuidSchema,
    role: MembershipRoleSchema,
    created_at: UtcIsoDateSchema,
  })
  .strict();

export type Membership = z.infer<typeof MembershipSchema>;
