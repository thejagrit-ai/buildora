import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  organizationId: string;
  membershipId: string;
  userId: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export const tenantContext = {
  get: () => storage.getStore(),
  run: <T>(context: TenantContext, callback: () => T) => storage.run(context, callback),
};
