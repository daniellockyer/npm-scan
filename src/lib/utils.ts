import { promises as fs } from "fs";
import { join, dirname } from "path";
import { type Packument } from "./fetch-packument.ts";

export const DEFAULT_OUTPUT_DIR = "./metadata";

export function nowIso(): string {
  return new Date().toISOString();
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

export async function ensureOutputDir(outputDir: string): Promise<void> {
  try {
    await fs.access(outputDir);
  } catch {
    await fs.mkdir(outputDir, { recursive: true });
  }
}

export function getMetadataFilePath(
  packageName: string,
  outputDir: string,
): string {
  // Extract first two characters for folder structure
  // For scoped packages like @types/node, use the first two chars after @
  // For regular packages like react, use the first two chars
  const nameForFolder = packageName.startsWith("@")
    ? packageName.slice(1).split("/")[0] // Get scope name without @
    : packageName;

  // Get first two characters, pad with underscore if less than 2 chars
  const folderName = (nameForFolder.slice(0, 2) || "__").toLowerCase();

  // Create two-char folder path
  const folderPath = join(outputDir, folderName);

  // Sanitize package name for filesystem (handle scoped packages)
  const sanitizedName = packageName.replace(/[\/\\:*?"<>|]/g, "_");
  return join(folderPath, `${sanitizedName}.json`);
}

export async function writeMetadataToFile(
  packageName: string,
  metadata: Packument,
  outputDir: string,
): Promise<void> {
  const filePath = getMetadataFilePath(packageName, outputDir);
  const folderPath = dirname(filePath);

  await ensureOutputDir(folderPath);
  await fs.writeFile(filePath, JSON.stringify(metadata, null, 2), "utf-8");
}
