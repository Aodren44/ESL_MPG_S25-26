async function login(page) {
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
    for (const sel of selectors) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(400);
        break;
      }
    }
    // Parfois le bandeau est dans un iframe OneTrust
    for (const frame of page.frames()) {
      try {
        const b = await frame.$("#onetrust-accept-btn-handler");
        if (b) {
          await b.click().catch(() => {});
          await page.waitForTimeout(300);
          break;
        }
      } catch {}
    }
  }

  // Navigue successivement sur les URLs candidates jusqu'à trouver le champ email
  let found = false;
  for (const u of urls) {
    await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(800);
    await acceptCookies();

    const emailField = await page.$("input[type='email'], input[name='email'], #email, input[autocomplete='email']").catch(() => null);
    if (emailField) {
      found = true;
      break;
    }
  }

  if (!found) {
    throw new Error("Formulaire de connexion introuvable (email).");
  }

  // Renseigne email + mot de passe et soumet
  await page.fill("input[type='email'], input[name='email'], #email, input[autocomplete='email']", EMAIL, { timeout: 30000 });
  await page.fill("input[type='password'], input[name='password'], #password, input[autocomplete='current-password']", PASSWORD, { timeout: 30000 });

  // Clique un bouton submit (plusieurs variantes possibles)
  const submits = [
    "button[type='submit']",
    "button:has-text('Se connecter')",
    "button:has-text('Connexion')",
    "button:has-text('Log in')",
    "button:has-text('Login')",
  ];
  for (const sel of submits) {
    const b = await page.$(sel).catch(() => null);
    if (b) { await b.click().catch(() => {}); break; }
  }

  // Attends d'être connecté/redirigé
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForURL(/mpg\.football\/(dashboard|league)/, { timeout: 60000 }).catch(() => {});
}
