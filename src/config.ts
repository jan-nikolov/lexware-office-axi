import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";

export const DEFAULT_BASE_URL = "https://api.lexware.io";
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LEXWARE_OFFICE_AXI_CONFIG_DIR) return env.LEXWARE_OFFICE_AXI_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "lexware-office-axi");
}

export function resolveProfile(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const name = flag ?? env.LEXWARE_PROFILE ?? "default";
  if (!PROFILE_NAME.test(name)) {
    throw new AxiError(`Invalid profile name: ${name}`, "VALIDATION_ERROR", [
      "Use lowercase letters, digits, - and _ (e.g. `--profile test`)",
    ]);
  }
  return name;
}

/** Env variable that holds the key for a profile: default → LEXWARE_API_KEY, test → LEXWARE_API_KEY_TEST. */
export function envNameFor(profile: string): string {
  return profile === "default" ? "LEXWARE_API_KEY" : `LEXWARE_API_KEY_${profile.toUpperCase().replace(/-/g, "_")}`;
}

function keyFile(profile: string, env: NodeJS.ProcessEnv): string {
  return join(configDir(env), "profiles", `${profile}.key`);
}

export interface KeySource {
  key: string;
  source: string; // never contains the key itself
}

export function resolveKey(profile: string, env: NodeJS.ProcessEnv = process.env): KeySource | undefined {
  const names = profile === "default" ? ["LEXWARE_API_KEY", "LEXOFFICE_API_KEY"] : [envNameFor(profile)];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { key: value, source: `env ${name}` };
  }
  const file = keyFile(profile, env);
  if (existsSync(file)) {
    const value = readFileSync(file, "utf8").trim();
    if (value) return { key: value, source: `file ${file.replace(homedir(), "~")}` };
  }
  return undefined;
}

export function requireKey(profile: string, env: NodeJS.ProcessEnv = process.env): KeySource {
  const found = resolveKey(profile, env);
  if (!found) {
    throw new AxiError(`No API key for profile "${profile}"`, "AUTH_MISSING", [
      `Set ${envNameFor(profile)}${profile === "default" ? " (or LEXOFFICE_API_KEY)" : ""}, or pipe the key into \`lexware-office-axi auth set${profile === "default" ? "" : ` --profile ${profile}`}\``,
      "Create a key at https://app.lexware.de/addons/public-api",
    ]);
  }
  return found;
}

export function saveKey(profile: string, key: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = join(configDir(env), "profiles");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = keyFile(profile, env);
  writeFileSync(file, `${key.trim()}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function removeKey(profile: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = keyFile(profile, env);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

export function storedProfiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = join(configDir(env), "profiles");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".key"))
    .map((f) => f.slice(0, -4))
    .sort();
}

export function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.LEXWARE_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}
