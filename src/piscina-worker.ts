import "dotenv/config";
import semver from "semver";
import { fetchPackument, type Packument } from "./lib/fetch-packument.ts";
import { sendCombinedScriptAlertNotifications, type Alert } from "./lib/notifications.ts";
import { saveFinding, updateFindingIssueStatus, type Finding } from "./lib/db.ts";
import { savePendingTask, removePendingTask,getPendingTasks } from "./lib/pending-db.ts";

// This will be passed from the main thread
export interface PackageJobData {
  packageName: string;
  version: string;
  timestamp: string;

}

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/";

interface VersionDoc {
  scripts?: {
    preinstall?: string;
    postinstall?: string;
    [key: string]: string | undefined;
  };
  [key: string]: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

function isLikelyVersionKey(key: unknown): key is string {
  return typeof key === "string" && semver.valid(key) !== null;
}

function hasScript(versionDoc: unknown, scriptName: string): boolean {
  if (!versionDoc || typeof versionDoc !== "object") return false;
  const doc = versionDoc as VersionDoc;
  const scripts = doc.scripts;
  if (!scripts || typeof scripts !== "object") return false;
  const val = scripts[scriptName];
  return typeof val === "string" && val.trim().length > 0;
}

function getScript(
  versionDoc: VersionDoc | undefined,
  scriptName: string,
): string {
  return versionDoc?.scripts?.[scriptName] ?? "";
}

function pickLatestAndPreviousVersions(doc: Packument): {
  latest: string | null;
  previous: string | null;
} {
  const versions = 
    doc.versions && typeof doc.versions === "object"
      ? (doc.versions as Record<string, VersionDoc>)
      : null;

  if (!versions) return { latest: null, previous: null };

  const versionKeys = Object.keys(versions);
  const sortedVersions = versionKeys
    .filter((v) => isLikelyVersionKey(v))
    .sort((a, b) => semver.compare(b, a) ?? 0);

  const latest = sortedVersions[0] || null;
  const previous = sortedVersions[1] || null;

  return { latest, previous };
}

export default async function processPackage(actual: PackageJobData): Promise<void> {

    const registryBaseUrl = process.env.NPM_REGISTRY_URL || DEFAULT_REGISTRY_URL;

    // Immediately save to pending tasks
  

 

    try {
        process.stdout.write(`[${nowIso()}] Processing: ${actual.packageName}\n`);

        let packument: Packument;
        try {
          packument = await fetchPackument(registryBaseUrl, actual.packageName);
        } catch (e) {
          throw new Error(
            `packument fetch failed for ${actual.packageName}: ${getErrorMessage(e)}`,
          );
        }

        const { latest, previous } = pickLatestAndPreviousVersions(packument);

        process.stdout.write(
          `[${nowIso()}] ${actual.packageName}: latest=${latest ?? "null"}, previous=${previous ?? "null"}\n`,
        );

        if (!latest) {
          process.stdout.write(
            `[${nowIso()}] Skipping ${actual.packageName}: no versions found\n`,
          );
          return;
        }

        const versions = (packument.versions ?? {}) as Record<string, VersionDoc>;
        const latestDoc = versions[latest];
        const prevDoc = previous ? versions[previous] : undefined;

        const alerts: Alert[] = [];

        for (const scriptType of ["preinstall", "postinstall","prebuild","postbuild"] as const) {
          const latestHas = hasScript(latestDoc, scriptType);
          const prevHas = prevDoc ? hasScript(prevDoc, scriptType) : false;
          const latestCmd = getScript(latestDoc, scriptType);
          const prevCmd = prevDoc ? getScript(prevDoc, scriptType) : "";

          if (latestHas && !prevHas) {
            alerts.push({ scriptType, action: "added", latestCmd, prevCmd: null });
          } else if (latestHas && prevHas && latestCmd !== prevCmd) {
            alerts.push({ scriptType, action: "changed", latestCmd, prevCmd });
          }
        }

        if (alerts.length > 0) {
          const prevTxt = previous ? ` (prev: ${previous})` : " (first publish / unknown prev)";
          for (const alert of alerts) {
            process.stdout.write(
              `[${nowIso()}] 🚨 MALICIOUS PACKAGE DETECTED: ${alert.scriptType} ${alert.action}: ${actual.packageName}@${latest}${prevTxt}\n` +
                (alert.action === "added"
                  ? `  ${alert.scriptType}: ${JSON.stringify(alert.latestCmd)}\n`
                  : `  Previous ${alert.scriptType}: ${JSON.stringify(alert.prevCmd)}\n` +
                    `  New ${alert.scriptType}: ${JSON.stringify(alert.latestCmd)}\n`)
            );
          }

          // Save findings to db.json
          for (const alert of alerts) {
            const finding: Finding = {
              packageName: actual.packageName,
              version: latest,
              scriptType: alert.scriptType,
              scriptContent: alert.latestCmd,
              previousVersion: previous,
              timestamp: nowIso(),
              issuesend: false,
            };
            await saveFinding(finding);
          }

          const successfulGithubAlerts = await sendCombinedScriptAlertNotifications(
            actual.packageName,
            latest,
            previous,
            alerts,
            packument,
          );

          for (const alert of successfulGithubAlerts) {
            await updateFindingIssueStatus(
              actual.packageName,
              latest,
              alert.scriptType,
              true,
            );
          }
        }
    } finally {
        process.stdout.write(`[${nowIso()}] Removing from pending queue: ${actual.packageName}\n`);
        // Remove from pending tasks once processing is complete
        
    }
}