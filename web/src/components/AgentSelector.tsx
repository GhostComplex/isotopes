import type { Agent } from "../lib/types";

interface Props {
  agents: Agent[];
  selected: string;
  onChange: (id: string) => void;
  loading: boolean;
}

export function AgentSelector({ agents, selected, onChange, loading }: Props) {
  if (loading) {
    return (
      <div className="h-9 w-40 animate-pulse rounded-md bg-gray-700" />
    );
  }

  return (
    <select
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-md border border-gray-600 bg-gray-800 px-3 text-sm text-white
        focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
    >
      {agents.map((agent) => (
        <option key={agent.id} value={agent.id}>
          {agent.name || agent.id}
        </option>
      ))}
    </select>
  );
}
