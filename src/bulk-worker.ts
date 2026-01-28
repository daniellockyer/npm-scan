/**
 * Bulk package metadata fetcher - Worker
 *
 * Processes packages from queue at 1 per second, fetches metadata from npm registry,
 * and writes it to disk.
 */

import "dotenv/config";
import { Worker } from "bullmq";
import { fetchPackument, type Packument } from "./lib/fetch-packument.ts";
import {
  DEFAULT_OUTPUT_DIR,
  nowIso,
  getErrorMessage,
  ensureOutputDir,
  writeMetadataToFile,
} from "./lib/utils.ts";

interface PackageJobData {
  packageName: string;
}

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.com/";

async function processPackage(job: { data: PackageJobData }): Promise<void> {
  const { packageName } = job.data;
  const registryBaseUrl = process.env.NPM_REGISTRY_URL || DEFAULT_REGISTRY_URL;
  const outputDir = process.env.OUTPUT_DIR || DEFAULT_OUTPUT_DIR;

  await ensureOutputDir(outputDir);

  process.stdout.write(`[${nowIso()}] Processing: ${packageName}\n`);

  let packument: Packument;
  try {
    packument = await fetchPackument(registryBaseUrl, packageName);
  } catch (e) {
    throw new Error(
      `packument fetch failed for ${packageName}: ${getErrorMessage(e)}`,
    );
  }

  try {
    await writeMetadataToFile(packageName, packument, outputDir);
    process.stdout.write(
      `[${nowIso()}] ✓ Wrote metadata for ${packageName}\n`,
    );
  } catch (e) {
    throw new Error(
      `failed to write metadata for ${packageName}: ${getErrorMessage(e)}`,
    );
  }
}

const connection = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
};

const worker = new Worker<PackageJobData>(
  "bulk-package-metadata",
  async (job) => {
    await processPackage(job);
  },
  {
    connection,
    concurrency: 1, // Process one at a time
    limiter: {
      max: 10, // 10 jobs per second
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
  `[${nowIso()}] Bulk worker started: processing at 1 package/second\n`,
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
