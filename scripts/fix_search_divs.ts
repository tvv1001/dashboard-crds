import fs from 'fs';
let content = fs.readFileSync('src/components/panel/LocalNameSearch.tsx', 'utf8');
content = content.replace("<div className='local-name-search-header'>\n\t\t\t\t<div className='local-name-search-header-row'", "<div className='local-name-search-header-row'");
content = content.replace("</div>\n\t\t\t</div>\n\t\t\t</div>", "</div>\n\t\t\t</div>");
fs.writeFileSync('src/components/panel/LocalNameSearch.tsx', content);
