import path from "node:path";

import { config } from "../core/config";

export const FIG_TOOLS_MCP_NAME = "fig_tools";

export interface StdioMcpServerSpec {
  name: string;
  command: string;
  args: string[];
}

export function figToolsStdioMcpServer(): StdioMcpServerSpec {
  return {
    name: FIG_TOOLS_MCP_NAME,
    command: path.join(config.repoRoot, "node_modules", ".bin", "tsx"),
    args: [path.join(config.repoRoot, "src", "runtimes", "fig-tools-mcp.ts")],
  };
}
