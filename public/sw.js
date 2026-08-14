const CACHE_NAME = 'finra-sec-cache-v1';

self.addEventListener('install', (event) => {
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then((cacheNames) => {
			return Promise.all(
				cacheNames
					.filter((name) => name !== CACHE_NAME)
					.map((name) => caches.delete(name))
			);
		})
	);
	self.clients.claim();
});

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);

	// Only cache GET requests
	if (event.request.method !== 'GET') {
		return;
	}

	const isHtml = event.request.mode === 'navigate' || (event.request.headers.get('accept') || '').includes('text/html');

	// For HTML pages and API requests, use Network First, fallback to Cache
	if (isHtml || url.pathname.startsWith('/api/')) {
		event.respondWith(
			fetch(event.request)
				.then(async (response) => {
					if (!response.ok && url.pathname.startsWith('/api/')) {
						// For API, try to fallback to cache on non-ok (e.g. 429 quota limits, 500/503 errors)
						const cache = await caches.open(CACHE_NAME);
						const cachedResponse = await cache.match(event.request);
						if (cachedResponse) {
							return cachedResponse;
						}
						// If not in cache, return the original error response so the app can parse it
						return response;
					}
					const responseClone = response.clone();
					caches.open(CACHE_NAME).then((cache) => {
						cache.put(event.request, responseClone);
					});
					return response;
				})
				.catch(async (err) => {
					// Hard network failure (e.g., offline)
					const cache = await caches.open(CACHE_NAME);
					const cachedResponse = await cache.match(event.request);
					if (cachedResponse) {
						return cachedResponse;
					}
					throw err;
				})
		);
		return;
	}

	// For static assets (JS, CSS, images), use Cache First, fallback to Network
	event.respondWith(
		caches.match(event.request).then((cachedResponse) => {
			if (cachedResponse) {
				return cachedResponse;
			}
			return fetch(event.request).then((networkResponse) => {
				if (networkResponse.ok) {
					// Clone immediately before async caches.open to avoid "Response body is already used"
					const responseToCache = networkResponse.clone();
					caches.open(CACHE_NAME).then((cache) => {
						cache.put(event.request, responseToCache);
					});
				}
				return networkResponse;
			});
		})
	);
});
