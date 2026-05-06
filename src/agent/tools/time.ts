import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

const timeSchema = Type.Object({
  timezone: Type.Optional(
    Type.String({ description: "IANA timezone (e.g., 'Asia/Shanghai'). Defaults to UTC." }),
  ),
});

export function createTimeTool(): AgentTool<typeof timeSchema> {
  return {
    name: "get_current_time",
    label: "get_current_time",
    description: "Returns the current date and time",
    parameters: timeSchema,
    execute: async (_id, { timezone }) => {
      const now = new Date();
      if (timezone) {
        try {
          return textResult(now.toLocaleString("en-US", { timeZone: timezone }));
        } catch {
          return textResult(`Invalid timezone: ${timezone}. Current UTC: ${now.toISOString()}`);
        }
      }
      return textResult(now.toISOString());
    },
  };
}
