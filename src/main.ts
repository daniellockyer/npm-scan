import "dotenv/config";
import { startProducer } from "./producer.ts";
import { processPackage } from "./worker.ts";
import { packageQueue } from "./lib/in-memory-queue.ts";

function nowIso(): string {
  return new Date().toISOString();
}

async function main() {
  console.log(`[${nowIso()}] Starting application...`);

  // Start the worker processing
  packageQueue.process(processPackage);
  console.log(`[${nowIso()}] Worker started.`);

  // Start the producer
  await startProducer();
}

main().catch((e) => {
  const errorMessage = e instanceof Error && e.stack ? e.stack : String(e);
  console.error(`[${nowIso()}] fatal: ${errorMessage}\n`);
  process.exitCode = 1;
});
