import {
  type Packument,
  encodePackageNameForRegistry,
} from "./fetch-packument.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
    ? `\`${scriptType}\` script changed in \`${packageName}@${packageVersion}\``
    : `New \`${scriptType}\` script added in \`${packageName}@${packageVersion}\``;

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
`;
  } else {
    issueBody = `
A new \`${scriptType}\` script was detected in version \`${packageVersion}\` of the package \`${packageName}\`.

**Script content:**
\`\`\`
${scriptContent}
\`\`\`
`;
  }

  if (previousVersion && packageVersion) {
    const encodedPackageName = encodePackageNameForRegistry(packageName);
    const diffUrl = `https://app.renovatebot.com/package-diff?name=${encodedPackageName}&from=${encodeURIComponent(previousVersion)}&to=${encodeURIComponent(packageVersion)}`;
    issueBody += `

**Package Diff:** [View diff](${diffUrl})`;
  }

  issueBody += `

This could be a security risk. Please investigate.`;

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

export type Alert = {
  scriptType: "preinstall" | "postinstall";
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
): Promise<void> {
  if (alerts.length === 0) return;

  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const githubToken = process.env.GITHUB_TOKEN;
  const npmPackageUrl = `https://www.npmjs.com/package/${encodePackageNameForRegistry(packageName)}`;

  // Build combined Telegram message
  if (telegramBotToken && telegramChatId) {
    try {
      const alertParts = alerts.map((alert) => {
        const scriptLabel =
          alert.scriptType.charAt(0).toUpperCase() + alert.scriptType.slice(1);
        const escapedCmd = escapeHtml(alert.latestCmd);
        if (alert.action === "added") {
          return `• <b>${scriptLabel} added:</b> <code>${escapedCmd}</code>`;
        } else {
          const escapedPrev = escapeHtml(alert.prevCmd ?? "");
          return `• <b>${scriptLabel} changed:</b>\n  Previous: <code>${escapedPrev}</code>\n  New: <code>${escapedCmd}</code>`;
        }
      });

      let message =
        `🚨 <b>${alerts.length} script change${alerts.length > 1 ? "s" : ""} detected</b>\n\n` +
        `<code>${escapeHtml(packageName)}</code>\n` +
        `<a href="${npmPackageUrl}">npm</a> ${escapeHtml(previous ?? "none")} → ${escapeHtml(latest)}\n\n` +
        alertParts.join("\n\n");

      if (previous && latest) {
        const encodedPackageName = encodePackageNameForRegistry(packageName);
        const diffUrl = `https://app.renovatebot.com/package-diff?name=${encodedPackageName}&from=${encodeURIComponent(previous)}&to=${encodeURIComponent(latest)}`;
        message += `\n\n<b>Package Diff:</b> <a href="${diffUrl}">View diff</a>`;
      }

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
        const scriptLabel =
          alert.scriptType.charAt(0).toUpperCase() + alert.scriptType.slice(1);
        if (alert.action === "added") {
          return `• **${scriptLabel} added:** \`\`\`${alert.latestCmd}\`\`\``;
        } else {
          return `• **${scriptLabel} changed:**\n  Previous: \`\`\`${alert.prevCmd ?? ""}\`\`\`\n  New: \`\`\`${alert.latestCmd}\`\`\``;
        }
      });

      let message =
        `🚨 **${alerts.length} script change${alerts.length > 1 ? "s" : ""} detected**\n\n` +
        `\`${packageName}\`\n` +
        `[npm](${npmPackageUrl}) ${previous ?? "none"} → ${latest}\n\n` +
        alertParts.join("\n\n");

      if (previous && latest) {
        const encodedPackageName = encodePackageNameForRegistry(packageName);
        const diffUrl = `https://app.renovatebot.com/package-diff?name=${encodedPackageName}&from=${encodeURIComponent(previous)}&to=${encodeURIComponent(latest)}`;
        message += `\n\n**Package Diff:** [View diff](${diffUrl})`;
      }

      await sendDiscordNotification(discordWebhookUrl, message);
    } catch (e) {
      process.stderr.write(
        `[${nowIso()}] WARN Discord notification failed: ${getErrorMessage(e)}\n`,
      );
    }
  }

  // Create GitHub issues for each alert
  if (githubToken && packument.repository?.url) {
    for (const alert of alerts) {
      try {
        await createGitHubIssue(
          githubToken,
          packument.repository.url,
          packageName,
          latest,
          alert.scriptType,
          alert.latestCmd,
          previous,
          alert.action === "changed" ? alert.prevCmd : null,
        );
      } catch (e) {
        process.stderr.write(
          `[${nowIso()}] WARN GitHub issue creation failed: ${getErrorMessage(e)}\n`,
        );
      }
    }
  }
}
