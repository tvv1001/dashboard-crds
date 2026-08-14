import re

with open('pages/api/_lib.ts', 'r') as f:
    content = f.read()

old_block = """		try {
			const rawValue = await Promise.any([p1, p2]);
			return decompressPayload(rawValue);
		} catch (e) {
			return null;
		}"""

new_block = """		try {
			const rawValue = await new Promise((resolve, reject) => {
				let rejectedCount = 0;
				const handleReject = () => {
					rejectedCount++;
					if (rejectedCount === 2) reject(new Error("both failed"));
				};
				p1.then(resolve).catch(handleReject);
				p2.then(resolve).catch(handleReject);
			});
			return decompressPayload(rawValue as string);
		} catch (e) {
			return null;
		}"""

content = content.replace(old_block, new_block)

with open('pages/api/_lib.ts', 'w') as f:
    f.write(content)
