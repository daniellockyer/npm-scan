/**
 * MVP script to fetch packument for a package
 * Usage: npm run fetch-packument <package-name>
 */

import "dotenv/config";
import { fetchPackument } from "./lib/fetch-packument.ts";

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/";

async function main(): Promise<void> {
  const packageName = process.argv[2];

  if (!packageName) {
    console.error("Usage: npm run fetch-packument <package-name>");
    process.exit(1);
  }

  const registryBaseUrl = process.env.NPM_REGISTRY_URL || DEFAULT_REGISTRY_URL;

  try {
    const packument = await fetchPackument(registryBaseUrl, packageName);
    console.log(JSON.stringify(packument, null, 2));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error fetching packument: ${errorMessage}`);
    process.exit(1);
  }
}

main().catch((error) => {
  const errorMessage =
    error instanceof Error && error.stack ? error.stack : String(error);
  console.error(`Fatal error: ${errorMessage}`);
  process.exit(1);
});
