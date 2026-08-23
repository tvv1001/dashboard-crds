const fs = require('fs');

let content = fs.readFileSync('pages/api/local-name-search.ts', 'utf8');

// Ensure imports
if (!content.includes('loadSavedPayload')) {
    content = content.replace(/import { formatErrorMessage, getRedisConnectionMode } from '.\/_lib';/, 
        "import { formatErrorMessage, getRedisConnectionMode, loadSavedPayload, getContentBlock } from './_lib';");
}

const augmentCode = `
		// Augment with Redis if available
		if (getSearchSourceMode() === 'redis') {
			await Promise.all(matches.map(async (m) => {
				try {
					const payload = await loadSavedPayload(m.key);
					if (payload) {
						const content = getContentBlock(m.key, payload);
						if (m.type === 'individual') {
							const emps = [
								...(Array.isArray(content?.currentEmployments) ? content.currentEmployments : []),
								...(Array.isArray(content?.currentIAEmployments) ? content.currentIAEmployments : [])
							];
							for (const emp of emps) {
								if (emp.firmName) {
									m.currentFirm = emp.firmName;
									const locs = Array.isArray(emp.branchOfficeLocations) ? emp.branchOfficeLocations : [];
									const loc = locs.find((l: any) => l.locatedAtFlag === 'Y') || locs[0];
									if (loc) {
										m.currentCity = loc.city || '';
										m.currentState = loc.state || '';
										m.currentAddress = [loc.street1, loc.street2, loc.city, loc.state, loc.zipCode].filter(Boolean).join(', ');
									} else {
										m.currentCity = emp.city || '';
										m.currentState = emp.state || '';
										m.currentAddress = [emp.city, emp.state].filter(Boolean).join(', ');
									}
									break;
								}
							}
						} else {
							const addr = content?.mainOfficeAddress || content?.mainAddress;
							if (addr) {
								m.currentCity = addr.city || '';
								m.currentState = addr.state || '';
								m.currentAddress = [addr.street1, addr.street2, addr.city, addr.state, addr.zipCode].filter(Boolean).join(', ');
							}
						}
						
						const otherNames = Array.isArray(content?.basicInformation?.otherNames) ? content.basicInformation.otherNames : [];
						if (otherNames.length) {
							m.aliases = Array.from(new Set([...m.aliases, ...otherNames]));
						}
					}
				} catch (e) {}
			}));
		}

		return res.status(200).json({
`;

if (!content.includes('// Augment with Redis if available')) {
    content = content.replace(/return res.status\(200\).json\(\{/, augmentCode);
    fs.writeFileSync('pages/api/local-name-search.ts', content);
    console.log('Augmentation added.');
} else {
    console.log('Already augmented.');
}
