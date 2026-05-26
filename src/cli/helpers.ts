export function requireArg(value: string | undefined, usage: string): string {
  if (!value) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }
  return value;
}

export function printJsonOr(json: boolean, data: unknown, fallback: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    fallback();
  }
}
