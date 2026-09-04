/**
 * Gateway-served Service Worker for the dedicated mobile page.
 *
 * ArkWeb (and some OEM WebView engines) do not reliably persist the HTTP disk
 * cache for the gateway's large gzip/chunked responses, so every page entry
 * re-downloads the full plugin/assets/mobile-boot payload. The worker below is
 * registered by the rewritten mobile index (opt-in `staticCacheWorker`) and
 * answers revisioned static URLs from Cache Storage — independent of the
 * engine's HTTP cache — with single-flight coalescing for the duplicate
 * fetches observed on real devices.
 *
 * Static URLs are content-addressed or revisioned by the server
 * (`/assets/<name>-<hash>.*`, `/plugins/*&rev=<hash>`, mobile-boot 64-hex
 * paths), so a cache hit is never stale. Entries older than a week are pruned
 * after each successful navigation to bound growth across releases.
 * @module dsh-mobile-sw-cache
 */

/** Worker script URL served at the gateway authentication prefix. */
export const SERVICE_WORKER_PATH = '/mobile-access/sw.js'

/** Worker body; served verbatim with a JavaScript content type. */
export const SERVICE_WORKER_SOURCE = `'use strict';
const CACHE_NAME = 'dshm-static-v1';
const MAX_STATIC_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STATIC_PREFIXES = ['/plugins/', '/assets/', '/mobile-access/mobile-boot/'];
const inflight = new Map();

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    const keys = await caches.keys();
    await Promise.all(keys.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
  })());
});

function isStaticPath(pathname) {
  return STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function acceptsGzip(request) {
  const value = request.headers.get('accept-encoding') ?? '';
  if (value.includes('gzip')) return true;
  return value.split(',').some((part) => part.trim().toLowerCase() === '*');
}

async function pruneStale(cache) {
  const entries = await cache.keys();
  const now = Date.now();
  for (const entry of entries) {
    const response = await cache.match(entry);
    if (response === undefined) continue;
    const stamped = response.headers.get('date');
    const age = stamped === null ? NaN : now - Date.parse(stamped);
    if (Number.isNaN(age) || age > MAX_STATIC_AGE_MS) await cache.delete(entry);
  }
}

async function serveStatic(request, url) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit !== undefined) return hit;
  const pending = inflight.get(url.href);
  if (pending !== undefined) return pending;
  const task = (async () => {
    const response = await fetch(request);
    if (response.ok) {
      try { await cache.put(request, response.clone()); } catch (error) { /* quota or storage failure: keep the network path */ }
    }
    return response;
  })();
  inflight.set(url.href, task);
  try { return await task; } finally { inflight.delete(url.href); }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const response = await fetch(request);
      if (response.ok) {
        caches.open(CACHE_NAME).then((cache) => pruneStale(cache)).catch(() => {});
      }
      return response;
    })());
    return;
  }
  if (!isStaticPath(url.pathname)) return;
  if (!acceptsGzip(request)) return;
  event.respondWith(serveStatic(request, url));
});`

/** Registration snippet injected into the rewritten mobile index. */
function serviceWorkerRegistrationScript(): string {
  const path = JSON.stringify(SERVICE_WORKER_PATH)
  return `(function(){if(!('serviceWorker'in navigator))return;var register=function(){return navigator.serviceWorker.register(${path},{scope:'/'}).catch(function(){})};if(document.readyState==='loading'){window.addEventListener('load',function(){void register()},{once:true})}else{void register()}})();`
}

/** Insert the registration snippet at the end of <head>; prepend when absent. */
export function injectServiceWorkerRegistration(html: string): string {
  const snippet = `<script>${serviceWorkerRegistrationScript()}</script>`
  const headEnd = html.indexOf('</head>')
  return headEnd < 0 ? snippet + html : html.slice(0, headEnd) + snippet + html.slice(headEnd)
}
