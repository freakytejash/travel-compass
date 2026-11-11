# Deploy for free and get a public URL

Result: Travel Compass running at `https://travel-compass-xxxx.onrender.com`, open on your phone, with live Google Flights and Hotels results, OpenStreetMap venues, Groq AI, and reminders by WhatsApp (CallMeBot) or Telegram. It costs €0 and needs no credit card. Checked November 2026.

| Piece | Free service | Free limit |
|---|---|---|
| App server (web + background jobs) | Render free web service | 750 hours/month. Sleeps after 15 min without traffic; about 1 min to wake |
| Database | Neon free Postgres | 100 compute-hours/month (≈400 h at the smallest size), 0.5 GB. Pauses after 5 min idle |
| Keep-awake ping | cron-job.org | Free |
| Flights + hotels | SerpApi | 250 searches/month |
| AI | Groq | Free-tier rate limits |
| WhatsApp reminders | CallMeBot | Free, personal use, only to your own number |

You do the sign-ups yourself (they need your email and phone), and you paste the keys into Render's dashboard, never into chat or git. It takes about 30 minutes.

## 1. Put the code on GitHub

Create an empty **private** repository on github.com, e.g. `travel-compass`. Then, in the project folder:

```bash
git remote add origin https://github.com/<your-username>/travel-compass.git
git branch -M main
git push -u origin main
```

## 2. Create the free database (Neon)

1. Sign up at neon.tech, choose a region in Europe (Frankfurt) and create a project.
2. Under **Connect**, turn **Connection pooling off** and copy the connection string. It looks like `postgresql://…@ep-….eu-central-1.aws.neon.tech/neondb?sslmode=require`.

## 3. Get the free keys

- **SerpApi**: serpapi.com → sign up → copy the API key.
- **Groq**: console.groq.com → API Keys → create.
- **WhatsApp (CallMeBot)**: you connect this later, inside the app (step 6).
- **Telegram** (optional): in Telegram, message @BotFather, send `/newbot`, and copy the token and the bot username.

## 4. Deploy on Render

1. Sign up at render.com with GitHub (no card needed).
2. Choose **New → Blueprint**, pick your `travel-compass` repository, and Render reads `render.yaml`.
3. Fill in the values it asks for:
   - `DATABASE_URL` — the Neon string from step 2.
   - `ADMIN_EMAILS` — your email.
   - `SERPAPI_API_KEY`, `AI_API_KEY` — the keys from step 3.
   - Telegram values if you have them.
   - Leave the others empty.
4. Click **Apply**. The first build takes about 5 minutes.
5. Your URL appears at the top of the service page (`https://travel-compass-….onrender.com`). Open `/api/ready` on it; it should show `{"ok":true}`.

## 5. Keep it awake (so reminders go out on time)

Free Render services sleep after 15 minutes without traffic, and a sleeping service can't send a reminder.

1. At cron-job.org (free), create a job that calls `https://<your-url>/api/health` every **10 minutes**.
2. That keeps the service running about 720 hours a month, which is under Render's 750 free hours.

The health check doesn't touch the database. The worker sleeps until the next reminder is due, so Neon can still pause and stay well inside its 100 hours.

## 6. First use

1. Open your URL on your phone and sign up with your `ADMIN_EMAILS` address.
2. With `EMAIL_LOG_ONLY=true` no email is sent: the verification link is in Render → your service → **Logs** (search `verify-email`). To get real emails in your inbox, see **Real verification emails** below.
3. Go to **Reminders → WhatsApp, free (CallMeBot)**:
   1. Save **+34 684 78 37 08** in your contacts. That's the number CallMeBot publishes; check callmebot.com in case it changes.
   2. In WhatsApp, send it `I allow callmebot to send me messages`.
   3. Paste the API key it replies with, plus your number, into the app. Press **Send test code**, enter the code, then **Turn on reminders**.
4. Plan a trip. The first search after a quiet period takes about a minute while Render and Neon wake up.

## Real verification emails (free, Brevo)

Emails don't arrive when `EMAIL_LOG_ONLY=true` (links only go to the log), or when Resend sends from `onboarding@resend.dev` (Resend only delivers that to the address you signed up to Resend with). Brevo's free plan sends 300 emails a day to anyone, from your own verified address, without a domain:

1. Sign up at brevo.com (free, no card).
2. **Senders, domains & dedicated IPs → Senders → Add a sender**: enter your own address (for example your Gmail) and confirm the email Brevo sends you.
3. **SMTP & API → API keys → Generate a new API key**. Copy it.
4. In Render → your service → **Environment**, set:
   - `BREVO_API_KEY` = the key
   - `EMAIL_FROM` = `Travel Compass <the-address-you-verified>`
   - `EMAIL_LOG_ONLY` = `false`
5. Save (Render redeploys). On the sign-in page use **Send a new link**; the email arrives within a minute. Check spam the first time — mail sent "from" a Gmail address through another service can be filtered. For best delivery, later verify your own domain in Brevo (SPF/DKIM).

## Trip ideas and "Book everything"

- The dashboard is public: anyone can pick a city and see upcoming long weekends (Nager.Date, free, no key) and the airports that will be compared.
- **Suggest trips** (signed in): one SerpApi *Google Travel Explore* search per date window (default 3), from all airports within 150 km at once. Choosing an idea creates the trip and starts one Google Flights search (all nearby airports together, plus 2 return searches) and one Google Hotels search. A full idea → trip run costs about 7 of the 250 free monthly searches.
- **Book everything** lists flights and stays with live prices, plus prefilled links for hostels, Airbnb, car rental (Kayak, sorted by price), trains/buses (Rome2Rio) and tickets your itinerary marks as needing a reservation. Car rental, hostel-site and Airbnb prices aren't loaded in the app: there's no free price feed for them.

## WhatsApp: what's free and what isn't

- **CallMeBot** (used here): free for personal use, but it can only message your own number. It's an unofficial gateway, not Meta, and gives no delivery receipts, so reminders show as "sent", never "delivered".
- **Meta WhatsApp Cloud API test number**: also free, to up to 5 verified numbers, with no payment method. But the access token shown in the API Setup page expires every 24 hours, so scheduled reminders would stop the next day unless you set up a permanent token in Meta Business. The app supports this route too: set `WHATSAPP_*` (see `.env.example`).
- **Meta Cloud API with your own number**: business-started template messages, which is what reminders are, are paid per message.

## Limits to know

- **Personal use only:** SerpApi free, Open-Meteo free and CallMeBot are all for personal use. Switch to the paid providers before inviting other people.
- **Data on Render's disk is temporary:** the airport list downloads again after each restart (a few seconds). Everything that matters is in Neon.
- **Neon storage:** the free plan has 0.5 GB per project. Housekeeping deletes old logs and jobs automatically.

## Commands

| Command | What it does |
|---|---|
| `git push` | Redeploys automatically on Render |
| `curl https://<your-url>/api/ready` | Checks the app and database are up |
| `DATABASE_URL=… SERPAPI_API_KEY=… AI_BASE_URL=… AI_API_KEY=… npm run check:integrations` | Live check of every configured service, run on your own computer with the same values (Render's shell is not available on the free plan) |
