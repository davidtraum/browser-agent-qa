export interface ParsedArgs {
  flags: Map<string, string | boolean>;
}

export const parseArgs = (argv: string[]): ParsedArgs => {
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected positional argument "${token}".`);
    }

    const key = token.slice(2);
    if (!key) {
      throw new Error('Empty flag name is not allowed.');
    }

    const nextToken = argv[index + 1];
    if (!nextToken || nextToken.startsWith('--')) {
      flags.set(key, true);
      continue;
    }

    flags.set(key, nextToken);
    index += 1;
  }

  return { flags };
};

export const getStringFlag = (parsed: ParsedArgs, name: string): string | undefined => {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value.trim() : undefined;
};

export const getBooleanFlag = (parsed: ParsedArgs, name: string): boolean => parsed.flags.get(name) === true;

export const requireStringFlag = (parsed: ParsedArgs, name: string): string => {
  const value = getStringFlag(parsed, name);
  if (!value) {
    throw new Error(`Missing required flag --${name}.`);
  }

  return value;
};

