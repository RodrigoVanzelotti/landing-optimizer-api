import { z } from 'zod';

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(200),
  tenantName: z.string().min(1).max(120),
  name: z.string().max(120).optional(),
});
export type RegisterDto = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type LoginDto = z.infer<typeof LoginSchema>;
