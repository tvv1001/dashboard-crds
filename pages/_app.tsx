import type { AppProps } from 'next/app';
import { Analytics, type BeforeSendEvent as AnalyticsBeforeSendEvent } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { readLastCrdSelection, writeLastCrdSelection } from '../src/lib/lastCrdSelection';
import '../public/styles.css';

type CrdSelection = { type: 'individual' | 'firm'; crd: string };
type SpeedInsightsEvent = { type: 'vital'; url: string; route?: string };

const ANALYTICS_DISABLE_STORAGE_KEY = 'dashboard-crds:disable_analytics';

function selectionFromPath(path: string): CrdSelection | null {
	const clean = String(path || '/')
		.split('?')[0]
		.split('#')[0];
	// Dashboard: /individual/123 or /firm/123
	let match = clean.match(/^\/(individual|firm)\/(\d+)\/?$/i);
	if (match) {
		return { type: match[1].toLowerCase() as 'individual' | 'firm', crd: match[2] };
	}
	// Graph: /graph/individual/123 or /graph/firm/123
	match = clean.match(/^\/graph\/(individual|firm)\/(\d+)\/?$/i);
	if (match) {
		return { type: match[1].toLowerCase() as 'individual' | 'firm', crd: match[2] };
	}
	// Global map: /chart/individual/123 or /chart/firm/123
	match = clean.match(/^\/chart\/(individual|firm)\/(\d+)\/?$/i);
	if (match) {
		return { type: match[1].toLowerCase() as 'individual' | 'firm', crd: match[2] };
	}
	return null;
}

function readStoredAnalyticsDisabled(): boolean {
	if (typeof window === 'undefined') return false;
	try {
		return window.localStorage.getItem(ANALYTICS_DISABLE_STORAGE_KEY) === '1';
	} catch {
		return false;
	}
}

function writeStoredAnalyticsDisabled(disabled: boolean) {
	if (typeof window === 'undefined') return;
	try {
		if (disabled) window.localStorage.setItem(ANALYTICS_DISABLE_STORAGE_KEY, '1');
		else window.localStorage.removeItem(ANALYTICS_DISABLE_STORAGE_KEY);
	} catch {
		// ignore quota / private mode
	}
}

function parseAnalyticsQueryFlag(raw: string | string[] | undefined): boolean | null {
	if (raw == null) return null;
	const value = String(Array.isArray(raw) ? raw[0] : raw)
		.trim()
		.toLowerCase();
	if (!value) return null;
	if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
	if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
	return null;
}

export default function MyApp({ Component, pageProps }: AppProps) {
	const router = useRouter();
	const isDashboardRoute = router.pathname === '/' || router.pathname === '/[type]/[crd]';
	const routePath = (router.asPath || '/').split('?')[0].split('#')[0];
	// Prefer live window path so dashboard history.pushState selections are visible.
	const [livePath, setLivePath] = useState(routePath);
	// Start true so first paint does not emit analytics before localStorage / query is read.
	const [analyticsDisabled, setAnalyticsDisabled] = useState(true);

	useEffect(() => {
		const syncFromLocation = () => {
			if (typeof window === 'undefined') return;
			setLivePath(window.location.pathname || '/');
		};
		syncFromLocation();
		const onRoute = () => syncFromLocation();
		const onSelection = (event: Event) => {
			const detail = (event as CustomEvent<{ path?: string }>).detail;
			if (detail?.path) {
				setLivePath(detail.path);
				return;
			}
			syncFromLocation();
		};
		router.events.on('routeChangeComplete', onRoute);
		window.addEventListener('popstate', syncFromLocation);
		window.addEventListener('crd-selection-change', onSelection as EventListener);
		return () => {
			router.events.off('routeChangeComplete', onRoute);
			window.removeEventListener('popstate', syncFromLocation);
			window.removeEventListener('crd-selection-change', onSelection as EventListener);
		};
	}, [router.events]);

	useEffect(() => {
		setLivePath(routePath);
	}, [routePath]);

	// Persist /?disable_analytics=1 (or =0 to re-enable) on this browser so local
	// machines do not inflate Vercel Analytics / Speed Insights.
	useEffect(() => {
		if (!router.isReady) return;
		const flag = parseAnalyticsQueryFlag(router.query.disable_analytics);
		if (flag === true) {
			writeStoredAnalyticsDisabled(true);
			setAnalyticsDisabled(true);
			return;
		}
		if (flag === false) {
			writeStoredAnalyticsDisabled(false);
			setAnalyticsDisabled(false);
			return;
		}
		setAnalyticsDisabled(readStoredAnalyticsDisabled());
	}, [router.isReady, router.query.disable_analytics]);

	const beforeSendAnalytics = useCallback(
		(event: AnalyticsBeforeSendEvent) => {
			if (analyticsDisabled || readStoredAnalyticsDisabled()) return null;
			return event;
		},
		[analyticsDisabled],
	);

	const beforeSendSpeedInsights = useCallback(
		(event: SpeedInsightsEvent) => {
			if (analyticsDisabled || readStoredAnalyticsDisabled()) return null;
			return event;
		},
		[analyticsDisabled],
	);

	const pathSelection = useMemo(() => selectionFromPath(livePath) || selectionFromPath(routePath), [livePath, routePath]);
	// When user is on bare / or /chart, still deep-link Global Map / Graph to the last CRD.
	const [storedSelection, setStoredSelection] = useState<CrdSelection | null>(null);

	useEffect(() => {
		const stored = readLastCrdSelection();
		if (stored) setStoredSelection({ type: stored.type, crd: stored.crd });
	}, []);

	useEffect(() => {
		if (!pathSelection) return;
		writeLastCrdSelection(pathSelection);
		setStoredSelection(pathSelection);
	}, [pathSelection]);

	useEffect(() => {
		const onSelection = (event: Event) => {
			const detail = (event as CustomEvent<{ type?: string; crd?: string }>).detail;
			const type: CrdSelection['type'] | null =
				detail?.type === 'firm' ? 'firm'
				: detail?.type === 'individual' ? 'individual'
				: null;
			const crd = String(detail?.crd || '').trim();
			if (!type || !/^\d+$/.test(crd)) return;
			const next: CrdSelection = { type, crd };
			writeLastCrdSelection(next);
			setStoredSelection(next);
		};
		window.addEventListener('crd-selection-change', onSelection as EventListener);
		return () => window.removeEventListener('crd-selection-change', onSelection as EventListener);
	}, []);

	useEffect(() => {
		if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
			window.addEventListener('load', () => {
				const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
				if (isLocalhost) {
					// Unregister any existing service workers on localhost to prevent stale offline cache
					navigator.serviceWorker.getRegistrations().then((registrations) => {
						for (const registration of registrations) {
							registration.unregister();
							console.log('ServiceWorker unregistered on localhost');
						}
					});
				} else {
					navigator.serviceWorker.register('/sw.js').then(
						(registration) => {
							console.log('ServiceWorker registration successful with scope: ', registration.scope);
						},
						(err) => {
							console.log('ServiceWorker registration failed: ', err);
						}
					);
				}
			});
		}
	}, []);

	const selection = pathSelection || storedSelection;

	const pageRouteClass = `page-${
		routePath
			.replace(/^\/+|\/+$/g, '')
			.replace(/[^a-zA-Z0-9]+/g, '-')
			.toLowerCase() || 'home'
	}`;

	const graphHref = selection ? `/graph/${selection.type}/${selection.crd}` : '/graph';
	const globalGraphHref = selection ? `/chart/${selection.type}/${selection.crd}` : '/chart';
	const dashboardHref = selection ? `/${selection.type}/${selection.crd}` : '/';

	const navItems = [
		{ href: graphHref, activePrefix: '/graph', label: 'Node Graph' },
		{ href: globalGraphHref, activePrefix: '/chart', label: 'Global Map' },
		{ href: dashboardHref, activePrefix: '/', label: 'Dashboard' },
	] as const;

	return (
		<div className='app-shell'>
			<nav className='top-nav' aria-label='Primary'>
				<div className='top-nav-brand'>FINRA / SEC</div>
				<div className='top-nav-links'>
					{navItems.map((item) => {
						const isActive =
							item.activePrefix === '/' ? isDashboardRoute
							: item.activePrefix === '/graph' ? router.pathname.startsWith('/graph') || router.pathname.startsWith('/node-graph')
							: router.pathname.startsWith(item.activePrefix);
						return (
							<Link
								key={item.label}
								href={item.href}
								className={`top-nav-link ${isActive ? 'active' : ''}`}>
								{item.label}
							</Link>
						);
					})}
				</div>
			</nav>
			<div className={`app-page ${isDashboardRoute ? 'dashboard-page' : ''} ${pageRouteClass}`.trim()}>
				<Component {...pageProps} />
			</div>
			{!analyticsDisabled && process.env.NODE_ENV === 'production' ?
				<>
					<Analytics beforeSend={beforeSendAnalytics} />
					<SpeedInsights beforeSend={beforeSendSpeedInsights} />
				</>
			:	null}
		</div>
	);
}
