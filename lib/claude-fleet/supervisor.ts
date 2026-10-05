import { createVercelClaudeWorkerAdapter, stopVercelSandboxById } from './sandbox-adapter';
import type { FleetSupervisorDependencies } from './service';

export const vercelFleetSupervisor: FleetSupervisorDependencies = {
  adapterFactory(registration, onSandboxCreated, isClaimActive) {
    return createVercelClaudeWorkerAdapter({
      apiKey: registration.executionKey, verifiedOrganizationId: registration.expectedOrganizationId,
      workspaceId: registration.workspaceId,
      baseSnapshotId: registration.baseSnapshotId, onSandboxCreated, isClaimActive,
    });
  },
  stopSandbox: (id) => stopVercelSandboxById(id, { signal: AbortSignal.timeout(5_000) }),
};
