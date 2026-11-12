import { z } from 'zod';

export const RegisterSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  password: z.string().min(10).max(200),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().trim().min(1).max(120),
});
export type RegisterDto = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(200),
  rememberMe: z.boolean().default(false),
});
export type LoginDto = z.infer<typeof LoginSchema>;

export const ResetPasswordSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  password: z.string().min(10).max(200),
});
