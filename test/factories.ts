/**
 * Shared `project()` factory for `ProjectRecord`, consolidated from the per-file copies
 * that had drifted into detect/resolve/skills/standard/mcp test files (DEA-137). The
 * body constructs a fresh `rules: []` on every call, so no two tests share a defaults
 * object.
 *
 * `test/view.test.ts` keeps its own copy on purpose -- the per-file edit cost is the
 * control that keeps its fails-open allowlist sweep a conscious act. Do not point it here.
 */
import type { ProjectRecord } from '../src/surfaces/types.ts';

export const project = (path: string, body: Partial<ProjectRecord> = {}): ProjectRecord => ({
  path,
  alive: true,
  registered: true,
  settings: null,
  localSettings: null,
  mcpJson: null,
  entry: null,
  rules: [],
  memory: null,
  claudeMd: null,
  ...body,
});
