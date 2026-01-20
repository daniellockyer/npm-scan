/**
 * MVP script to fetch packument for a package
 * Usage: npm run fetch-packument <package-name>
 */

import "dotenv/config";

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/";

interface Packument {
  name?: string;
  versions?: Record<string, unknown>;
  "dist-tags"?: {
    latest?: string;
    [key: string]: string | undefined;
  };
  [key: string]: unknown;
}

function encodePackageNameForRegistry(name: string): string {
  return encodeURIComponent(name);
}

async function fetchPackument(
  registryBaseUrl: string,
  name: string,
): Promise<Packument> {
  const encodedName = encodePackageNameForRegistry(name);
  const url = `${registryBaseUrl.replace(/\/$/, "")}/${encodedName}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const packument = await response.json();
    return packument as Packument;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("packument fetch timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

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
    const errorMessage =
      error instanceof Error ? error.message : String(error);
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
