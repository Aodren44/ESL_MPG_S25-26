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

  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
}

/* ==========================
   SCRAPE ROBUSTE (corrigé)
   ========================== */
async function scrapeLeague(page, url) {
  const out = [];
  try {
    await page.goto(url, { waitUntil: "networkidle" });
  } catch {
    return out;
  }

  // Attendre qu’un tableau OU des "ranking-row" existent
  try {
    await page.waitForFunction(() => {
      return (
        document.querySelector("[data-testid=ranking-row]") ||
        (document.querySelector("table") &&
          (document.querySelector("tbody tr") ||
           document.querySelector("[role=rowgroup] [role=row]")))
      );
    }, { timeout: 12000 });
  } catch {
    return out;
  }

  // Tout parser côté page pour limiter les va-et-vient
  const rows = await page.evaluate(() => {
    const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
    const pickInt = (s) => {
      const m = clean(s).match(/-?\d+/);
      return m ? parseInt(m[0], 10) : NaN;
    };

    const result = [];

    // 1) Cas prioritaire : listes avec data-testid=ranking-row
    const rankRows = Array.from(document.querySelectorAll("[data-testid=ranking-row]"));
    if (rankRows.length) {
      for (const r of rankRows) {
        // Nom d’équipe
        let team =
          clean(r.querySelector("[data-testid=team-name]")?.textContent) ||
          clean(r.querySelector(".team-name,.name")?.textContent) ||
          clean(r.textContent);

        // Pointage : chercher un libellé "Pts/Points" DANS la ligne
        let ptsText = "";
        // 1a) élément dont le texte ressemble à "Pts 4" ou "Points : 4"
        const elPts = Array.from(r.querySelectorAll("*")).find((el) =>
          /(?:^|\b)(pts?|points?)(?:\b|[^a-z])/i.test(clean(el.textContent))
        );
        if (elPts) {
          const m = clean(elPts.textContent).match(/(?:pts?|points?)\s*:?\s*(-?\d+)/i);
          if (m) ptsText = m[1];
        }
        // 1b) si pas trouvé, chercher un attribut data-title/aria-label parlant
        if (!ptsText) {
          const elAttr = Array.from(r.querySelectorAll("*")).find((el) => {
            const t = clean(el.getAttribute?.("title"));
            const a = clean(el.getAttribute?.("aria-label"));
            return /pts|points/i.test(t) || /pts|points/i.test(a);
          });
          if (elAttr) {
            const m = (clean(elAttr.getAttribute("title")) || clean(elAttr.getAttribute("aria-label")) || "")
              .match(/-?\d+/);
            if (m) ptsText = m[0];
          }
        }
        // 1c) ultimissime secours : repérer "Pts 4" dans le texte de la ligne
        if (!ptsText) {
          const m = clean(r.textContent).match(/(?:pts?|points?)\s*:?\s*(-?\d+)/i);
          if (m) ptsText = m[1];
        }
        // 1d) tout dernier recours (pour ne PAS renvoyer vide) : prendre le nombre
        //     situé après le nom de l’équipe, pas le dernier
        let points = NaN;
        if (ptsText) {
          points = parseInt(ptsText, 10);
        } else {
          const text = clean(r.textContent);
          const nums = text.match(/-?\d+/g) || [];
          if (nums.length) {
            // éviter de prendre un "+/-" : privilégier un nombre non précédé de +/-
            const good = nums.find((n) => !new RegExp(`[+\\-]\\s*${n}`).test(text));
            points = parseInt(good || nums[0], 10);
          }
        }

        if (team && Number.isFinite(points)) {
          // nettoyage léger nom d’équipe
          team = team.split(" — ")[0].split(" - ")[0].split(",")[0];
          result.push({ team, points });
        }
      }
      return result;
    }

    // 2) Fallback : véritables tableaux <table>
    const headerEls = Array.from(document.querySelectorAll("thead th, [role=columnheader]"));
    const headers = headerEls.map((h) => clean(h.textContent).toLowerCase());
    let idxTeam = headers.findIndex((h) => /(équipe|team)/.test(h));
    let idxPts  = headers.findIndex((h) => /^(pts|points)\b/.test(h));

    const lineEls = Array.from(
      document.querySelectorAll("tbody tr, [role=rowgroup] [role=row]")
    );

    for (const tr of lineEls) {
      const cells = Array.from(tr.querySelectorAll("td, [role=cell], th, div"));
      const texts = cells.map((c) => clean(c.textContent)).filter(Boolean);

      // Team
      let team = idxTeam >= 0 && idxTeam < texts.length ? texts[idxTeam] : null;
      if (!team) {
        team = texts.filter((t) => /[A-Za-zÀ-ÿ]/.test(t)).sort((a, b) => b.length - a.length)[0];
      }
      if (team) team = team.split(" — ")[0].split(" - ")[0].split(",")[0];

      // Points
      let points = NaN;
      if (idxPts >= 0 && idxPts < texts.length) {
        points = pickInt(texts[idxPts]);
      } else {
        // essayer de repérer "Pts 4" dans la ligne
        const m = clean(tr.textContent).match(/(?:pts?|points?)\s*:?\s*(-?\d+)/i);
        if (m) points = parseInt(m[1], 10);
      }

      if (team && Number.isFinite(points)) result.push({ team, points });
    }

    return result;
  });

  return Array.isArray(rows) ? rows : out;
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

  const columns = ["FR", "EN", "ES", "IT"];
  const max = Object.fromEntries(columns.map((c) => [c, Math.max(...table.map((r) => r[c])) || 0]));
  const min = Object.fromEntries(columns.map((c) => [c, Math.min(...table.map((r) => r[c])) || 0]));

  const rows = table.map((r) => {
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
    }).join("\n");

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
      console.log(`✓ ${code}: ${leagues[code].length} équipes lues`);
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
