import { useEffect } from "react";
import type { Agent } from "../lib/types";
import { useChat } from "../hooks/useChat";
import { AgentSelector } from "./AgentSelector";
import { MessageList } from "./MessageList";
import { MessageInput } from "./MessageInput";

interface Props {
  agents: Agent[];
  agentsLoading: boolean;
  selectedAgent: string;
  onSelectAgent: (id: string) => void;
}

export function ChatView({
  agents,
  agentsLoading,
  selectedAgent,
  onSelectAgent,
}: Props) {
  const { messages, streaming, sendMessage, newChat, loadHistory, historyLoaded } =
    useChat(selectedAgent);

  useEffect(() => {
    if (selectedAgent) {
      loadHistory();
    }
  }, [selectedAgent, loadHistory]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-gray-700 bg-gray-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-white">Isotopes</h1>
          <AgentSelector
            agents={agents}
            selected={selectedAgent}
            onChange={onSelectAgent}
            loading={agentsLoading}
          />
        </div>
        <button
          onClick={newChat}
          className="rounded-md border border-gray-600 px-3 py-1.5 text-sm text-gray-300
            transition-colors hover:bg-gray-700 hover:text-white"
        >
          New Chat
        </button>
      </header>

      {/* Messages */}
      {!historyLoaded ? (
        <div className="flex flex-1 items-center justify-center text-gray-500">
          Loading...
        </div>
      ) : (
        <MessageList messages={messages} streaming={streaming} />
      )}

      {/* Input */}
      <MessageInput onSend={sendMessage} disabled={streaming || !selectedAgent} />
    </div>
  );
}
