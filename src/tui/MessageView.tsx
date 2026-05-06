import React from "react";
import { Box, Text } from "ink";
import type { ChatMessage } from "./types.js";

const TOOL_ARGS_MAX = 60;

interface Props {
  message: ChatMessage;
  width: number;
  topMargin?: boolean;
}

function roleLabel(role: ChatMessage["role"]): string {
  return role === "user" ? "You" : role === "assistant" ? "Agent" : "System";
}

function roleColor(role: ChatMessage["role"]): string {
  return role === "user" ? "green" : role === "assistant" ? "blue" : "gray";
}

export function MessageView({ message, width, topMargin }: Props) {
  const label = roleLabel(message.role);
  const color = roleColor(message.role);
  const marginTop = topMargin ? 1 : 0;

  if (!message.blocks) {
    return (
      <Box flexDirection="column" width={width} marginTop={marginTop}>
        <Text wrap="wrap">
          <Text color={color} bold>{label}</Text>
          <Text>: {message.content}</Text>
        </Text>
      </Box>
    );
  }

  const elements: React.ReactNode[] = [];
  let labelRendered = false;
  for (let j = 0; j < message.blocks.length; j++) {
    const block = message.blocks[j];
    if (block.type === "text") {
      if (!labelRendered) {
        labelRendered = true;
        elements.push(
          <Box key={j}>
            <Text wrap="wrap">
              <Text color={color} bold>{label}</Text>
              <Text>: {block.text}</Text>
            </Text>
          </Box>
        );
      } else {
        elements.push(<Box key={j}><Text wrap="wrap">{block.text}</Text></Box>);
      }
    } else {
      if (!labelRendered) {
        labelRendered = true;
        elements.push(
          <Box key="label">
            <Text color={color} bold>{label}</Text>
            <Text>:</Text>
          </Box>
        );
      }
      const argsTrunc = block.args.length > TOOL_ARGS_MAX ? block.args.slice(0, TOOL_ARGS_MAX) + "…" : block.args;
      const status = block.isError ? " ✗" : block.result ? " ✓" : " …";
      elements.push(
        <Box key={j}>
          <Text color="gray" dimColor wrap="truncate-end">
            {"  "}{block.name}({argsTrunc}){status}
          </Text>
        </Box>
      );
    }
  }

  return <Box flexDirection="column" width={width} marginTop={marginTop}>{elements}</Box>;
}
