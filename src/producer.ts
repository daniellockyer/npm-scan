/**
 * npm preinstall/postinstall monitor - Producer
 *
 * Polls npm's replicate `_changes` endpoint and adds packages to a BullMQ queue
 * for processing by workers.
 */

import "dotenv/config";
import { setTimeout as delay } from "node:timers/promises";
import { packageQueue, type PackageJobData } from "./queue.ts";

const DEFAULT_REPLICATE_DB_URL = "https://replicate.npmjs.com/";
const DEFAULT_CHANGES_URL = "https://replicate.npmjs.com/_changes";

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

function nowIso(): string {
  return new Date().toISOString();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
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
        "User-Agent": "npm-scan-preinstall-postinstall-monitor",
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

async function run(): Promise<void> {
  const replicateDbUrl =
    process.env.NPM_REPLICATE_DB_URL || DEFAULT_REPLICATE_DB_URL;
  const changesUrl = process.env.NPM_CHANGES_URL || DEFAULT_CHANGES_URL;

  const changesLimit = Math.max(
    1,
    Math.min(5000, Number(process.env.CHANGES_LIMIT || 200)),
  );
  const pollMs = Math.max(250, Number(process.env.POLL_MS || 1500));

  let since: string | number | null = null;
  let backoffMs = 1000;

  since = await getInitialSince(replicateDbUrl);
  process.stdout.write(
    `[${nowIso()}] Producer starting: changes=${changesUrl} since=${since} limit=${changesLimit}\n`,
  );

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

        try {
          // Add job to queue - worker will handle version detection
          const jobData: PackageJobData = {
            packageName: name,
          };

          await packageQueue.add("scan-package", jobData, {
            jobId: name, // Use package name as job ID
            delay: 60000, // Delay 60 seconds before processing
          });

          process.stdout.write(`[${nowIso()}] Queued: ${name}\n`);
        } catch (e) {
          process.stderr.write(
            `[${nowIso()}] WARN failed to queue ${name}: ${getErrorMessage(e)}\n`,
          );
        }
      }

      since = changes.last_seq;

      if (changes.results.length === 0) {
        await delay(pollMs);
      }
    } catch (err) {
      process.stderr.write(
        `[${nowIso()}] poll error: ${getErrorMessage(err)}; retrying in ${backoffMs}ms\n`,
      );
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }
}

run().catch((e) => {
  const errorMessage =
    e instanceof Error && e.stack ? e.stack : getErrorMessage(e);
  process.stderr.write(`[${nowIso()}] fatal: ${errorMessage}\n`);
  process.exitCode = 1;
  process.exit(1);
});
