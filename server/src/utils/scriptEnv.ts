import fs from "node:fs";
import path from "node:path";

type LoadScriptEnvOptions = {
  cwd?: string;
  explicitEnvFile?: string | null;
  preferTestEnv?: boolean;
  overrideExisting?: boolean;
};

export function readArgFromArgv(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx < 0) return null;
  return argv[idx + 1] || null;
}

export function hasFlagInArgv(argv: string[], name: string): boolean {
  return argv.includes(name);
}

export function loadScriptEnvFiles(options: LoadScriptEnvOptions = {}): string[] {
  const cwd = path.resolve(options.cwd || process.cwd());
  const explicitEnvFile = options.explicitEnvFile ? path.resolve(options.explicitEnvFile) : null;
  const candidates = new Set<string>();
  if (explicitEnvFile) candidates.add(explicitEnvFile);
  if (options.preferTestEnv) {
    candidates.add(path.join(cwd, ".env.test.local"));
    candidates.add(path.join(cwd, ".env.test"));
  }
  candidates.add(path.join(cwd, ".env.local"));
  candidates.add(path.join(cwd, ".env"));

  const loaded: string[] = [];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const text = fs.readFileSync(envPath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) continue;
      const key = match[1];
      if (process.env[key] && !options.overrideExisting) continue;
      let value = match[2].trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
    loaded.push(path.basename(envPath));
  }
  return loaded;
}
