// scripts/generate.mjs
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

/* ======================== CONFIG ======================== */
const ORDER = ["FR", "EN", "ES", "IT"];
const HEADERS = { FR: "🇫🇷", EN: "🇬🇧", ES: "🇪🇸", IT: "🇮🇹" };

// URLs depuis secrets
const LEAGUES = {
  FR: process.env.MPG_ESL_FR || "",
  EN: process.env.MPG_ESL_UK || "",
  ES: process.env.MPG_ESL_ES || "",
  IT: process.env.MPG_ESL_IT || "",
};

// Identifiants (secrets)
const MPG_EMAIL = process.env.MPG_EMAIL || "";
const MPG_PASSWORD = process.env.MPG_PASSWORD || "";

// Sortie
const OUTPUT_DIR = existsSync("docs") ? "docs" : ".";
const OUTPUT_FILE = path.join(OUTPUT_DIR, "index.html");
// ✅ 1) Titre MAJUSCULES
const PAGE_TITLE = "CLASSEMENT MPG - EUROPEAN STAR LEAGUE - S25/26";

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
// ✅ 5) Format avec " à " entre date et heure
function fmtDateFR(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${date} à ${time}`;
}
function canonicalName(name) {
  return String(name || "").trim();
}
// ✅ 3) Affichage signé pour Diff
function fmtSigned(n) {
  if (n > 0) return `+${n}`;
  return String(n);
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

/* ======================== LOGIN ROBUSTE (version qui marchait) ======================== */
// Accepte les cookies (page + iframes OneTrust)
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

// Cherche un champ dans la page OU ses frames
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

// Clique un CTA “Se connecter”
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

// Login principal (robuste)
async function loginRobust(page) {
  if (!MPG_EMAIL || !MPG_PASSWORD) throw new Error("MPG_EMAIL / MPG_PASSWORD manquants.");

  // 1) Home
  console.log("→ GOTO home");
  await page.goto("https://mpg.football/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(800);
  await acceptCookiesRobust(page);

  // 2) URLs directes de login
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

  // 3) Sinon CTA
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

  // 4) Submit dans la MÊME frame
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

// Wrapper “login si nécessaire” (utilisé par le nouv
