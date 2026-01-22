/**
 * npm preinstall/postinstall monitor - Producer
 *
 * Polls npm's replicate `_changes` endpoint and adds packages to a BullMQ queue
 * for processing by workers.
 */

import "dotenv/config";
import Piscina from "piscina";
import { setTimeout as delay } from "node:timers/promises";
  let is_shutting_down = false;
import { savePendingTask, removePendingTask,getPendingTasks } from "./lib/pending-db.ts";
export interface PackageJobData {
  packageName: string;
}

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
const shutdown = () => {
    if (!is_shutting_down) {
      is_shutting_down = true;
      process.stdout.write(`[${nowIso()}] Producer shutting down...\n`);
    }
  }
export { shutdown };
export async function startProducer(piscina: Piscina): Promise<void> {
   
   (async () => {
    const list = await getPendingTasks();
  for await (const num of list) {
    console.log(num);
    // Expected output: 1
    await piscina.run(num).catch(err => {
            console.error(`[${nowIso()}] Piscina task failed for ${num.packageName  }: ${getErrorMessage(err)}`);
          });
          continue
    // Closes iterator, triggers return
  }
})();
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
  while (!is_shutting_down) {
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
      console.log(`[${nowIso()}] Fetched ${changes.results.length} changes since ${since}.`);
      for (const row of changes.results) {
        if (!row || typeof row.id !== "string") continue;
        console.log(`[${nowIso()}] Queuing package: ${JSON.stringify(row)}`);
        const name = row.id;
        if (name.startsWith("_design/")) continue;

        try {
          const jobData: PackageJobData = {
            packageName: name,
          };
            await savePendingTask({
                packageName: jobData.packageName,
                version: "latest", // or a more specific version if available
                timestamp: nowIso(),
              });
             process.stdout.write(`[${nowIso()}] Added to pending queue: ${jobData.packageName}\n`);
         // process.stdout.write(`[${nowIso()}] Queued: ${name}\n`);
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
  };
   if (process.env.GITHUB_ACTIONS !== 'true') {
   (async () => {
    const list = await getPendingTasks();
  for await (const num of list) {
    console.log(num);
    // Expected output: 1
    await piscina.run(num).catch(err => {
            console.error(`[${nowIso()}] Piscina task failed for ${num.packageName  }: ${getErrorMessage(err)}`);
          }).then(() => {
            process.stdout.write(`[${nowIso()}] Finished processing: ${num.packageName}\n`);
            return
          });
          continue
    // Closes iterator, triggers return
  }
})();
   }
 
  process.stdout.write(`[${nowIso()}] Producer has shut down.\n`);
  return
    
}


