import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";
import type { FsBridge } from "../middleware/fs.js";

export function createFsTools(workspacePath: string, fs: FsBridge): AgentTool[] {
  return [
    createReadTool(workspacePath, {
      operations: {
        readFile: (p) => fs.readFile(p),
        access: (p) => fs.access(p),
      },
    }) as AgentTool,
    createWriteTool(workspacePath, {
      operations: {
        writeFile: (p, c) => fs.writeFile(p, c),
        mkdir: (d) => fs.mkdir(d),
      },
    }) as AgentTool,
    createEditTool(workspacePath, {
      operations: {
        readFile: (p) => fs.readFile(p),
        writeFile: (p, c) => fs.writeFile(p, c),
        access: (p) => fs.access(p),
      },
    }) as AgentTool,
    createLsTool(workspacePath, {
      operations: {
        exists: (p) => fs.exists(p),
        stat: (p) => fs.stat(p),
        readdir: (p) => fs.readdir(p),
      },
    }) as AgentTool,
  ];
}
