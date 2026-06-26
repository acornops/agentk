import { config } from '../config.js';
import { withK8sApiLimit } from './api-limiter.js';

export interface ListPageOptions {
  limit?: number;
  _continue?: string;
}

export interface ListPage<T> {
  items?: T[];
  metadata?: {
    _continue?: string;
    resourceVersion?: string;
  };
}

export interface ListAllPagesResult<T> {
  items: T[];
  resourceVersion?: string;
}

/** Fetch all Kubernetes list pages using continue tokens. */
export async function listAllPages<T>(
  fetchPage: (options: ListPageOptions) => Promise<ListPage<T>>
): Promise<T[]> {
  return (await listAllPagesWithMetadata(fetchPage)).items;
}

/** Fetch all Kubernetes list pages and return the collection resource version. */
export async function listAllPagesWithMetadata<T>(
  fetchPage: (options: ListPageOptions) => Promise<ListPage<T>>
): Promise<ListAllPagesResult<T>> {
  const items: T[] = [];
  let continueToken: string | undefined;
  let resourceVersion: string | undefined;
  const limit = config.ACORNOPS_AGENT_K8S_LIST_PAGE_LIMIT ?? 500;

  do {
    const page = await withK8sApiLimit(() => fetchPage({ limit, _continue: continueToken }));
    items.push(...(page.items || []));
    resourceVersion = page.metadata?.resourceVersion || resourceVersion;
    continueToken = page.metadata?._continue || undefined;
  } while (continueToken);

  return { items, resourceVersion };
}
