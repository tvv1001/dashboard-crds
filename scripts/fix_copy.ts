import fs from 'fs';
let content = fs.readFileSync('src/hooks/useLocalNameSearch.ts', 'utf8');

const replacement = `const text = results
			.map((r) => {
				const parts: string[] = [r.name || r.key || ''];
				if (r.crd) parts.push(\`CRD: \${r.crd}\`);
				if (r.type === 'individual' && r.currentFirm) parts.push(\`Firm: \${r.currentFirm} (CRD: \${r.currentFirmCrd})\`);
				if (r.currentAddress) parts.push(\`Address: \${r.currentAddress}\`);
				if (r.source) parts.push(\`Source: \${r.source}\`);
				return parts.join(' | ');
			})`;
			
content = content.replace(/const text = results[\s\S]*?\.join\('\\n'\);/, replacement + "\n\t\t\t.join('\\n');");
fs.writeFileSync('src/hooks/useLocalNameSearch.ts', content);
