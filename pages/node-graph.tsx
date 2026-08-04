import { useEffect } from 'react';
import { useRouter } from 'next/router';

// The node graph now lives at /graph (see pages/graph/[[...params]].tsx),
// which also supports deep-linkable /graph/individual/<crd> and
// /graph/firm/<crd> URLs that update as nodes are selected. This stub keeps
// any existing /node-graph bookmarks/links working.
export default function LegacyNodeGraphRedirect() {
	const router = useRouter();

	useEffect(() => {
		router.replace('/graph');
	}, [router]);

	return null;
}
