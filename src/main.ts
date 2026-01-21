import "dotenv/config";
import Piscina from "piscina";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startProducer } from "./producer.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (process.env.GITHUB_ACTIONS === 'true') {
  console.log("Exécution dans une GitHub Action : activation du timeout de 5 minutes.");

  setTimeout(() => {
    console.log("Arrêt du script après 5 minutes (GitHub Action).");
    process.exit(0); // Arrête le processus avec succès
  }, 300000); // 300 000 ms = 5 minutes
} else {
  console.log("Exécution locale : pas de timeout activé.");
}


function nowIso(): string {
  return new Date().toISOString();
}

async function main() {
  console.log(`[${nowIso()}] Starting application...`);

  const piscina = new Piscina({
    filename: path.resolve(__dirname, "piscina-worker.ts"),
  });

  console.log(`[${nowIso()}] Worker pool started.`);

  // Start the producer
  await startProducer(piscina);
}

main().catch((e) => {
  const errorMessage = e instanceof Error && e.stack ? e.stack : String(e);
  console.error(`[${nowIso()}] fatal: ${errorMessage}\n`);
  process.exitCode = 1;
});
