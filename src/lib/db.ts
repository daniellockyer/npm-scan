import { Db } from "./app-updater.ts";

const DB_PATH = "./docs/db.json";

export interface Finding {
  packageName: string;
  version: string;
  scriptType: "preinstall" | "postinstall";
  scriptContent: string;
  previousVersion: string | null;
  timestamp: string;
}

const db = new Db<Finding>(DB_PATH);

export async function saveFinding(finding: Finding): Promise<void> {
  const findings = await db.read();
  findings.unshift(finding);
  await db.write(findings);
}
