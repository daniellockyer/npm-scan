export interface Packument {
  name?: string;
  versions?: Record<string, unknown>;
  "dist-tags"?: {
    latest?: string;
    [key: string]: string | undefined;
  };
  repository?: {
    url: string;
  };
  [key: string]: unknown;
}

export function encodePackageNameForRegistry(name: string): string {
  return encodeURIComponent(name);
}

export async function fetchPackument(
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
