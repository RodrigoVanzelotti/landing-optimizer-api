import type { Role } from '@prisma/client';

/** The authenticated principal attached to each control-plane request. */
export interface AuthUser {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  sessionVersion?: number;
  customerName?: string;
}

export interface CustomerScope {
  typ: 'customer-scope';
  sub: string;
  tid: string;
  home: string;
  sv: number;
}

export interface JwtPayload {
  sub: string;
  tid: string;
  role: Role;
  email: string;
  sv?: number;
}
