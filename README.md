# 🎬 Netflix Home Confirm

A bot that automatically confirms the **Netflix household** upon receiving the verification email. It monitors your Gmail inbox via Google Cloud Pub/Sub, detects Netflix emails requesting primary location confirmation, and automatically clicks the confirmation button using a headless browser (Playwright/Chromium).

---

## ✨ Features

- 📧 **Real-time Gmail monitoring** via Google Cloud Pub/Sub webhook
- 🔍 **Automatic detection** of Netflix household confirmation emails
- 🖱️ **Automatic click** on the confirmation button via Playwright (headless Chromium)
- 🔁 **Retry with back-off** on error (up to 3 attempts)
- 🗄️ **Message deduplication** via Redis (24-hour TTL)
- 📬 **Email notification** on failure (with 10-minute rate limiting)
- 💚 **Health check** endpoint for uptime monitoring
- 🛡️ **Anti-bot evasion**: realistic HTTP headers, blocking of unnecessary resources (images, fonts, CSS)

---

## 🏗️ Architecture

```
Gmail ──► Google Cloud Pub/Sub ──► /webhook (Express)
                                         │
                                    Redis (dedup)
                                         │
                                   Gmail API (fetch email)
                                         │
                              Playwright (click confirm)
```

1. Gmail sends a notification to Google Cloud Pub/Sub every time a new message arrives.
2. The Express webhook receives the notification and fetches new messages via the Gmail History API.
3. If the sender is `netflix.com` and the subject contains relevant keywords, the confirmation link is extracted.
4. Playwright opens the link in a headless browser and clicks the confirmation button.
5. On failure, an error email is sent.

---

## 🔧 Requirements

- **Node.js** ≥ 18
- **Redis** (e.g. Redis Cloud, Upstash, Railway Redis)
- **Google Cloud account** with:
  - Gmail API enabled
  - Google Cloud Pub/Sub enabled
  - OAuth 2.0 Client ID configured

---

## 📦 Local Installation

```bash
git clone https://github.com/oscarnastro/netflix-confirm.git
cd netflix-confirm
npm install
```

### Install the Chromium browser (local only, not in Docker)

```bash
npx playwright install chromium
```

---

## ⚙️ Configuration

Create a `.env` file in the project root with the following variables:

```env
# Google OAuth2
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REFRESH_TOKEN=your_google_refresh_token

# Google Cloud Pub/Sub
PUBSUB_TOPIC=projects/YOUR_PROJECT_ID/topics/YOUR_TOPIC_NAME

# Redis
REDIS_URL=redis://localhost:6379

# (Optional) Email address for error notifications
GMAIL_ADDRESS=your@gmail.com
ERROR_EMAIL_TO=your@gmail.com

# (Optional) Chromium browser path (local only, if different from default)
PLAYWRIGHT_EXEC_PATH=/usr/bin/chromium
```

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth2 Client ID |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google OAuth2 Client Secret |
| `GOOGLE_REFRESH_TOKEN` | ✅ | OAuth2 refresh token (obtained via OAuth Playground) |
| `PUBSUB_TOPIC` | ✅ | Full name of the Pub/Sub topic |
| `REDIS_URL` | ✅ | Redis connection URL |
| `GMAIL_ADDRESS` | ❌ | Gmail address used to send error notifications |
| `ERROR_EMAIL_TO` | ❌ | Error email recipient (default: `oscarnastro@gmail.com`) |
| `PLAYWRIGHT_EXEC_PATH` | ❌ | Chromium binary path (set automatically in Docker) |

---

## 🔑 How to obtain Google credentials

### 1. Create OAuth2 credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or select an existing one)
3. Enable the APIs: **Gmail API** and **Cloud Pub/Sub API**
4. Go to **Credentials** → **Create credentials** → **OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Authorized redirect URI: `https://developers.google.com/oauthplayground`
7. Save the `Client ID` and `Client Secret`

### 2. Obtain the Refresh Token

1. Go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
2. Click the ⚙️ icon in the top right → enable **"Use your own OAuth credentials"**
3. Enter your `Client ID` and `Client Secret`
4. In the **Step 1** field, select/enter the scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.modify`
5. Click **"Authorize APIs"** and sign in with your Google account
6. In **Step 2** click **"Exchange authorization code for tokens"**
7. Copy the `Refresh token`

### 3. Configure Google Cloud Pub/Sub

```bash
# Create the topic
gcloud pubsub topics create gmail-netflix

# Create the push subscription (replace YOUR_URL with your server URL)
gcloud pubsub subscriptions create gmail-netflix-sub \
  --topic=gmail-netflix \
  --push-endpoint=https://YOUR_URL/webhook \
  --ack-deadline=60

# Authorize Gmail to publish to the topic
gcloud pubsub topics add-iam-policy-binding gmail-netflix \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

---

## 🚀 Running

### Locally

```bash
npm start
# or in watch mode (auto-restart)
npm run dev
```

### With Docker

```bash
docker build -t netflix-confirm .
docker run -d \
  --env-file .env \
  -p 3000:3000 \
  netflix-confirm
```

---

## ☁️ Deploy on Railway

The project is pre-configured for [Railway](https://railway.app/) via the `railway.toml` file.

1. Create a new project on Railway
2. Connect this GitHub repository
3. Add a **Redis** service from Railway
4. Set the environment variables in the Railway dashboard (see table above)
5. Railway will deploy automatically using the `Dockerfile`

The `railway.toml` file configures:
- Build via `Dockerfile`
- Restart policy `ON_FAILURE` (max 5 attempts)
- Health check on `/health` every 30 seconds

---

## 🌐 API Endpoints

### `POST /webhook`

Receives notifications from Google Cloud Pub/Sub.

**Body (JSON):**
```json
{
  "message": {
    "data": "<base64-encoded-pubsub-payload>"
  }
}
```

Always responds with `200 OK` immediately (as required by Pub/Sub), then processes the message in the background.

---

### `GET /health`

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "uptime": 3600,
  "browserReady": true,
  "redisConnected": true
}
```

---

## 🔍 How email detection works

A Netflix email is considered relevant if it meets **both** conditions:

1. **Sender** contains `netflix.com`
2. **Subject** contains at least one of the following keywords:
   - `Importante`
   - `aggiornare`
   - `Netflix`
   - `posizione principale`

The confirmation link is searched in the HTML body (first in `href` attributes, then as a bare URL) and in the plain text.

Searched pattern: `https://www.netflix.com/account/update-primary-location...`

The button is located by searching in this order:
`conferma` → `confirm` → `update` → `aggiorna` → `continue` → *(first available button as fallback)*

---

## 🗄️ Redis

Redis is used for:

| Key | TTL | Description |
|---|---|---|
| `netflix:uid:<messageId>` | 24 hours | Deduplication of already-processed messages |
| `gmail:historyId` | Persistent | Last processed Gmail `historyId` |

---

## 📁 Project structure

```
netflix-confirm/
├── index.js          # Main code (single file)
├── package.json      # Dependencies and npm scripts
├── package-lock.json # Dependency lockfile
├── Dockerfile        # Docker image (Node 20 + Chromium)
├── railway.toml      # Railway deploy configuration
├── .gitignore        # Files ignored by git
└── README.md         # This documentation
```

---

## 🛠️ Tech stack

| Technology | Version | Usage |
|---|---|---|
| [Node.js](https://nodejs.org/) | ≥ 18 | Runtime |
| [Express](https://expressjs.com/) | ^4.19 | HTTP server / webhook |
| [googleapis](https://github.com/googleapis/google-api-nodejs-client) | ^140 | Gmail API & OAuth2 |
| [Playwright](https://playwright.dev/) | ^1.44 | Browser automation (Chromium) |
| [redis](https://github.com/redis/node-redis) | ^4.6 | Cache / deduplication |
| [dotenv](https://github.com/motdotla/dotenv) | ^16.4 | Environment variable management |

---

## 🐛 Troubleshooting

**The bot is not receiving Gmail notifications**
- Verify that the Gmail watch is registered correctly (check the logs for `Gmail watch registrato`)
- Make sure the service account `gmail-api-push@system.gserviceaccount.com` has the `pubsub.publisher` permission on the topic

**Playwright cannot find the button**
- Check the logs to see the title of the loaded page
- Netflix may have changed the layout. Update `BUTTON_KEYWORDS` in `index.js`

**Redis connection error**
- Verify that `REDIS_URL` is correct and that the Redis service is reachable

**`FATAL: Variabile d'ambiente mancante`**
- Make sure all required variables are present in the `.env` file or in the execution environment

---

## 📄 License

Personal use. This project is intended exclusively for automating your own personal Netflix account.
