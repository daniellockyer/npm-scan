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
  githubToken: string,
  repoUrl: string,
  packageName: string,
  packageVersion: string,
  scriptType: "preinstall" | "postinstall",
  scriptContent: string,
  previousVersion: string | null = null,
  previousScriptContent: string | null = null,
  diffOutput: string | null = null,
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

  if (diffOutput) {
    const diffLines = diffOutput.split('\n').slice(0, 10);
    const truncatedDiff = diffLines.join('\n');
    const isTruncated = diffOutput.split('\n').length > 10;
    issueBody += `

**Package Diff (${previousVersion} → ${packageVersion}):**
\`\`\`diff
${truncatedDiff}${isTruncated ? '\n\n... (truncated)' : ''}
\`\`\`
`;
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
  diffOutput: string | null = null,
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
        const scriptLabel = alert.scriptType.charAt(0).toUpperCase() + alert.scriptType.slice(1);
        const escapedCmd = alert.latestCmd.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        if (alert.action === "added") {
          return `• <b>${scriptLabel} added:</b> <code>${escapedCmd}</code>`;
        } else {
          const escapedPrev = (alert.prevCmd ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          return `• <b>${scriptLabel} changed:</b>\n  Previous: <code>${escapedPrev}</code>\n  New: <code>${escapedCmd}</code>`;
        }
      });

      let message =
        `🚨 <b>Security Alert: ${alerts.length} script change${alerts.length > 1 ? "s" : ""} detected</b>\n\n` +
        `<code>${packageName}</code> <a href="${npmPackageUrl}">View on npm</a>\n` +
        `${previous ?? "none"} → ${latest}\n\n` +
        alertParts.join("\n\n");

      if (diffOutput) {
        const diffLines = diffOutput.split('\n').slice(0, 10);
        const truncatedDiff = diffLines.join('\n');
        const isTruncated = diffOutput.split('\n').length > 10;
        message += `\n\n<b>Package Diff (${previous} → ${latest}):</b>\n` +
          `<pre><code>${truncatedDiff}${isTruncated ? '\n\n... (truncated)' : ''}</code></pre>`;
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
        const scriptLabel = alert.scriptType.charAt(0).toUpperCase() + alert.scriptType.slice(1);
        if (alert.action === "added") {
          return `• **${scriptLabel} added:** \`\`\`${alert.latestCmd}\`\`\``;
        } else {
          return `• **${scriptLabel} changed:**\n  Previous: \`\`\`${alert.prevCmd ?? ""}\`\`\`\n  New: \`\`\`${alert.latestCmd}\`\`\``;
        }
      });

      let message =
        `🚨 **Security Alert: ${alerts.length} script change${alerts.length > 1 ? "s" : ""} detected**\n\n` +
        `\`${packageName}\` [View on npm](${npmPackageUrl})\n` +
        `${previous ?? "none"} → ${latest}\n\n` +
        alertParts.join("\n\n");

      if (diffOutput) {
        const diffLines = diffOutput.split('\n').slice(0, 10);
        const truncatedDiff = diffLines.join('\n');
        const isTruncated = diffOutput.split('\n').length > 10;
        message += `\n\n**Package Diff (${previous} → ${latest}):**\n` +
          `\`\`\`diff\n${truncatedDiff}${isTruncated ? '\n\n... (truncated)' : ''}\n\`\`\``;
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
          diffOutput,
        );
      } catch (e) {
        process.stderr.write(
          `[${nowIso()}] WARN GitHub issue creation failed: ${getErrorMessage(e)}\n`,
        );
      }
    }
  }
}
