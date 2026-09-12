# IAE — Shopify (B2B) → Fortnox-integration

Automatiserad B2B-kund- och fakturasynk mellan Shopify Plus (nativ B2B) och Fortnox.
Bygger på tech-specen `techspec-shopify-fortnox`.

**Driftsatt:** `https://app-production-0956.up.railway.app` (Railway, projekt `shopify-fortnox`).

Fyra flöden:

- **Flöde A – Kundsynk.** `companies/*` & `company_locations/*` → upsert av Fortnox-kund (nyckel: org.nr), writeback av `CustomerNumber` till `Company.externalId`.
- **Flöde B – Orderfakturering.** `orders/fulfilled` (B2B) → Fortnox-order → faktura → utskick (e-post/eprint) → bokför.
- **Flöde C – Import & produktsynk.** `npm run import:customers` hämtar alla aktiva Fortnox-kunder och lägger upp dem som B2B-companies i Shopify. `npm run sync:products` speglar Shopify-varianter (SKU) som artiklar i Fortnox så fakturering inte stoppar på okänd SKU. Båda är dry-run som standard, `--apply` för skarpt.
- **Flöde D – B2B-ansökan.** Publikt formulär på `/b2b/apply` → skapar Company i Shopify → triggar Flöde A vidare till Fortnox. Nya ansökningar spärras med `checkoutToDraft` tills de godkänts manuellt.

Webhook-mottagaren gör **inga** Fortnox-anrop synkront: verifierar HMAC, kvitterar 200, lägger i kö. All Fortnox-trafik sker i en worker bakom en global throttle (25 anrop/5 s, delad).

---

## Arkitektur

```
Shopify B2B (Plus)          Denna tjänst (Railway)                 Fortnox API
──────────────────         ────────────────────────              ───────────
companies/*      ─webhook─▶ [web]  HMAC → dedup → kö (Redis)
company_locations/*                         │
orders/fulfilled ─webhook─▶                 ▼
                            [worker]  BullMQ, idempotens, state machine
                              Flöde A ─ kund-upsert ───────────▶ /3/customers
                              │        └ writeback externalId → Shopify (companyUpdate)
                              Flöde B ─ order ─────────────────▶ /3/orders
                                       ─ createinvoice ────────▶ /3/orders/{nr}/createinvoice
                                       ─ email|eprint ─────────▶ /3/invoices/{nr}/email|eprint
                                       ─ bookkeep ─────────────▶ /3/invoices/{nr}/bookkeep
                            [Postgres: mappings + audit + tokens]
```

**Stack:** Node 20 + TypeScript, Express, BullMQ + Redis, Prisma + PostgreSQL, Zod, Pino, Nodemailer.

---

## Snabbstart (lokalt)

```bash
# 1. Beroenden
npm install

# 2. Infra (Postgres + Redis). Om 5432/6379 är upptagna: sätt POSTGRES_PORT/REDIS_PORT i .env.
docker compose up -d

# 3. Miljö
cp .env.example .env      # .env finns redan ifylld med Fortnox-uppgifter
#  Fyll i SHOPIFY_ADMIN_TOKEN och SHOPIFY_API_SECRET efter att appen skapats (se nedan).

# 4. Databas
npm run prisma:migrate    # skapar tabellerna

# 5. Kör (web + worker i en process)
npm run dev
```

Verifiera: `curl localhost:8080/health` → `{"ok":true,...,"fortnoxConnected":false}`.

> Roller: `ROLE=web` (bara mottagare), `ROLE=worker` (bara worker), `ROLE=all` (båda, default).
> I prod kör web och worker som **separata** processer/tjänster.

---

## Provisionering (engångssteg, delvis i webbläsaren)

### 1. Fortnox developer-app
I Fortnox developer-portalen (`apps.fortnox.se/developer`), på er app (client-id finns i `.env` / portalen):

- **Redirect URI:** måste exakt matcha `FORTNOX_REDIRECT_URI`.
  - Lokalt: `http://localhost:8080/oauth/fortnox/callback`
  - Prod: `https://<din-railway-domän>/oauth/fortnox/callback`
- **Scopes (be om ALLA från start** — kan ej läggas till i efterhand utan återaktivering): `customer article order invoice bookkeeping companyinformation`.

### 2. Anslut Fortnox (OAuth)
Starta tjänsten och öppna i webbläsaren:

```
http://localhost:8080/oauth/fortnox/start
```

Logga in i Fortnox och godkänn. Tjänsten byter `code` mot token-paret och sparar det. `/health` visar då `fortnoxConnected:true`.

> Refresh-token roterar vid **varje** användning och är giltig i 45 dagar. Tappas den måste du köra `/oauth/fortnox/start` igen. Atomisk lagring + distribuerat lås gör att samtidiga refresh aldrig tappar anslutningen.

### 3. Shopify-app (Dev Dashboard, OAuth)
Butiken `viwrsi-jk` använder Shopifys **Dev Dashboard** (inga legacy custom apps finns). Appen **"IAE Fortnox Sync"** är redan skapad — client id `975b53e897baf3da89ec71f28feb9de1` (i `SHOPIFY_API_KEY`), scopes `read_companies, write_companies, read_customers, write_customers, read_orders`, aktiv version `iae-fortnox-sync-2`.

Till skillnad från gamla custom apps ges Admin-token via **OAuth-install** (inte en statisk token). Tjänsten har därför egna Shopify-OAuth-routes som fångar och lagrar token.

1. Dev Dashboard → appen → **Settings → Credentials** → kopiera **Secret** till `SHOPIFY_API_SECRET` i `.env`. (Används för både webhook-HMAC och OAuth-token-utbyte.)
2. Dev Dashboard → aktiv version → fältet **Redirect URLs** → lägg till `${APP_BASE_URL}/oauth/shopify/callback` (t.ex. `https://<railway-domän>/oauth/shopify/callback`). Release en ny version.
3. Starta tjänsten (med publik URL) och öppna **`${APP_BASE_URL}/oauth/shopify/start`** → godkänn installen. Offline-token fångas av callbacken och lagras i DB. `SHOPIFY_ADMIN_TOKEN` lämnas tomt.

> Protected customer data (Company/CompanyLocation-PII) ingår i install-medgivandet för denna egna app — ingen separat App Store-granskning krävs.

### 4. Registrera webhooks
När `APP_BASE_URL` pekar på en publik URL (prod, eller en tunnel lokalt):

```bash
npm run provision:webhooks   # skapar prenumerationer mot ${APP_BASE_URL}/webhooks/shopify
npm run provision:list-webhooks
```

Topics: `companies/create`, `companies/update`, `company_locations/create`, `company_locations/update`, `orders/fulfilled`.

> Lokalt behöver du en publik tunnel (t.ex. `cloudflared tunnel --url http://localhost:8080`) och sätta `APP_BASE_URL` till tunnel-URL:en innan du kör `provision:webhooks`.

### 5. Artiklar + storefront-konfig
```bash
npm run sync:articles        # speglar Fortnox-artikelregistret (SKU → ArticleNumber)
```

Seeda sedan `StorefrontConfig` (en rad per storefront) med t.ex. Prisma Studio (`npx prisma studio`):

| Fält | Exempel | Not |
|------|---------|-----|
| `shopDomain` | `viwrsi-jk.myshopify.com` | |
| `pricesIncludeVat` | `false` | MÅSTE matcha Shopify `taxesIncluded` |
| `sendMethod` | `email` \| `eprint` | |
| `shippingArticleNr` | `FRAKT` | Fortnox-fraktartikel (egen rad) |
| `paymentTermsMap` | `{"Net 30":"30"}` | Shopify payment terms-mall → Fortnox `TermsOfPayment` |
| `accountMap` | `{"sales_se":3001,"sales_eu_reverse":3231,"sales_export":3105}` | momsscenario → Fortnox-konto (**verifiera med redovisning**) |

Saknas raden används säkra defaults (SEK, inhemsk, email, exkl. moms).

---

## Samlingsfakturering (periodfaktura)

Kunder som lägger många småordrar behöver inte en faktura per order. Sätt rytm
per kund i adminvyn:

```
https://<domän>/admin/billing?token=<ADMIN_TOKEN>
```

| Rytm | Innebörd |
|------|----------|
| `per order` | Faktura direkt vid leverans (default) |
| `varje vecka` | Alla ordrar under veckan → en faktura |
| `varannan vecka` | Samma, men jämna ISO-veckor |
| `varje månad` | Alla ordrar under månaden → en faktura |

Ordrar från kunder med periodrytm **parkeras** (`AWAITING_CONSOLIDATION`) i
stället för att faktureras. Ett schemalagt jobb körs dagligen kl.
`CONSOLIDATION_HOUR` och klipper de perioder som är mogna
(`CONSOLIDATION_WEEKDAY`, default måndag). Då skapas **en** Fortnox-order med
alla rader → **en** faktura, där varje rad är märkt med sitt Shopify-ordernummer.

Adminvyn visar antal parkerade ordrar per kund och har en **"Fakturera nu"**-knapp
för att klippa i förtid. Samma sak från terminalen:

```bash
npm run invoice:consolidate                  # torrkörning, bara mogna perioder
npm run invoice:consolidate -- --apply --force   # fakturera allt parkerat nu
```

Säkerhetsspärrar: ordrar grupperas per kund **och valuta**, och en samlingsfaktura
blockeras med larm om någon SKU saknas i Fortnox eller om ordrarna har olika
inkl./exkl. moms — ordrarna ligger då kvar parkerade tills felet är löst.

## Godkänna en B2B-ansökan

När någon ansökt via `/b2b/apply` skapas bolaget i Shopify men **spärrat**: alla
ordrar går till utkast för granskning i stället för att bli skarpa fakturaordrar.
Du får ett larm med uppgifterna. För att godkänna:

1. Shopify-admin → **Customers → Companies** → öppna bolaget (noten visar ansökningsuppgifterna).
2. Öppna locationen → stäng av **"Checkout to draft"** i buyer experience-inställningarna.
3. Säkerställ att kontakten har orderrätt och rätt betalningsvillkor.

Kunden finns redan i Fortnox (Flöde A körde vid skapandet), så fakturering fungerar direkt.

## Deploy till Railway

**Nuvarande drift:** projekt `shopify-fortnox`, tjänster `app` + `Postgres` + `Redis`.
Deploya om med `railway up` (kräver `railway login`). `npm start` kör
`prisma migrate deploy` före serverstart, så migreringar sker automatiskt.

Byter domänen måste tre saker pekas om: Fortnox redirect-URI, Shopify-appens
Redirect URL (ny version i Dev Dashboard) och `npm run provision:webhooks`
(städar automatiskt bort prenumerationer med gammal URL).

### Förstagångsuppsättning

1. Skapa projekt och lägg till **PostgreSQL** + **Redis** (Railway-plugins). De exponerar `DATABASE_URL` och `REDIS_URL`.
2. Skapa **två** tjänster från detta repo:
   - **web:** `ROLE=web`, start: `npm run start` (efter `npm run build`).
   - **worker:** `ROLE=worker`, start: `npm run start`.
   - Build-kommando för båda: `npm run build && npm run prisma:generate`.
3. Sätt miljövariabler (se `.env.example`) på båda tjänsterna. `APP_BASE_URL` = web-tjänstens publika domän.
4. Kör migrering en gång: `npm run prisma:deploy` (t.ex. via Railway-deploy-hook eller en engångskommando-tjänst).
5. Registrera redirect-URI:er på prod-URL:en: Fortnox-appen (`/oauth/fortnox/callback`) och Shopify-appen (`/oauth/shopify/callback`).
6. Anslut: öppna `https://<web-domän>/oauth/shopify/start` (godkänn install) och `https://<web-domän>/oauth/fortnox/start` (logga in + godkänn).
7. Kör `npm run provision:webhooks` mot prod-URL:en.

---

## Drift

- **Audit-logg:** tabellen `AuditLog` — en rad per steg (`customer.upsert`, `order.create`, `invoice.create`, `invoice.send`, `invoice.bookkeep`, ...). Inspektera med `npx prisma studio`.
- **State machine per order:** `PENDING → ORDER_OK → INVOICE_OK → SENT → BOOKKEPT` (tabell `OrderMapping`). Omkörning återupptar från senaste lyckade steg.
- **Dead-letter:** jobb som misslyckas efter 5 försök behålls i kön + larm (logg, och e-post om SMTP är satt). `ALERT_EMAIL_TO` styr mottagare.
- **Idempotens:** webhook-id (`ProcessedWebhook`), mapping-tabeller och `Company.externalId` skyddar mot dubbletter och retries.
- **Throttle:** global token-bucket i Redis (25/5 s) framför Fortnox-klienten, delad över alla workers/storefronts. `429` → backoff.

### Köra om en order manuellt
Radera (eller nollställ `state`) raden i `OrderMapping` och trigga om `orders/fulfilled` (eller anropa `handleOrderFulfilled`). State machine ser till att inget dubbleras.

---

## Att verifiera med redovisning (medvetet ej hårdkodat)

- **Momsmatris** (`src/vat/matrix.ts`): satser, konton och `VATType` per scenario. Konton sätts via `StorefrontConfig.accountMap`.
- **`taxRegistrationId` = org.nr eller VAT-nr?** Shopify-fältet är fritext. Heuristik: börjar det med två bokstäver tolkas det som VAT-nr (annars org.nr). Bekräfta hur ni fyller i det i Shopify.
- **Pris inkl./exkl. moms:** `pricesIncludeVat` måste matcha Shopify `taxesIncluded` — annars blir totalen fel (vanligaste buggen). Tjänsten sätter Fortnox `VATIncluded` efter Shopifys faktiska värde och larmar vid avvikelse mot konfig.
- **Flera locations per company:** varje CompanyLocation blir en egen Fortnox-kund (mapping-tabellen är sann källa). `Company.externalId` sätts till senaste synkade — exakt i 1:1-fallet.

---

## Projektstruktur

```
src/
  config/      env (zod) + storefront-konfig
  lib/         logger, prisma, redis
  fortnox/     oauth (atomisk refresh), client (+throttle, 429-backoff), types
  shopify/     hmac, oauth (install/token), graphql-klient, queries (validerade), data, webhooks, types
  vat/         momsmatris + VIES
  domain/      mapping, state machine, audit
  flows/       customerSync (A), orderInvoice (B)
  queue/       BullMQ-kö
  worker/      worker + dead-letter
  web/         Express-server + routes (webhooks, fortnox-oauth, shopify-oauth, health)
  scripts/     provisionWebhooks, listWebhooks, syncArticles
prisma/        schema + migrations
```

## Utanför scope för v1 (roadmap)
Kreditfakturor/returer, DTC-bokföring, Fortnox→Shopify betalstatus, taggad B2B-modell (koden har stöd via `StorefrontConfig.b2bModel` men triggers/entiteter för taggade kunder är inte aktiverade).
