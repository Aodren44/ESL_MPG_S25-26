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
