// Obre el portal de Stripe perquè l'Amic gestioni o cancel·li la renovació.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "METODE" }, 405);
  const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY");
  const SITE_URL = Deno.env.get("SITE_URL");
  if (!STRIPE_KEY || !SITE_URL) return json({ error: "CONFIG_PENDENT" }, 503);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "JSON" }, 400); }
  const token = String(b.token ?? "");
  if (!/^[0-9a-f]{32}$/.test(token)) return json({ error: "NO_TROBAT" }, 404);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: a } = await db.from("amics").select("stripe_customer_id").eq("token", token).maybeSingle();
  if (!a?.stripe_customer_id) return json({ error: "NO_TROBAT" }, 404);

  const f = new URLSearchParams();
  f.set("customer", a.stripe_customer_id);
  f.set("return_url", `${SITE_URL}/carnet.html?t=${token}`);
  f.set("locale", "ca");
  const r = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: f,
  });
  const s = await r.json();
  if (!r.ok) { console.error("stripe", s?.error?.message); return json({ error: "STRIPE" }, 502); }
  return json({ url: s.url });
});
