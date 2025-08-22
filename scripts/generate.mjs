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
