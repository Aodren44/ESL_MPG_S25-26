// scripts/generate.mjs
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

/* ======================== CONFIG ======================== */
const ORDER = ["FR", "EN", "ES", "IT"];
const HEADERS = { FR: "🇫🇷", EN: "🇬🇧", ES: "🇪🇸", IT: "🇮🇹" };

const LEAGUES = {
  FR: process.env.MPG_ESL_FR || "",
  EN: process.env.MPG_ESL_UK || "",
  ES: process.env.MPG_ESL_ES || "",
  IT: process.env.MPG_ESL_IT || "",
};

const MPG_EMAIL = process.env.MPG_EMAIL || "";
const MPG_PASSWORD = process.env.MPG_PASSWORD || "";

const OUTPUT_DIR = existsSync("docs") ? "docs" : ".";
const OUTPUT_FILE = path.join(OUTPUT_DIR, "index.html");
const PAGE_TITLE = "CLASSEMENT MPG - EUROPEAN STAR LEAGUE - S25/26";

for (const k of ORDER) console.log(`URL ${k}:`, LEAGUES[k] ? "(ok via secret)" : "(vide)");

/* ======================== HELPERS ======================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowFR = () => new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

function parseIntSafe(raw, fallback = 0) {
  if (raw == null) return fallback;
  const m = String(raw).replace(/\u00A0/g, " ").match(/-?\d+/);
  return m ? parseInt(m[0], 10) : fallback;
}
function fmtDateFR(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${date} à ${time}`;
}
function canonicalName(name) {
  return String(name || "").trim();
}
function fmtSigned(n) {
  return n > 0 ? `+${n}` : String(n);
}

async function acceptCookiesRobust(page) {
  const selectors = [
    "#onetrust-accept-btn-handler",
    "button:has-text('Accepter')",
    "button:has-text('Tout accepter')",
    "button:has-text('Accept all')",
    "button:has-text('Accept')",
    "[aria-label*='accept']",
    '[data-testid="uc-accept-all-button"]',
  ];
  let clicked = false;
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click().catch(() => {});
        clicked = true;
        break;
      }
    } catch {}
  }
  if (!clicked) {
    for (const f of page.frames()) {
      try {
        const b = await f.$("#onetrust-accept-btn-handler");
        if (b) {
          await b.click().catch(() => {});
          clicked = true;
          break;
        }
      } catch {}
    }
  }
  if (clicked) {
    console.log("🍪 cookies: accepté");
    await page.waitForTimeout(300);
  }
}
async function findFieldAcrossFrames(page, selector) {
  const frames = [page, ...page.frames()];
  for (const f of frames) {
    try {
      const loc = f.locator(selector);
      const handle = await loc.elementHandle({ timeout: 600 }).catch(() => null);
      if (handle) return { frame: f, locator: loc };
    } catch {}
  }
  return null;
}
async function clickLoginCTA(page) {
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
    const el = await page.$(sel).catch(() => null);
    if (el) {
      console.log("▶️ clique CTA login:", sel);
      await el.click().catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(700);
      return true;
    }
  }
  return false;
}
async function loginRobust(page) {
  if (!MPG_EMAIL || !MPG_PASSWORD) throw new Error("MPG_EMAIL / MPG_PASSWORD manquants.");

  console.log("→ GOTO home");
  await page.goto("https://mpg.football/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(800);
  await acceptCookiesRobust(page);

  const loginUrls = ["https://mpg.football/login", "https://mpg.football/connexion", "https://mpg.football/auth/login"];
  for (const u of loginUrls) {
    console.log("→ tentative URL login:", u);
    await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(600);
    await acceptCookiesRobust(page);
    const found = await findFieldAcrossFrames(
      page,
      "input[type='email'], input[name='email'], #email, input[autocomplete='email']"
    );
    if (found) {
      console.log("✅ Champ email trouvé via URL directe, frame:", found.frame.url());
      break;
    }
  }

  let emailField = await findFieldAcrossFrames(
    page,
    "input[type='email'], input[name='email'], #email, input[autocomplete='email']"
  );
  if (!emailField) {
    const clicked = await clickLoginCTA(page);
    if (clicked) {
      emailField = await findFieldAcrossFrames(
        page,
        "input[type='email'], input[name='email'], #email, input[autocomplete='email']"
      );
    }
  }
  if (!emailField) throw new Error("Formulaire de connexion introuvable (email).");

  const pwdField = await findFieldAcrossFrames(
    page,
    "input[type='password'], input[name='password'], #password, input[autocomplete='current-password']"
  );
  if (!pwdField) throw new Error("Champ mot de passe introuvable.");

  await emailField.locator.fill(MPG_EMAIL, { timeout: 30000 });
  await pwdField.locator.fill(MPG_PASSWORD, { timeout: 30000 });

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
        await btn.click().catch(() => {});
        console.log("📨 Credentials soumis (via:", sel, ")");
        submitted = true;
        break;
      }
    } catch {}
  }
  if (!submitted) {
    try {
      await pwdField.locator.press("Enter");
      console.log("↩️ Submit via Enter");
    } catch {}
  }

  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForURL(/mpg\.football\/(dashboard|league)/, { timeout: 60000 }).catch(() => {});
  console.log("✅ Login tenté, url actuelle:", page.url());
}
async function loginIfNeeded(context) {
  const page = await context.newPage();
  try {
    await loginRobust(page);
    const ok = /mpg\.football\/(dashboard|league)/.test(page.url());
    console.log(ok ? "✅ Login OK" : "⚠️ Login non confirmé (on continue)");
    return ok;
  } catch (e) {
    console.log("⚠️ Login: exception, on continue en invité:", e?.message || e);
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

/* ======================== SCRAPING ======================== */
async function scrapeLeague(context, code, url) {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  let triedLogin = false;

  async function ensureOnLeague() {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await acceptCookiesRobust(page);
  }

  try {
    console.log(`▶️  ${code} → ${url || "(vide)"}`);
    if (!url) throw new Error(`URL manquante pour ${code}`);

    await ensureOnLeague();

    const firstHtml = await page.content().catch(() => "");
    if ((/\/login/i.test(page.url()) || /Du foot, des amis/.test(firstHtml)) && !triedLogin) {
      console.log(`🔁 ${code}: redirigé vers login/homepage → login + 2e tentative`);
      triedLogin = await loginIfNeeded(context);
      await ensureOnLeague();
    }

    await page.waitForSelector("table", { timeout: 20000 }).catch(() => {});
    await sleep(1000);

    let rows =
      (await page
        .$$eval("table tbody tr", (trs) =>
          trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim()))
        )
        .catch(() => [])) || [];

    if (!rows.length) {
      rows =
        (await page
          .$eval("table", (tbl) =>
            Array.from(tbl.querySelectorAll("tr"))
              .filter((tr) => tr.querySelectorAll("td").length)
              .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim()))
          )
          .catch(() => [])) || [];
    }

    if (!rows.length) {
      await dumpForDebug(page, code);
      throw new Error(`Aucune ligne de classement trouvée pour ${code}`);
    }

    const headers =
      (await page.$$eval("table thead th", (ths) => ths.map((th) => th.textContent.trim())).catch(() => [])) || [];
    const findIdx = (re, fallback) => {
      const i = headers.findIndex((h) => re.test(h || ""));
      return i !== -1 ? i : fallback;
    };
    const idxTeam = findIdx(/équipe|equipe|team/i, 1);
    const idxPts = findIdx(/points|pts/i, Math.max(0, (headers.length || 1) - 1));
    const idxDiff = findIdx(/\+\/-|±|diff/i, Math.max(0, idxPts - 1));

    const data = new Map();
    for (const row of rows) {
      if (!row || !row.length) continue;
      const name = canonicalName(row[idxTeam] ?? row[1] ?? row[0]);
      const pts = parseIntSafe(row[idxPts], 0);
      const diff = parseIntSafe(row[idxDiff], 0);
      if (!name) continue;
      data.set(name, { pts, diff });
    }

    if (!data.size) {
      await dumpForDebug(page, code);
      throw new Error(`Tableau lu mais vide pour ${code}`);
    }

    console.log(`✅ ${code}: ${data.size} équipes`);
    return data;
  } catch (e) {
    console.warn(`⚠️ ${code}: échec (${e?.message || e}). On continue avec 0. Voir dumps.`);
    return new Map();
  } finally {
    await page.close().catch(() => {});
  }
}

/* ======================== AGREGE + CLASSE ======================== */
function aggregate(leaguesData) {
  const teams = new Map();

  for (const code of ORDER) {
    const map = leaguesData[code] || new Map();
    for (const [name, { pts, diff }] of map.entries()) {
      if (!teams.has(name)) {
        teams.set(name, {
          name,
          FR: { pts: 0, diff: 0 },
          EN: { pts: 0, diff: 0 },
          ES: { pts: 0, diff: 0 },
          IT: { pts: 0, diff: 0 },
          totalPts: 0,
          totalDiff: 0,
          greens: 0,
          reds: 0,
        });
      }
      const t = teams.get(name);
      t[code].pts = pts;
      t[code].diff = diff;
    }
  }

  for (const t of teams.values()) {
    t.totalPts = ORDER.reduce((s, c) => s + (t[c].pts || 0), 0);
    t.totalDiff = ORDER.reduce((s, c) => s + (t[c].diff || 0), 0);
  }

  // Min/Max par colonne
  const minPts = {}, maxPts = {};
  for (const code of ORDER) {
    const vals = Array.from(teams.values()).map((t) => t[code].pts || 0);
    minPts[code] = vals.length ? Math.min(...vals) : 0;
    maxPts[code] = vals.length ? Math.max(...vals) : 0;
  }
  const totals = Array.from(teams.values()).map((t) => t.totalPts);
  const diffs = Array.from(teams.values()).map((t) => t.totalDiff);
  const minTotal = totals.length ? Math.min(...totals) : 0;
  const maxTotal = totals.length ? Math.max(...totals) : 0;
  const minDiffAll = diffs.length ? Math.min(...diffs) : 0;
  const maxDiffAll = diffs.length ? Math.max(...diffs) : 0;

  // Compter verts/rouges FR/EN/ES/IT
  for (const t of teams.values()) {
    t.greens = ORDER.reduce((s, c) => s + (t[c].pts === maxPts[c] ? 1 : 0), 0);
    t.reds = ORDER.reduce((s, c) => s + (t[c].pts === minPts[c] ? 1 : 0), 0);
  }

  // Tri final
  const rows = Array.from(teams.values()).sort((a, b) => {
    if (b.totalPts !== a.totalPts) return b.totalPts - a.totalPts;
    if (b.greens !== a.greens) return b.greens - a.greens;
    if (a.reds !== b.reds) return a.reds - b.reds;
    if (b.totalDiff !== a.totalDiff) return b.totalDiff - a.totalDiff;
    return 0;
  });

  return { rows, minPts, maxPts, minTotal, maxTotal, minDiffAll, maxDiffAll };
}

/* ======================== RENDU HTML ======================== */
function buildHtml({ rows, minPts, maxPts, minTotal, maxTotal, minDiffAll, maxDiffAll }) {
  const updated = fmtDateFR(new Date());

  const style = `
  <style>
    :root { --bg:#ffffff; --text:#111; --muted:#666; --line:#eee; --accent:#b9c2ff; --accent-bg:#f4f6ff; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 24px; }

    /* Conteneur centré et largeur maîtrisée */
    .wrap { max-width: 900px; margin: 0 auto; }

    /* === LOGO === */
    .logo { text-align: center; margin-bottom: 16px; }
    .logo img {
      display: block;
      width: 100%;        /* pile la largeur du conteneur (donc du tableau) */
      height: auto;
      max-height: 160px;  /* ajuste si besoin (140/180/etc.) */
      object-fit: contain;
      margin: 0 auto;
    }

    /* Tableau */
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    th:nth-child(2), td:nth-child(2) { text-align: left; }

    /* Réduction écart entre Équipe et 🇫🇷 */
    th:nth-child(2), td:nth-child(2) { padding-right: 6px; }
    th:nth-child(3), td:nth-child(3) { padding-left: 6px; }

    .rank { width: 42px; color: var(--muted); }
    .team { width: auto; }
    .num { width: 70px; }
    tr:hover td { background: #fafafa; }

    .tag-green { background: #e6ffed; }
    .tag-red { background: #ffecec; }

    /* TOTAL en valeur */
    .total-col { border: 2px solid var(--accent); background: var(--accent-bg); border-radius: 8px; }
    .total { font-weight: 800; }

    .updated { color: var(--muted); font-size: 13px; margin-top: 12px; text-align: right; }
  </style>`.trim();

  const thead = `
  <thead>
    <tr>
      <th class="rank">#</th>
      <th class="team">Équipe</th>
      ${ORDER.map((c) => `<th class="num" title="${c}">${HEADERS[c]}</th>`).join("")}
      <th class="num" title="Différence de buts cumulée">Diff +/-</th>
      <th class="num total total-col" title="Points cumulés">TOTAL</th>
    </tr>
  </thead>`.trim();

  const tbody = `
  <tbody>
    ${rows.map((t, i) => {
      const cellsLeagues = ORDER.map((c) => {
        const v = t[c].pts || 0;
        const cls = v === maxPts[c] ? "tag-green" : v === minPts[c] ? "tag-red" : "";
        return `<td class="num ${cls}">${v}</td>`;
      }).join("");

      const clsTotal = t.totalPts === maxTotal ? "tag-green" : t.totalPts === minTotal ? "tag-red" : "";
      const clsDiff  = t.totalDiff === maxDiffAll ? "tag-green" : t.totalDiff === minDiffAll ? "tag-red" : "";

      return `
        <tr>
          <td class="rank">${i + 1}</td>
          <td class="team">${t.name}</td>
          ${cellsLeagues}
          <td class="num ${clsDiff}">${fmtSigned(t.totalDiff)}</td>
          <td class="num total total-col ${clsTotal}">${t.totalPts}</td>
        </tr>`;
    }).join("\n")}
  </tbody>`.trim();

  const html = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${PAGE_TITLE}</title>
  ${style}
</head>
<body>
  <div class="wrap">
    <div class="logo">
      <img src="Spurs_Logo_ESL_25-26.png" alt="European MPG Super League" />
    </div>
    <table>
      ${thead}
      ${tbody}
    </table>
    <div class="updated">Dernière Mise à jour : ${fmtDateFR(new Date())}</div>
  </div>
</body>
</html>`.trim();

  return html;
}

/* ======================== MAIN ======================== */
(async () => {
  console.log("🚀 generate.mjs démarré", nowFR());
  for (const k of ORDER) if (!LEAGUES[k]) console.warn(`⚠️ URL manquante pour ${k}`);

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "fr-FR",
      timezoneId: "Europe/Paris",
    });

    // Tentative login une fois
    await loginIfNeeded(context);

    const leaguesData = {};
    for (const code of ORDER) {
      const started = Date.now();
      leaguesData[code] = await scrapeLeague(context, code, LEAGUES[code]).catch(() => new Map());
      console.log(`⏱️ ${code} traité en ${(Date.now() - started) / 1000}s`);
    }

    const aggregated = aggregate(leaguesData);
    const html = buildHtml(aggregated);

    if (OUTPUT_DIR !== "." && !existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(OUTPUT_FILE, html, "utf8");
    console.log(`💾 Page générée → ${OUTPUT_FILE}`);
  } catch (e) {
    console.error("❌ Erreur durant la génération :", e?.stack || e);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    console.log("🏁 Terminé", nowFR());
  }
})();
