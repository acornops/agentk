import { config, KubernetesRbacAddition, KubernetesRbacAdditionVerb } from '../config.js';
import { ToolExecutionError } from './errors.js';

export type CustomResourceAddition = KubernetesRbacAddition['resources'][number] & {
  additionKey: string;
  additionName: string;
};

/** Resolve one exact snapshotted custom resource and required verb. */
export function requireCustomResourceAddition(
  additionKey: string,
  resourcePlural: string,
  requiredVerb: KubernetesRbacAdditionVerb
): CustomResourceAddition {
  const addition = config.ACORNOPS_AGENT_RBAC_ADDITIONS_JSON.find((candidate) => candidate.key === additionKey);
  const resources = addition?.resources.filter((candidate) => candidate.resource === resourcePlural) || [];
  const resource = resources[0];
  if (!addition || resources.length !== 1 || !resource || !resource.verbs.includes(requiredVerb)) {
    throw new ToolExecutionError(
      'INVALID_ARGUMENTS',
      `Custom resource ${additionKey}/${resourcePlural} is not enabled for ${requiredVerb}`
    );
  }
  return { ...resource, additionKey: addition.key, additionName: addition.name };
}
