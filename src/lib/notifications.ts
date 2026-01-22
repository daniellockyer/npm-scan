import { Octokit } from "@octokit/rest";
import { type Packument, encodePackageNameForRegistry } from "./fetch-packument.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
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

export async function sendTelegramNotification(
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

export async function sendDiscordNotification(
  webhookUrl: string,
  message: string,
): Promise<void> {
  await httpPostJson(
    webhookUrl,
    { content: message },
    { timeoutMessage: "Discord notification timeout" },
  );
}

export async function createGitHubIssue(
  octokit: Octokit,
  repoUrl: string,
  packageName: string,
  packageVersion: string,
  scriptType: "preinstall" | "postinstall"|"prebuild" | "postbuild",
  scriptContent: string,
  previousVersion: string | null = null,
  previousScriptContent: string | null = null,
): Promise<void> {
  const url = new URL(repoUrl);
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts.length < 2) {
    throw new Error(`Invalid GitHub repository URL: ${repoUrl}`);
  }
  console.log(pathParts);
  const owner = pathParts[0];
  const repo = pathParts[1].replace(/\.git$/, "");

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

  await octokit.issues.create({
    owner,
    repo,
    title: issueTitle,
    body: issueBody,
  });
}

export type Alert = {
  scriptType: "preinstall" | "postinstall" | "prebuild" | "postbuild";
  action: "added" | "changed";
  latestCmd: string;
  prevCmd: string | null;
};

export async function sendCombinedScriptAlertNotifications(
  packageName: string,
  latest: string,
  previous: string | null,
  alerts: Alert[],
  packument: Packument,
): Promise<Alert[]> { // Changed return type
  if (alerts.length === 0) return []; // Return empty array if no alerts

  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const githubToken = process.env.GITHUB_TOKEN;
  const npmPackageUrl = `https://www.npmjs.com/package/${encodePackageNameForRegistry(packageName)}`;

  const successfulGithubAlerts: Alert[] = []; // Collect successful alerts

  // Build combined Telegram message
  if (telegramBotToken && telegramChatId) {
    try {
      const alertParts = alerts.map((alert) => {
        const scriptLabel = alert.scriptType.charAt(0).toUpperCase() + alert.scriptType.slice(1);
        const escapedCmd = alert.latestCmd.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        if (alert.action === "added") {
          return `• <b>${scriptLabel} added:</b> <code>${escapedCmd}</code>`;
        } else {
          const escapedPrev = (alert.prevCmd ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          return `• <b>${scriptLabel} changed:</b>\n  Previous: <code>${escapedPrev}</code>\n  New: <code>${escapedCmd}</code>`;
        }
      });

      const message =
        `🚨 <b>Security Alert: ${alerts.length} script change${alerts.length > 1 ? "s" : ""} detected</b>\n\n` +
        `Package: <code>${packageName}@${latest}</code>\n` +
        `<a href="${npmPackageUrl}">View on npm</a>\n` +
        `Previous version: ${previous ?? "none"}\n\n` +
        alertParts.join("\n\n");

      await sendTelegramNotification(telegramBotToken, telegramChatId, message);
    } catch (e) {
      process.stderr.write(
        `[${nowIso()}] WARN Telegram notification failed: ${getErrorMessage(e)}\n`,
      );
    }
  }

  // Build combined Discord message
  if (discordWebhookUrl) {
    try {
      const alertParts = alerts.map((alert) => {
        const scriptLabel = alert.scriptType.charAt(0).toUpperCase() + alert.scriptType.slice(1);
        if (alert.action === "added") {
          return `• **${scriptLabel} added:** \`\`\`${alert.latestCmd}\`\`\``;
        } else {
          return `• **${scriptLabel} changed:**\n  Previous: \`\`\`${alert.prevCmd ?? ""}\`\`\`\n  New: \`\`\`${alert.latestCmd}\`\`\``;
        }
      });

      const message =
        `🚨 **Security Alert: ${alerts.length} script change${alerts.length > 1 ? "s" : ""} detected**\n\n` +
        `**Package:** \`${packageName}@${latest}\`\n` +
        `**Previous version:** ${previous ?? "none"}\n\n` +
        alertParts.join("\n\n");

      await sendDiscordNotification(discordWebhookUrl, message);
    } catch (e) {
      process.stderr.write(
        `[${nowIso()}] WARN Discord notification failed: ${getErrorMessage(e)}\n`,
      );
    }
  }
   
  // Create GitHub issues for each alert
  if (githubToken && packument.repository?.url) {
    const octokit = new Octokit({ auth: githubToken });
    for (const alert of alerts) {
      try {
        await createGitHubIssue(
          octokit,
          packument.repository.url,
          packageName,
          latest,
          alert.scriptType,
          alert.latestCmd,
          previous,
          alert.action === "changed" ? alert.prevCmd : null,
        );
        successfulGithubAlerts.push(alert); // Add to successful alerts
      } catch (e) {
        process.stderr.write(
          `[${nowIso()}] WARN GitHub issue creation failed: ${getErrorMessage(e)}\n`,
        );
      }
    }
  }
  return successfulGithubAlerts; // Return collected successful alerts
}
