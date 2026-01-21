/**
 * BullMQ Queue Metrics Script
 *
 * Connects to a remote server via SSH, establishes a tunnel to Redis,
 * and produces comprehensive metrics and statistics for the BullMQ queue.
 */

import "dotenv/config";
import { Client } from "ssh2";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { createServer } from "net";

interface SSHTunnelConfig {
  host: string;
  port: number;
  username: string;
  agent: string; // SSH_AUTH_SOCK path
}

interface RedisConfig {
  host: string;
  port: number;
}

interface Metrics {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  paused: number;
  rateLimit?: {
    max: number;
    duration: number;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function formatNumber(num: number): string {
  return num.toLocaleString();
}

async function createSSHTunnel(
  sshConfig: SSHTunnelConfig,
  redisConfig: RedisConfig,
): Promise<{ localPort: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const server = createServer((localConn) => {
      conn.forwardOut(
        "127.0.0.1",
        0,
        redisConfig.host,
        redisConfig.port,
        (err, stream) => {
          if (err) {
            localConn.destroy();
            return;
          }
          localConn.pipe(stream).pipe(localConn);
        },
      );
    });

    server.listen(0, "127.0.0.1", () => {
      const localPort = (server.address() as { port: number }).port;

      conn.on("ready", () => {
        resolve({
          localPort,
          close: () => {
            conn.end();
            server.close();
          },
        });
      });

      conn.on("error", (err) => {
        reject(err);
      });

      conn.connect({
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        agent: sshConfig.agent,
      });
    });

    server.on("error", reject);
  });
}

async function getQueueMetrics(queue: Queue): Promise<Metrics> {
  const counts = await queue.getJobCounts();

  return {
    waiting: counts.waiting || 0,
    active: counts.active || 0,
    completed: counts.completed || 0,
    failed: counts.failed || 0,
    paused: counts.paused || 0,
    rateLimit: undefined, // Rate limiting is configured on Worker, not Queue
  };
}

function printMetrics(queueName: string, metrics: Metrics): void {
  console.log(`[${nowIso()}] ${queueName}: Waiting=${formatNumber(metrics.waiting)} Active=${formatNumber(metrics.active)} Paused=${formatNumber(metrics.paused)} Completed=${formatNumber(metrics.completed)} Failed=${formatNumber(metrics.failed)}${metrics.rateLimit ? ` RateLimit=${metrics.rateLimit.max}/${formatDuration(metrics.rateLimit.duration)}` : ""}`);
}

async function cleanup(
  queue: Queue | null,
  redis: Redis | null,
  tunnel: { localPort: number; close: () => void } | null,
): Promise<void> {
  if (queue) await queue.close().catch(() => {});
  if (redis) await redis.quit().catch(() => {});
  if (tunnel) tunnel.close();
}

async function main(): Promise<void> {
  // SSH Configuration
  const sshHost = process.env.SSH_HOST || process.env.SSH_SERVER;
  const sshPort = Number(process.env.SSH_PORT || 22);
  const sshUser = process.env.SSH_USER || process.env.SSH_USERNAME || "root";
  const sshAuthSock = process.env.SSH_AUTH_SOCK;

  // Redis Configuration (on remote server)
  const redisHost = process.env.REDIS_HOST || "localhost";
  const redisPort = Number(process.env.REDIS_PORT || 6379);

  // Queue Configuration
  const queueName = process.env.QUEUE_NAME || "package-scan";

  if (!sshHost) {
    console.error("Error: SSH_HOST must be set");
    console.error("\nRequired environment variables:");
    console.error("  SSH_HOST - Remote server hostname or IP");
    console.error("  SSH_AUTH_SOCK - SSH agent socket (default: uses $SSH_AUTH_SOCK)");
    console.error("\nOptional environment variables:");
    console.error("  SSH_USER - SSH username (default: root)");
    console.error("  SSH_PORT - SSH port (default: 22)");
    console.error("  REDIS_HOST - Redis host on remote server (default: localhost)");
    console.error("  REDIS_PORT - Redis port on remote server (default: 6379)");
    console.error("  QUEUE_NAME - BullMQ queue name (default: package-scan)");
    process.exit(1);
  }

  if (!sshAuthSock) {
    console.error("Error: SSH_AUTH_SOCK must be set");
    console.error("  The script requires SSH agent authentication.");
    console.error("  Make sure ssh-agent is running and SSH_AUTH_SOCK is set.");
    console.error("  You can check with: echo $SSH_AUTH_SOCK");
    process.exit(1);
  }

  let tunnel: { localPort: number; close: () => void } | null = null;
  let redis: Redis | null = null;
  let queue: Queue | null = null;

  try {
    tunnel = await createSSHTunnel(
      {
        host: sshHost,
        port: sshPort,
        username: sshUser,
        agent: sshAuthSock,
      },
      {
        host: redisHost,
        port: redisPort,
      },
    );

    // Connect to Redis through tunnel
    redis = new Redis({
      host: "127.0.0.1",
      port: tunnel.localPort,
      maxRetriesPerRequest: null,
      retryStrategy: () => null, // Don't retry on connection errors
    });

    await redis.ping();

    const redisConnection = {
      host: "127.0.0.1",
      port: tunnel.localPort,
      maxRetriesPerRequest: null,
    };

    queue = new Queue(queueName, { connection: redisConnection });

    const printMetricsLoop = async () => {
      try {
        const metrics = await getQueueMetrics(queue!);
        printMetrics(queueName, metrics);
      } catch (error) {
        console.error(`[${nowIso()}] Error fetching metrics:`, error);
      }
    };

    await printMetricsLoop();
    const intervalId = setInterval(printMetricsLoop, 5000);

    const shutdown = async () => {
      clearInterval(intervalId);
      await cleanup(queue, redis, tunnel);
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error(`[${nowIso()}] Error:`, error);
    await cleanup(queue, redis, tunnel);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[${nowIso()}] Fatal error:`, error);
  process.exit(1);
});
