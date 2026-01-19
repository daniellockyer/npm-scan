/**
 * npm preinstall/postinstall monitor
 *
 * Polls npm's replicate `_changes` endpoint and flags new publishes that
 * introduce a `scripts.preinstall` or `scripts.postinstall` entry.
 *
 * Notes:
 * - `replicate.npmjs.com` currently rejects streaming feeds (`feed=continuous`)
 *   and `include_docs`, so this script uses the normal `_changes` feed and
 *   fetches package metadata from `registry.npmjs.org` to inspect scripts.
 */

import "dotenv/config";
import { setTimeout as delay } from "node:timers/promises";
import pLimit from "p-limit";
import semver from "semver";

const DEFAULT_REPLICATE_DB_URL = "https://replicate.npmjs.com/";
const DEFAULT_CHANGES_URL = "https://replicate.npmjs.com/_changes";
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/";

interface VersionDoc {
  scripts?: {
    preinstall?: string;
    postinstall?: string;
    [key: string]: string | undefined;
  };
  [key: string]: unknown;
}

interface Packument {
  versions?: Record<string, VersionDoc>;
  "dist-tags"?: {
    latest?: string;
    [key: string]: string | undefined;
  };
  repository?: {
    url: string;
  };
  [key: string]: unknown;
}

interface ChangesResult {
  id: string;
  [key: string]: unknown;
}

interface ChangesResponse {
  results: ChangesResult[];
  last_seq: string | number;
  [key: string]: unknown;
}

interface DbInfo {
  update_seq: string | number;
  [key: string]: unknown;
}

interface VersionResult {
  latest: string | null;
  previous: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
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

function hasPostinstall(versionDoc: unknown): boolean {
  return hasScript(versionDoc, "postinstall");
}

function hasPreinstall(versionDoc: unknown): boolean {
  return hasScript(versionDoc, "preinstall");
}

function pickLatestAndPreviousVersions(doc: unknown): VersionResult {
  const packument = doc as Packument;
  const versions =
    packument.versions && typeof packument.versions === "object"
      ? packument.versions
      : null;
  const distTags =
    packument["dist-tags"] && typeof packument["dist-tags"] === "object"
      ? packument["dist-tags"]
      : null;

  if (!versions) return { latest: null, previous: null };

  // Prefer dist-tags.latest for the "current" publish signal.
  const latest =
    distTags && typeof distTags.latest === "string" ? distTags.latest : null;

  if (!latest || !versions[latest]) {
    return { latest: null, previous: null };
  }

  // Find the highest previous version using semver comparison.
  // Only consider versions that are smaller than the latest version.
  const versionKeys = Object.keys(versions).filter((v) =>
    isLikelyVersionKey(v),
  );
  const sortedVersions = versionKeys
    .filter((v) => {
      if (v === latest) return false;
      // Only include versions that are smaller than latest
      const comparison = semver.compare(v, latest);
      return comparison !== null && comparison < 0;
    })
    .sort((a, b) => {
      const comparison = semver.compare(b, a);
      return comparison !== null ? comparison : 0;
    });

  const previous = sortedVersions.length > 0 ? sortedVersions[0] : null;

  return { latest, previous };
}

async function httpGetJson<T = unknown>(
  url: string | URL,
  { headers }: { headers?: Record<string, string> } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "npm-check-preinstall-postinstall-monitor",
        Accept: "application/json",
        ...headers,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("request timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getInitialSince(
  replicateDbUrl: string,
): Promise<string | number> {
  const dbInfo = await httpGetJson<DbInfo>(replicateDbUrl);
  if (!dbInfo || typeof dbInfo.update_seq === "undefined") {
    throw new Error("replicate db info missing update_seq");
  }
  return dbInfo.update_seq;
}

function encodePackageNameForRegistry(name: string): string {
  // Scoped packages need the slash encoded: @scope%2Fpkg
  return encodeURIComponent(name);
}

async function fetchPackument(
  registryBaseUrl: string,
  name: string,
): Promise<Packument> {
  const url = new URL(encodePackageNameForRegistry(name), registryBaseUrl);
  return httpGetJson<Packument>(url);
}

async function sendTelegramNotification(
  botToken: string,
  chatId: string,
  message: string,
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Telegram notification timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sendDiscordNotification(
  webhookUrl: string,
  message: string,
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: message,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Discord notification timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function createGitHubIssue(
  githubToken: string,
  repoUrl: string,
  packageName: string,
  packageVersion: string,
  scriptType: "preinstall" | "postinstall",
  scriptContent: string,
): Promise<void> {
  const url = new URL(repoUrl);
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts.length < 2) {
    throw new Error(`Invalid GitHub repository URL: ${repoUrl}`);
  }
  const owner = pathParts[0];
  const repo = pathParts[1];
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues`;

  const issueTitle = `[Security Alert] New \`${scriptType}\` script added in \`${packageName}@${packageVersion}\``;
  const issueBody = `
A new \`${scriptType}\` script was detected in version \`${packageVersion}\` of the package \`${packageName}\`.

**Script content:**
\`\`\`
${scriptContent}
\`\`\`

This could be a security risk. Please investigate.
`;
  console.log(issueBody)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `token ${githubToken}`,
        Accept: "application/vnd.github.v3+json",
      },
      body: JSON.stringify({
        title: issueTitle,
        body: issueBody,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("GitHub issue creation timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function run(): Promise<void> {
  const replicateDbUrl =
    process.env.NPM_REPLICATE_DB_URL || DEFAULT_REPLICATE_DB_URL;
  const changesUrl = process.env.NPM_CHANGES_URL || DEFAULT_CHANGES_URL;
  const registryBaseUrl = process.env.NPM_REGISTRY_URL || DEFAULT_REGISTRY_URL;

  const maxConcurrency = Math.max(1, Number(process.env.MAX_CONCURRENCY || 10));
  const changesLimit = Math.max(
    1,
    Math.min(5000, Number(process.env.CHANGES_LIMIT || 200)),
  );
  const pollMs = Math.max(250, Number(process.env.POLL_MS || 1500));
  const maxCachePackages = 1000;

  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const githubToken = process.env.GITHUB_TOKEN;

  const flagged = new Set<string>(); // `${name}@${version}` flagged already
  const lastSeenLatest = new Map<string, string>(); // name -> latest version processed

  let since: string | number | null = null;
  let backoffMs = 1000;

  since = await getInitialSince(replicateDbUrl);
  process.stdout.write(
    `[${nowIso()}] starting poll: changes=${changesUrl} since=${since} limit=${changesLimit} concurrency=${maxConcurrency}\n`,
  );

  const limit = pLimit(maxConcurrency);

  // Run indefinitely.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const url = new URL(changesUrl);
      url.searchParams.set("since", String(since));
      url.searchParams.set("limit", String(changesLimit));

      const changes = await httpGetJson<ChangesResponse>(url);
      backoffMs = 1000;

      if (
        !changes ||
        !Array.isArray(changes.results) ||
        typeof changes.last_seq === "undefined"
      ) {
        throw new Error("unexpected _changes response shape");
      }

      for (const row of changes.results) {
        if (!row || typeof row.id !== "string") continue;
        const name = row.id;
        if (name.startsWith("_design/")) continue;

        limit(async () => {
          await delay(30000);

          let packument: Packument;
          try {
            packument = await fetchPackument(registryBaseUrl, name);
          } catch (e) {
            const errorMessage =
              e instanceof Error && e.message ? e.message : String(e);
            process.stderr.write(
              `[${nowIso()}] WARN packument fetch failed for ${name}: ${errorMessage}\n`,
            );
            return;
          }

          const { latest, previous } = pickLatestAndPreviousVersions(packument);
          if (!latest) return;

          const prevVersion = previous ? previous : "none";
          process.stdout.write(
            `[${nowIso()}] ${name}: ${prevVersion} -> ${latest}\n`,
          );

          const last = lastSeenLatest.get(name);
          if (last === latest) return;
          lastSeenLatest.set(name, latest);

          if (lastSeenLatest.size > maxCachePackages) {
            lastSeenLatest.clear();
            process.stderr.write(
              `[${nowIso()}] WARN package cache exceeded ${maxCachePackages}; cleared cache\n`,
            );
          }

          const versions =
            packument.versions && typeof packument.versions === "object"
              ? packument.versions
              : {};
          const latestDoc = versions[latest];
          const prevDoc = previous ? versions[previous] : null;

          const latestHasPostinstall = hasPostinstall(latestDoc);
          const latestHasPreinstall = hasPreinstall(latestDoc);
          if (!latestHasPostinstall && !latestHasPreinstall) return;

          const prevHasPostinstall = prevDoc ? hasPostinstall(prevDoc) : false;
          const prevHasPreinstall = prevDoc ? hasPreinstall(prevDoc) : false;

          // Check for postinstall
          if (latestHasPostinstall && !prevHasPostinstall) {
            const key = `${name}@${latest}:postinstall`;
            if (!flagged.has(key)) {
              flagged.add(key);

              const cmd =
                latestDoc && latestDoc.scripts && latestDoc.scripts.postinstall
                  ? latestDoc.scripts.postinstall
                  : "";
              const prevTxt = previous
                ? ` (prev: ${previous})`
                : " (first publish / unknown prev)";
              process.stdout.write(
                `[${nowIso()}] FLAG postinstall added: ${name}@${latest}${prevTxt}\n` +
                `  postinstall: ${JSON.stringify(cmd)}\n`,
              );

              // Send Telegram notification if configured
              if (telegramBotToken && telegramChatId) {
                try {
                  const message =
                    `🚨 <b>Postinstall script added</b>\n\n` +
                    `Package: <code>${name}@${latest}</code>\n` +
                    `Previous version: ${previous || "none"}\n` +
                    `Postinstall: <code>${cmd.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`;
                  await sendTelegramNotification(
                    telegramBotToken,
                    telegramChatId,
                    message,
                  );
                } catch (e) {
                  const errorMessage =
                    e instanceof Error && e.message ? e.message : String(e);
                  process.stderr.write(
                    `[${nowIso()}] WARN Telegram notification failed: ${errorMessage}\n`,
                  );
                }
              }

              // Send Discord notification if configured
              if (discordWebhookUrl) {
                try {
                  const message =
                    `🚨 **Postinstall script added**\n\n` +
                    `**Package:** \`${name}@${latest}\`\n` +
                    `**Previous version:** ${previous || "none"}\n` +
                    `**Postinstall:** \`\`\`${cmd}\`\`\``;
                  await sendDiscordNotification(discordWebhookUrl, message);
                } catch (e) {
                  const errorMessage =
                    e instanceof Error && e.message ? e.message : String(e);
                  process.stderr.write(
                    `[${nowIso()}] WARN Discord notification failed: ${errorMessage}\n`,
                  );
                }
              }

              // Create GitHub issue if configured
              if (githubToken && packument.repository?.url) {
                try {
                  await createGitHubIssue(
                    githubToken,
                    packument.repository.url,
                    name,
                    latest,
                    "postinstall",
                    cmd
                  );
                } catch (e) {
                  const errorMessage =
                    e instanceof Error && e.message ? e.message : String(e);
                  process.stderr.write(
                    `[${nowIso()}] WARN GitHub issue creation failed: ${errorMessage}\n`,
                  );
                }
              }
            }
          }

          // Check for preinstall
          if (latestHasPreinstall && !prevHasPreinstall) {
            const key = `${name}@${latest}:preinstall`;
            if (!flagged.has(key)) {
              flagged.add(key);

              const cmd =
                latestDoc && latestDoc.scripts && latestDoc.scripts.preinstall
                  ? latestDoc.scripts.preinstall
                  : "";
              const prevTxt = previous
                ? ` (prev: ${previous})`
                : " (first publish / unknown prev)";
              process.stdout.write(
                `[${nowIso()}] FLAG preinstall added: ${name}@${latest}${prevTxt}\n` +
                `  preinstall: ${JSON.stringify(cmd)}\n`,
              );

              // Send Telegram notification if configured
              if (telegramBotToken && telegramChatId) {
                try {
                  const message =
                    `🚨 <b>Preinstall script added</b>\n\n` +
                    `Package: <code>${name}@${latest}</code>\n` +
                    `Previous version: ${previous || "none"}\n` +
                    `Preinstall: <code>${cmd.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`;
                  await sendTelegramNotification(
                    telegramBotToken,
                    telegramChatId,
                    message,
                  );
                } catch (e) {
                  const errorMessage =
                    e instanceof Error && e.message ? e.message : String(e);
                  process.stderr.write(
                    `[${nowIso()}] WARN Telegram notification failed: ${errorMessage}\n`,
                  );
                }
              }
              
              // Send Discord notification if configured
              if (discordWebhookUrl) {
                try {
                  const message =
                    `🚨 **Preinstall script added**\n\n` +
                    `**Package:** \`${name}@${latest}\`\n` +
                    `**Previous version:** ${previous || "none"}\n` +
                    `**Preinstall:** \`\`\`${cmd}\`\`\``;
                  await sendDiscordNotification(discordWebhookUrl, message);
                } catch (e) {
                  const errorMessage =
                    e instanceof Error && e.message ? e.message : String(e);
                  process.stderr.write(
                    `[${nowIso()}] WARN Discord notification failed: ${errorMessage}\n`,
                  );
                }
              }

              // Create GitHub issue if configured
              if (githubToken && packument.repository?.url) {
                try {
                  await createGitHubIssue(
                    githubToken,
                    packument.repository.url,
                    name,
                    latest,
                    "preinstall",
                    cmd
                  );
                } catch (e) {
                  const errorMessage =
                    e instanceof Error && e.message ? e.message : String(e);
                  process.stderr.write(
                    `[${nowIso()}] WARN GitHub issue creation failed: ${errorMessage}\n`,
                  );
                }
              }
            }
          }
        }).catch(() => {
          // Errors are already logged in the limit function
        });
      }

      since = changes.last_seq;

      if (changes.results.length === 0) {
        await delay(pollMs);
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error && err.message ? err.message : String(err);
      process.stderr.write(
        `[${nowIso()}] poll error: ${errorMessage}; retrying in ${backoffMs}ms\n`,
      );
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }
}

run().catch((e) => {
  const errorMessage = e instanceof Error && e.stack ? e.stack : String(e);
  process.stderr.write(`[${nowIso()}] fatal: ${errorMessage}\n`);
  process.exitCode = 1;
});
