import re

with open('src/components/panel/StatusBox.tsx', 'r') as f:
    content = f.read()

old_hook = """function useFirmEmployeeConnections(crd: string, enabled: boolean) {
	const [state, setState] = useState<{ current: any[]; previous: any[]; loading: boolean } | null>(null);

	React.useEffect(() => {
		if (!enabled || !crd) {
			setState(null);
			return;
		}
		let cancelled = false;
		setState({ current: [], previous: [], loading: true });
		fetch(`/api/finra/expand/${encodeURIComponent(`firm:${crd}`)}?hops=1`)
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => {
				if (cancelled || !data) return;
				const nodes = Array.isArray(data.nodes) ? data.nodes : [];
				const links = Array.isArray(data.links) ? data.links : [];
				const nodeById = new Map(nodes.map((n: any) => [n.id, n]));
				const firmId = `firm:${crd}`;
				const current: any[] = [];
				const previous: any[] = [];
				for (const link of links) {
					if (!link || link.relationship !== 'employment' || link.target !== firmId) continue;
					const person = nodeById.get(link.source) as any;
					if (!person) continue;
					// Use `individualName` (not `legalName`) so inferRowType() correctly
					// classifies these rows as individuals — `legalName` is treated as a
					// firm-name signal and would otherwise build a bad firm:<crd> link.
					const cityState = formatAddress({ city: person.city, state: person.state });
					const row = { individualName: person.label, crd: person.crd, __subtitleOverride: cityState };
					(link.isCurrent ? current : previous).push(row);
				}
				setState({
					current: sortRowsByLabel(current),
					previous: sortRowsByLabel(previous),
					loading: false,
				});
			})
			.catch(() => {
				if (!cancelled) setState({ current: [], previous: [], loading: false });
			});
		return () => {
			cancelled = true;
		};
	}, [crd, enabled]);

	return state;
}"""

new_hook = """function useFirmEmployeeConnections(crd: string, enabled: boolean, combinedBundle: any) {
	const [state, setState] = useState<{ current: any[]; previous: any[]; loading: boolean } | null>(null);

	React.useEffect(() => {
		if (!enabled || !crd || !combinedBundle) {
			setState(null);
			return;
		}
		
		const current: any[] = [];
		const previous: any[] = [];
		const owners: any[] = [];
		
		for (const source of ['finra', 'sec']) {
			const record = combinedBundle.sources?.[source];
			if (record?.found && record?.payload) {
				const p = record.payload;
				if (Array.isArray(p.directOwners)) owners.push(...p.directOwners);
				if (Array.isArray(p.indirectOwners)) owners.push(...p.indirectOwners);
			}
		}
		
		const seen = new Set();
		for (const owner of owners) {
			const ownerCrd = owner.crdNumber || owner.ownerCrd || owner.ownerCrdNumber || owner.ownerCRDNb;
			const textCrd = String(ownerCrd || '').trim().replace(/^0+/, '') || '0';
			if (!textCrd || textCrd === '0' || !/^\\d+$/.test(textCrd)) continue;
			if (seen.has(textCrd)) continue;
			seen.add(textCrd);
			
			const name = owner.ownerName || owner.legalName || owner.name || '';
			const row = { individualName: name, crd: textCrd, __subtitleOverride: String(owner.position || '').trim() };
			current.push(row);
		}
		
		setState({
			current: sortRowsByLabel(current),
			previous: sortRowsByLabel(previous),
			loading: false,
		});
	}, [crd, enabled, combinedBundle]);

	return state;
}"""

content = content.replace(old_hook, new_hook)

old_call = """	const employeeConnections = useFirmEmployeeConnections(parsedKey?.crd || '', parsedKey?.type === 'firm');
	const rawPayload = maybeParseJson(detailJson);
	const combinedBundle = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? (rawPayload as Record<string, any>) : null;"""

new_call = """	const rawPayload = maybeParseJson(detailJson);
	const combinedBundle = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? (rawPayload as Record<string, any>) : null;
	const employeeConnections = useFirmEmployeeConnections(parsedKey?.crd || '', parsedKey?.type === 'firm', combinedBundle);"""

content = content.replace(old_call, new_call)

with open('src/components/panel/StatusBox.tsx', 'w') as f:
    f.write(content)

