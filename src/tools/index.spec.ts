import { describe, expect, it, vi } from 'vitest';
import { registerAllTools } from './index.js';
import { toolRegistry } from './registry.js';
import { getResourceLogsTool } from './atomic/get-resource-logs.js';
import { getResourceTool } from './atomic/get-resource.js';
import { listResourcesTool } from './atomic/list-resources.js';
import { restartWorkloadTool } from './atomic/restart-workload.js';
import { scaleWorkloadTool } from './atomic/scale.js';
import { patchResourceTool } from './atomic/patch-resource.js';

describe('registerAllTools', () => {
  it('registers each built-in tool with the shared registry', () => {
    const registerSpy = vi.spyOn(toolRegistry, 'register');

    registerAllTools();

    expect(registerSpy).toHaveBeenCalledWith(listResourcesTool);
    expect(registerSpy).toHaveBeenCalledWith(getResourceLogsTool);
    expect(registerSpy).toHaveBeenCalledWith(getResourceTool);
    expect(registerSpy).toHaveBeenCalledWith(restartWorkloadTool);
    expect(registerSpy).toHaveBeenCalledWith(scaleWorkloadTool);
    expect(registerSpy).toHaveBeenCalledWith(patchResourceTool);
  });
});
