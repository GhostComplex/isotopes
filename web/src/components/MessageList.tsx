import { useEffect, useRef } from "react";
import type { Message } from "../lib/types";
import { StreamingMessage } from "./StreamingMessage";
import { useState } from "react";

interface Props {
  messages: Message[];
  streaming: boolean;
}

function ToolCallPanel({
  name,
  args,
  output,
  isError,
}: {
  name: string;
  args: unknown;
  output?: string;
  isError?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="my-1 rounded-md border border-gray-600 bg-gray-800 text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-300 hover:text-white"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z" />
        </svg>
        <span className="font-mono font-medium text-blue-400">{name}</span>
        {output !== undefined && (
          <span className={`ml-auto ${isError ? "text-red-400" : "text-green-400"}`}>
            {isError ? "error" : "done"}
          </span>
        )}
        {output === undefined && (
          <span className="ml-auto text-yellow-400">running...</span>
        )}
      </button>
      {open && (
        <div className="border-t border-gray-700 px-3 py-2">
          <div className="mb-1 text-gray-400">Arguments:</div>
          <pre className="overflow-x-auto whitespace-pre-wrap text-gray-300">
            {JSON.stringify(args, null, 2)}
          </pre>
          {output !== undefined && (
            <>
              <div className="mb-1 mt-2 text-gray-400">Output:</div>
              <pre
                className={`overflow-x-auto whitespace-pre-wrap ${isError ? "text-red-300" : "text-gray-300"}`}
              >
                {output}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function MessageList({ messages, streaming }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const lastMessageCountRef = useRef(0);

  // Detect manual scroll
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  };

  // Auto-scroll on new content
  useEffect(() => {
    if (autoScrollRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  });

  // Re-enable auto-scroll when a new message arrives
  useEffect(() => {
    if (messages.length > lastMessageCountRef.current) {
      autoScrollRef.current = true;
    }
    lastMessageCountRef.current = messages.length;
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-gray-500">
        <p>Send a message to start chatting</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-4"
    >
      <div className="mx-auto max-w-3xl space-y-4">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-800 text-gray-100"
              }`}
            >
              {msg.role === "assistant" ? (
                <>
                  <StreamingMessage content={msg.content} />
                  {msg.toolCalls?.map((tc) => (
                    <ToolCallPanel key={tc.id} {...tc} />
                  ))}
                </>
              ) : (
                <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
              )}
            </div>
          </div>
        ))}
        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-gray-800 px-4 py-3">
              <div className="flex gap-1">
                <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.3s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.15s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400" />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
