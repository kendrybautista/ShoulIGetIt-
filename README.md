# SIGI · Should I Get It?

Check products, food and cars for recalls before you buy, and keep watch over what you already own.

- **Check:** search a product, brand, model number or barcode, or pick a car by make, model and year. You get a verdict (GET IT / CHECK IT / SKIP IT) with the matching official notices.
- **My stuff:** a watch list that flags anything with a matching recall, including recalls issued after you added it.
- **Latest:** new recalls with filters (kids & baby, food, home, batteries & fire, outdoor).
- **Account:** email sign-in, recent checks, theme, data sources.
- **Ask Claude to compare** (optional): Claude reads the candidate notices and says which ones are really your product.

Data comes from the CPSC, FDA (Class I food) and NHTSA (vehicles and child seats). A GitHub Action refreshes it every Monday.

## How it fits together

| Piece | Job |
|---|---|
| GitHub | Holds the code and refreshes the recall data weekly |
| Render | Runs `server.js`: serves the app and keeps your Claude API key secret |
| Supabase | Email sign-in and the database (watch lists, recent checks) |

```
public/            the app (index.html, app.js, styles.css)
public/img/        logo and icons
public/data/       recall data (data.json + one file per vehicle make in v/)
scripts/           build_data.py, which downloads and rebuilds public/data
supabase/          schema.sql, the database tables and security rules
server.js          Express server
render.yaml        Render setup
```

## Setup

### 1. Supabase (database and sign-in)

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Go to **Authentication → Sign In / Providers** and make sure **Email** is on.
4. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key.

### 2. GitHub

1. Create a new repository (for example `sigi`).
2. Push this folder to it.
3. Under **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions**, so the weekly data refresh can commit.

### 3. Render (hosting)

1. At [render.com](https://render.com), choose **New → Blueprint** and pick your repo. Render reads `render.yaml`.
2. When it asks for environment variables, enter:
   - `SUPABASE_URL`: the Project URL from step 1
   - `SUPABASE_ANON_KEY`: the anon public key from step 1
   - `ANTHROPIC_API_KEY`: optional. This turns on **Ask Claude to compare**. Get a key at [console.anthropic.com](https://console.anthropic.com). Leave it blank to hide that button.
3. Deploy, then copy your site address (for example `https://sigi.onrender.com`).

### 4. Connect sign-in to your site

In Supabase, open **Authentication → URL Configuration**:

- **Site URL:** your Render address
- **Redirect URLs:** add your Render address, and `http://localhost:3000` if you'll run it locally

Without this, the emailed sign-in link sends people to the wrong place.

## Run it on your computer

```bash
cp .env.example .env      # then fill in the values
npm install
npm run dev               # http://localhost:3000
```

Refresh the recall data by hand with `npm run data` (needs Python 3).

## Good to know

- **Free Render plans sleep** after about 15 minutes idle. The first visit after that takes 30 to 60 seconds to wake up. A paid plan avoids this.
- **The anon key is meant to be public.** Row-level security in `schema.sql` means each person can only read and change their own rows.
- **The Claude API key never reaches the browser.** `/api/compare` only works for signed-in users, with a limit of 30 checks per user per hour.
- **Supabase's built-in email sender is rate limited** (a few emails per hour) and meant for testing. Before launching, add your own SMTP provider under **Authentication → Emails → SMTP Settings**.
- **Matching is keyword based.** SIGI can miss a recall or flag one that isn't yours. The app tells users to confirm on the official notice; keep that.
- **Vehicle recalls are by make, model and year, not VIN.** The app links to NHTSA's VIN lookup for an exact answer.

SIGI is not affiliated with the CPSC, FDA or NHTSA.
