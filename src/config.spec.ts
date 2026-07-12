import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

async function importConfigModule() {
  vi.resetModules();
  return import('./config.js');
}

function setBaseEnv(overrides: Record<string, string | undefined> = {}) {
  process.env = {
    ...originalEnv,
    ACORNOPS_AGENT_PLATFORM_URL: 'wss://platform.example.com/api/v1/agent/connect',
    ACORNOPS_CLUSTER_ID: 'cluster-1',
    ACORNOPS_AGENT_KEY: 'agent-key-12345678',
    ...overrides,
  };
}

describe('config', () => {
  beforeEach(() => {
    setBaseEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('retains bounded watch intent while deriving leader defaults', async () => {
    setBaseEnv({
      ACORNOPS_AGENT_WATCH_NAMESPACES: 'default, kube-public,team-a',
      ACORNOPS_AGENT_POD_NAMESPACE: 'agents',
      ACORNOPS_AGENT_POD_UID: 'pod-uid-1',
      ACORNOPS_AGENT_LEASE_NAMESPACE: '',
      ACORNOPS_AGENT_LEADER_IDENTITY: '',
    });

    const { config, DEFAULT_EXCLUDED_NAMESPACES } = await importConfigModule();

    expect(DEFAULT_EXCLUDED_NAMESPACES).toEqual(['kube-node-lease', 'kube-public']);
    expect(config.ACORNOPS_AGENT_WATCH_NAMESPACES).toEqual(['default', 'kube-public', 'team-a']);
    expect(config.ACORNOPS_AGENT_LEASE_NAMESPACE).toBe('agents');
    expect(config.ACORNOPS_AGENT_LEADER_IDENTITY).toBe('pod-uid-1');
    expect(config.ACORNOPS_AGENT_POD_NAMESPACE).toBe('agents');
    expect(config.ACORNOPS_AGENT_K8S_CONCURRENCY).toBe(8);
    expect(config.ACORNOPS_AGENT_K8S_LIST_PAGE_LIMIT).toBe(500);
    expect(config.ACORNOPS_AGENT_WATCH_CACHE_ENABLED).toBe(true);
    expect(config.ACORNOPS_AGENT_WATCH_SNAPSHOT_DEBOUNCE_MS).toBe(5000);
    expect(config.ACORNOPS_AGENT_WATCH_CACHE_SYNC_TIMEOUT_MS).toBe(15000);
    expect(config.ACORNOPS_AGENT_WATCH_TIMEOUT_SECONDS).toBe(300);
    expect(config.ACORNOPS_AGENT_PATCH_KINDS).toEqual(['Deployment', 'StatefulSet', 'DaemonSet']);
    expect(config.ACORNOPS_AGENT_ALLOW_SERVICE_SELECTOR_PATCH).toBe(false);
    expect(config.TARGET_ID).toBe('cluster-1');
  });

  it('accepts explicit structured patch policy settings', async () => {
    setBaseEnv({
      ACORNOPS_AGENT_PATCH_KINDS: 'Deployment,CronJob,Service,Ingress',
      ACORNOPS_AGENT_ALLOW_SERVICE_SELECTOR_PATCH: 'true',
    });

    const { config } = await importConfigModule();

    expect(config.ACORNOPS_AGENT_PATCH_KINDS).toEqual(['Deployment', 'CronJob', 'Service', 'Ingress']);
    expect(config.ACORNOPS_AGENT_ALLOW_SERVICE_SELECTOR_PATCH).toBe(true);
  });

  it('rejects unsupported structured patch kinds', async () => {
    setBaseEnv({ ACORNOPS_AGENT_PATCH_KINDS: 'Deployment,Secret' });
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit:1'); }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(importConfigModule()).rejects.toThrow('process.exit:1');
    expect(errorSpy).toHaveBeenCalledWith(
      '❌ Invalid configuration:',
      expect.objectContaining({ ACORNOPS_AGENT_PATCH_KINDS: expect.arrayContaining([expect.stringContaining('Unsupported patch kind')]) }),
    );
  });

  it('rejects an explicitly empty structured patch policy', async () => {
    setBaseEnv({ ACORNOPS_AGENT_PATCH_KINDS: '' });
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit:1'); }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(importConfigModule()).rejects.toThrow('process.exit:1');
    expect(errorSpy).toHaveBeenCalledWith(
      '❌ Invalid configuration:',
      expect.objectContaining({ ACORNOPS_AGENT_PATCH_KINDS: expect.arrayContaining([expect.stringContaining('At least one patch kind')]) }),
    );
  });

  it('accepts explicit Kubernetes API and watch cache settings', async () => {
    setBaseEnv({
      ACORNOPS_AGENT_K8S_CONCURRENCY: '12',
      ACORNOPS_AGENT_K8S_LIST_PAGE_LIMIT: '250',
      ACORNOPS_AGENT_WATCH_CACHE_ENABLED: 'false',
      ACORNOPS_AGENT_WATCH_SNAPSHOT_DEBOUNCE_MS: '250',
      ACORNOPS_AGENT_WATCH_CACHE_SYNC_TIMEOUT_MS: '2000',
      ACORNOPS_AGENT_WATCH_TIMEOUT_SECONDS: '60',
    });

    const { config } = await importConfigModule();

    expect(config.ACORNOPS_AGENT_K8S_CONCURRENCY).toBe(12);
    expect(config.ACORNOPS_AGENT_K8S_LIST_PAGE_LIMIT).toBe(250);
    expect(config.ACORNOPS_AGENT_WATCH_CACHE_ENABLED).toBe(false);
    expect(config.ACORNOPS_AGENT_WATCH_SNAPSHOT_DEBOUNCE_MS).toBe(250);
    expect(config.ACORNOPS_AGENT_WATCH_CACHE_SYNC_TIMEOUT_MS).toBe(2000);
    expect(config.ACORNOPS_AGENT_WATCH_TIMEOUT_SECONDS).toBe(60);
  });

  it('rejects out-of-range Kubernetes API collection settings', async () => {
    setBaseEnv({
      ACORNOPS_AGENT_K8S_CONCURRENCY: '0',
      ACORNOPS_AGENT_K8S_LIST_PAGE_LIMIT: '1001',
      ACORNOPS_AGENT_WATCH_SNAPSHOT_DEBOUNCE_MS: '60001',
      ACORNOPS_AGENT_WATCH_CACHE_SYNC_TIMEOUT_MS: '999',
      ACORNOPS_AGENT_WATCH_TIMEOUT_SECONDS: '29',
    });

    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit:1');
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(importConfigModule()).rejects.toThrow('process.exit:1');
    expect(errorSpy).toHaveBeenCalledWith(
      '❌ Invalid configuration:',
      expect.objectContaining({
        ACORNOPS_AGENT_K8S_CONCURRENCY: expect.arrayContaining([expect.any(String)]),
        ACORNOPS_AGENT_K8S_LIST_PAGE_LIMIT: expect.arrayContaining([expect.any(String)]),
        ACORNOPS_AGENT_WATCH_SNAPSHOT_DEBOUNCE_MS: expect.arrayContaining([expect.any(String)]),
        ACORNOPS_AGENT_WATCH_CACHE_SYNC_TIMEOUT_MS: expect.arrayContaining([expect.any(String)]),
        ACORNOPS_AGENT_WATCH_TIMEOUT_SECONDS: expect.arrayContaining([expect.any(String)]),
      }),
    );
  });

  it('rejects insecure agent transport unless explicitly allowed for local development', async () => {
    setBaseEnv({
      ACORNOPS_AGENT_PLATFORM_URL: 'ws://127.0.0.1:8081/api/v1/agent/connect',
    });

    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit:1');
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(importConfigModule()).rejects.toThrow('process.exit:1');
    expect(errorSpy).toHaveBeenCalledWith(
      '❌ Invalid configuration:',
      expect.objectContaining({
        ACORNOPS_AGENT_PLATFORM_URL: expect.arrayContaining([expect.stringContaining('must use wss://')]),
      }),
    );
  });

  it('allows ws transport only behind the explicit local-development override', async () => {
    setBaseEnv({
      ACORNOPS_AGENT_PLATFORM_URL: 'ws://127.0.0.1:8081/api/v1/agent/connect',
      ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT: 'true',
    });

    const { config } = await importConfigModule();

    expect(config.ACORNOPS_AGENT_PLATFORM_URL).toBe('ws://127.0.0.1:8081/api/v1/agent/connect');
    expect(config.ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT).toBe(true);
  });

  it('rejects renew deadlines that are not less than the lease duration', async () => {
    setBaseEnv({
      ACORNOPS_AGENT_RENEW_DEADLINE_MS: '15000',
      ACORNOPS_AGENT_LEASE_DURATION_MS: '15000',
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit:1');
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(importConfigModule()).rejects.toThrow('process.exit:1');
    expect(errorSpy).toHaveBeenCalledWith(
      '❌ Invalid configuration:',
      expect.objectContaining({
        ACORNOPS_AGENT_RENEW_DEADLINE_MS: [
          'ACORNOPS_AGENT_RENEW_DEADLINE_MS must be less than ACORNOPS_AGENT_LEASE_DURATION_MS',
        ],
      }),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects retry periods that exceed the renew deadline', async () => {
    setBaseEnv({
      ACORNOPS_AGENT_RENEW_DEADLINE_MS: '5000',
      ACORNOPS_AGENT_RETRY_PERIOD_MS: '6000',
    });

    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit:1');
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(importConfigModule()).rejects.toThrow('process.exit:1');
    expect(errorSpy).toHaveBeenCalledWith(
      '❌ Invalid configuration:',
      expect.objectContaining({
        ACORNOPS_AGENT_RETRY_PERIOD_MS: [
          'ACORNOPS_AGENT_RETRY_PERIOD_MS must be less than or equal to ACORNOPS_AGENT_RENEW_DEADLINE_MS',
        ],
      }),
    );
  });
});
