import type { AppProps } from 'next/app';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import '../public/styles.css';

type CrdSelection = { type: 'individual' | 'firm'; crd: string };

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
	// Global map: /global-graph/individual/123 or /global-graph/firm/123
	match = clean.match(/^\/global-graph\/(individual|firm)\/(\d+)\/?$/i);
	if (match) {
		return { type: match[1].toLowerCase() as 'individual' | 'firm', crd: match[2] };
	}
	return null;
}

export default function MyApp({ Component, pageProps }: AppProps) {
	const router = useRouter();
	const isDashboardRoute = router.pathname === '/' || router.pathname === '/[type]/[crd]';
	const routePath = (router.asPath || '/').split('?')[0].split('#')[0];
	// Prefer live window path so dashboard history.pushState selections are visible.
	const [livePath, setLivePath] = useState(routePath);

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

	const selection = useMemo(() => selectionFromPath(livePath) || selectionFromPath(routePath), [livePath, routePath]);

	const pageRouteClass = `page-${
		routePath
			.replace(/^\/+|\/+$/g, '')
			.replace(/[^a-zA-Z0-9]+/g, '-')
			.toLowerCase() || 'home'
	}`;

	const graphHref = selection ? `/graph/${selection.type}/${selection.crd}` : '/graph';
	const globalGraphHref = selection ? `/global-graph/${selection.type}/${selection.crd}` : '/global-graph';
	const dashboardHref = selection ? `/${selection.type}/${selection.crd}` : '/';

	const navItems = [
		{ href: graphHref, activePrefix: '/graph', label: 'Node Graph' },
		{ href: globalGraphHref, activePrefix: '/global-graph', label: 'Global Map' },
		{ href: dashboardHref, activePrefix: '/', label: 'Dashboard' },
		{ href: '/insights', activePrefix: '/insights', label: 'Insights' },
	] as const;

	return (
		<div className='app-shell'>
			<nav className='top-nav'>
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
		</div>
	);
}
