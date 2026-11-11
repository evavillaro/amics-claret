// Alta d'un nou Amic: desa les dades i crea la sessió de pagament a Stripe.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const QUOTA_CENTS = 4000;
const TALLES = ["XS", "S", "M", "L", "XL", "XXL"];

// Propera renovació: 1 d'octubre. Qui s'apunta a partir de l'1 de juliol
// ja no paga l'octubre immediat sinó el de l'any següent.
function properaRenovacio(ara = new Date()): number {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "numeric" })
    .formatToParts(ara);
  const any = Number(p.find((x) => x.type === "year")!.value);
  const mes = Number(p.find((x) => x.type === "month")!.value);
  const anyRenov = mes >= 7 ? any + 1 : any;
  return Math.floor(Date.UTC(anyRenov, 9, 1, 8, 0, 0) / 1000);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "METODE" }, 405);

  const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY");
  const SITE_URL = Deno.env.get("SITE_URL");
  if (!STRIPE_KEY || !SITE_URL) return json({ error: "CONFIG_PENDENT" }, 503);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "JSON" }, 400); }

  const nom = String(b.nom ?? "").trim().slice(0, 80);
  const email = String(b.email ?? "").trim().toLowerCase().slice(0, 120);
  const mobil = String(b.mobil ?? "").trim().slice(0, 20) || null;
  const talla = String(b.talla ?? "").trim().toUpperCase();
  if (nom.length < 3) return json({ error: "NOM" }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "EMAIL" }, 400);
  if (!TALLES.includes(talla)) return json({ error: "TALLA" }, 400);
  if (b.accepta !== true) return json({ error: "CONDICIONS" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Si ja és Amic actiu amb aquest correu, no el tornem a cobrar
  const { data: existent } = await db.from("amics").select("id").eq("email", email).eq("estat", "actiu").limit(1);
  if (existent && existent.length) return json({ error: "JA_ES_AMIC" }, 409);

  const { data: amic, error } = await db.from("amics")
    .insert({ nom, email, mobil, talla, accepta_condicions_at: new Date().toISOString() })
    .select("id, token").single();
  if (error || !amic) return json({ error: "DB" }, 500);

  const renov = properaRenovacio();
  const f = new URLSearchParams();
  f.set("mode", "subscription");
  f.set("locale", "ca");
  f.set("customer_email", email);
  f.set("client_reference_id", amic.id);
  f.set("success_url", `${SITE_URL}/carnet.html?t=${amic.token}&nou=1`);
  f.set("cancel_url", `${SITE_URL}/?cancel=1`);
  // 1) quota d'aquesta temporada, es cobra avui
  f.set("line_items[0][quantity]", "1");
  f.set("line_items[0][price_data][currency]", "eur");
  f.set("line_items[0][price_data][unit_amount]", String(QUOTA_CENTS));
  f.set("line_items[0][price_data][product_data][name]", "Amics del Bàsquet Claret · alta");
  // 2) renovació anual automàtica, primer cobrament l'1 d'octubre
  f.set("line_items[1][quantity]", "1");
  f.set("line_items[1][price_data][currency]", "eur");
  f.set("line_items[1][price_data][unit_amount]", String(QUOTA_CENTS));
  f.set("line_items[1][price_data][recurring][interval]", "year");
  f.set("line_items[1][price_data][product_data][name]", "Amics del Bàsquet Claret · quota anual");
  f.set("subscription_data[trial_end]", String(renov));
  f.set("subscription_data[metadata][amic_id]", amic.id);
  f.set("metadata[amic_id]", amic.id);
  f.set("metadata[renovacio]", String(renov));

  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: f,
  });
  const s = await r.json();
  if (!r.ok) {
    console.error("stripe", s?.error?.message);
    return json({ error: "STRIPE" }, 502);
  }
  return json({ url: s.url });
});
