export const DEFAULT_MAX_TOOL_RESULT_CHARS = 16_000;

const MIN_KEEP_CHARS = 2_000;

const MIDDLE_OMISSION_MARKER =
  "\n\n⚠️ [... middle content omitted — showing head and tail ...]\n\n";

function formatTruncationSuffix(truncatedChars: number): string {
  return `\n\n[... ${Math.max(1, Math.floor(truncatedChars))} more characters truncated]`;
}

function hasImportantTail(text: string): boolean {
  const tail = text.slice(-2000).toLowerCase();
  return (
    /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b/.test(tail) ||
    /\}\s*$/.test(tail.trim()) ||
    /\b(total|summary|result|complete|finished|done)\b/.test(tail)
  );
}

export function truncateToolResultText(
  text: string,
  maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS,
): string {
  if (text.length <= maxChars) {
    return text;
  }

  const suffix = formatTruncationSuffix(text.length - maxChars);
  const budget = Math.max(MIN_KEEP_CHARS, maxChars - suffix.length);

  if (hasImportantTail(text) && budget > MIN_KEEP_CHARS * 2) {
    const tailBudget = Math.min(Math.floor(budget * 0.3), 4_000);
    const headBudget = budget - tailBudget - MIDDLE_OMISSION_MARKER.length;

    if (headBudget > MIN_KEEP_CHARS) {
      let headCut = headBudget;
      const headNewline = text.lastIndexOf("\n", headBudget);
      if (headNewline > headBudget * 0.8) {
        headCut = headNewline;
      }

      let tailStart = text.length - tailBudget;
      const tailNewline = text.indexOf("\n", tailStart);
      if (tailNewline !== -1 && tailNewline < tailStart + tailBudget * 0.2) {
        tailStart = tailNewline + 1;
      }

      const kept = text.slice(0, headCut) + MIDDLE_OMISSION_MARKER + text.slice(tailStart);
      const actualSuffix = formatTruncationSuffix(text.length - kept.length);
      return kept + actualSuffix;
    }
  }

  let cutPoint = budget;
  const lastNewline = text.lastIndexOf("\n", budget);
  if (lastNewline > budget * 0.8) {
    cutPoint = lastNewline;
  }

  const kept = text.slice(0, cutPoint);
  return kept + formatTruncationSuffix(text.length - kept.length);
}
