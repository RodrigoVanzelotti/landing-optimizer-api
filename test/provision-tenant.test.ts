import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { provisionTenant } from '../src/modules/team/provision-tenant';

describe('operator-only tenant provisioning', () => {
  function setup() {
    const tx = { user: { findFirst: vi.fn().mockResolvedValue(null) }, tenant: { create: vi.fn() }, teamInvitation: { create: vi.fn() } };
    const prisma = { $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) };
    return { tx, prisma: prisma as unknown as PrismaClient };
  }

  it('creates a tenant and one initial administrator invitation in the same transaction', async () => {
    const { tx, prisma } = setup();
    const result = await provisionTenant(prisma, 'Acme', { name: 'Ana', email: 'ana@acme.com', role: 'viewer' }, 'https://dashboard.example.com');
    expect(tx.tenant.create).toHaveBeenCalledWith({ data: expect.objectContaining({ id: result.tenantId, name: 'Acme' }) });
    expect(tx.teamInvitation.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: result.tenantId, role: 'admin', email: 'ana@acme.com', invitedByUserId: null }) });
    const link = new URL(result.invitationUrl);
    expect(link.hash.slice(1)).toMatch(/^[a-f0-9]{64}$/);
    expect(result.expiresAt.getTime() - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it('rejects an already registered initial admin without creating an unusable tenant', async () => {
    const { tx, prisma } = setup();
    tx.user.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(provisionTenant(prisma, 'Acme', { name: 'Ana', email: 'ana@acme.com', role: 'admin' }, 'https://dashboard.example.com')).rejects.toThrow('already has an account');
    expect(tx.tenant.create).not.toHaveBeenCalled();
    expect(tx.teamInvitation.create).not.toHaveBeenCalled();
  });
});
