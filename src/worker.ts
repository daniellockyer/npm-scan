/**
 * npm preinstall/postinstall monitor - Worker
 *
 * Processes packages from BullMQ queue and runs heuristics to detect
 * malicious packages (specifically checking for newly introduced preinstall/postinstall scripts).
 */

import "dotenv/config";
import { Worker } from "bullmq";
import semver from "semver";
import { type PackageJobData } from "./queue.ts";
import {
  fetchPackument,
  encodePackageNameForRegistry,
  type Packument,
} from "./lib/fetch-packument.ts";

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

  // Always find the highest semver version from all available versions
  // Don't trust dist-tags as they may not reflect the actual highest version
  const versionKeys = Object.keys(versions);
  const sortedVersions = versionKeys
    .filter((v) => isLikelyVersionKey(v))
    .sort((a, b) => semver.compare(b, a) ?? 0);

  const latest = sortedVersions[0] || null;
  const previous = sortedVersions[1] || null;

  return { latest, previous };
}

async function httpPostJson(
  url: string | URL,
  body: unknown,
  {
    headers = {},
    timeoutMs = 10000,
    timeoutMessage = "request timeout",
  }: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    timeoutMessage?: string;
  } = {},
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sendTelegramNotification(
  botToken: string,
  chatId: string,
  message: string,
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await httpPostJson(
    url,
    {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
    },
    { timeoutMessage: "Telegram notification timeout" },
  );
}

async function sendDiscordNotification(
  webhookUrl: string,
  message: string,
): Promise<void> {
  await httpPostJson(
    webhookUrl,
    { content: message },
    { timeoutMessage: "Discord notification timeout" },
  );
}

async function createGitHubIssue(
  githubToken: string,
  repoUrl: string,
  packageName: string,
  packageVersion: string,
  scriptType: "preinstall" | "postinstall",
  scriptContent: string,
  previousVersion: string | null = null,
  previousScriptContent: string | null = null,
): Promise<void> {
  const url = new URL(repoUrl);
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts.length < 2) {
    throw new Error(`Invalid GitHub repository URL: ${repoUrl}`);
  }
  const owner = pathParts[0];
  const repo = pathParts[1];
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues`;

  const isChanged = previousScriptContent !== null;
  const issueTitle = isChanged
    ? `[Security Alert] \`${scriptType}\` script changed in \`${packageName}@${packageVersion}\``
    : `[Security Alert] New \`${scriptType}\` script added in \`${packageName}@${packageVersion}\``;

  let issueBody: string;
  if (isChanged) {
    issueBody = `
The \`${scriptType}\` script was changed in version \`${packageVersion}\` of the package \`${packageName}\`.

**Previous version:** ${previousVersion ?? "none"}
**Previous script:**
\`\`\`
${previousScriptContent}
\`\`\`

**New script:**
\`\`\`
${scriptContent}
\`\`\`

This could be a security risk. Please investigate.
`;
  } else {
    issueBody = `
A new \`${scriptType}\` script was detected in version \`${packageVersion}\` of the package \`${packageName}\`.

**Script content:**
\`\`\`
${scriptContent}
\`\`\`

This could be a security risk. Please investigate.
`;
  }

  await httpPostJson(
    apiUrl,
    {
      title: issueTitle,
      body: issueBody,
    },
    {
      headers: {
        Authorization: `token ${githubToken}`,
        Accept: "application/vnd.github.v3+json",
      },
      timeoutMessage: "GitHub issue creation timeout",
    },
  );
}

async function sendScriptAlertNotifications(
  packageName: string,
  latest: string,
  previous: string | null,
  scriptType: "preinstall" | "postinstall",
  latestCmd: string,
  prevCmd: string | null,
  packument: Packument,
  alertType: "added" | "changed",
): Promise<void> {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const githubToken = process.env.GITHUB_TOKEN;

  const scriptLabel = scriptType.charAt(0).toUpperCase() + scriptType.slice(1);
  const npmPackageUrl = `https://www.npmjs.com/package/${encodePackageNameForRegistry(packageName)}`;

  // Send Telegram notification if configured
  if (telegramBotToken && telegramChatId) {
    try {
      let message: string;
      if (alertType === "added") {
        message =
          `🚨 <b>${scriptLabel} script added</b>\n\n` +
          `Package: <code>${packageName}@${latest}</code>\n` +
          `<a href="${npmPackageUrl}">View on npm</a>\n` +
          `Previous version: ${previous ?? "none"}\n` +
          `<code>${latestCmd.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`;
      } else {
        message =
          `🚨 <b>${scriptLabel} script changed</b>\n\n` +
          `Package: <code>${packageName}@${latest}</code>\n` +
          `<a href="${npmPackageUrl}">View on npm</a>\n` +
          `Previous version: ${previous ?? "none"}\n` +
          `Previous ${scriptLabel}: <code>${(prevCmd ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>\n` +
          `New ${scriptLabel}: <code>${latestCmd.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`;
      }
      await sendTelegramNotification(telegramBotToken, telegramChatId, message);
    } catch (e) {
      process.stderr.write(
        `[${nowIso()}] WARN Telegram notification failed: ${getErrorMessage(e)}\n`,
      );
    }
  }

  // Send Discord notification if configured
  if (discordWebhookUrl) {
    try {
      let message: string;
      if (alertType === "added") {
        message =
          `🚨 **${scriptLabel} script added**\n\n` +
          `**Package:** \`${packageName}@${latest}\`\n` +
          `**Previous version:** ${previous ?? "none"}\n` +
          `**${scriptLabel}:** \`\`\`${latestCmd}\`\`\``;
      } else {
        message =
          `🚨 **${scriptLabel} script changed**\n\n` +
          `**Package:** \`${packageName}@${latest}\`\n` +
          `**Previous version:** ${previous ?? "none"}\n` +
          `**Previous ${scriptLabel}:** \`\`\`${prevCmd ?? ""}\`\`\`\n` +
          `**New ${scriptLabel}:** \`\`\`${latestCmd}\`\`\``;
      }
      await sendDiscordNotification(discordWebhookUrl, message);
    } catch (e) {
      process.stderr.write(
        `[${nowIso()}] WARN Discord notification failed: ${getErrorMessage(e)}\n`,
      );
    }
  }

  // Create GitHub issue if configured
  if (githubToken && packument.repository?.url) {
    try {
      await createGitHubIssue(
        githubToken,
        packument.repository.url,
        packageName,
        latest,
        scriptType,
        latestCmd,
        previous,
        alertType === "changed" ? prevCmd : null,
      );
    } catch (e) {
      process.stderr.write(
        `[${nowIso()}] WARN GitHub issue creation failed: ${getErrorMessage(e)}\n`,
      );
    }
  }
}

async function processPackage(job: { data: PackageJobData }): Promise<void> {
  const { packageName } = job.data;
  const registryBaseUrl = process.env.NPM_REGISTRY_URL || DEFAULT_REGISTRY_URL;

  process.stdout.write(`[${nowIso()}] Processing: ${packageName}\n`);

  let packument: Packument;
  try {
    packument = await fetchPackument(registryBaseUrl, packageName);
  } catch (e) {
    throw new Error(
      `packument fetch failed for ${packageName}: ${getErrorMessage(e)}`,
    );
  }

  const { latest, previous } = pickLatestAndPreviousVersions(packument);

  process.stdout.write(
    `[${nowIso()}] ${packageName}: latest=${latest ?? "null"}, previous=${previous ?? "null"}\n`,
  );

  if (!latest) {
    process.stdout.write(
      `[${nowIso()}] Skipping ${packageName}: no versions found\n`,
    );
    return;
  }

  const versions = (packument.versions ?? {}) as Record<string, VersionDoc>;
  const latestDoc = versions[latest];
  const prevDoc = previous ? versions[previous] : undefined;

  for (const scriptType of ["postinstall", "preinstall"] as const) {
    const latestHasScript = hasScript(latestDoc, scriptType);
    const prevHasScript = prevDoc ? hasScript(prevDoc, scriptType) : false;

    // Skip if latest version doesn't have the script
    if (!latestHasScript) continue;

    const latestCmd = getScript(latestDoc, scriptType);
    const prevCmd = prevDoc ? getScript(prevDoc, scriptType) : null;
    const prevTxt = previous
      ? ` (prev: ${previous})`
      : " (first publish / unknown prev)";

    // Detect script added (wasn't in previous version)
    if (!prevHasScript) {
      process.stdout.write(
        `[${nowIso()}] 🚨 MALICIOUS PACKAGE DETECTED: ${scriptType} added: ${packageName}@${latest}${prevTxt}\n` +
          `  ${scriptType}: ${JSON.stringify(latestCmd)}\n`,
      );

      await sendScriptAlertNotifications(
        packageName,
        latest,
        previous,
        scriptType,
        latestCmd,
        null,
        packument,
        "added",
      );
      continue;
    }

    // Detect script changed (both versions have it but content differs)
    if (prevHasScript && latestCmd !== prevCmd) {
      process.stdout.write(
        `[${nowIso()}] 🚨 MALICIOUS PACKAGE DETECTED: ${scriptType} changed: ${packageName}@${latest}${prevTxt}\n` +
          `  Previous ${scriptType}: ${JSON.stringify(prevCmd)}\n` +
          `  New ${scriptType}: ${JSON.stringify(latestCmd)}\n`,
      );

      await sendScriptAlertNotifications(
        packageName,
        latest,
        previous,
        scriptType,
        latestCmd,
        prevCmd,
        packument,
        "changed",
      );
    }
  }
}

const connection = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
};

const worker = new Worker<PackageJobData>(
  "package-scan",
  async (job) => {
    await processPackage(job);
  },
  {
    connection,
    concurrency: Number(process.env.WORKER_CONCURRENCY || 5),
    limiter: {
      max: Number(process.env.WORKER_MAX_JOBS_PER_SECOND || 10),
      duration: 1000,
    },
  },
);

worker.on("completed", (job) => {
  process.stdout.write(
    `[${nowIso()}] JOB COMPLETED: ${job.data.packageName}\n`,
  );
});

worker.on("failed", (job, err) => {
  process.stderr.write(
    `[${nowIso()}] JOB FAILED: ${job?.data.packageName}: ${getErrorMessage(err)}\n`,
  );
});

worker.on("error", (err) => {
  process.stderr.write(`[${nowIso()}] WORKER ERROR: ${getErrorMessage(err)}\n`);
});

process.stdout.write(
  `[${nowIso()}] Worker started: concurrency=${process.env.WORKER_CONCURRENCY || 5}\n`,
);

// Graceful shutdown
process.on("SIGTERM", async () => {
  process.stdout.write(`[${nowIso()}] SIGTERM received, closing worker...\n`);
  await worker.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  process.stdout.write(`[${nowIso()}] SIGINT received, closing worker...\n`);
  await worker.close();
  process.exit(0);
});
