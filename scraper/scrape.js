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

  const emailField = await page.$('input[type="email"], input[name="email"], input[placeholder*="mail" i], input[placeholder*="correo" i]');
  const passField = await page.$('input[type="password"]');
  if (!emailField || !passField) throw new Error('Login fields not found');
  await emailField.fill(process.env.POLLAYA_EMAIL);
  await passField.fill(process.env.POLLAYA_PASSWORD);
  await passField.press('Enter');
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log('✅ Logged in, at:', page.url());

  // ── Standings + participant links ──────────────────────
  console.log('📊 Scraping standings...');
  await page.goto(`${BASE_URL}/mis-grupos/${GROUP_ID}/posiciones`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Load all players
  let more = true, attempts = 0;
  while (more && attempts < 10) {
    const btn = await page.$('button:has-text("Ver más usuarios")');
    if (btn) { await btn.click(); await page.waitForTimeout(700); attempts++; }
    else more = false;
  }

  const { standings, participantLinks } = await page.evaluate((base) => {
    const items = [...document.querySelectorAll('.t-pts')];
    const standings = items.map(item => {
      const posEl = item.querySelector('.rank-position');
      const nameEl = item.querySelector('.name span');
      const scoreEl = item.querySelector('.score-points b');
      const pos = parseInt((posEl?.textContent || '').replace(/\D/g, ''));
      const name = nameEl?.textContent.trim();
      const pts = parseInt((scoreEl?.textContent || '').trim());
      return (name && !isNaN(pts) && !isNaN(pos)) ? { pos, name, pts } : null;
    }).filter(Boolean).sort((a, b) => a.pos - b.pos);

    const participantLinks = items.map(item => {
      const nameEl = item.querySelector('.name span');
      const link = item.querySelector('a');
      const href = link?.getAttribute('href');
      if (!nameEl || !href) return null;
      return { name: nameEl.textContent.trim(), href: href.startsWith('http') ? href : base + href };
    }).filter(Boolean);

    return { standings, participantLinks };
  }, BASE_URL);
  console.log(`✅ Got ${standings.length} players, ${participantLinks.length} profile links`);

  // ── Match results ──────────────────────────────────────
  console.log('⚽ Scraping match results...');
  await page.goto(`${BASE_URL}/mis-grupos/${GROUP_ID}/pronosticos`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const rawText = await page.evaluate(() => document.body.textContent);
  const matchesPlayed = parseMatches(rawText);
  console.log(`✅ Got ${matchesPlayed.length} completed matches`);

  // ── Per-participant predictions & accuracy ─────────────
  let accuracyStats = [];
  if (participantLinks.length > 0 && matchesPlayed.length > 0) {
    console.log(`🎯 Scraping predictions for ${participantLinks.length} participants...`);
    for (const p of participantLinks) {
      try {
        // Derive the user's pronosticos page from their profile link
        const predUrl = p.href.includes('pronosticos')
          ? p.href
          : p.href.replace(/\/$/, '') + '/pronosticos';
        await page.goto(predUrl, { waitUntil: 'networkidle', timeout: 12000 });
        await page.waitForTimeout(1000);
        const text = await page.evaluate(() => document.body.textContent);
        const preds = parseUserPredictions(text);
        if (preds.length > 0) {
          const stats = computeAccuracy(preds, matchesPlayed);
          if (stats) accuracyStats.push({ name: p.name, ...stats });
        }
      } catch (e) {
        console.warn(`⚠️  Skipped ${p.name}: ${e.message}`);
      }
    }
    console.log(`✅ Accuracy stats for ${accuracyStats.length}/${participantLinks.length} participants`);
  } else {
    console.log('ℹ️  No participant links found — accuracy stats skipped');
  }

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
    totalMatches: 104,
    // Keep previous accuracy stats if we got none this run (e.g. site structure changed)
    accuracyStats: accuracyStats.length > 0 ? accuracyStats : (existing.accuracyStats || [])
  };
  data.group.participants = standings.length;

  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  console.log('💾 data.json updated!');
}

// ── Parsers ────────────────────────────────────────────────

function parseMatches(text) {
  // Format: "vie. 12 jun. 03:00 MEX2(2)vs1(0)CompararRSA"
  // actual score is outside parens; logged-in user's forecast is inside parens
  const matches = [];
  const days = { 'vie':'Vie','sáb':'Sáb','dom':'Dom','lun':'Lun','mar':'Mar','mié':'Mié','jue':'Jue' };
  const re = /(vie|sáb|dom|lun|mar|mié|jue)\.\s+(\d+)\s+(\w+)\.\s+[\d:]+\s+([A-Z]{2,4})(\d+)\(\d+\)vs(\d+)\(\d+\)Comparar([A-Z]{2,4})/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, day, dom, mon, home, hg, ag, away] = m;
    const monthMap = { 'jun':'Jun','jul':'Jul','ago':'Ago','sep':'Sep','oct':'Oct','nov':'Nov' };
    const date = `${days[day.toLowerCase()]||day} ${dom} ${monthMap[mon.toLowerCase()]||mon}`;
    matches.push({ date, home, away, hg: parseInt(hg), ag: parseInt(ag), group: '?' });
  }
  return matches;
}

function parseUserPredictions(text) {
  // Same page format — values inside parens are THIS user's forecast for the match
  const preds = [];
  const re = /([A-Z]{2,4})\d+\((\d+)\)vs\d+\((\d+)\)Comparar([A-Z]{2,4})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, home, phg, pag, away] = m;
    preds.push({ home, away, hg: parseInt(phg), ag: parseInt(pag) });
  }
  return preds;
}

function computeAccuracy(predictions, actualMatches) {
  let exactCount = 0, winnerCount = 0, total = 0;
  for (const pred of predictions) {
    const actual = actualMatches.find(m => m.home === pred.home && m.away === pred.away);
    if (!actual) continue;
    total++;
    if (pred.hg === actual.hg && pred.ag === actual.ag) exactCount++;
    const pw = pred.hg > pred.ag ? 'H' : pred.hg < pred.ag ? 'A' : 'D';
    const aw = actual.hg > actual.ag ? 'H' : actual.hg < actual.ag ? 'A' : 'D';
    if (pw === aw) winnerCount++;
  }
  if (total === 0) return null;
  return {
    exactPct: parseFloat((exactCount / total * 100).toFixed(1)),
    winnerPct: parseFloat((winnerCount / total * 100).toFixed(1)),
    totalPredicted: total
  };
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
