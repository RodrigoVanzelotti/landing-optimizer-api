import { z } from 'zod';

export const CreateSiteSchema = z.object({
  name: z.string().min(1).max(120),
  primaryDomain: z
    .string()
    .min(3)
    .max(255)
    .regex(/^[a-z0-9.-]+(:\d+)?$/i, 'must be a bare host, e.g. example.com'),
});
export type CreateSiteDto = z.infer<typeof CreateSiteSchema>;

export const UpdateSiteSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  samplingRate: z.number().min(0).max(1).optional(),
  status: z.enum(['active', 'paused']).optional(),
  settings: z.record(z.unknown()).optional(),
});
export type UpdateSiteDto = z.infer<typeof UpdateSiteSchema>;

export const AddOriginSchema = z.object({
  origin: z
    .string()
    .url()
    .max(255)
    .refine((v) => {
      try {
        const u = new URL(v);
        return u.pathname === '/' || u.pathname === '';
      } catch {
        return false;
      }
    }, 'must be a bare origin, e.g. https://example.com'),
});
export type AddOriginDto = z.infer<typeof AddOriginSchema>;
