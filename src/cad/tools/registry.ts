import type { ToolManager } from './ToolManager';
import { SelectTool } from './SelectTool';

/** Register every interactive tool with the tool manager. */
export function registerTools(tm: ToolManager) {
  tm.register('select', () => new SelectTool());
}
