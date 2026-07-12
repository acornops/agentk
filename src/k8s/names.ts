const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const QUALIFIED_NAME_PART = /^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

/** Return whether a value is a Kubernetes DNS label (for example, a namespace). */
export function isKubernetesDnsLabel(value: string): boolean {
  return value.length <= 63 && DNS_LABEL.test(value);
}

/** Return whether a value is a Kubernetes DNS subdomain name. */
export function isKubernetesDnsSubdomain(value: string): boolean {
  return value.length <= 253 && value.split('.').every(isKubernetesDnsLabel);
}

/** Return whether a value is a Kubernetes qualified label or annotation key. */
export function isKubernetesQualifiedName(value: string): boolean {
  const separator = value.indexOf('/');
  if (separator < 0) return value.length <= 63 && QUALIFIED_NAME_PART.test(value);
  if (separator !== value.lastIndexOf('/')) return false;
  const prefix = value.slice(0, separator);
  const name = value.slice(separator + 1);
  return prefix.length > 0 && isKubernetesDnsSubdomain(prefix) && name.length <= 63 && QUALIFIED_NAME_PART.test(name);
}

/** Return whether a value is valid for a Kubernetes label. Empty values are valid. */
export function isKubernetesLabelValue(value: string): boolean {
  return value.length === 0 || (value.length <= 63 && QUALIFIED_NAME_PART.test(value));
}
