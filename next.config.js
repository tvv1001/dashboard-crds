/** @type {import('next').NextConfig} */
const nextConfig = {
	async redirects() {
		return [
			// Legacy global-graph URLs → /chart
			{
				source: '/global-graph',
				destination: '/chart',
				permanent: true,
			},
			{
				source: '/global-graph/:path*',
				destination: '/chart/:path*',
				permanent: true,
			},
		];
	},
	async rewrites() {
		return [
			{
				source: '/favicon.ico',
				destination: '/favicon.svg',
			},
		];
	},
};

module.exports = nextConfig;
