// scripts/generate.mjs
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

/* ======================== CONFIG ======================== */
const ORDER = ["FR", "EN", "ES", "IT"];
const HEADERS = { FR: "🇫🇷", EN: "🇬🇧", ES: "🇪🇸", IT: "🇮🇹" };

// Secrets
const LEAGUES = {
  FR: process.env.MPG_ESL_FR || "",
  EN: process.env.MPG_ESL_UK || "",
  ES: process.env.MPG_ESL_ES || "",
  IT: process.env.MPG_ESL_IT || "",
};
const MPG_EMAIL = process.env.MPG_EMAIL || "";
const MPG_PASSWORD = process.env.MPG_PASSWORD || "";

// Sortie
const OUTPUT_DIR = existsSync("docs") ? "docs" : ".";
const OUTPUT_FILE = path.join(OUTPUT_DIR, "index.html");
const PAGE_TITLE = "Classement MPG — European Star League — S25/26";

// Logs secrets (sans afficher les URLs)
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
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`;
}
function canonicalName(name) {
  return String(name || "").trim();
}
async function safeClick(page, selectors = []) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
        await el.click({ timeout: 1500 });
        return true;
      }
    } catch {}
  }
  return false;
}
async function dumpForDebug(page, code) {
  try {
    const png = `screenshot-${code}.png`;
    const html = `dump-${code}.html`;
    await page.screenshot({ path: png, fullPage: true }).catch(() => {});
    const content = await page.content().catch(() => "");
    if (content) writeFileSync(html, content);
    console.log(`🧩 Dump ${code}: ${png}${content ? `, ${html}` : ""}`);
  } catch {}
}

/* ======================== AUTH ======================== */
async function acceptCookies(page) {
  await safeClick(page, [
    'button:has-text("Accepter")',
    'button:has-text("Accept")',
    'button:has-text("Tout accepter")',
    '[data-testid="uc-accept-all-button"]',
  ]);
}
async function fillLoginForm(page) {
  const emails = ['input[name="email"]', 'input[type="email"]', '#email', 'input[placeholder*="mail" i]'];
  const passes = ['input[name="password"]', 'input[type="password"]', '#password', 'input[placeholder*="mot de passe" i]'];
  let okE = false,
    okP = false;
  for (const s of emails) if (await page.locator(s).first().isVisible().catch(() => false)) { await page.fill(s, MPG_EMAIL); okE = true; break; }
  for (const s of passes) if (await page.locator(s).first().isVisible().catch(() => false)) { await page.fill(s, MPG_PASSWORD); okP = true; break; }
  if (!(okE && okP)) return false;
  await safeClick(page, [
    'button[type="submit"]',
    'button:has-text("Se connecter")',
    'button:has-text("Je me connecte")',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
  ]);
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  return true;
}
async function loginIfNeeded(context, testUrl) {
  if (!MPG_EMAIL || !MPG_PASSWORD) {
    console.log("🔓 Login ignoré (MPG_EMAIL/MPG_PASSWORD non fournis).");
    return false;
  }
  const page = await context.newPage();
  try {
    console.log("🔐 Tentative de login…");
    await page.goto("https://mpg.football", { waitUntil: "domcontentloaded", timeout: 60000 });
    await acceptCookies(page);
    await safeClick(page, [
      'button:has-text("Je me connecte")',
      'button:has-text("Se connecter")',
      'a:has-text("Je me connecte")',
      'a:has-text("Se connecter")',
    ]);
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await acceptCookies(page);
    await fillLoginForm(page);
    if (testUrl) {
      await page.goto(testUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    }
    const html = await page.content().catch(() => "");
    const ok = !/\/login/i.test(page.url()) && !/Du foot, des amis/.test(html);
    console.log(ok ? "✅ Login OK" : "⚠️ Login non confirmé (on continue quand même)");
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
  page.setDefaultTimeout(15000); // bornes strictes
  try {
    console.log(`▶️  ${code} → ${url || "(vide)"}`);
    if (!url) throw new Error(`URL manquante pour ${code}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await acceptCookies(page);

    // Si renvoyé vers login/homepage → une seule tentative de relog + retry
    const firstHtml = await page.content().catch(() => "");
    if (/\/login/i.test(page.url()) || /Du foot, des amis/.test(firstHtml)) {
      console.log(`🔁 ${code}: redirigé vers login/homepage → login + retry`);
      await page.close().catch(() => {});
      await loginIfNeeded(context, url);
      return await scrapeLeague(context, code, url); // 1 retry borné par les timeouts ci‑dessus
    }

    // Attend le tableau mais ne bloque pas indéfiniment
    await page.waitForSelector("table", { timeout: 20000 }).catch(() => {});
    await sleep(1000);

    // Récupère lignes
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
    return new Map(); // tolérant : permet de finir la page
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

  for (const t of teams.values()) {
    t.greens = ORDER.reduce((s, c) => s + (t[c].pts === maxPts[c] ? 1 : 0), 0);
    t.reds = ORDER.reduce((s, c) => s + (t[c].pts === minPts[c] ? 1 : 0), 0);
  }

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
    :root { --bg:#ffffff; --text:#111; --muted:#666; --line:#eee; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 32px; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .updated { color: var(--muted); font-size: 13px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: right; }
    th:nth-child(2), td:nth-child(2) { text-align: left; }
    th { font-weight: 600; }
    tr:hover td { background: #fafafa; }
    .tag-green { background: #e6ffed; }
    .tag-red { background: #ffecec; }
    .rank { width: 42px; color: var(--muted); }
    .team { width: 280px; }
    .total { font-weight: 700; }
    .foot { color: var(--muted); font-size: 12px; margin-top: 10px; }
  </style>`.trim();

  const thead = `
  <thead>
    <tr>
      <th class="rank">#</th>
      <th class="team">Équipe</th>
      ${ORDER.map((c) => `<th title="${c}">${HEADERS[c]}</th>`).join("")}
      <th title="Différence de buts cumulée">Diff +/-</th>
      <th class="total" title="Points cumulés">TOTAL</th>
    </tr>
  </thead>`.trim();

  const tbody = `
  <tbody>
    ${rows
      .map((t, i) => {
        const cellsLeagues = ORDER.map((c) => {
          const v = t[c].pts || 0;
          const cls = v === maxPts[c] ? "tag-green" : v === minPts[c] ? "tag-red" : "";
          return `<td class="${cls}">${v}</td>`;
        }).join("");

        const clsTotal = t.totalPts === maxTotal ? "tag-green" : t.totalPts === minTotal ? "tag-red" : "";
        const clsDiff = t.totalDiff === maxDiffAll ? "tag-green" : t.totalDiff === minDiffAll ? "tag-red" : "";

        return `
          <tr>
            <td class="rank">${i + 1}</td>
            <td>${t.name}</td>
            ${cellsLeagues}
            <td class="${clsDiff}">${t.totalDiff}</td>
            <td class="total ${clsTotal}">${t.totalPts}</td>
          </tr>`;
      })
      .join("\n")}
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
  <h1>${PAGE_TITLE}</h1>
  <div class="updated">Mis à jour automatiquement&nbsp;: ${updated}</div>
  <table>
    ${thead}
    ${tbody}
  </table>
  <p class="foot">Verts = meilleure valeur de la colonne • Rouges = pire valeur de la colonne. Les couleurs de TOTAL et Diff +/- sont informatives (non prises en compte dans les tie‑breakers).</p>
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

    // tentative de login avant scraping
    await loginIfNeeded(context, LEAGUES.FR || LEAGUES.EN || LEAGUES.ES || LEAGUES.IT);

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
