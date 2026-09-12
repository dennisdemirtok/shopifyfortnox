import { Router, json, urlencoded, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { redis } from "../../lib/redis";
import { prisma } from "../../lib/prisma";
import { createCompany, findCompanies } from "../../shopify/data";
import { audit } from "../../domain/audit";
import { alert } from "../../notify/notifier";

/**
 * Publik B2B-ansökan (Flöde D).
 *
 *   GET  /b2b/apply   → HTML-formulär (kan länkas/bäddas in från storefronten)
 *   POST /b2b/apply   → skapar Company + Location + kontakt i Shopify
 *
 * Företaget skapas med buyerExperienceConfiguration.checkoutToDraft = true, dvs.
 * ordrar från nyansökta bolag blir UTKAST för granskning i stället för skarpa
 * ordrar. Det hindrar att vem som helst self-servar sig till fakturaköp med
 * betalningsvillkor. När du godkänt bolaget: stäng av "checkout to draft" på
 * locationen i Shopify-admin.
 *
 * När företaget skapats fyrar Shopify webhooken companies/create → Flöde A →
 * kunden läggs upp i Fortnox (org.nr = taxRegistrationId).
 */

const MAX_PER_IP_PER_HOUR = 5;

const applicationSchema = z.object({
  companyName: z.string().trim().min(2, "Företagsnamn saknas").max(120),
  orgNr: z
    .string()
    .trim()
    .regex(/^(\d{6}|\d{8})-?\d{4}$/, "Ogiltigt organisationsnummer (ÅÅMMDD-XXXX)"),
  email: z.string().trim().toLowerCase().email("Ogiltig e-postadress").max(150),
  firstName: z.string().trim().min(1, "Förnamn saknas").max(60),
  lastName: z.string().trim().min(1, "Efternamn saknas").max(60),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  address1: z.string().trim().min(2, "Gatuadress saknas").max(150),
  zip: z.string().trim().min(3, "Postnummer saknas").max(20),
  city: z.string().trim().min(1, "Ort saknas").max(80),
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .optional()
    .default("SE"),
  message: z.string().trim().max(1000).optional().or(z.literal("")),
  // Honeypot: fylls bara i av bottar. Valideras medvetet INTE — ifylld ger ett
  // tyst "ok" längre ner, så bottar inte lär sig att de fastnat.
  website: z.string().max(200).optional(),
});

type Application = z.infer<typeof applicationSchema>;

/** Normaliserat org.nr (bara siffror) för jämförelse. */
const normOrgNr = (s: string) => s.replace(/\D/g, "");

async function rateLimited(ip: string): Promise<boolean> {
  try {
    const key = `b2b:apply:rl:${ip}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 3600);
    return n > MAX_PER_IP_PER_HOUR;
  } catch (err) {
    logger.warn({ err }, "Rate-limit-koll misslyckades — släpper igenom");
    return false;
  }
}

/** Redan registrerad? Kollar lokal mapping (org.nr) och Shopify-sök (namn). */
async function findExisting(app: Application): Promise<string | null> {
  const digits = normOrgNr(app.orgNr);
  // Org.nr lagras med varierande formatering — normalisera i JS.
  const mappings = await prisma.customerMapping.findMany({
    where: { shopDomain: env.SHOPIFY_SHOP_DOMAIN, organisationNumber: { not: null } },
    select: { organisationNumber: true, companyId: true },
  });
  const hit = mappings.find((m) => normOrgNr(m.organisationNumber!) === digits);
  if (hit) return hit.companyId;

  try {
    const matches = await findCompanies(`name:'${app.companyName.replace(/'/g, "")}'`);
    const exact = matches.find(
      (m) => (m.name ?? "").trim().toLowerCase() === app.companyName.toLowerCase()
    );
    if (exact) return exact.id;
  } catch (err) {
    logger.warn({ err }, "Namnsökning för dubblettkoll misslyckades — fortsätter");
  }
  return null;
}

function buildInput(app: Application, withContact: boolean) {
  const orgNr = normOrgNr(app.orgNr);
  const noteLines = [
    `B2B-ANSÖKAN via webbformulär ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    `Kontakt: ${app.firstName} ${app.lastName} <${app.email}>`,
    app.phone ? `Telefon: ${app.phone}` : null,
    `Org.nr: ${app.orgNr}`,
    app.message ? `Meddelande: ${app.message}` : null,
    "STATUS: ej granskad — ordrar går till utkast tills du godkänner.",
  ].filter(Boolean);

  return {
    company: {
      name: app.companyName,
      note: noteLines.join("\n"),
    },
    ...(withContact
      ? {
          companyContact: {
            email: app.email,
            firstName: app.firstName,
            lastName: app.lastName,
          },
        }
      : {}),
    companyLocation: {
      name: app.city || "Huvudkontor",
      taxRegistrationId: orgNr,
      billingSameAsShipping: true,
      shippingAddress: {
        address1: app.address1,
        city: app.city,
        zip: app.zip,
        countryCode: (app.countryCode ?? "SE").toUpperCase(),
        recipient: app.companyName,
      },
      // Säkerhetsspärr: ordrar blir utkast för granskning tills bolaget godkänts.
      buyerExperienceConfiguration: { checkoutToDraft: true },
    },
  };
}

export const b2bApplyRouter = Router();

// CORS så formuläret kan ligga i Shopify-temat och posta hit.
function allowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  const allow = env.B2B_ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.includes("*")) return origin;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === env.SHOPIFY_SHOP_DOMAIN.toLowerCase()) return origin;
    if (allow.some((a) => host === a.toLowerCase())) return origin;
  } catch {
    /* ogiltig origin */
  }
  return null;
}

b2bApplyRouter.use("/b2b/apply", (req, res, next) => {
  const origin = allowedOrigin(req.header("origin"));
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

b2bApplyRouter.get("/b2b/apply", (req, res) => {
  const sent = req.query.sent === "1";
  res.type("html").send(renderForm({ sent }));
});

b2bApplyRouter.post(
  "/b2b/apply",
  json({ limit: "32kb" }),
  urlencoded({ extended: false, limit: "32kb" }),
  async (req: Request, res: Response) => {
    const wantsHtml =
      (req.header("accept") ?? "").includes("text/html") &&
      !(req.header("content-type") ?? "").includes("application/json");

    const fail = (status: number, message: string, fields?: Record<string, string>) => {
      if (wantsHtml) {
        return res
          .status(status)
          .type("html")
          .send(renderForm({ error: message, values: req.body, fieldErrors: fields }));
      }
      return res.status(status).json({ ok: false, error: message, fields });
    };

    const ip = (req.ip ?? "okänd").replace(/^::ffff:/, "");
    if (await rateLimited(ip)) {
      logger.warn({ ip }, "B2B-ansökan rate-limitad");
      return fail(429, "För många ansökningar från denna adress. Försök igen om en stund.");
    }

    const parsed = applicationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const k = String(issue.path[0] ?? "form");
        if (!fields[k]) fields[k] = issue.message;
      }
      return fail(400, "Kontrollera uppgifterna nedan.", fields);
    }
    const app = parsed.data;

    // Honeypot ifylld => bot. Svara "ok" utan att skapa något.
    if (app.website) {
      logger.info({ ip }, "B2B-ansökan blockerad (honeypot)");
      return wantsHtml
        ? res.redirect(303, "/b2b/apply?sent=1")
        : res.json({ ok: true });
    }

    try {
      const existingId = await findExisting(app);
      if (existingId) {
        await audit({
          shopDomain: env.SHOPIFY_SHOP_DOMAIN,
          flow: "D",
          entityType: "b2b_application",
          entityId: normOrgNr(app.orgNr),
          step: "apply.duplicate",
          status: "skipped",
          message: `${app.companyName} finns redan (${existingId})`,
        });
        return fail(
          409,
          "Det finns redan ett konto för detta företag. Kontakta oss så hjälper vi dig vidare."
        );
      }

      let result = await createCompany(buildInput(app, true));
      if (result.userErrors.length > 0) {
        logger.warn(
          { errors: result.userErrors.map((e) => e.message) },
          "companyCreate med kontakt misslyckades — försöker utan kontakt"
        );
        result = await createCompany(buildInput(app, false));
      }
      if (result.userErrors.length > 0 || !result.company) {
        throw new Error(
          result.userErrors.map((e) => e.message).join("; ") || "okänt fel från Shopify"
        );
      }

      const companyId = result.company.id;
      logger.info({ companyId, company: app.companyName }, "B2B-ansökan skapad");
      await audit({
        shopDomain: env.SHOPIFY_SHOP_DOMAIN,
        flow: "D",
        entityType: "b2b_application",
        entityId: normOrgNr(app.orgNr),
        step: "apply.created",
        status: "ok",
        message: `${app.companyName} → ${companyId} (väntar på godkännande)`,
      });
      await alert(
        "Ny B2B-ansökan",
        `${app.companyName} (org.nr ${app.orgNr}) har ansökt om B2B-konto.\n` +
          `Kontakt: ${app.firstName} ${app.lastName} <${app.email}>` +
          (app.phone ? `, tel ${app.phone}` : "") +
          `\nAdress: ${app.address1}, ${app.zip} ${app.city}\n` +
          (app.message ? `Meddelande: ${app.message}\n` : "") +
          `\nGranska i Shopify: https://admin.shopify.com/store/${env.SHOPIFY_SHOP_DOMAIN.replace(".myshopify.com", "")}/companies\n` +
          `Ordrar går till UTKAST tills du stänger av "checkout to draft" på locationen.`
      );

      return wantsHtml
        ? res.redirect(303, "/b2b/apply?sent=1")
        : res.status(201).json({ ok: true, companyId });
    } catch (err) {
      logger.error({ err }, "B2B-ansökan misslyckades");
      await audit({
        shopDomain: env.SHOPIFY_SHOP_DOMAIN,
        flow: "D",
        entityType: "b2b_application",
        entityId: normOrgNr(app.orgNr),
        step: "apply.created",
        status: "error",
        message: (err as Error).message,
      });
      return fail(500, "Något gick fel när ansökan skickades. Försök igen eller kontakta oss.");
    }
  }
);

// ── HTML-formulär ─────────────────────────────────────────────────────────
const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function renderForm(opts: {
  sent?: boolean;
  error?: string;
  values?: Record<string, unknown>;
  fieldErrors?: Record<string, string>;
}): string {
  const v = opts.values ?? {};
  const fe = opts.fieldErrors ?? {};
  const field = (
    name: string,
    label: string,
    type = "text",
    required = true,
    extra = ""
  ) => `
    <label class="f">
      <span>${label}${required ? " <i>*</i>" : ""}</span>
      <input type="${type}" name="${name}" value="${esc(v[name])}" ${required ? "required" : ""} ${extra} />
      ${fe[name] ? `<em class="err">${esc(fe[name])}</em>` : ""}
    </label>`;

  const body = opts.sent
    ? `<div class="card ok">
         <h1>Tack för din ansökan!</h1>
         <p>Vi har tagit emot uppgifterna och återkommer så snart kontot granskats.
            Du får ett mejl när kontot är aktiverat.</p>
       </div>`
    : `<div class="card">
         <h1>Ansök om företagskonto</h1>
         <p class="lead">Handla mot faktura med företagspriser. Fyll i uppgifterna nedan
            så återkommer vi när kontot har granskats.</p>
         ${opts.error ? `<div class="banner">${esc(opts.error)}</div>` : ""}
         <form method="post" action="/b2b/apply" novalidate>
           <h2>Företaget</h2>
           ${field("companyName", "Företagsnamn")}
           ${field("orgNr", "Organisationsnummer", "text", true, 'placeholder="556123-4567"')}
           <h2>Kontaktperson</h2>
           <div class="row">
             ${field("firstName", "Förnamn")}
             ${field("lastName", "Efternamn")}
           </div>
           ${field("email", "E-post", "email")}
           ${field("phone", "Telefon", "tel", false)}
           <h2>Fakturaadress</h2>
           ${field("address1", "Gatuadress")}
           <div class="row">
             ${field("zip", "Postnummer")}
             ${field("city", "Ort")}
           </div>
           <label class="f">
             <span>Land</span>
             <select name="countryCode">
               <option value="SE">Sverige</option>
               <option value="NO">Norge</option>
               <option value="DK">Danmark</option>
               <option value="FI">Finland</option>
             </select>
           </label>
           <label class="f">
             <span>Meddelande (valfritt)</span>
             <textarea name="message" rows="3">${esc(v.message)}</textarea>
           </label>
           <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" />
           <button type="submit">Skicka ansökan</button>
           <p class="fine">Genom att skicka in godkänner du att vi behandlar uppgifterna
              för att bedöma och administrera ditt företagskonto.</p>
         </form>
       </div>`;

  return `<!doctype html><html lang="sv"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ansök om företagskonto</title>
<style>
  :root { --bg:#f6f6f7; --card:#fff; --ink:#1a1a1a; --muted:#6b7177; --line:#d9dbde;
          --accent:#1a1a1a; --err:#b42318; --ok:#067647; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#151719; --card:#1e2124; --ink:#f2f3f4; --muted:#a4abb2; --line:#343a3f;
            --accent:#f2f3f4; --err:#f97066; --ok:#47cd89; }
  }
  * { box-sizing:border-box }
  body { margin:0; padding:32px 16px; background:var(--bg); color:var(--ink);
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif }
  .card { max-width:620px; margin:0 auto; background:var(--card); border:1px solid var(--line);
          border-radius:14px; padding:28px }
  h1 { margin:0 0 6px; font-size:24px; letter-spacing:-.01em }
  h2 { margin:26px 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:.06em;
       color:var(--muted); font-weight:600 }
  .lead { margin:0 0 4px; color:var(--muted) }
  .f { display:block; margin:12px 0 }
  .f > span { display:block; font-size:13px; font-weight:600; margin-bottom:5px }
  .f i { color:var(--err); font-style:normal }
  input, select, textarea { width:100%; padding:10px 12px; font:inherit; color:var(--ink);
    background:var(--bg); border:1px solid var(--line); border-radius:8px }
  input:focus, select:focus, textarea:focus { outline:2px solid var(--accent); outline-offset:1px }
  .row { display:flex; gap:12px } .row .f { flex:1 }
  button { margin-top:22px; width:100%; padding:12px; font:inherit; font-weight:600;
    color:var(--card); background:var(--accent); border:0; border-radius:8px; cursor:pointer }
  .banner { margin:14px 0; padding:10px 12px; border-radius:8px; font-size:14px;
    background:color-mix(in srgb, var(--err) 12%, transparent); color:var(--err) }
  .err { display:block; margin-top:4px; font-size:12.5px; font-style:normal; color:var(--err) }
  .fine { margin:14px 0 0; font-size:12.5px; color:var(--muted) }
  .hp { position:absolute; left:-9999px; width:1px; height:1px }
  .ok h1 { color:var(--ok) }
</style></head><body>${body}</body></html>`;
}
