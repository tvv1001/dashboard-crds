async function checkApi(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
      console.log(`[ERROR] ${url} -> Status: ${res.status}`);
      return;
    }
    const data = await res.json();
    console.log(`[OK] ${url} -> Total Hits: ${data?.hits?.total || 0}`);
  } catch (err) {
    console.log(`[FAILED] ${url} -> ${err.message}`);
  }
}

async function run() {
  await checkApi("https://api.brokercheck.finra.org/search/firm?query=smith&hl=true");
  await checkApi("https://api.brokercheck.finra.org/search/individual?query=adams&hl=true");
  await checkApi("https://api.adviserinfo.sec.gov/search/individual?query=smith&hl=true");
  await checkApi("https://api.adviserinfo.sec.gov/search/firm?query=nixon&hl=true");
}
run();
