import { useState } from "react";
import { useAgents } from "./hooks/useAgents";
import { ChatView } from "./components/ChatView";

export default function App() {
  const { agents, loading, error } = useAgents();
  const [selectedAgent, setSelectedAgent] = useState("");

  // Auto-select first agent once loaded
  if (!selectedAgent && agents.length > 0) {
    setSelectedAgent(agents[0].id);
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-lg text-red-400">Failed to load agents</p>
          <p className="mt-1 text-sm text-gray-400">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <ChatView
      agents={agents}
      agentsLoading={loading}
      selectedAgent={selectedAgent}
      onSelectAgent={setSelectedAgent}
    />
  );
}
