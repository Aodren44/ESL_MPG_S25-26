// scripts/generate.mjs
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

// ▼▼ Logs de démarrage
console.log("🚀 Script generate.mjs lancé à", new Date().toISOString());
// --- CONFIG ---
const LEAGUES = {
  FR: "https://mpg.football/league/mpg_league_N382D585/mpg_division_N382D585_10_1/ranking/general",
  EN: "https://mpg.football/league/mpg_league_N382L3SN/mpg_division_N382L3SN_10_1/ranking/general",
  ES: "https://mpg.football/league/mpg_league_N382NGDF/mpg_division_N382NGDF_10_1/ranking/general",
  IT: "https://mpg.football/league/mpg_league_N382M95P/mpg_division_N382M95P_10_1/ranking/general",
};
const EMAIL = process.env.MPG_EMAIL;
const PASSWORD = process.env.MPG_PASSWORD;
if (!EMAIL || !PASSWORD) {
  throw new Error("Secrets MPG_EMAIL / MPG_PASSWORD manquants.");
}
// --- HELPERS ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowStr = () =>
  new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
/* ===========================
   LOGIN (robuste: iframe/CTA)
=========================== */
async function login(page) {
  console.log("🔐 login() start");
// Cookies (page + iframes OneTrust)
  async function acceptCookies() {
    const selectors = [
      "#onetrust-accept-btn-handler",
      "button:has-text('Accepter')",
      "button:has-text('Tout accepter')",
      "button:has-text('Accept all')",
      "button:has-text('Accept')",
      "[aria-label*='accept']",
    ];
    let clicked = false;
    for (const sel of selectors) {
      try {
        const btn = await page.$(sel);
        if (btn) { await btn.click().catch(()=>{}); clicked = true; break; }
      } catch {}
    }
    if (!clicked) {
      for (const f of page.frames()) {
        try {
          const b = await f.$("#onetrust-accept-btn-handler");
          if (b) { await b.click().catch(()=>{}); clicked = true; break; }
        } catch {}
      }
    }
    if (clicked) { console.log("🍪 cookies: accepté"); await page.waitForTimeout(300); }
  }
// Cherche un champ dans la page ou ses frames
  async function findFieldAcrossFrames(selector) {
    const frames = [page, ...page.frames()];
    for (const f of frames) {
      try {
        const loc = f.locator(selector);
        const handle = await loc.elementHandle({ timeout: 600 }).catch(()=>null);
        if (handle) return { frame: f, locator: loc };
      } catch {}
    }
    return null;
  }
// Clique un CTA "Se connecter"
  async function clickLoginCTA() {
    const selectors = [
      "a[href*='/login']",
      "a[href*='connexion']",
      "button:has-text('Se connecter')",
      "button:has-text('Connexion')",
      "button:has-text('Login')",
      "a:has-text('Se connecter')",
      "a:has-text('Connexion')",
      "[data-testid*='login']",
    ];
    for (const sel of selectors) {
      const el = await page.$(sel).catch(()=>null);
      if (el) {
        console.log("▶️ clique CTA login:", sel);
        await el.click().catch(()=>{});
        await page.waitForLoadState("networkidle").catch(()=>{});
        await page.waitForTimeout(700);
        return true;
      }
    }
    return false;
  }
// 1) Aller sur la home
  console.log("→ GOTO home");
  await page.goto("https://mpg.football/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
  await page.waitForTimeout(800);
  await acceptCookies();

// 2) Essayer les URLs directes de login
  const loginUrls = [
    "https://mpg.football/login",
    "https://mpg.football/connexion",
    "https://mpg.football/auth/login",
  ];
  for (const u of loginUrls) {
    console.log("→ tentative URL login:", u);
    await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
    await page.waitForTimeout(600);
    await acceptCookies();

const found = await findFieldAcrossFrames("input[type='email'], input[name='email'], #email, input[autocomplete='email']");
    if (found) { console.log("✅ Champ email trouvé via URL directe, frame:", found.frame.url()); break; }
  }
// 3) Sinon, cliquer un CTA
  let emailField = await findFieldAcrossFrames("input[type='email'], input[name='email'], #email, input[autocomplete='email']");
  if (!emailField) {
    const clicked = await clickLoginCTA();
    if (clicked) {
      emailField = await findFieldAcrossFrames("input[type='email'], input[name='email'], #email, input[autocomplete='email']");
    }
  }
  if (!emailField) throw new Error("Formulaire de connexion introuvable (email).");
// 4) Mot de passe (même frame)
  const pwdField = await findFieldAcrossFrames("input[type='password'], input[name='password'], #password, input[autocomplete='current-password']");
  if (!pwdField) throw new Error("Champ mot de passe introuvable.");
await emailField.locator.fill(EMAIL, { timeout: 30000 });
  await pwdField.locator.fill(PASSWORD, { timeout: 30000 });
// 5) Soumettre
  const submitSelectors = [
    "button[type='submit']",
    "button:has-text('Se connecter')",
    "button:has-text('Connexion')",
    "button:has-text('Log in')",
    "button:has-text('Login')",
    "input[type='submit']",
  ];
  let submitted = false;
  for (const sel of submitSelectors) {
    try {
      const btn = await emailField.frame.$(sel);
      if (btn) {
        await btn.click().catch(()=>{});
        console.log("📨 Credentials soumis (via:", sel, ")");
        submitted = true;
        break;
      }
    } catch {}
  }
  if (!submitted) { try { await pwdField.locator.press("Enter"); console.log("↩️ Submit via Enter"); } catch {} }
await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(()=>{});
  await page.waitForURL(/mpg\.football\/(dashboard|league)/, { timeout: 60000 }).catch(()=>{});
  console.log("✅ Login tenté, url actuelle:", page.url());
}
// helper à coller AU-DESSUS de scrapeLeague
async function gotoWithRetry(page, url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      console.log(`↻ goto try ${i}/${tries}:`, url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      // on laisse l’app SPA charger un peu
      await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
      return true;
    } catch (e) {
      console.log("   goto fail:", e?.message);
      if (i === tries) return false;
    }
  }
  return false;
}

// === SCRAPER ===
async function scrapeLeague(page, url) {
  const out = [];
// 1) navigation robuste (corrige FR)
  const ok = await gotoWithRetry(page, url, 3);
  if (!ok) {
    console.log("⚠️ impossible de charger la page de ligue", url);
    return out;
  }
// 2) attendre le tableau avec plusieurs stratégies (corrige IT)
  //   a) nos sélecteurs cibles
  const wanted = '[data-testid="ranking-row"], table, [role="table"]';
  try {
    await page.waitForSelector(wanted, { timeout: 8000 });
  } catch {}
//   b) si toujours rien de visible, attendre qu’il y ait des lignes utilisables
  try {
    await page.waitForFunction(() => {
      const rankRows = document.querySelectorAll('[data-testid="ranking-row"]').length;
      const tableRows = Array.from(document.querySelectorAll("table tr, [role=table] tr"))
        .filter(tr => tr.querySelectorAll("td").length > 1).length;
      return rankRows > 0 || tableRows > 2;
    }, { timeout: 8000 });
  } catch (e) {
    console.log("⚠️ pas de structure de tableau détectée:", e?.message);
    // on continue quand même, le fallback ci‑dessous tentera un parse large
  }
// 3) chemin 1 : lignes balisées par data-testid
  const rows = await page.$$('[data-testid="ranking-row"]');
  if (rows.length > 0) {
    console.log("   rows[data-testid=ranking-row] =", rows.length);
    for (const r of rows) {
      const name =
        (await r.locator(".team-name, .name, [data-testid=team-name]").textContent().catch(() => null))?.trim()
        ?? (await r.textContent() || "").trim();
let ptsText =
        (await r.locator(".points, .pts, [data-testid*=points]").textContent().catch(() => null)) ?? "";
if (!ptsText) {
        const all = (await r.textContent()) || "";
        const nums = all.match(/\d+/g) || [];
        ptsText = nums.length ? nums[nums.length - 1] : "";
      }
const points = Number.parseInt(String(ptsText).replace(",", "."), 10);
      if (name && Number.isFinite(points)) out.push({ team: name, points });
    }
    return out;
  }
// 4) chemin 2 : fallback tableau générique (plus permissif)
  const trs = await page.$$("table tr, [role=table] tr, div[role='row']");
  let found = 0;
  for (const tr of trs) {
    // on prend seulement les lignes avec au moins 2 cellules “données”
    const tds = await tr.$$("td, [role='cell'], th, div");
    if (tds.length < 2) continue;

let team = null;
    let points = null;
for (const el of tds) {
      const txt = ((await el.textContent()) || "").trim();
      if (!team && /[A-Za-zÀ-ÿ]/.test(txt) && txt.length > 1) team = txt;
      if (!points) {
        const m = txt.match(/^\d+$/);
        if (m) points = Number.parseInt(m[0], 10);
      }
    }
if (team && Number.isFinite(points)) {
      out.push({ team, points });
      found++;
    }
  }
  console.log("   rows<table> (fallback) =", found);
  return out;
}
/* ===== AGRÉGATION + RENDU ===== */
function aggregate(leagues) {
  const columns = ["FR", "EN", "ES", "IT"];
  const teams = new Set();
  for (const c of columns) for (const row of leagues[c] || []) teams.add(row.team);
const byTeam = {};
  for (const team of teams) {
    const pts = Object.fromEntries(
      columns.map((c) => [c, (leagues[c] || []).find((x) => x.team === team)?.points ?? 0])
    );
    const total = columns.reduce((s, c) => s + pts[c], 0);
    byTeam[team] = { team, ...pts, total };
  }
const maxPerCol = Object.fromEntries(
    ["FR", "EN", "ES", "IT"].map((c) => [c, Math.max(0, ...Object.values(byTeam).map((x) => x[c]))])
  );
  const minPerCol = Object.fromEntries(
    ["FR", "EN", "ES", "IT"].map((c) => [c, Math.min(...Object.values(byTeam).map((x) => x[c]))])
  );
for (const t of Object.values(byTeam)) {
    t.wins  = ["FR", "EN", "ES", "IT"].filter((c) => t[c] === maxPerCol[c]).length;
    t.lasts = ["FR", "EN", "ES", "IT"].filter((c) => t[c] === minPerCol[c]).length;
  }
const table = Object.values(byTeam).sort(
    (a, b) =>
      b.total - a.total ||
      b.wins - a.wins ||
      a.lasts - b.lasts ||
      a.team.localeCompare(b.team)
  );
  table.forEach((r, i) => (r.rank = i + 1));
  return table;
}
function renderHTML(table) {
  const genAt = nowStr();
  const th = (txt) => `<th>${txt}</th>`;
  const td = (txt, cls = "") => `<td class="${cls}">${txt}</td>`;
const columns = ["FR", "EN", "ES", "IT"];
  const max = Object.fromEntries(columns.map((c) => [c, Math.max(...table.map((r) => r[c] ?? 0))]));
  const min = Object.fromEntries(columns.map((c) => [c, Math.min(...table.map((r) => r[c] ?? 0))]));
const rows = table
    .map((r) => {
      const cells = columns
        .map((c) => {
          const cls = r[c] === max[c] ? "best" : r[c] === min[c] ? "worst" : "";
          return td(r[c], cls);
        })
        .join("");
      return `<tr>
        ${td(r.rank)}
        ${td(r.team)}
        ${cells}
        ${td(`<strong>${r.total}</strong>`)}
        ${td(r.wins)}
        ${td(r.lasts)}
      </tr>`;
    })
    .join("\n");
return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>Classement MPG — Global</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { --bg:#fff; --fg:#111; --muted:#666; --border:#e5e7eb; --best:#e6ffed; --worst:#ffecec;}
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:var(--bg); color:var(--fg); margin:40px auto; max-width:1100px; padding:0 16px; }
    .card { border:1px solid var(--border); border-radius:14px; padding:22px; box-shadow:0 1px 2px rgba(0,0,0,.03); }
    h1 { margin:0 0 6px 0; font-size:28px; }
    small { color:var(--muted); }
    table { width:100%; border-collapse: collapse; margin-top:14px; }
    th, td { padding:10px 12px; border-bottom:1px solid var(--border); text-align:left; white-space:nowrap; }
    thead th { background:#fafafa; position:sticky; top:0; }
    tr:hover td { background:#fafafa; }
    td.best { background: var(--best); font-weight:600; }
    td.worst { background: var(--worst); }
    .legend { margin-top:10px; color:var(--muted); font-size:14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Classement MPG — Global</h1>
    <p><small>Mis à jour automatiquement : ${genAt}</small></p>
    <table>
      <thead>
        <tr>
          ${th("#")}
          ${th("Équipe")}
          ${th("FR")}
          ${th("EN")}
          ${th("ES")}
          ${th("IT")}
          ${th("Total")}
          ${th("Verts")}
          ${th("Rouges")}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="legend">Verts = meilleur score de la ligue ; Rouges = plus petit score de la ligue (sert aux tie-breakers).</div>
  </div>
</body>
</html>`;
}

// === MAIN ===
async function main() {
  // Sur runner GitHub: pas de sandbox
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
await login(page);
const leagues = {};
  for (const [code, url] of Object.entries(LEAGUES)) {
    try {
      const rows = await scrapeLeague(page, url);
      leagues[code] = rows;
      console.log(`✅ ${code} -> ${rows.length} équipes`);
    } catch (e) {
      console.log(`⚠️ ${code} indisponible:`, e?.message);
      leagues[code] = [];
    }
    await sleep(300);
  }
await browser.close();
const table = aggregate(leagues);
  console.log("📊 total équipes agrégées:", table.length);
mkdirSync("docs", { recursive: true });
  writeFileSync("docs/index.html", renderHTML(table), "utf8");
  console.log("📝 écrit: docs/index.html");
console.log("✅ Page générée avec", table.length, "équipes :", nowStr());
}
// Lancer + log d'erreur fatal si besoin
main().catch((e) => {
  console.error("💥 Erreur fatale:", e);
  process.exit(1);
});
