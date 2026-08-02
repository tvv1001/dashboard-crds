import InsightsView from '../../src/components/insights/InsightsView';

// Optional catch-all covers every Insights URL shape with one route file
// (Next.js forbids sibling dynamic segments with different names at the
// same depth, so /insights/<crd> and /insights/<type>/<crd> can't be
// separate [crd].tsx / [type]/[crd].tsx files):
//   /insights                    -> slug: undefined (search landing page)
//   /insights/<crd>              -> slug: [crd]              (type unknown/ambiguous)
//   /insights/<type>/<crd>       -> slug: [type, crd]         (type known)
export default function InsightsCatchAll() {
	return <InsightsView />;
}
