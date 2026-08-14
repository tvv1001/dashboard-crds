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

	// For API requests, use Network First, fallback to Cache
	if (url.pathname.startsWith('/api/')) {
		event.respondWith(
			fetch(event.request)
				.then((response) => {
					// If the response is an error (like 429 or 500 from Upstash quota limits),
					// and we have a cached version, we might want to throw to trigger the catch block.
					// However, 429 is a valid HTTP response, so fetch() doesn't throw.
					if (!response.ok) {
						throw new Error(`HTTP error! status: ${response.status}`);
					}
					// Clone and cache the successful response
					const responseClone = response.clone();
					caches.open(CACHE_NAME).then((cache) => {
						cache.put(event.request, responseClone);
					});
					return response;
				})
				.catch(async (err) => {
					// Network failed or returned error status (e.g. Upstash blocked)
					// Fallback to cache
					const cache = await caches.open(CACHE_NAME);
					const cachedResponse = await cache.match(event.request);
					if (cachedResponse) {
						return cachedResponse;
					}
					// If no cache, we have to throw or return a graceful failure
					throw err;
				})
		);
		return;
	}

	// For static assets and pages, use Stale-While-Revalidate or Network First
	event.respondWith(
		caches.match(event.request).then((cachedResponse) => {
			const fetchPromise = fetch(event.request).then((networkResponse) => {
				if (networkResponse.ok) {
					caches.open(CACHE_NAME).then((cache) => {
						cache.put(event.request, networkResponse.clone());
					});
				}
				return networkResponse;
			}).catch(() => {
				// Ignore network errors for static assets if we have cache
			});

			return cachedResponse || fetchPromise;
		})
	);
});
