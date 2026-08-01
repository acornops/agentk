import { toolRegistry } from './registry.js';
import { getResourceLogsTool } from './atomic/get-resource-logs.js';
import { listResourcesTool } from './atomic/list-resources.js';
import { getResourceTool } from './atomic/get-resource.js';
import { restartWorkloadTool } from './atomic/restart-workload.js';
import { scaleWorkloadTool } from './atomic/scale.js';
import { patchResourceTool } from './atomic/patch-resource.js';
import { patchWorkloadTool } from './atomic/patch-workload.js';
import { patchConfigMapTool } from './atomic/patch-configmap.js';
import { listCustomResourcesTool } from './atomic/list-custom-resources.js';
import { patchCustomResourceTool } from './atomic/patch-custom-resource.js';
import {
  createCustomResourceTool,
  deleteCustomResourceTool,
  getCustomResourceTool,
  watchCustomResourcesTool
} from './atomic/custom-resource-operations.js';

/** Register every built-in Kubernetes agent tool. */
export function registerAllTools() {
  toolRegistry.register(listResourcesTool);
  toolRegistry.register(getResourceLogsTool);
  toolRegistry.register(getResourceTool);
  toolRegistry.register(restartWorkloadTool);
  toolRegistry.register(scaleWorkloadTool);
  toolRegistry.register(patchWorkloadTool);
  toolRegistry.register(patchResourceTool);
  toolRegistry.register(patchConfigMapTool);
  toolRegistry.register(listCustomResourcesTool);
  toolRegistry.register(getCustomResourceTool);
  toolRegistry.register(watchCustomResourcesTool);
  toolRegistry.register(createCustomResourceTool);
  toolRegistry.register(patchCustomResourceTool);
  toolRegistry.register(deleteCustomResourceTool);
}
