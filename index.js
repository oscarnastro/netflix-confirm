require('dotenv').config();

const express         = require('express');
const { google }      = require('googleapis');
const { chromium }    = require('playwright');
const { createClient} = require('redis');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT              = process.env.PORT || 3000;
const ERROR_EMAIL_TO    = process.env.ERROR_EMAIL_TO || 'oscarnastro@gmail.com';
const ERROR_MAIL_COOLDOWN = 10 * 60 * 1000;
const UID_RETENTION_S   = 24 * 60 * 60;

const SUBJECT_KEYWORDS  = ['Importante', 'aggiornare', 'Netflix', 'posizione principale'];
const BUTTON_KEYWORDS   = ['conferma', 'confirm', 'update', 'aggiorna', 'continue'];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36',
];

const REQUIRED_ENV = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'PUBSUB_TOPIC',
  'REDIS_URL'
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Variabile d'ambiente mancante: ${key}`);
    process.exit(1);
  }
}

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(level, ...args) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${level}] ${args.join(' ')}`;
  level === 'ERROR' ? console.error(line) : console.log(line);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Redis ────────────────────────────────────────────────────────────────────
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', e => log('ERROR', 'Redis:', e.message));

async function isProcessed(msgId) {
  return !!(await redis.get(`netflix:uid:${msgId}`));
}

async function markProcessed(msgId) {
  await redis.set(`netflix:uid:${msgId}`, '1', { EX: UID_RETENTION_S });
}

// ─── Gmail API client ─────────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// ─── Gmail: registra watch Pub/Sub ────────────────────────────────────────────
async function registerGmailWatch() {
  try {
    const res = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: process.env.PUBSUB_TOPIC,
        labelIds: ['INBOX'],
        labelFilterBehavior: 'INCLUDE'
      }
    });
    log('INFO', `Gmail watch registrato. Scade: ${new Date(Number(res.data.expiration)).toISOString()}`);
    return res.data;
  } catch (e) {
    log('ERROR', 'Registrazione Gmail watch fallita:', e.message);
    throw e;
  }
}

async function scheduleWatchRenewal() {
  await registerGmailWatch();
  setInterval(async () => {
    log('INFO', 'Rinnovo Gmail watch...');
    await registerGmailWatch().catch(e => log('ERROR', 'Rinnovo watch fallito:', e.message));
  }, 6 * 24 * 60 * 60 * 1000);
}

// ─── Gmail: leggi messaggio per ID ───────────────────────────────────────────
async function fetchEmailById(messageId) {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full'
  });
  return res.data;
}

function getHeader(message, name) {
  return message.payload?.headers?.find(
    h => h.name.toLowerCase() === name.toLowerCase()
  )?.value || '';
}

function decodeBase64Url(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function extractParts(payload) {
  let text = '';
  let html = '';

  function walk(part) {
    const mime = part.mimeType || '';
    const data = part.body?.data;
    if (mime === 'text/plain' && data) text += decodeBase64Url(data);
    if (mime === 'text/html'  && data) html += decodeBase64Url(data);
    if (part.parts) part.parts.forEach(walk);
  }

  walk(payload);
  return { text, html };
}

// ─── Link extractor ───────────────────────────────────────────────────────────
const NETFLIX_LINK_RE = /https:\/\/www\.netflix\.com\/account\/update-primary-location[^\s"'>\]<]*/gi;

function extractNetflixUpdateLink(text, html) {
  if (html) {
    const hrefRe = /href="(https:\/\/www\.netflix\.com\/account\/update-primary-location[^"]+)"/gi;
    const m = hrefRe.exec(html);
    if (m) {
      log('INFO', 'Link trovato in HTML href.');
      return m[1].replace(/&amp;/g, '&');
    }
    NETFLIX_LINK_RE.lastIndex = 0;
    const um = NETFLIX_LINK_RE.exec(html);
    if (um) {
      log('INFO', 'Link trovato in HTML (URL nuda).');
      return um[0].replace(/&amp;/g, '&');
    }
  }
  if (text) {
    NETFLIX_LINK_RE.lastIndex = 0;
    const tm = NETFLIX_LINK_RE.exec(text);
    if (tm) {
      log('INFO', 'Link trovato in testo plain.');
      return tm[0].replace(/&amp;/g, '&');
    }
  }
  log('INFO', 'Nessun link Netflix trovato.');
  return null;
}

function subjectMatches(subject) {
  if (!subject) return false;
  const lower = subject.toLowerCase();
  return SUBJECT_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
}

// ─── Browser warm persistente ─────────────────────────────────────────────────
let warmBrowser = null;

async function getWarmBrowser() {
  if (warmBrowser) {
    try {
      if (warmBrowser.isConnected()) return warmBrowser;
    } catch (_) {}
    log('WARN', 'Browser warm non connesso, ricreo.');
    warmBrowser = null;
  }

  log('INFO', 'Avvio browser Playwright (Chromium)...');
  warmBrowser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXEC_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-extensions',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  warmBrowser.on('disconnected', () => {
    log('WARN', 'Browser disconnesso.');
    warmBrowser = null;
  });

  log('INFO', '✅ Browser warm pronto.');
  return warmBrowser;
}

getWarmBrowser().catch(e => log('WARN', 'Pre-warm fallito:', e.message));

// ─── Playwright: click conferma ───────────────────────────────────────────────
const clickLock = new Set();

async function clickButtonOnPage(url, maxRetries = 3) {
  if (clickLock.has(url)) {
    log('INFO', 'Click già in corso per questo link, skip.');
    return false;
  }
  clickLock.add(url);

  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      log('INFO', `Tentativo ${attempt}/${maxRetries} → ${url}`);
      let context;
      try {
        const browser = await getWarmBrowser();
        const idx = (attempt - 1) % USER_AGENTS.length;

        context = await browser.newContext({
          userAgent: USER_AGENTS[idx],
          viewport: { width: 1920, height: 1080 },
          locale: 'it-IT',
          extraHTTPHeaders: {
            'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8'
          },
          serviceWorkers: 'block'
        });

        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        await context.route('**/*', (route) => {
          const type = route.request().resourceType();
          if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
            route.abort();
          } else {
            route.continue();
          }
        });

        const page = await context.newPage();

        await sleep(300 + Math.random() * 400);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await sleep(800);

        const title = await page.title();
        log('INFO', `Pagina caricata: "${title}"`);

        let clicked = false;

        for (const keyword of BUTTON_KEYWORDS) {
          try {
            const btn = page.locator(
              `button:has-text("${keyword}"), input[type="submit"][value*="${keyword}" i], a[role="button"]:has-text("${keyword}")`
            ).first();

            const isVisible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
            if (isVisible) {
              await btn.click({ timeout: 5000 });
              log('INFO', `✅ Bottone "${keyword}" cliccato.`);
              clicked = true;
              break;
            }
          } catch (_) {
            continue;
          }
        }

        if (!clicked) {
          try {
            const firstBtn = page.locator('button, input[type="submit"]').first();
            const isVisible = await firstBtn.isVisible({ timeout: 2000 }).catch(() => false);
            if (isVisible) {
              await firstBtn.click({ timeout: 5000 });
              log('INFO', '✅ Bottone fallback cliccato.');
              clicked = true;
            }
          } catch (_) {}
        }

        if (clicked) {
          await sleep(1500);
          log('INFO', '✅ Conferma nucleo domestico Netflix completata!');
          return true;
        }

        log('WARN', `Tentativo ${attempt}: nessun bottone trovato.`);

      } catch (err) {
        log('ERROR', `Tentativo ${attempt} fallito:`, err.message);

        if (err.message.includes('Target closed') || err.message.includes('Browser closed')) {
          warmBrowser = null;
        }

        const isRetryable = ['net::', 'timeout', 'Navigation', 'ERR_CONNECTION'].some(
          s => err.message.includes(s)
        );
        if (isRetryable && attempt < maxRetries) {
          const delay = Math.min(5_000 * attempt, 15_000);
          log('INFO', `Riprovo tra ${delay / 1000}s...`);
          await sleep(delay);
        }
      } finally {
        if (context) {
          await context.close().catch(e => log('WARN', 'Chiusura context:', e.message));
        }
      }
    }

    log('ERROR', `Tutti i ${maxRetries} tentativi falliti.`);
    return false;
  } finally {
    clickLock.delete(url);
  }
}

// ─── Notifiche errore via email ───────────────────────────────────────────────
let lastErrorMailAt = 0;

async function sendErrorMail(subject, body) {
  if (Date.now() - lastErrorMailAt < ERROR_MAIL_COOLDOWN) {
    log('INFO', 'Email errore soppressa (rate limit).');
    return;
  }
  lastErrorMailAt = Date.now();

  const raw = [
    `From: "Script Netflix" <${process.env.GMAIL_ADDRESS}>`,
    `To: ${ERROR_EMAIL_TO}`,
    `Subject: ${subject}`,
    '',
    body
  ].join('\n');

  const encoded = Buffer.from(raw).toString('base64url');

  try {
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encoded }
    });
    log('INFO', 'Email di errore inviata.');
  } catch (e) {
    log('ERROR', 'Invio email di errore fallito:', e.message);
  }
}

// ─── Processamento messaggio Netflix ─────────────────────────────────────────
async function processMessage(messageId) {
  if (await isProcessed(messageId)) {
    log('INFO', `Messaggio ${messageId} già processato, skip.`);
    return;
  }

  await markProcessed(messageId);

  let message;
  try {
    message = await fetchEmailById(messageId);
  } catch (e) {
    log('ERROR', 'Fetch messaggio Gmail fallito:', e.message);
    return;
  }

  const sender  = getHeader(message, 'from');
  const subject = getHeader(message, 'subject');
  log('INFO', `📨 Da: ${sender} | Oggetto: ${subject}`);

  if (!sender.toLowerCase().includes('netflix.com') || !subjectMatches(subject)) {
    log('INFO', 'Email non rilevante, ignorata.');
    return;
  }

  log('INFO', `🎯 Email Netflix rilevante: "${subject}"`);
  const { text, html } = extractParts(message.payload);
  const link = extractNetflixUpdateLink(text, html);

  if (!link) {
    log('INFO', 'Nessun link di aggiornamento trovato.');
    return;
  }

  const success = await clickButtonOnPage(link);
  if (success) {
    log('INFO', '✅ Conferma effettuata con successo!');
  } else {
    log('ERROR', '❌ Conferma fallita dopo tutti i tentativi.');
    await sendErrorMail(
      'Script Netflix: conferma fallita',
      `Impossibile cliccare il link Netflix:\n${link}\n\nTimestamp: ${new Date().toISOString()}`
    );
  }
}

// ─── Express + Webhook ────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const pubsubMsg = req.body?.message;
    if (!pubsubMsg?.data) {
      log('WARN', 'Webhook ricevuto senza data, ignorato.');
      return;
    }

    const payload = JSON.parse(
      Buffer.from(pubsubMsg.data, 'base64').toString('utf8')
    );
    log('INFO', `Webhook ricevuto: emailAddress=${payload.emailAddress}, historyId=${payload.historyId}`);

    // Recupera l'ultimo historyId salvato
    const savedHistoryId = await redis.get('gmail:historyId');
    const startHistoryId = savedHistoryId || String(Number(payload.historyId) - 1);
    log('INFO', `Uso startHistoryId: ${startHistoryId}`);

    // Salva il nuovo historyId
    await redis.set('gmail:historyId', String(payload.historyId));

    const historyRes = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: startHistoryId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX'
    });

    const historyItems = historyRes.data.history || [];
    log('INFO', `History items trovati: ${historyItems.length}`);

    const messageIds = historyItems
      .flatMap(h => h.messagesAdded || [])
      .map(m => m.message.id)
      .filter(Boolean);

    const uniqueIds = [...new Set(messageIds)];
    log('INFO', `Nuovi messaggi rilevati: ${uniqueIds.length}`);

    await Promise.all(uniqueIds.map(id => processMessage(id)));

  } catch (e) {
    log('ERROR', 'Errore gestione webhook:', e.message);
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    browserReady: warmBrowser?.isConnected() ?? false,
    redisConnected: redis.isReady
  });
});

// ─── Global error handlers ────────────────────────────────────────────────────
process.on('uncaughtException', async (err) => {
  log('ERROR', 'uncaughtException:', err.stack || err);
  await sendErrorMail('Script Netflix: crash', err.stack || String(err));
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  log('ERROR', 'unhandledRejection:', reason?.stack || reason);
  await sendErrorMail('Script Netflix: unhandled rejection', String(reason));
  process.exit(1);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  log('INFO', `Ricevuto ${signal}, shutdown graceful...`);
  if (warmBrowser) await warmBrowser.close().catch(() => {});
  await redis.quit().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Avvio ────────────────────────────────────────────────────────────────────
async function main() {
  await redis.connect();
  log('INFO', '✅ Redis connesso.');

  // Inizializza historyId se non esiste
  const existing = await redis.get('gmail:historyId');
  if (!existing) {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    await redis.set('gmail:historyId', String(profile.data.historyId));
    log('INFO', `historyId iniziale salvato: ${profile.data.historyId}`);
  }

  app.listen(PORT, () => log('INFO', `Server in ascolto su porta ${PORT}`));
  await scheduleWatchRenewal();
}

main().catch(e => {
  log('ERROR', 'Avvio fallito:', e.message);
  process.exit(1);
});