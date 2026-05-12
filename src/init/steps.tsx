import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";

interface TextStepProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  mask?: boolean;
  error?: string;
}

export function TextStep({ label, value, onChange, onSubmit, mask, error }: TextStepProps) {
  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      <Box>
        <Text color="cyan">› </Text>
        <TextInput
          value={value}
          mask={mask ? "•" : undefined}
          onChange={onChange}
          onSubmit={onSubmit}
        />
      </Box>
      {error && <Text color="yellow">  {error}</Text>}
    </Box>
  );
}

interface SelectStepProps<V extends string> {
  label: string;
  items: Array<{ label: string; value: V }>;
  onSelect: (item: { value: V }) => void;
}

export function SelectStep<V extends string>({ label, items, onSelect }: SelectStepProps<V>) {
  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      <SelectInput items={items} onSelect={onSelect} />
    </Box>
  );
}
