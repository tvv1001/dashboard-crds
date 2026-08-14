import re

with open('src/components/panel/StatusBox.tsx', 'r') as f:
    content = f.read()

old_use_effect = """	}, [crd, enabled, combinedBundle]);"""
new_use_effect = """	}, [crd, enabled, combinedBundle ? JSON.stringify(combinedBundle) : null]);"""

content = content.replace(old_use_effect, new_use_effect)

with open('src/components/panel/StatusBox.tsx', 'w') as f:
    f.write(content)
