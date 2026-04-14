# 🎬 Netflix Home Confirm

Bot che conferma automaticamente il **nucleo domestico Netflix** alla ricezione dell'email di verifica. Monitora la tua casella Gmail tramite Google Cloud Pub/Sub, individua le email di Netflix che richiedono la conferma della posizione principale e clicca automaticamente il bottone di conferma tramite un browser headless (Playwright/Chromium).

---

## ✨ Funzionalità

- 📧 **Monitoraggio Gmail in tempo reale** via Google Cloud Pub/Sub webhook
- 🔍 **Rilevamento automatico** delle email Netflix di conferma nucleo domestico
- 🖱️ **Click automatico** sul bottone di conferma tramite Playwright (Chromium headless)
- 🔁 **Retry con back-off** in caso di errore (fino a 3 tentativi)
- 🗄️ **Deduplicazione** messaggi tramite Redis (TTL 24 ore)
- 📬 **Notifica email** in caso di fallimento (con rate limiting a 10 minuti)
- 💚 **Health check** endpoint per monitoraggio uptime
- 🛡️ **Anti-bot evasion**: header HTTP realistici, blocco delle risorse inutili (immagini, font, CSS)

---

## 🏗️ Architettura

```
Gmail ──► Google Cloud Pub/Sub ──► /webhook (Express)
                                         │
                                    Redis (dedup)
                                         │
                                   Gmail API (fetch email)
                                         │
                              Playwright (click conferma)
```

1. Gmail invia una notifica a Google Cloud Pub/Sub ogni volta che arriva un nuovo messaggio.
2. Il webhook Express riceve la notifica, recupera i nuovi messaggi tramite Gmail History API.
3. Se il mittente è `netflix.com` e l'oggetto contiene parole chiave rilevanti, viene estratto il link di conferma.
4. Playwright apre il link in un browser headless e clicca il bottone di conferma.
5. In caso di fallimento, viene inviata un'email di errore.

---

## 🔧 Requisiti

- **Node.js** ≥ 18
- **Redis** (es. Redis Cloud, Upstash, Railway Redis)
- **Account Google Cloud** con:
  - Gmail API abilitata
  - Google Cloud Pub/Sub abilitato
  - OAuth 2.0 Client ID configurato

---

## 📦 Installazione locale

```bash
git clone https://github.com/oscarnastro/netflix-confirm.git
cd netflix-confirm
npm install
```

### Installare il browser Chromium (solo in locale, non in Docker)

```bash
npx playwright install chromium
```

---

## ⚙️ Configurazione

Crea un file `.env` nella root del progetto con le seguenti variabili:

```env
# Google OAuth2
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REFRESH_TOKEN=your_google_refresh_token

# Google Cloud Pub/Sub
PUBSUB_TOPIC=projects/YOUR_PROJECT_ID/topics/YOUR_TOPIC_NAME

# Redis
REDIS_URL=redis://localhost:6379

# (Opzionale) Email per notifiche di errore
GMAIL_ADDRESS=tua@gmail.com
ERROR_EMAIL_TO=tua@gmail.com

# (Opzionale) Path del browser Chromium (solo in locale se diverso dal default)
PLAYWRIGHT_EXEC_PATH=/usr/bin/chromium

# (Opzionale) Cookie Netflix per tentativo fetch senza browser e autenticazione Playwright
NETFLIX_ID=il_tuo_NetflixId
NETFLIX_SECURE_ID=il_tuo_SecureNetflixId
```

| Variabile | Obbligatoria | Descrizione |
|---|---|---|
| `GOOGLE_CLIENT_ID` | ✅ | Client ID OAuth2 Google |
| `GOOGLE_CLIENT_SECRET` | ✅ | Client Secret OAuth2 Google |
| `GOOGLE_REFRESH_TOKEN` | ✅ | Refresh token OAuth2 (ottenuto via OAuth Playground) |
| `PUBSUB_TOPIC` | ✅ | Nome completo del topic Pub/Sub |
| `REDIS_URL` | ✅ | URL di connessione Redis |
| `GMAIL_ADDRESS` | ❌ | Indirizzo Gmail mittente delle notifiche di errore |
| `ERROR_EMAIL_TO` | ❌ | Destinatario email di errore (default: `oscarnastro@gmail.com`) |
| `PLAYWRIGHT_EXEC_PATH` | ❌ | Path del binario Chromium (in Docker è automatico) |
| `NETFLIX_ID` | ❌ | Valore del cookie `NetflixId` (da DevTools → Application → Cookies su netflix.com). Se configurato, il bot tenta prima la conferma via fetch HTTP (senza avviare il browser) e inietta il cookie anche nel contesto Playwright |
| `NETFLIX_SECURE_ID` | ❌ | Valore del cookie `SecureNetflixId` (vedi `NETFLIX_ID`) |

---

## 🔑 Come ottenere le credenziali Google

### 1. Creare le credenziali OAuth2

1. Vai su [Google Cloud Console](https://console.cloud.google.com/)
2. Crea un progetto (o selezionane uno esistente)
3. Abilita le API: **Gmail API** e **Cloud Pub/Sub API**
4. Vai su **Credenziali** → **Crea credenziali** → **ID client OAuth 2.0**
5. Tipo applicazione: **Applicazione web**
6. URI di reindirizzamento autorizzato: `https://developers.google.com/oauthplayground`
7. Salva `Client ID` e `Client Secret`

### 2. Ottenere il Refresh Token

1. Vai su [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
2. Clicca sull'icona ⚙️ in alto a destra → abilita **"Use your own OAuth credentials"**
3. Inserisci il tuo `Client ID` e `Client Secret`
4. Nel campo **Step 1**, seleziona/inserisci gli scope:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.modify`
5. Clicca **"Authorize APIs"** e accedi con il tuo account Google
6. In **Step 2** clicca **"Exchange authorization code for tokens"**
7. Copia il `Refresh token`

### 3. Configurare Google Cloud Pub/Sub

```bash
# Crea il topic
gcloud pubsub topics create gmail-netflix

# Crea la subscription push (sostituisci YOUR_URL con l'URL del tuo server)
gcloud pubsub subscriptions create gmail-netflix-sub \
  --topic=gmail-netflix \
  --push-endpoint=https://YOUR_URL/webhook \
  --ack-deadline=60

# Autorizza Gmail a pubblicare sul topic
gcloud pubsub topics add-iam-policy-binding gmail-netflix \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

---

## 🚀 Avvio

### In locale

```bash
npm start
# oppure in modalità watch (riavvio automatico)
npm run dev
```

### Con Docker

```bash
docker build -t netflix-confirm .
docker run -d \
  --env-file .env \
  -p 3000:3000 \
  netflix-confirm
```

---

## ☁️ Deploy su Railway

Il progetto è preconfigurato per [Railway](https://railway.app/) tramite il file `railway.toml`.

1. Crea un nuovo progetto su Railway
2. Collega questo repository GitHub
3. Aggiungi un servizio **Redis** da Railway
4. Configura le variabili d'ambiente nel pannello Railway (vedi tabella sopra)
5. Railway effettuerà il deploy automaticamente usando il `Dockerfile`

Il file `railway.toml` configura:
- Build tramite `Dockerfile`
- Restart policy `ON_FAILURE` (max 5 tentativi)
- Health check su `/health` ogni 30 secondi

---

## 🌐 API Endpoints

### `POST /webhook`

Riceve le notifiche da Google Cloud Pub/Sub.

**Body (JSON):**
```json
{
  "message": {
    "data": "<base64-encoded-pubsub-payload>"
  }
}
```

Risponde sempre con `200 OK` immediatamente (come richiesto da Pub/Sub), poi elabora il messaggio in background.

---

### `GET /health`

Endpoint di health check.

**Risposta:**
```json
{
  "status": "ok",
  "uptime": 3600,
  "browserReady": true,
  "redisConnected": true
}
```

---

## 🔍 Come funziona il rilevamento email

L'email Netflix viene considerata rilevante se soddisfa **entrambe** le condizioni:

1. **Mittente** contiene `netflix.com`
2. **Oggetto** contiene almeno una delle parole chiave:
   - `Importante`
   - `aggiornare`
   - `Netflix`
   - `posizione principale`

Il link di conferma viene cercato nel corpo HTML (prima nei tag `href`, poi come URL nuda) e nel testo plain.

Pattern ricercato: `https://www.netflix.com/account/update-primary-location...`

Il bottone viene individuato cercando nell'ordine:
`conferma` → `confirm` → `update` → `aggiorna` → `continue` → *(primo bottone disponibile come fallback)*

---

## 🗄️ Redis

Redis viene usato per:

| Chiave | TTL | Descrizione |
|---|---|---|
| `netflix:uid:<messageId>` | 24 ore | Deduplicazione messaggi già processati |
| `gmail:historyId` | Persistente | Ultimo `historyId` Gmail processato |

---

## 📁 Struttura del progetto

```
netflix-confirm/
├── index.js          # Codice principale (unico file)
├── package.json      # Dipendenze e scripts npm
├── package-lock.json # Lockfile dipendenze
├── Dockerfile        # Immagine Docker (Node 20 + Chromium)
├── railway.toml      # Configurazione deploy Railway
├── .gitignore        # File ignorati da git
└── README.md         # Questa documentazione
```

---

## 🛠️ Stack tecnologico

| Tecnologia | Versione | Utilizzo |
|---|---|---|
| [Node.js](https://nodejs.org/) | ≥ 18 | Runtime |
| [Express](https://expressjs.com/) | ^4.19 | Server HTTP / webhook |
| [googleapis](https://github.com/googleapis/google-api-nodejs-client) | ^140 | Gmail API & OAuth2 |
| [Playwright](https://playwright.dev/) | ^1.44 | Browser automation (Chromium) |
| [redis](https://github.com/redis/node-redis) | ^4.6 | Cache / deduplicazione |
| [dotenv](https://github.com/motdotla/dotenv) | ^16.4 | Gestione variabili d'ambiente |

---

## 🐛 Troubleshooting

**Il bot non riceve le notifiche Gmail**
- Verifica che il watch Gmail sia registrato correttamente (controlla i log `Gmail watch registrato`)
- Assicurati che l'account di servizio `gmail-api-push@system.gserviceaccount.com` abbia il permesso `pubsub.publisher` sul topic

**Playwright non trova il bottone**
- Controlla i log per vedere il titolo della pagina caricata
- Netflix potrebbe aver modificato il layout. Aggiorna `BUTTON_KEYWORDS` in `index.js`

**Errore di connessione Redis**
- Verifica che `REDIS_URL` sia corretto e che il servizio Redis sia raggiungibile

**`FATAL: Variabile d'ambiente mancante`**
- Controlla che tutte le variabili obbligatorie siano presenti nel file `.env` o nell'ambiente di esecuzione

---

## 📄 Licenza

Uso personale. Questo progetto è destinato esclusivamente all'automazione del proprio account Netflix personale.
