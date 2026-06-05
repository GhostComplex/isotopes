import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";

export function createFsTools(workspacePath: string): AgentTool[] {
  return [
    createReadTool(workspacePath, {
      operations: {
        readFile: (p) => fs.readFile(p),
        access: (p) => fs.access(p),
      },
    }) as AgentTool,
    createWriteTool(workspacePath, {
      operations: {
        writeFile: (p, c) => fs.writeFile(p, c, "utf-8"),
        mkdir: (d) => fs.mkdir(d, { recursive: true }).then(() => undefined),
      },
    }) as AgentTool,
    createEditTool(workspacePath, {
      operations: {
        readFile: (p) => fs.readFile(p),
        writeFile: (p, c) => fs.writeFile(p, c, "utf-8"),
        access: (p) => fs.access(p),
      },
    }) as AgentTool,
    createLsTool(workspacePath, {
      operations: {
        exists: (p) => fs.stat(p).then(() => true, () => false),
        stat: (p) => fs.stat(p),
        readdir: (p) => fs.readdir(p),
      },
    }) as AgentTool,
  ];
}
