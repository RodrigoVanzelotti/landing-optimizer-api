import { SetMetadata } from '@nestjs/common';
import type { Role } from '@prisma/client';

export const ROLES_KEY = 'requiredRole';
/** Require at least the given role (owner > admin > editor > viewer). */
export const Roles = (role: Role): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, role);
