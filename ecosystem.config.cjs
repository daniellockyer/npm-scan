/**
 * PM2 ecosystem config for npm-scan.
 *
 * On the server:
 *   pm2 startOrReload ecosystem.config.cjs --env production
 *   pm2 save
 */

"use strict";

const path = require("path");

module.exports = {
  apps: [
    {
      name: process.env.PM2_APP_NAME_PRODUCER || "npm-scan-producer",
      script: path.join(__dirname, "src", "producer.ts"),
      interpreter: "node",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 2000,
      env: {
        NODE_ENV: "production",
        REDIS_HOST: process.env.REDIS_HOST || "localhost",
        REDIS_PORT: process.env.REDIS_PORT || "6379",
        NPM_REPLICATE_DB_URL: process.env.NPM_REPLICATE_DB_URL || "",
        NPM_CHANGES_URL: process.env.NPM_CHANGES_URL || "",
        NPM_REGISTRY_URL: process.env.NPM_REGISTRY_URL || "",
        CHANGES_LIMIT: process.env.CHANGES_LIMIT || "200",
        POLL_MS: process.env.POLL_MS || "1500",
      },
    },
    {
      name: process.env.PM2_APP_NAME_WORKER || "npm-scan-worker",
      script: path.join(__dirname, "src", "worker.ts"),
      interpreter: "node",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 2000,
      instances: process.env.WORKER_INSTANCES || 5,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        REDIS_HOST: process.env.REDIS_HOST || "localhost",
        REDIS_PORT: process.env.REDIS_PORT || "6379",
        NPM_REGISTRY_URL: process.env.NPM_REGISTRY_URL || "",
        WORKER_CONCURRENCY: process.env.WORKER_CONCURRENCY || "5",
        WORKER_MAX_JOBS_PER_SECOND:
          process.env.WORKER_MAX_JOBS_PER_SECOND || "10",
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
        DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || "",
        GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
      },
    },
  ],
};
