// scripts/generate.mjs
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

/* ======================== CONFIG ======================== */
/*
   ⚠️ Laisse tes 4 URL ici (celles que tu avais déjà).
   Tu peux aussi les passer via variables d'env MPG_FR / MPG_EN / MPG_ES / MPG_IT si tu préfères.
*/
const LEAGUES = {
  FR: process.env.MPG_ESL_FR || "",
  EN: process.env.MPG_ESL_UK || "",
  ES: process.env.MPG_ESL_ES || "",
  IT: process.env.MPG_ESL_IT || "",
};
for (const k of ORDER) {
  console.log(`URL ${k}:`, LEAGUES[k] ? "(ok via secret)" : "(vide)");
}

// Nom d’affichage et ordre des ligues
const ORDER = ["FR", "EN", "ES", "IT"];
const HEADERS = { FR: "🇫🇷", EN: "🇬🇧", ES: "🇪🇸", IT: "🇮🇹" };

// Où écrire la page (auto‑détection docs/ → sinon racine)
const OUTPUT_DIR = existsSync("docs") ? "docs" : ".";
const OUTPUT_FILE = path.join(OUTPUT_DIR, "index.html");

// Titre demandé
const PAGE_TITLE = "Classement MPG — European Star League — S25/26";

/* ======================== HELPERS ======================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseIntSafe(raw, fallback = 0) {
  if (raw == null) return fallback;
  const m = String(raw).replace(/\u00A0/g, " ").match(/-?\d+/); // gère espaces insécables et signes
  return m ? parseInt(m[0], 10) : fallback;
}

function fmtDateFR(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function canonicalName(name) {
  // Nettoyage doux ; vous uniformisez côté joueurs
  return String(name || "").trim();
}

/* ======================== SCRAPING ======================== */

async function scrapeLeague(browser, code, url) {
  const page = await browser.newPage();
  try {
    console.log(`▶️  ${code} → ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
    // Certains contenus se chargent en JS : petite marge
    await page.waitForSelector("table", { timeout: 120_000 }).catch(() => {});
    await sleep(1500);

    // Récupère en une passe toutes les lignes du tableau
    const rows = await page.$$eval("table tbody tr", (trs) =>
      trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim()))
    );

    if (!rows || rows.length === 0) {
      throw new Error(`Aucune ligne de classement trouvée pour ${code}`);
    }

    // Récupère les en‑têtes pour trouver les colonnes (souvent "Équipe", "+/-", "Points")
    const headers =
      (await page.$$eval("table thead th", (ths) => ths.map((th) => th.textContent.trim()))) || [];

    // Trouve les index
    const idxTeam =
      headers.findIndex((h) => /équipe|equipe|team/i.test(h)) !== -1
        ? headers.findIndex((h) => /équipe|equipe|team/i.test(h))
        : 1; // fallback : souvent 2e colonne
    const idxPts =
      headers.findIndex((h) => /points|pts/i.test(h)) !== -1
        ? headers.findIndex((h) => /points|pts/i.test(h))
        : headers.length - 1; // fallback : souvent dernière colonne
    const idxDiff =
      headers.findIndex((h) => /\+\/-|±/i.test(h)) !== -1
        ? headers.findIndex((h) => /\+\/-|±/i.test(h))
        : Math.max(0, idxPts - 1); // fallback : souvent juste avant Points

    // Map résultat : { team -> { pts, diff } }
    const data = new Map();
    for (const row of rows) {
      if (!row || row.length === 0) continue;
      const name = canonicalName(row[idxTeam] ?? row[1] ?? row[0]);
      const pts = parseIntSafe(row[idxPts], 0);
      const diff = parseIntSafe(row[idxDiff], 0);
      if (!name) continue;
      data.set(name, { pts, diff });
    }

    console.log(`✅  ${code} : ${data.size} équipes lues`);
    return data;
  } finally {
    await page.close().catch(() => {});
  }
}

/* ======================== AGREGE + CLASSE ======================== */

function aggregate(leaguesData) {
  // teams: { name, FR:{pts,diff}, EN:{...}, ES:{...}, IT:{...}, totalPts, totalDiff }
  const teams = new Map();

  for (const code of ORDER) {
    const map = leaguesData[code];
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

  // Totaux
  for (const t of teams.values()) {
    t.totalPts = ORDER.reduce((s, c) => s + (t[c].pts || 0), 0);
    t.totalDiff = ORDER.reduce((s, c) => s + (t[c].diff || 0), 0);
  }

  // Min/Max par colonne (pour coloration et décompte verts/rouges)
  const minPts = {};
  const maxPts = {};
  for (const code of ORDER) {
    const vals = Array.from(teams.values()).map((t) => t[code].pts || 0);
    minPts[code] = Math.min(...vals);
    maxPts[code] = Math.max(...vals);
  }
  const minTotal = Math.min(...Array.from(teams.values()).map((t) => t.totalPts));
  const maxTotal = Math.max(...Array.from(teams.values()).map((t) => t.totalPts));
  const minDiffAll = Math.min(...Array.from(teams.values()).map((t) => t.totalDiff));
  const maxDiffAll = Math.max(...Array.from(teams.values()).map((t) => t.totalDiff));

  // Compte verts/rouges uniquement sur FR/EN/ES/IT (pas Total ni Diff)
  for (const t of teams.values()) {
    t.greens = ORDER.reduce((s, c) => s + (t[c].pts === maxPts[c] ? 1 : 0), 0);
    t.reds = ORDER.reduce((s, c) => s + (t[c].pts === minPts[c] ? 1 : 0), 0);
  }

  // Tri : TOTAL ↓ → greens ↓ → reds ↑ → Diff ↓
  const sorted = Array.from(teams.values()).sort((a, b) => {
    if (b.totalPts !== a.totalPts) return b.totalPts - a.totalPts;
    if (b.greens !== a.greens) return b.greens - a.greens;
    if (a.reds !== b.reds) return a.reds - b.reds;
    if (b.totalDiff !== a.totalDiff) return b.totalDiff - a.totalDiff;
    return 0; // (on évite tri alphabétique comme demandé)
  });

  return { rows: sorted, minPts, maxPts, minTotal, maxTotal, minDiffAll, maxDiffAll };
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
  console.log("🚀 generate.mjs démarré", new Date().toISOString());

  // Vérif URLs
  for (const k of ORDER) {
    if (!LEAGUES[k] || LEAGUES[k].includes("....")) {
      console.warn(`⚠️  URL manquante pour ${k}. Mets tes URL dans LEAGUES ou via variables d'env MPG_${k}.`);
    }
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const leaguesData = {};
    for (const code of ORDER) {
      leaguesData[code] = await scrapeLeague(browser, code, LEAGUES[code]);
    }

    const aggregated = aggregate(leaguesData);
    const html = buildHtml(aggregated);

    // Écrit la page
    if (OUTPUT_DIR !== "." && !existsSync(OUTPUT_DIR)) {
      mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    writeFileSync(OUTPUT_FILE, html, "utf8");
    console.log(`💾 Page générée → ${OUTPUT_FILE}`);

  } catch (e) {
    console.error("❌ Erreur durant la génération :", e?.stack || e);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    console.log("🏁 Terminé", new Date().toISOString());
  }
})();
