/**
 * 极简离线外壳 Service Worker。
 * 仅缓存应用外壳（HTML/JS/CSS/图标），让 PWA 二次打开可离线进入；
 * API 请求（/api/）始终走网络，不缓存，避免展示陈旧归因结果。
 * 注册逻辑见 apps/web/index.html。
 */
const CACHE = 'aicorr-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // API 与上传永远走网络
  if (url.pathname.startsWith('/api/')) return;

  // 应用外壳：优先网络，失败回退缓存（离线进入）
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
  );
});
