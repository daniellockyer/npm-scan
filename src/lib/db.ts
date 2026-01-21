import { promises as fs } from "node:fs";

const DB_PATH = "./docs/db.json";

export interface Finding {
  packageName: string;
  version: string;
  scriptType: "preinstall" | "postinstall";
  scriptContent: string;
  previousVersion: string | null;
  timestamp: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function saveFinding(finding: Finding): Promise<void> {
  let findings: Finding[] = [];
  try {
    const data = await fs.readFile(DB_PATH, "utf8");
    findings = JSON.parse(data);
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      process.stderr.write(
        `[${nowIso()}] WARN could not read ${DB_PATH}: ${error.message}\n`,
      );
    }
  }

  // Add new finding to the top
  findings.unshift(finding);

  try {
    await fs.writeFile(DB_PATH, JSON.stringify(findings, null, 2), "utf8");
  } catch (error: any) {
    process.stderr.write(
      `[${nowIso()}] WARN could not write to ${DB_PATH}: ${error.message}\n`,
    );
  }
}
