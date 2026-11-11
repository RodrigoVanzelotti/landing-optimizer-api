import { z } from 'zod';

export const TeamRoleSchema = z.enum(['admin', 'editor', 'viewer']);
export const InviteUserSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  role: TeamRoleSchema.default('viewer'),
});
export type InviteUserDto = z.infer<typeof InviteUserSchema>;
export const ChangeRoleSchema = z.object({ role: TeamRoleSchema });
