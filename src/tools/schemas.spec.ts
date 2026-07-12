import { describe, expect, it } from 'vitest';
import { imageReferenceSchema, kubernetesNameSchema, labelValueSchema, namespaceSchema, qualifiedNameSchema, reasonSchema } from './schemas.js';

describe('tool input schemas', () => {
  it('enforces Kubernetes DNS label and subdomain rules', () => {
    expect(kubernetesNameSchema.safeParse('api.example').success).toBe(true);
    expect(kubernetesNameSchema.safeParse('api..example').success).toBe(false);
    expect(namespaceSchema.safeParse('a'.repeat(64)).success).toBe(false);
    expect(namespaceSchema.safeParse('Team-A').success).toBe(false);
  });

  it('rejects control characters in write reasons', () => {
    expect(reasonSchema.safeParse('approved restart').success).toBe(true);
    expect(reasonSchema.safeParse('approved\nrestart').success).toBe(false);
    expect(reasonSchema.safeParse('approved\u202erestart').success).toBe(false);
  });

  it('validates Kubernetes metadata keys and label values', () => {
    expect(qualifiedNameSchema.safeParse('app.kubernetes.io/name').success).toBe(true);
    expect(qualifiedNameSchema.safeParse('bad//key').success).toBe(false);
    expect(labelValueSchema.safeParse('').success).toBe(true);
    expect(labelValueSchema.safeParse('Blue_team.v2').success).toBe(true);
    expect(labelValueSchema.safeParse('bad/value').success).toBe(false);
  });

  it('restricts image references to visible ASCII', () => {
    expect(imageReferenceSchema.safeParse('registry.example/api:v1').success).toBe(true);
    expect(imageReferenceSchema.safeParse('registry.example/api:\u202ev1').success).toBe(false);
  });
});
