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

// === LOGIN (ta version + logs) ===
async function login(page) {
  console.log("🔐 login() start");

  // Tente plusieurs URLs de connexion possibles
  const urls = [
    "https://mpg.football/login",
    "https://mpg.football/connexion",
    "https://mpg.football/auth/login",
  ];

  // petite fonction utilitaire : tenter de fermer les cookies (plusieurs systèmes possibles)
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
        if (btn) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(400);
          clicked = true;
          break;
        }
      } catch {}
    }
    // Parfois le bandeau est dans un iframe OneTrust
    if (!clicked) {
      for (const frame of page.frames()) {
        try {
          const b = await frame.$("#onetrust-accept-btn-handler");
          if (b) {
            await b.click().catch(() => {});
            await page.waitForTimeout(300);
            clicked = true;
            break;
          }
        } catch {}
      }
    }
    if (clicked) console.log("🍪 cookies: accepté");
  }

  // Navigue successivement sur les URLs candidates jusqu'à trouver le champ email
  let found = false;
  for (const u of urls) {
    try {
      console.log("→ GOTO", u);
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) {
      console.log("⚠️ goto échec:", u, e?.message);
      continue;
    }
    await page.waitForTimeout(800);
    await acceptCookies();

    const emailField = await page
      .$(
        "input[type='email'], input[name='email'], #email, input[autocomplete='email']"
      )
      .catch(() => null);

    if (emailField) {
      console.log("✅ Formulaire trouvé sur", page.url());
      found = true;
      break;
    }
  }

  if (!found) {
    throw new Error("Formulaire de connexion introuvable (email).");
  }

  // Renseigne email + mot de passe et soumet
  await page.fill(
    "input[type='email'], input[name='email'], #email, input[autocomplete='email']",
    EMAIL,
    { timeout: 30000 }
  );
  await page.fill(
    "input[type='password'], input[name='password'], #password, input[autocomplete='current-password']",
    PASSWORD,
    { timeout: 30000 }
  );

  // Clique un bouton submit (plusieurs variantes possibles)
  const submits = [
    "button[type='submit']",
    "button:has-text('Se connecter')",
    "button:has-text('Connexion')",
    "button:has-text('Log in')",
    "button:has-text('Login')",
  ];
  for (const sel of submits) {
    try {
      const b = await page.$(sel);
      if (b) {
        await b.click().catch(() => {});
        console.log("📨 Credentials soumis (via:", sel, ")");
        break;
      }
    } catch {}
  }

  // Attends d'être connecté/redirigé
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForURL(/mpg\.football\/(dashboard|league)/, { timeout: 60000 }).catch(() => {});
  console.log("✅ Login tenté, url actuelle:", page.url());
}

// === SCRAPER ===
async function scrapeLeague(page, url) {
  const out = [];
  try {
    console.log("→ GOTO league", url);
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  } catch (e) {
    console.log("⚠️ goto échoué pour", url, e?.message);
    return out;
  }

  try {
    await page.waitForSelector(
      '[data-testid="ranking-row"], table, [role="table"]',
      { timeout: 10000 }
    );
  } catch (e) {
    console.log("⚠️ pas de sélecteur table/ranking pour", url, e?.message);
    return out;
  }

  // 1) Rangées marquées
  const rows = await page.$$('[data-testid="ranking-row"]');
  if (rows.length > 0) {
    console.log("   rows[data-testid=ranking-row] =", rows.length);
    for (const r of rows) {
      const name =
        (await r
          .locator(".team-name, .name, [data-testid=team-name]")
          .textContent()
          .catch(() => null))?.trim() ?? (await r.textContent()).trim();

      let ptsText =
        (await r.locator(".points, .pts").textContent().catch(() => null)) ?? "";

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

  // 2) Fallback: tableau générique
  const trs = await page.$$("table tr, [role=table] tr");
  for (const tr of trs) {
    const tds = await tr.$$("td, th, div");
    if (!tds.length) continue;

    let team = null;
    let points = null;

    for (const el of tds) {
      const txt = ((await el.textContent()) || "").trim();
      if (!team && /[A-Za-zÀ-ÿ]/.test(txt) && txt.length > 1) {
        team = txt;
      }
      if (!points && /^\d+$/.test(txt)) {
        points = Number.parseInt(txt, 10);
      }
    }

    if (team && Number.isFinite(points)) out.push({ team, points });
  }
  console.log("   rows<table> =", out.length);
  return out;
}

// === AGRÉGATION + RENDU ===
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
  // Tips runner GitHub : pas de sandbox pour éviter des erreurs furtives
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
