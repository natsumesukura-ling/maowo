// 让猫窝可以「添加到主屏幕」。不缓存任何东西：页面和数据都直接从服务器取。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
