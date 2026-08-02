import React from 'react';
import Head from 'next/head';
import Dashboard from '../src/components/Dashboard';

export default function Index() {
	return (
		<>
			<Head>
				<title>FINRA / SEC Dashboard</title>
				<meta
					name='viewport'
					content='width=device-width, initial-scale=1'
				/>
			</Head>
			<Dashboard />
		</>
	);
}
