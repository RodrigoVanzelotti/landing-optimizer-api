import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { newId } from '../../common/crypto/ids';
import { InviteUserSchema, type InviteUserDto } from './team.dto';
import { newInvitation } from './invitation';
import { ConflictException } from '@nestjs/common';
import { writeAudit } from '../../common/audit/audit.module';

export async function provisionTenant(prisma: PrismaClient, tenantName: string, input: InviteUserDto, origin: string, actorUserId?: string) {
  return prisma.$transaction(async (tx) => {
    if (await tx.user.findFirst({ where: { email: { equals: input.email, mode: 'insensitive' } } })) throw new ConflictException('This email already has an account');
    const tenantId = newId();
    await tx.tenant.create({ data: { id: tenantId, name: tenantName, slug: `tenant-${tenantId}` } });
    const invitation = newInvitation(tenantId, { ...input, role: 'admin' }, origin);
    await tx.teamInvitation.create({ data: invitation.data });
    await writeAudit(tx, { tenantId, actorUserId, action: 'tenant.created', targetType: 'tenant', targetId: tenantId });
    await writeAudit(tx, { tenantId, actorUserId, action: 'team.invited', targetType: 'team_invitation', targetId: invitation.data.id, metadata: { role: 'admin' } });
    return { tenantId, invitationUrl: invitation.url, expiresAt: invitation.data.expiresAt };
  });
}

/** Operator CLI fallback; platform management reuses provisionTenant. */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    tenant: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, 'dashboard-url': { type: 'string' },
  } });
  const tenantName = z.string().trim().min(1).max(120).parse(values.tenant);
  const input = InviteUserSchema.parse({ name: values.name, email: values.email, role: 'admin' });
  const origin = z.string().url().parse(values['dashboard-url'] ?? process.env.DASHBOARD_ORIGIN);
  const parsedOrigin = new URL(origin);
  if (!['https:', 'http:'].includes(parsedOrigin.protocol) || parsedOrigin.username || parsedOrigin.password) throw new Error('Expected an HTTP(S) dashboard URL');
  const prisma = new PrismaClient();
  try {
    const result = await provisionTenant(prisma, tenantName, input, origin);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Tenant provisioning failed');
  process.exitCode = 1;
});
