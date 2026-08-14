import { Head, Html, Main, NextScript } from 'next/document';

export default function Document() {
	return (
		<Html lang='en'>
			<Head>
				<link rel='manifest' href='/manifest.json' />
				<link rel='apple-touch-icon' href='/apple-touch-icon.png' />
				<meta name='theme-color' content='#0d1117' />
				<link
					rel='icon'
					type='image/png'
					sizes='32x32'
					href='/favicon.ico'
				/>
				<link
					rel='icon'
					type='image/svg+xml'
					href='/favicon.svg'
				/>
				<link
					rel='shortcut icon'
					href='/favicon.svg'
				/>
			</Head>
			<body>
				<Main />
				<NextScript />
			</body>
		</Html>
	);
}
