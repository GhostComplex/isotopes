export function requireArg(value: string | undefined, usage: string): string {
  if (!value) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }
  return value;
}
