#!/usr/bin/env node
// Probe harness for the two reference apps (chirper, starter).
//
//   node tools/probe.mjs --target prod            read-only checks
//   node tools/probe.mjs --target beta --rw       adds write-path checks
//   node tools/probe.mjs --chirper URL --starter URL [--rw]
//
// --rw registers a throwaway account, posts a chirp with a photo through the
// multipart bridge, and round-trips the bytes back out of /storage. It is
// refused against prod: the live site is never written to by tooling.
//
// Exit code 0 = every check passed. The wrangler exit code lies; this is the
// deploy gate.

// Named targets come from tools/probe.targets.json (untracked; see
// probe.targets.example.json). Explicit --chirper/--starter URLs always work.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGETS = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'probe.targets.json')));
  } catch {
    return {};
  }
})();

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const has = (name) => args.includes(name);

const target = flag('--target');
const bases = {
  chirper: flag('--chirper') ?? TARGETS[target]?.chirper,
  starter: flag('--starter') ?? TARGETS[target]?.starter,
};
const rw = has('--rw');

if (!bases.chirper && !bases.starter) {
  console.error('usage: probe.mjs --target prod|beta [--rw] | --chirper URL --starter URL [--rw]');
  process.exit(2);
}
if (rw && target === 'prod') {
  console.error('refusing --rw against prod: the live site is read-only for tooling');
  process.exit(2);
}

// ---------------------------------------------------------------- utilities

let failures = 0;
let checks = 0;

function report(ok, label, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? '  ok ' : 'FAIL '} ${label}${detail ? `  (${detail})` : ''}`);
}

class Jar {
  #cookies = new Map();
  absorb(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get(name) {
    return this.#cookies.get(name);
  }
}

async function req(jar, url, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  const cookie = jar.header();
  if (cookie) headers.cookie = cookie;
  const res = await fetch(url, { redirect: 'manual', ...options, headers });
  jar.absorb(res);
  return res;
}

function csrfFrom(html) {
  return html.match(/name="_token"\s+value="([^"]+)"/)?.[1]
    ?? html.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1];
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('hex');
}

// A real 1x1 PNG: the upload must survive getimagesize() inside the wasm.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// ---------------------------------------------------------- read-only suite

async function readOnly(name, base, { livewire = false } = {}) {
  console.log(`\n== ${name} (${base}) read-only ==`);
  const jar = new Jar();

  const t0 = performance.now();
  let home;
  try {
    home = await req(jar, `${base}/`);
  } catch (e) {
    report(false, `${name} GET / reachable`, String(e));
    return null;
  }
  const ms = Math.round(performance.now() - t0);
  const html = await home.text();
  report(home.status === 200, `${name} GET / is 200`, `${home.status}, ${ms}ms`);
  report(ms < 30000, `${name} first response under 30s`, `${ms}ms`);
  if (ms > 10000) console.log(`       note: ${ms}ms is slow for a cold isolate — inspect`);

  const again = await req(jar, `${base}/`);
  report(again.status === 200, `${name} second GET / with cookies is 200`, `${again.status}`);

  for (const path of ['/app.zip', '/app%2Ezip', '/APP.ZIP']) {
    const res = await req(jar, `${base}${path}`);
    const head = Buffer.from((await res.arrayBuffer()).slice(0, 2)).toString('latin1');
    report(res.status === 404 && head !== 'PK', `${name} ${path} denied`, `${res.status}`);
  }

  const asset = html.match(/\/build\/assets\/[a-zA-Z0-9._-]+\.(?:css|js)/)?.[0];
  if (asset) {
    const a1 = await req(jar, `${base}${asset}`);
    const etag = a1.headers.get('etag');
    report(a1.status === 200, `${name} asset ${asset} is 200`, `${a1.status}`);
    if (etag) {
      const a2 = await req(jar, `${base}${asset}`, { headers: { 'if-none-match': etag } });
      report(a2.status === 304, `${name} conditional asset GET is 304`, `${a2.status}`);
    } else {
      report(false, `${name} asset carries an ETag`);
    }
  }

  if (livewire) {
    for (const page of ['/login', '/register']) {
      const res = await req(jar, `${base}${page}`);
      report(res.status === 200, `${name} GET ${page} is 200`, `${res.status}`);
      if (page === '/login') {
        const body = await res.text();
        const script = body.match(/\/livewire-[0-9a-f]+\/livewire[\w.-]*\.js[^"']*/)?.[0];
        report(!!script, `${name} login page references a Livewire script`, script ?? 'not found');
        if (script) {
          const js = await req(jar, `${base}${script}`);
          report(
            js.status === 200 && /javascript/.test(js.headers.get('content-type') ?? ''),
            `${name} Livewire script serves`,
            `${js.status} ${js.headers.get('content-type')}`,
          );
        }
      }
    }
  }

  return { jar, html };
}

// --------------------------------------------------------- write-path suite

async function writePath(base) {
  console.log(`\n== chirper (${base}) write-path ==`);
  const jar = new Jar();
  const runId = crypto.randomUUID().slice(0, 8);

  // Register a throwaway user. Succeeding at all proves the session survives
  // between the form GET and the POST (secret-injection timing guard).
  const form = await req(jar, `${base}/register`);
  const formHtml = await form.text();
  const token = csrfFrom(formHtml);
  report(form.status === 200 && !!token, 'register form + CSRF token', `${form.status}`);
  if (!token) return;

  const reg = await req(jar, `${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _token: token,
      name: `Probe ${runId}`,
      email: `probe-${runId}@example.test`,
      password: 'probe-password-1',
      password_confirmation: 'probe-password-1',
    }),
  });
  report(reg.status === 302, 'register POST redirects', `${reg.status}`);

  // Chirp with a photo through the multipart bridge. The message ends in a
  // sentinel suffix: the historical parser bug ate the last two bytes of every
  // part, so "-END" surviving into the SSR page is the regression guard. The
  // photo bytes round-trip out of /storage and must hash identical.
  const homeBefore = await req(jar, `${base}/`);
  const tokenTwo = csrfFrom(await homeBefore.text());
  report(!!tokenTwo, 'authed homepage has a CSRF token');
  if (!tokenTwo) return;

  const message = `probe ${runId} boundary-lookalike ------ INTACT-${runId}-END`;
  const body = new FormData();
  body.append('_token', tokenTwo);
  body.append('message', message);
  body.append('extra[]', 'array-field');
  body.append('photo', new Blob([PNG], { type: 'image/png' }), 'probe.png');

  const post = await req(jar, `${base}/chirps`, {
    method: 'POST',
    headers: { accept: 'application/json' },
    body,
  });
  report(post.status === 201, 'multipart chirp POST returns 201', `${post.status}`);

  const homeAfter = await req(jar, `${base}/`);
  const afterHtml = await homeAfter.text();
  report(afterHtml.includes(`INTACT-${runId}-END`), 'message survives byte-exact (sentinel suffix present)');

  const photoUrl = afterHtml.match(/\/storage\/chirp-photos\/[^"']+/)?.[0];
  report(!!photoUrl, 'chirp photo URL rendered', photoUrl ?? 'not found');
  if (photoUrl) {
    const photo = await req(jar, `${base}${photoUrl}`);
    const bytes = await photo.arrayBuffer();
    report(photo.status === 200, 'photo serves from /storage', `${photo.status}`);
    report(
      (await sha256(bytes)) === (await sha256(PNG)),
      'photo bytes hash identical after R2 round-trip',
      `${bytes.byteLength} bytes`,
    );
  }

  // Demo widgets: atomic DO counter, then the rate limiter must actually hold.
  const xsrf = decodeURIComponent(jar.get('XSRF-TOKEN') ?? '');
  const counter = await req(jar, `${base}/demo/counter`, {
    method: 'POST',
    headers: { 'x-xsrf-token': xsrf, accept: 'application/json' },
  });
  const clicks = counter.status === 200 ? (await counter.json()).clicks : null;
  report(counter.status === 200 && Number.isInteger(clicks), 'DO counter increments', `clicks=${clicks}`);

  let limited = null;
  for (let i = 0; i < 6; i++) {
    limited = await req(jar, `${base}/demo/limited`, {
      method: 'POST',
      headers: { 'x-xsrf-token': xsrf, accept: 'application/json' },
    });
    if (limited.status === 429) break;
  }
  report(
    limited?.status === 429 && !!limited.headers.get('retry-after'),
    'rate limiter returns 429 with Retry-After within 6 hits',
    `${limited?.status} retry-after=${limited?.headers.get('retry-after')}`,
  );
}

// -------------------------------------------------------------------- main

if (bases.chirper) await readOnly('chirper', bases.chirper);
if (bases.starter) await readOnly('starter', bases.starter, { livewire: true });
if (rw && bases.chirper) await writePath(bases.chirper);

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
