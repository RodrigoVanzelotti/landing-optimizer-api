import { createHash, randomBytes } from 'node:crypto';
import { newId } from '../../common/crypto/ids';
import type { InviteUserDto } from './team.dto';

export const USER_LIMIT = 10;
export const ADMIN_LIMIT = 3;
export const isAdmin = (role: string): boolean => role === 'admin' || role === 'owner';
export const emailDomain = (email: string): string => email.trim().toLowerCase().split('@')[1] ?? '';
export const hashInvitationToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function newInvitation(tenantId: string, input: InviteUserDto, dashboardOrigin: string, invitedByUserId?: string) {
  const token = randomBytes(32).toString('hex');
  const data = {
    id: newId(), tenantId, ...input, tokenHash: hashInvitationToken(token),
    invitedByUserId: invitedByUserId ?? null,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };
  const url = new URL('/invite', dashboardOrigin);
  url.search = new URLSearchParams({ name: input.name, email: input.email }).toString();
  // A fragment keeps the one-use credential out of HTTP access logs and referrers.
  url.hash = token;
  return { data, url: url.toString() };
}
