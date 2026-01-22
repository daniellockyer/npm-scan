import { Db } from "./app-updater.ts";

const DB_PATH = "./docs/db.json";

export interface Finding {
  packageName: string;
  version: string;
  scriptType: "preinstall" | "postinstall";
  scriptContent: string;
  previousVersion: string | null;
  timestamp: string;
  issuesend?: boolean;
}

const db = new Db<Finding>(DB_PATH);

export async function saveFinding(finding: Finding): Promise<void> {
  const findings = await db.read();
  findings.unshift(finding);
  await db.write(findings);
}

export async function updateFindingIssueStatus(
  packageName: string,
  version: string,
  scriptType: "preinstall" | "postinstall",
  status: boolean,
): Promise<void> {
  const findings = await db.read();
  const findingIndex = findings.findIndex(
    (f) =>
      f.packageName === packageName &&
      f.version === version &&
      f.scriptType === scriptType,
  );

  if (findingIndex !== -1) {
    findings[findingIndex].issuesend = status;
    await db.write(findings);
  }
}
