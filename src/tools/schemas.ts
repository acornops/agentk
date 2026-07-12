import { z } from 'zod';
import {
  isKubernetesDnsLabel,
  isKubernetesDnsSubdomain,
  isKubernetesLabelValue,
  isKubernetesQualifiedName,
} from '../k8s/names.js';

const CONTROL_OR_FORMAT_CHARACTER = /[\p{Cc}\p{Cf}]/u;

export const kubernetesNameSchema = z.string().min(1).max(253)
  .refine(isKubernetesDnsSubdomain, 'Must be a Kubernetes DNS-compatible name');
export const namespaceSchema = z.string().min(1).max(63)
  .refine(isKubernetesDnsLabel, 'Must be a Kubernetes DNS label');
export const containerNameSchema = namespaceSchema;
export const reasonSchema = z.string().min(1).max(512)
  .refine((value) => !CONTROL_OR_FORMAT_CHARACTER.test(value), 'Must not contain control or format characters');
export const selectorSchema = z.string().max(1024);
export const continuationTokenSchema = z.string().max(4096);
export const qualifiedNameSchema = z.string().min(1).max(317)
  .refine(isKubernetesQualifiedName, 'Must be a Kubernetes qualified name');
export const labelValueSchema = z.string().max(63)
  .refine(isKubernetesLabelValue, 'Must be a Kubernetes label value');
export const annotationValueSchema = z.string().max(4096)
  .refine((value) => !CONTROL_OR_FORMAT_CHARACTER.test(value), 'Must not contain control or format characters');
export const imageReferenceSchema = z.string().min(1).max(1024)
  .regex(/^[\x21-\x7e]+$/, 'Must contain only visible ASCII characters');
export const kubernetesUidSchema = z.string().min(1).max(128)
  .refine((value) => !CONTROL_OR_FORMAT_CHARACTER.test(value), 'Must not contain control or format characters');
