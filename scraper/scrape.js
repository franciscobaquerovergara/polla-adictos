const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const GROUP_ID = 84178;
const BASE_URL = 'https://game.pollaya.com';
// Per-participant accuracy scraping is disabled: Pollaya no longer shows each
// user's pick for already-played matches inline, so it can't be computed
// reliably and only slowed the run down. Flip to true if that changes.
const SCRAPE_ACCURACY = false;

async function main() {
  console.log('Starting Pollaya scraper...');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);

  try {
    // Login
    console.log('Logging in...');
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    // Dismiss any cookie/consent overlay that could hide the form.
    for (const sel of ['button:has-text("Aceptar")', 'button:has-text("Accept")', 'button:has-text("De acuerdo")', 'button:has-text("Entendido")', '#onetrust-accept-btn-handler']) {
      const b = await page.$(sel).catch(() => null);
      if (b) { await b.click().catch(() => {}); await page.waitForTimeout(400); }
    }

    // Wait for the password field to exist in the DOM (state attached, not
    // necessarily visible). The login form is JS-rendered and slow under CI.
    const emailSelector = 'input[type="email"], input[name="email"], input[placeholder*="mail" i], input[placeholder*="correo" i]';
    const passField = await page.waitForSelector('input[type="password"]', { state: 'attached', timeout: 60000 }).catch(() => null);

    if (!passField) {
      // Self-diagnose: log exactly what the headless page shows so we can fix it.
      try {
        const diag = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          inputs: [...document.querySelectorAll('input')].map(i => i.type + '|' + (i.name || '') + '|' + (i.placeholder || '')),
          frames: [...document.querySelectorAll('iframe')].map(f => f.src).slice(0, 5),
          body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600)
        }));
        console.error('LOGIN-DIAG ' + JSON.stringify(diag));
      } catch (e) { console.error('diag failed', e.message); }
      throw new Error('Login fields not found');
    }

    const emailField = await page.$(emailSelector);
    if (!emailField) throw new Error('Email field not found');

    await emailField.fill(process.env.POLLAYA_EMAIL || '');
    await passField.fill(process.env.POLLAYA_PASSWORD || '');
    await passField.press('Enter');

    // Wait until we've left the login page (successful auth redirects away).
    await page.waitForURL(u => !String(u).includes('/login'), { timeout: 20000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    console.log('Logged in, at:', page.url());
    if (page.url().includes('/login')) throw new Error('Login did not redirect - check credentials/secrets');

    // Standings + participant links
    console.log('Scraping standings...');
    await page.goto(`${BASE_URL}/mis-grupos/${GROUP_ID}/posiciones`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.t-pts', { timeout: 45000 });

    // Load all players
    let more = true, attempts = 0;
    while (more && attempts < 12) {
      const btn = await page.$('button:has-text("Ver más usuarios")');
      if (btn) { await btn.click().catch(() => {}); await page.waitForTimeout(800); attempts++; }
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
    console.log('Got ' + standings.length + ' players, ' + participantLinks.length + ' profile links');

    // Match results
    console.log('Scraping match results...');
    await page.goto(`${BASE_URL}/mis-grupos/${GROUP_ID}/pronosticos`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.textContent.includes('Comparar'), { timeout: 45000 });
    await page.waitForTimeout(1500);

    const rawText = await page.evaluate(() => document.body.textContent);
    const matchesPlayed = parseMatches(rawText);
    console.log('Got ' + matchesPlayed.length + ' completed matches');

    // Per-participant predictions & accuracy (optional)
    let accuracyStats = [];
    if (SCRAPE_ACCURACY && participantLinks.length > 0 && matchesPlayed.length > 0) {
      for (const p of participantLinks) {
        try {
          const predUrl = p.href.includes('pronosticos') ? p.href : p.href.replace(/\/$/, '') + '/pronosticos';
          await page.goto(predUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForFunction(() => document.body.textContent.includes('Comparar'), { timeout: 10000 }).catch(() => {});
          const text = await page.evaluate(() => document.body.textContent);
          const preds = parseUserPredictions(text);
          if (preds.length > 0) {
            const stats = computeAccuracy(preds, matchesPlayed);
            if (stats) accuracyStats.push({ name: p.name, ...stats });
          }
        } catch (e) { /* best-effort */ }
      }
    }

    await browser.close();

    // Build data.json
    const dataPath = path.join(__dirname, '..', 'data.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(dataPath, 'utf8')); } catch {}

    // Never wipe good data with an empty scrape - keep previous values instead.
    const safeStandings = standings.length > 0 ? standings : (existing.standings || []);
    const safeMatches = matchesPlayed.length > 0 ? matchesPlayed : (existing.matchesPlayed || []);

    const data = {
      lastUpdated: new Date().toISOString(),
      group: existing.group || { name: 'Adictos', id: GROUP_ID, tournament: 'Copa Mundial FIFA 2026' },
      rules: existing.rules || {},
      standings: safeStandings,
      matchesPlayed: safeMatches,
      matchesPlayed_count: safeMatches.length,
      totalMatches: existing.totalMatches || 104,
      accuracyStats: accuracyStats.length > 0 ? accuracyStats : (existing.accuracyStats || [])
    };
    data.group.participants = safeStandings.length || data.group.participants;

    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
    console.log('data.json updated!');
  } catch (err) {
    try {
      await page.screenshot({ path: path.join(__dirname, '..', 'debug.png'), fullPage: true });
      fs.writeFileSync(path.join(__dirname, '..', 'debug.html'), await page.content());
      console.error('Saved debug.png / debug.html');
    } catch {}
    await browser.close().catch(() => {});
    throw err;
  }
}

// Parsers

function parseMatches(text) {
  // Current Pollaya layout for a played/locked match (concatenated textContent):
  //   "vie. 12 jun. 03:00 MEX(2)(0)CompararRSA"
  // The two parenthesised numbers are the REAL match score (home)(away).
  // Upcoming matches render editable inputs (no parentheses), so they are skipped.
  const matches = [];
  const seen = new Set();
  const days = { 'vie': 'Vie', 'sáb': 'Sáb', 'dom': 'Dom', 'lun': 'Lun', 'mar': 'Mar', 'mié': 'Mié', 'jue': 'Jue' };
  const monthMap = { 'ene': 'Ene', 'feb': 'Feb', 'mar': 'Mar', 'abr': 'Abr', 'may': 'May', 'jun': 'Jun', 'jul': 'Jul', 'ago': 'Ago', 'sep': 'Sep', 'oct': 'Oct', 'nov': 'Nov', 'dic': 'Dic' };
  const re = /(vie|sáb|dom|lun|mar|mié|jue)\.\s*(\d{1,2})\s+(\w+)\.\s*[\d:]+\s*([A-Z]{2,4})\s*\((\d+)\)[^()]{0,8}\((\d+)\)\s*Comparar\s*([A-Z]{2,4}?)(?=Grupo|Hoy|Octavos|Cuartos|Semifinal|Final|Tercer|[a-z\s]|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const day = m[1], dom = m[2], mon = m[3], home = m[4], hg = m[5], ag = m[6], away = m[7];
    const key = home + '-' + away;
    if (seen.has(key)) continue;
    seen.add(key);
    const date = (days[day.toLowerCase()] || day) + ' ' + dom + ' ' + (monthMap[mon.toLowerCase()] || mon);
    matches.push({ date, home, away, hg: parseInt(hg), ag: parseInt(ag), group: '?' });
  }
  return matches;
}

function parseUserPredictions(text) {
  const preds = [];
  const re = /([A-Z]{2,4})\s*\((\d+)\)[^()]{0,8}\((\d+)\)\s*Comparar\s*([A-Z]{2,4}?)(?=Grupo|Hoy|Octavos|Cuartos|Semifinal|Final|Tercer|[a-z\s]|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    preds.push({ home: m[1], away: m[4], hg: parseInt(m[2]), ag: parseInt(m[3]) });
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

main().catch(e => { console.error('ERROR', e.message); process.exit(1); });
