// scripts/generate.mjs
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const LEAGUES = {
  FR: "https://mpg.football/league/mpg_league_N382D585/mpg_division_N382D585_10_1/ranking/general",
  EN: "https://mpg.football/league/mpg_league_N382L3SN/mpg_division_N382L3SN_10_1/ranking/general",
  ES: "https://mpg.football/league/mpg_league_N382NGDF/mpg_division_N382NGDF_10_1/ranking/general",
  IT: "https://mpg.football/league/mpg_league_N382M95P/mpg_division_N382M95P_10_1/ranking/general",
};

const EMAIL = process.env.MPG_EMAIL;
const PASSWORD = process.env.MPG_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error("Secrets MPG_EMAIL / MPG_PASSWORD manquants.");

const now = () => new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

async function login(page){
  await page.goto("https://mpg.football/login", { waitUntil:"networkidle" });
  // cookies (quels que soient les textes)
  for (const txt of ["Accepter","Tout accepter","Accept all","Accept"]) {
    const btn = await page.$(`:text("${txt}")`);
    if (btn) { await btn.click().catch(()=>{}); break; }
  }
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
  // on attend d'être loggé (redirection vers le dashboard)
  await page.waitForURL(/mpg\.football\/(dashboard|league)/, { timeout: 15000 }).catch(()=>{});
}

async function scrapeLeague(page, url){
  const rows = [];
  try { await page.goto(url, { waitUntil:"networkidle" }); } catch { return rows; }
  // attendre qu’un tableau/rows apparaisse
  await page.waitForSelector('[data-testid="ranking-row"], table, [role="table"]', { timeout: 10000 }).catch(()=>{});
  // 1) cas “ranking-row”
  for (const r of await page.$$('[data-testid="ranking-row"]')) {
    const name = (await r.locator('.team-name, .name, [data-testid="team-name"]').textContent().catch(()=>null))?.trim();
    let pts = (await r.locator('.points, .pts').textContent().catch(()=>null))?.trim();
    if (!pts) { // fallback: dernier entier de la ligne
      const t = (await r.textContent()) || "";
      const nums = t.match(/\d+/g) || [];
      pts = nums.at(-1) || "";
    }
    const points = parseInt(String(pts).replace(",", "."));
    if (name && Number.isFinite(points)) rows.push({ team:name, points });
  }
  if (rows.length) return rows;

  // 2) fallback tableau générique
  for (const tr of await page.$$('table tr, [role="table"] tr')) {
    const cells = await tr.$$('td, th, div');
    const texts = await Promise.all(cells.map(c=>c.textContent().then(s=>s?.trim()||"")));
    const team = texts.find(t => /[A-Za-zÀ-ÿ]/.test(t) && t.length>1);
    const p = texts.map(t=>t.match(/^\d+$/)?.[0]).filter(Boolean).map(Number).at(-1);
    if (team && Number.isFinite(p)) rows.push({ team, points:p });
  }
  return rows;
}

function aggregate(leagues){
  const cols = ["FR","EN","ES","IT"];
  const teams = new Set(cols.flatMap(c => (leagues[c]||[]).map(x=>x.team)));
  const out = [];
  for (const team of teams) {
    const row = { team };
    cols.forEach(c => row[c] = (leagues[c]||[]).find(x=>x.team===team)?.points ?? 0);
    row.total = cols.reduce((s,c)=>s+row[c],0);
    out.push(row);
  }
  const max = Object.fromEntries(cols.map(c => [c, Math.max(0, ...out.map(r=>r[c]))]));
  const min = Object.fromEntries(cols.map(c => [c, Math.min(...out.map(r=>r[c]))]));
  for (const r of out) {
    r.wins  = cols.filter(c => r[c] === max[c]).length;   // cases vertes
    r.lasts = cols.filter(c => r[c] === min[c]).length;   // cases rouges
  }
  out.sort((a,b)=> b.total-a.total || b.wins-a.wins || a.lasts-b.lasts || a.team.localeCompare(b.team));
  out.forEach((r,i)=>r.rank=i+1);
  return { rows: out, max, min };
}

function render({ rows, max, min }){
  const th = s=>`<th>${s}</th>`;
  const td = (s,cls="")=>`<td class="${cls}">${s}</td>`;
  const cols=["FR","EN","ES","IT"];
  const body = rows.map(r=>{
    const cells = cols.map(c=>{
      const cls = r[c]===max[c] ? "best" : (r[c]===min[c] ? "worst" : "");
      return td(r[c], cls);
    }).join("");
    return `<tr>${td(r.rank)}${td(r.team)}${cells}${td(`<strong>${r.total}</strong>`)}${td(r.wins)}${td(r.lasts)}</tr>`;
  }).join("\n");
  return `<!doctype html><html lang="fr"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Classement MPG — Global</title>
  <style>
    :root{--border:#e5e7eb;--best:#e6ffed;--worst:#ffecec}
    body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:1100px;margin:40px auto;padding:0 16px}
    .card{border:1px solid var(--border);border-radius:14px;padding:22px}
    table{width:100%;border-collapse:collapse;margin-top:12px}
    th,td{padding:10px 12px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap}
    thead th{background:#fafafa}
    td.best{background:var(--best);font-weight:600}
    td.worst{background:var(--worst)}
    .legend{margin-top:10px;color:#666;font-size:14px}
  </style></head><body>
  <!-- build:${Date.now()} -->
  <div class="card">
    <h1>Classement MPG — Global</h1>
    <p><small>Mis à jour automatiquement : ${now()}</small></p>
    <table>
      <thead><tr>${th("#")}${th("Équipe")}${th("FR")}${th("EN")}${th("ES")}${th("IT")}${th("Total")}${th("Verts")}${th("Rouges")}</tr></thead>
      <tbody>${body}</tbody>
    </table>
    <div class="legend">Verts = meilleur score de la ligue ; Rouges = plus petit score (sert au tie-break).</div>
  </div></body></html>`;
}

async function main(){
  const browser = await chromium.launch({ headless:true });
  const page = await browser.newPage();
  await login(page);

  const leagues = {};
  for (const [code,url] of Object.entries(LEAGUES)) {
    leagues[code] = await scrapeLeague(page, url).catch(()=>[]);
    console.log(`⚽ ${code}: ${leagues[code].length} équipes`);
    await sleep(300);
  }
  await browser.close();

  const table = aggregate(leagues);
  mkdirSync("docs",{recursive:true});
  writeFileSync("docs/index.html", render(table), "utf8");
  console.log(`✅ Page générée avec ${table.rows.length} équipes à ${now()}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
