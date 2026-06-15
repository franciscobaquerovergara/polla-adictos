const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const GROUP_ID = 84178;
const BASE_URL = 'https://game.pollaya.com';

async function main() {
  console.log('🚀 Starting Pollaya scraper...');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
  const page = await ctx.newPage();

  // ── Login ──────────────────────────────────────────────
  console.log('🔐 Logging in...');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Fill email and password
  const emailField = await page.$('input[type="email"], input[name="email"], input[placeholder*="mail" i], input[placeholder*="correo" i]');
  const passField = await page.$('input[type="password"]');
  if (!emailField || !passField) throw new Error('Login fields not found');
  await emailField.fill(process.env.POLLAYA_EMAIL);
  await passField.fill(process.env.POLLAYA_PASSWORD);
  await passField.press('Enter');
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log('✅ Logged in, at:', page.url());

  // ── Standings ──────────────────────────────────────────
  console.log('📊 Scraping standings...');
  await page.goto(`${BASE_URL}/mis-grupos/${GROUP_ID}/pronosticos`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Click Participantes tab
  const participantesLink = await page.$('a[href*="posiciones"]');
  if (participantesLink) await participantesLink.click();
  await page.waitForTimeout(2500);

  // Load all players
  let more = true;
  let attempts = 0;
  while (more && attempts < 5) {
    const btn = await page.$('button:has-text("Ver más usuarios")');
    if (btn) { await btn.click(); await page.waitForTimeout(700); attempts++; }
    else more = false;
  }

  const standings = await page.evaluate(() => {
    return [...document.querySelectorAll('.t-pts')].map(item => {
      const posEl = item.querySelector('.rank-position');
      const nameEl = item.querySelector('.name span');
      const scoreEl = item.querySelector('.score-points b');
      const pos = parseInt((posEl?.textContent || '').replace(/\D/g, ''));
      const name = nameEl?.textContent.trim();
      const pts = parseInt((scoreEl?.textContent || '').trim());
      return (name && !isNaN(pts) && !isNaN(pos)) ? { pos, name, pts } : null;
    }).filter(Boolean).sort((a, b) => a.pos - b.pos);
  });
  console.log(`✅ Got ${standings.length} players`);

  // ── Match results ──────────────────────────────────────
  console.log('⚽ Scraping match results...');
  await page.goto(`${BASE_URL}/mis-grupos/${GROUP_ID}/pronosticos`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const rawText = await page.evaluate(() => document.body.textContent);
  const matchesPlayed = parseMatches(rawText);
  console.log(`✅ Got ${matchesPlayed.length} completed matches`);

  await browser.close();

  // ── Build data.json ────────────────────────────────────
  const dataPath = path.join(__dirname, '..', 'data.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(dataPath, 'utf8')); } catch {}

  const data = {
    lastUpdated: new Date().toISOString(),
    group: existing.group || { name: 'Adictos', id: GROUP_ID, tournament: 'Copa Mundial FIFA 2026' },
    rules: existing.rules || {},
    standings,
    matchesPlayed,
    matchesPlayed_count: matchesPlayed.length,
    totalMatches: 104
  };
  data.group.participants = standings.length;

  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  console.log('💾 data.json updated!');
}

function parseMatches(text) {
  // Extract completed matches from page text
  // Format in page: "vie. 12 jun. 03:00 MEX2(2)vs1(0)CompararRSA"
  const matches = [];
  const days = { 'vie':'Vie','sáb':'Sáb','dom':'Dom','lun':'Lun','mar':'Mar','mié':'Mié','jue':'Jue' };
  // Regex: day date time TEAM score(forecast) vs score(forecast) Comparar TEAM
  const re = /(vie|sáb|dom|lun|mar|mié|jue)\.\s+(\d+)\s+(\w+)\.\s+[\d:]+\s+([A-Z]{2,4})(\d+)\(\d+\)vs(\d+)\(\d+\)Comparar([A-Z]{2,4})/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, day, dom, mon, home, hg, ag, away] = m;
    const monthMap = { 'jun':'Jun','jUl':'Jul','ago':'Ago','sep':'Sep','oct':'Oct','nov':'Nov' };
    const date = `${days[day.toLowerCase()]||day} ${dom} ${monthMap[mon.toLowerCase()]||mon}`;
    // figure group from context (not trivial from raw text, default to '?')
    matches.push({ date, home, away, hg: parseInt(hg), ag: parseInt(ag), group: '?' });
  }
  return matches;
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
