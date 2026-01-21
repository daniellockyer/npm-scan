export interface AllowlistPattern {
  pattern: string | RegExp;
  description: string;
  isRegex?: boolean;
}

export const SCRIPT_ALLOWLIST: AllowlistPattern[] = [
  {
    pattern: /^npx only-allow pnpm$/i,
    description: "only-allow pnpm package manager enforcement",
    isRegex: true,
  },
];

export function isScriptAllowed(scriptContent: string): boolean {
  if (!scriptContent || typeof scriptContent !== "string") {
    return false;
  }
  
  const trimmed = scriptContent.trim();
  if (trimmed.length === 0) {
    return true;
  }
  
  for (const entry of SCRIPT_ALLOWLIST) {
    if (entry.isRegex !== false) {
      const regex = entry.pattern instanceof RegExp 
        ? entry.pattern 
        : new RegExp(entry.pattern);
      if (regex.test(trimmed)) {
        return true;
      }
    } else {
      if (trimmed === entry.pattern) {
        return true;
      }
    }
  }
  
  return false;
}

export function getMatchingAllowlistEntry(
  scriptContent: string,
): AllowlistPattern | null {
  if (!scriptContent || typeof scriptContent !== "string") {
    return null;
  }
  
  const trimmed = scriptContent.trim();
  
  for (const entry of SCRIPT_ALLOWLIST) {
    if (entry.isRegex !== false) {
      const regex = entry.pattern instanceof RegExp 
        ? entry.pattern 
        : new RegExp(entry.pattern);
      if (regex.test(trimmed)) {
        return entry;
      }
    } else {
      if (trimmed === entry.pattern) {
        return entry;
      }
    }
  }
  
  return null;
}
