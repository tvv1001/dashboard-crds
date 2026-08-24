const fs = require('fs');

const path = 'src/components/panel/StatusBox.tsx';
let content = fs.readFileSync(path, 'utf8');

const target = `	const hasLiveSourcePayload = Boolean(
		combinedBundle?.sources?.finra?.found ||
		combinedBundle?.sources?.sec?.found ||
		combinedBundle?.sources?.finra?.payload ||
		combinedBundle?.sources?.sec?.payload ||
		(typeof combinedBundle?.sources?.finra?.rawPayload === 'string' && combinedBundle.sources.finra.rawPayload.trim()) ||
		(typeof combinedBundle?.sources?.sec?.rawPayload === 'string' && combinedBundle.sources.sec.rawPayload.trim()),
	);`;

const replacement = `	const isFinraReal = combinedBundle?.sources?.finra?.found && !combinedBundle?.sources?.finra?.payload?.orphan;
	const isSecReal = combinedBundle?.sources?.sec?.found && !combinedBundle?.sources?.sec?.payload?.orphan;
	const hasLiveSourcePayload = Boolean(
		isFinraReal ||
		isSecReal ||
		(typeof combinedBundle?.sources?.finra?.rawPayload === 'string' && combinedBundle.sources.finra.rawPayload.trim() && !combinedBundle.sources.finra.rawPayload.includes('"orphan":')) ||
		(typeof combinedBundle?.sources?.sec?.rawPayload === 'string' && combinedBundle.sources.sec.rawPayload.trim() && !combinedBundle.sources.sec.rawPayload.includes('"orphan":'))
	);`;

if (content.includes(target)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(path, content, 'utf8');
    console.log("Patched successfully!");
} else {
    console.log("Could not find target to patch.");
}
