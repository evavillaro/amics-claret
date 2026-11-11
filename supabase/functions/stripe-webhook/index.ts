// Rep els avisos de Stripe i manté l'estat de cada Amic.
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRACIA_DIES = 7; // "primera setmana d'octubre"

async function signaturaValida(body: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts["t"]; const v1 = parts["v1"];
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  const hex = [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (hex.length !== v1.length) return false;
  let dif = 0;
  for (let i = 0; i < hex.length; i++) dif |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return dif === 0;
}

// Envia el correu amb l'enllaç del carnet (Brevo). Si no hi ha clau configurada, no fa res.
async function enviaCarnet(a: { nom: string; email: string; token: string; num: number }): Promise<boolean> {
  const key = Deno.env.get("BREVO_API_KEY"); const site = Deno.env.get("SITE_URL");
  if (!key || !site) return false;
  const url = `${site}/carnet.html?t=${a.token}`;
  const nom = a.nom.replace(/[<>&"]/g, "");
  const html = `<div style="font-family:Verdana,Arial,sans-serif;max-width:520px;margin:auto;background:#001034;color:#ffffff;padding:28px;border-radius:16px">
<p style="color:#f68f16;font-weight:bold;letter-spacing:1px;margin:0">AMICS DEL BÀSQUET CLARET</p>
<h1 style="font-style:italic;margin:8px 0 16px">Benvingut/da, ${nom}!</h1>
<p>Ja formes part de la família Amics Claret. El teu número d'Amic és el <b style="color:#f68f16">${String(a.num).padStart(4, "0")}</b>.</p>
<p>Aquest és el teu carnet digital. Ensenya'l al bar i a la Festa dels Amics:</p>
<p style="text-align:center;margin:26px 0"><a href="${url}" style="background:#f68f16;color:#1a0d00;font-weight:bold;text-decoration:none;padding:14px 26px;border-radius:10px;display:inline-block">Obre el meu carnet</a></p>
<p style="font-size:13px;color:#c5d4f5">Guarda aquest correu: l'enllaç és personal i no s'ha de compartir. Des del carnet pots gestionar la renovació de la quota quan vulguis.</p>
<p style="color:#f68f16;font-style:italic;font-weight:bold;text-align:center;font-size:18px;margin:22px 0 0">Amics que sumen.</p></div>`;
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": key, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: "Amics del Bàsquet Claret", email: Deno.env.get("EMAIL_FROM") ?? "amicsclaret@gmail.com" },
      to: [{ email: a.email, name: a.nom }],
      subject: "El teu carnet d'Amic del Bàsquet Claret",
      htmlContent: html,
    }),
  });
  if (!r.ok) console.error("brevo", r.status, (await r.text()).slice(0, 200));
  return r.ok;
}

const dataMes = (unix: number, dies = 0) =>
  new Date((unix + dies * 86400) * 1000).toISOString().slice(0, 10);

Deno.serve(async (req) => {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return new Response("config", { status: 503 });
  const body = await req.text();
  if (!(await signaturaValida(body, req.headers.get("stripe-signature"), secret))) {
    return new Response("signatura", { status: 400 });
  }
  const ev = JSON.parse(body);
  const o = ev.data.object;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  if (ev.type === "checkout.session.completed" && o.payment_status === "paid") {
    const amicId = o.metadata?.amic_id ?? o.client_reference_id;
    const renov = Number(o.metadata?.renovacio);
    if (amicId && renov) {
      // Només la primera vegada (estat 'pendent'): així un reintent de Stripe no reenvia el correu
      const { data: fets, error } = await db.from("amics").update({
        estat: "actiu",
        valid_fins: dataMes(renov, GRACIA_DIES),
        stripe_customer_id: o.customer,
        stripe_subscription_id: o.subscription,
      }).eq("id", amicId).eq("estat", "pendent").select("nom, email, token, num");
      if (error) { console.error(error.message); return new Response("db", { status: 500 }); }
      if (fets?.length) await enviaCarnet(fets[0]).catch((e) => console.error("correu", String(e)));
    }
  } else if (ev.type === "invoice.paid" && o.billing_reason === "subscription_cycle") {
    const sub = o.subscription ?? o.parent?.subscription_details?.subscription;
    const fi = o.lines?.data?.[0]?.period?.end;
    if (sub && fi) {
      const { error } = await db.from("amics")
        .update({ estat: "actiu", valid_fins: dataMes(fi, GRACIA_DIES) })
        .eq("stripe_subscription_id", sub);
      if (error) { console.error(error.message); return new Response("db", { status: 500 }); }
    }
  } else if (ev.type === "customer.subscription.deleted") {
    // Baixa: conserva el carnet fins a valid_fins, però ja no es renova
    const { error } = await db.from("amics").update({ estat: "cancellat" }).eq("stripe_subscription_id", o.id);
    if (error) { console.error(error.message); return new Response("db", { status: 500 }); }
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});
