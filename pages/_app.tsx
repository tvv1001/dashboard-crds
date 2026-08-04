import type { AppProps } from 'next/app';
import Link from 'next/link';
import { useRouter } from 'next/router';
import '../public/styles.css';

export default function MyApp({ Component, pageProps }: AppProps) {
	const router = useRouter();
	const isDashboardRoute = router.pathname === '/' || router.pathname === '/[type]/[crd]';
	const routePath = (router.asPath || '/').split('?')[0].split('#')[0];
	const pageRouteClass = `page-${
		routePath
			.replace(/^\/+|\/+$/g, '')
			.replace(/[^a-zA-Z0-9]+/g, '-')
			.toLowerCase() || 'home'
	}`;
	const navItems = [
		{ href: '/graph', label: 'Node Graph' },
		{ href: '/', label: 'Dashboard' },
		{ href: '/insights', label: 'Insights' },
	] as const;

	return (
		<div className='app-shell'>
			<nav className='top-nav'>
				<div className='top-nav-brand'>FINRA / SEC</div>
				<div className='top-nav-links'>
					{navItems.map((item) => {
						const isActive = item.href === '/' ? isDashboardRoute : router.pathname.startsWith(item.href);
						return (
							<Link
								key={item.href}
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
