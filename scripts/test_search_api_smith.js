const http = require('http');

http.get('http://localhost:3001/api/local-name-search?q=smith&limit=1', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log(JSON.stringify(JSON.parse(data).matches, null, 2)));
});
