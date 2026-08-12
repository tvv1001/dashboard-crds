import fetch from 'node-fetch';
const res = await fetch('http://localhost:3000/api/key?name=finra:individual:1000003');
const json = await res.json();
console.log(JSON.stringify(json, null, 2));
