/**
 * PM2 ecosystem config for npm-check.
 *
 * On the server:
 *   pm2 startOrReload ecosystem.config.cjs --env production
 *   pm2 save
 */

'use strict';

module.exports = {
  apps: [
    {
      name: process.env.PM2_APP_NAME || 'npm-check',
      script: 'src/index.js',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};

