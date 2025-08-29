// scripts/generate.mjs
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

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

async function maybeClick(page, selectorOrText) {
  try {
    const el = await page.$(selectorOrText);
    if (el) await el.click({ delay: 50 });
  } catch {}
}

async function login(page) {
  await page.goto("https://mpg.football/login", { waitUntil: "networkidle" });

  // Gestion éventuelle du bandeau cookies
  await maybeClick(page, 'button:has-text("Accepter")');
  await maybeClick(page, 'button:has-text("Tout accepter")');
  await maybeClick(page, 'button:has-text("Accept")');

  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);

  // Le bouton peut avoir différents libellés, on clique le submit
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
}

/* ==========================
   SEULE MODIF IMPORTANTE ICI
   ========================== */
async function scrapeLeague(page, url) {
  const out = [];
  try {
    await page.goto(url, { waitUntil: "networkidle" });
  } catch {
    // Ligue non accessible (ex: Italie avant démarrage)
    return out;
  }

  // Attendre que l'UI React ait fini de rendre un tableau et des lignes
  try {
    await page.waitForFunction(() => {
      const hasTable = document.querySelector("table");
      const hasRows =
        document.querySelector("tbody tr,[role=rowgroup] [role=row],[data-testid=ranking-row]");
      return hasTable && hasRows;
    }, { timeout: 10000 });
  } catch {
    return out;
  }

  // Parser côté page pour être robuste et ne lire que la colonne Points
  const rows = await page.evaluate(() => {
    const getTxt = (el) =>
      (el?.textContent || "").trim().replace(/\s+/g, " ");

    // 1) Lire les en-têtes (thead ou rôles ARIA)
    const headerEls = Array.from(
      document.querySelectorAll("thead th, [role=columnheader]")
    );
    const headers = headerEls.map((h) => getTxt(h).toLowerCase());

    // Index des colonnes "Pts/Points" et "Équipe/Team"
    let idxPts = headers.findIndex((h) => /^(pts|points)\b/.test(h));
    let idxTeam = headers.findIndex((h) => /(équipe|team)/.test(h));

    // 2) Récupérer les lignes (plusieurs structures possibles)
    const lineEls = Array.from(
      document.querySelectorAll(
        "tbody tr, [role=rowgroup] [role=row], [data-testid=ranking-row]"
      )
    );

    const result = [];
    for (const row of lineEls) {
      // ignorer une éventuelle ligne d'en-tête
      if (row.querySelector("th")) continue;

      // cellules visibles
      const cells = Array.from(row.querySelectorAll("td, [role=cell], th, div"));
      const texts = cells.map(getTxt).filter(Boolean);

      // Nom d'équipe depuis colonne dédiée, sinon meilleur fallback
      let team = null;
      if (idxTeam >= 0 && idxTeam < texts.length) {
        team = texts[idxTeam];
      } else {
        // fallback: plus long texte non purement numérique
        team = texts
          .filter((t) => /[A-Za-zÀ-ÿ]/.test(t))
          .sort((a, b) => b.length - a.length)[0];
      }
      if (team) {
        // Nettoyage de suffixes éventuels
        team = team.split(" — ")[0].split(" - ")[0].split(",")[0].trim();
      }

      // Points uniquement via la colonne "Pts/Points"
      let ptsText = null;
      if (idxPts >= 0 && idxPts < texts.length) {
        ptsText = texts[idxPts];
      } else {
        // Dernier recours: un élément dont le libellé interne contient pts/points
        const ptsEl = Array.from(row.querySelectorAll("*")).find((el) =>
          /pts|points/i.test(getTxt(el))
        );
        ptsText = getTxt(ptsEl);
      }

      const m = ptsText.match(/-?\d+/);
      const points = m ? parseInt(m[0], 10) : NaN;

      if (team && Number.isFinite(points)) {
        result.push({ team, points });
      }
    }

    return result;
  });

  return rows || out;
}

function aggregate(leagues) {
  const columns = ["FR", "EN", "ES", "IT"];
  const teams = new Set();
  for (const col of columns) {
    for (const row of leagues[col] || []) teams.add(row.team);
  }

  const byTeam = {};
  for (const team of teams) {
    const pts = Object.fromEntries(
      columns.map((c) => [c, (leagues[c] || []).find((x) => x.team === team)?.points ?? 0])
    );
    const total = columns.reduce((s, c) => s + pts[c], 0);
    byTeam[team] = { team, ...pts, total };
  }

  // max/min par colonne pour cases vertes/rouges
  const maxPerCol = Object.fromEntries(
    ["FR", "EN", "ES", "IT"].map((c) => [
      c,
      Math.max(0, ...Object.values(byTeam).map((x) => x[c])),
    ])
  );
  const minPerCol = Object.fromEntries(
    ["FR", "EN", "ES", "IT"].map((c) => [
      c,
      Math.min(...Object.values(byTeam).map((x) => x[c])),
    ])
  );

  for (const t of Object.values(byTeam)) {
    t.wins = ["FR", "EN", "ES", "IT"].filter((c) => t[c] === maxPerCol[c]).length;
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

  // calcul max/min pour couleurs
  const columns = ["FR", "EN", "ES", "IT"];
  const max = Object.fromEntries(
    columns.map((c) => [c, Math.max(...table.map((r) => r[c]))])
  );
  const min = Object.fromEntries(
    columns.map((c) => [c, Math.min(...table.map((r) => r[c]))])
  );

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
    .card { border:1px solid var(--border); border-radius:14px; padding:22px; box-shadow:0 1px 2px rgba(0,0,0,.03);}
    h1 { margin:0 0 6px 0; font-size:28px; }
    small { color:var(--muted); }
    table { width:100%; border-collapse: collapse; margin-top:14px; }
    th, td { padding:10px 12px; border-bottom:1px solid var(--border); text-align:left; white-space:nowrap;}
    thead th { background:#fafafa; position:sticky; top:0; }
    tr:hover td { background:#fafafa; }
    td.best { background: var(--best); font-weight:600;}
    td.worst { background: var(--worst);}
    .legend { margin-top:10px; color:var(--muted); font-size:14px;}
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

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await login(page);

  const leagues = {};
  for (const [code, url] of Object.entries(LEAGUES)) {
    try {
      leagues[code] = await scrapeLeague(page, url);
    } catch (e) {
      console.log(`⚠️ ${code} indisponible:`, e.message);
      leagues[code] = [];
    }
    await sleep(300); // petite pause
  }

  await browser.close();

  const table = aggregate(leagues);

  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/index.html", renderHTML(table), "utf8");
  console.log("✅ Page générée avec", table.length, "équipes :", nowStr());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
