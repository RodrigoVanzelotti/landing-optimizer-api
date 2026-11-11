import { z } from 'zod';
import { InviteUserSchema } from '../team/team.dto';

export const CreateTenantSchema = InviteUserSchema.pick({ name: true, email: true }).extend({ tenantName: z.string().trim().min(1).max(120) });
export type CreateTenantDto = z.infer<typeof CreateTenantSchema>;
export const ArchiveTenantSchema = z.object({ confirmation: z.string().min(1).max(120) });
