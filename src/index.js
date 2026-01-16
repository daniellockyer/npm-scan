/**
 * npm postinstall monitor
 *
 * Streams npm's CouchDB changes feed and flags new publishes that introduce
 * a `scripts.postinstall` entry.
 *
 * Data source: https://replicate.npmjs.com/_changes
 */

'use strict';

const https = require('node:https');
const { setTimeout: delay } = require('node:timers/promises');

const DEFAULT_ENDPOINT =
  'https://replicate.npmjs.com/_changes?feed=continuous&include_docs=true&since=now&heartbeat=60000';

function nowIso() {
  return new Date().toISOString();
}

function isLikelyVersionKey(key) {
  // Basic semver-ish guard; npm time keys are usually exact versions.
  return typeof key === 'string' && /^\d+\.\d+\.\d+.*$/.test(key);
}

function hasPostinstall(versionDoc) {
  if (!versionDoc || typeof versionDoc !== 'object') return false;
  const scripts = versionDoc.scripts;
  if (!scripts || typeof scripts !== 'object') return false;
  const val = scripts.postinstall;
  return typeof val === 'string' && val.trim().length > 0;
}

function pickLatestAndPreviousVersions(doc) {
  const versions = doc && doc.versions && typeof doc.versions === 'object' ? doc.versions : null;
  const time = doc && doc.time && typeof doc.time === 'object' ? doc.time : null;
  const distTags =
    doc && doc['dist-tags'] && typeof doc['dist-tags'] === 'object' ? doc['dist-tags'] : null;

  if (!versions) return { latest: null, previous: null };

  // Prefer dist-tags.latest for the "current" publish signal.
  const latest = distTags && typeof distTags.latest === 'string' ? distTags.latest : null;

  // Try to find the previous version using publish times.
  let previous = null;
  if (time) {
    const entries = Object.entries(time)
      .filter(([k, v]) => isLikelyVersionKey(k) && typeof v === 'string')
      .map(([k, v]) => ({ version: k, t: Date.parse(v) }))
      .filter((x) => Number.isFinite(x.t))
      .sort((a, b) => b.t - a.t);

    if (entries.length > 0) {
      const effectiveLatest = latest && versions[latest] ? latest : entries[0].version;
      const prevEntry = entries.find((e) => e.version !== effectiveLatest);
      previous = prevEntry ? prevEntry.version : null;
      return { latest: effectiveLatest, previous };
    }
  }

  // Fallback: if we can't use time, just use dist-tag latest and no previous.
  return { latest: latest && versions[latest] ? latest : null, previous: null };
}

function parseNdjsonLines(chunk, state, onLine) {
  state.buffer += chunk.toString('utf8');

  // Protect against runaway buffering (e.g., if we miss newlines somehow).
  const MAX_BUFFER = 50 * 1024 * 1024; // 50MB
  if (state.buffer.length > MAX_BUFFER) {
    state.buffer = '';
    process.stderr.write(`[${nowIso()}] WARN buffer exceeded ${MAX_BUFFER} bytes; reset\n`);
    return;
  }

  let idx;
  while ((idx = state.buffer.indexOf('\n')) >= 0) {
    const line = state.buffer.slice(0, idx).trim();
    state.buffer = state.buffer.slice(idx + 1);
    if (!line) continue; // heartbeat
    onLine(line);
  }
}

async function run() {
  const endpoint = process.env.NPM_CHANGES_URL || DEFAULT_ENDPOINT;
  const processed = new Set(); // `${name}@${version}`
  let since = null; // last seq, used on reconnect
  let backoffMs = 1000;

  process.stdout.write(`[${nowIso()}] starting stream: ${endpoint}\n`);

  // Run indefinitely.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = new URL(endpoint);
    if (since != null) url.searchParams.set('since', String(since));

    const state = { buffer: '' };

    try {
      await new Promise((resolve, reject) => {
        const req = https.request(
          url,
          {
            method: 'GET',
            headers: {
              'User-Agent': 'npm-check-postinstall-monitor',
              Accept: 'application/json'
            },
            timeout: 120000
          },
          (res) => {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode || 0}`));
              res.resume();
              return;
            }

            backoffMs = 1000; // reset on successful connect
            res.setEncoding('utf8');

            res.on('data', (chunk) => {
              parseNdjsonLines(chunk, state, (line) => {
                let msg;
                try {
                  msg = JSON.parse(line);
                } catch {
                  process.stderr.write(`[${nowIso()}] WARN failed JSON parse\n`);
                  return;
                }

                if (msg && typeof msg.seq !== 'undefined') since = msg.seq;
                if (!msg || !msg.doc || !msg.id) return;

                const name = msg.id;
                const doc = msg.doc;
                const { latest, previous } = pickLatestAndPreviousVersions(doc);
                if (!latest) return;

                const key = `${name}@${latest}`;
                if (processed.has(key)) return;
                processed.add(key);

                const versions = doc.versions && typeof doc.versions === 'object' ? doc.versions : {};
                const latestDoc = versions[latest];
                const prevDoc = previous ? versions[previous] : null;

                const latestHas = hasPostinstall(latestDoc);
                if (!latestHas) return;

                const prevHas = prevDoc ? hasPostinstall(prevDoc) : false;
                if (!prevHas) {
                  const cmd = latestDoc && latestDoc.scripts ? latestDoc.scripts.postinstall : '';
                  const prevTxt = previous ? ` (prev: ${previous})` : ' (first publish / unknown prev)';
                  process.stdout.write(
                    `[${nowIso()}] FLAG postinstall added: ${name}@${latest}${prevTxt}\n` +
                      `  postinstall: ${JSON.stringify(cmd)}\n`
                  );
                }
              });
            });

            res.on('end', () => resolve());
            res.on('error', (e) => reject(e));
          }
        );

        req.on('timeout', () => {
          req.destroy(new Error('request timeout'));
        });
        req.on('error', (e) => reject(e));
        req.end();
      });
    } catch (err) {
      process.stderr.write(
        `[${nowIso()}] stream error: ${err && err.message ? err.message : String(err)}; reconnecting in ${backoffMs}ms\n`
      );
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }
}

run().catch((e) => {
  process.stderr.write(`[${nowIso()}] fatal: ${e && e.stack ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});

