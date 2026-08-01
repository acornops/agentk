import pino from 'pino';
import { config } from './config.js';
import { LifecycleManager } from './core/lifecycle.js';
import { LeaderElector } from './runtime/leader-election.js';

const logger = pino({
    level: config.ACORNOPS_AGENT_LOG_LEVEL,
    transport: config.ACORNOPS_AGENT_LOG_LEVEL === 'debug' ? {
        target: 'pino-pretty',
        options: { colorize: true }
    } : undefined
});

logger.info(
  {
    connectorVersion: config.CONNECTOR_VERSION,
    leaderElectionEnabled: config.ACORNOPS_AGENT_LEADER_ELECTION_ENABLED,
    podName: config.ACORNOPS_AGENT_POD_NAME || undefined,
    podUid: config.ACORNOPS_AGENT_POD_UID || undefined,
  },
  'AcornOps Agent starting...'
);

const manager = new LifecycleManager();
const elector = config.ACORNOPS_AGENT_LEADER_ELECTION_ENABLED
  ? new LeaderElector({
      leaseName: config.ACORNOPS_AGENT_LEASE_NAME,
      leaseNamespace: config.ACORNOPS_AGENT_LEASE_NAMESPACE,
      holderIdentity: config.ACORNOPS_AGENT_LEADER_IDENTITY,
      leaseDurationMs: config.ACORNOPS_AGENT_LEASE_DURATION_MS,
      renewDeadlineMs: config.ACORNOPS_AGENT_RENEW_DEADLINE_MS,
      retryPeriodMs: config.ACORNOPS_AGENT_RETRY_PERIOD_MS,
      podName: config.ACORNOPS_AGENT_POD_NAME || undefined,
      podUid: config.ACORNOPS_AGENT_POD_UID || undefined,
      onAcquired: () => {
        logger.info(
          {
            leaseName: config.ACORNOPS_AGENT_LEASE_NAME,
            leaseNamespace: config.ACORNOPS_AGENT_LEASE_NAMESPACE,
            holderIdentity: config.ACORNOPS_AGENT_LEADER_IDENTITY,
          },
          'Leadership acquired; starting agent runtime'
        );
        manager.start();
      },
      onLost: (reason) => {
        logger.warn(
          {
            leaseName: config.ACORNOPS_AGENT_LEASE_NAME,
            leaseNamespace: config.ACORNOPS_AGENT_LEASE_NAMESPACE,
            holderIdentity: config.ACORNOPS_AGENT_LEADER_IDENTITY,
            reason,
          },
          'Leadership lost; stopping agent runtime'
        );
        manager.stop();
      },
    })
  : null;

let shuttingDown = false;

/** Stop leadership and runtime state before exiting the process. */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutdown requested');
  if (elector) {
    await elector.stop();
  }
  manager.stop();
  process.exit(0);
}

// Handle process signals
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught Exception');
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason, promise }, 'Unhandled Rejection');
});

if (elector) {
  elector.start();
} else {
  manager.start();
}
