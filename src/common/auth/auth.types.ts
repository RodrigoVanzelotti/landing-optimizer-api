import type { Role } from '@prisma/client';

/** The authenticated principal attached to each control-plane request. */
export interface AuthUser {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  sessionVersion?: number;
}

export interface JwtPayload {
  sub: string;
  tid: string;
  role: Role;
  email: string;
  sv?: number;
}
