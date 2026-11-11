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

// El correu de benvinguda l'envia la funció 'recupera' (un sol lloc on viu el codi de correu)
async function enviaCarnet(a: { email: string }): Promise<void> {
  await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/recupera`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: a.email }),
  });
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
        // Subscripció (targeta) → es renova sola. Pagament únic (Bizum) → actiu sense renovació.
        estat: o.mode === "subscription" ? "actiu" : "cancellat",
        valid_fins: dataMes(renov, GRACIA_DIES),
        stripe_customer_id: o.customer ?? null,
        stripe_subscription_id: o.subscription ?? null,
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
  } else if (ev.type === "customer.subscription.updated") {
    // Cancel·lació des del portal: la subscripció segueix viva fins al final del període, però ja no es renovarà.
    // Si l'Amic es repensa i la reactiva, torna a 'actiu'.
    const esCancella = o.cancel_at_period_end === true || o.cancel_at != null;
    const viva = o.status === "active" || o.status === "trialing";
    if (viva) {
      const { error } = await db.from("amics")
        .update({ estat: esCancella ? "cancellat" : "actiu" })
        .eq("stripe_subscription_id", o.id).in("estat", ["actiu", "cancellat"]);
      if (error) { console.error(error.message); return new Response("db", { status: 500 }); }
    }
  } else if (ev.type === "customer.subscription.deleted") {
    // Baixa: conserva el carnet fins a valid_fins, però ja no es renova
    const { error } = await db.from("amics").update({ estat: "cancellat" }).eq("stripe_subscription_id", o.id);
    if (error) { console.error(error.message); return new Response("db", { status: 500 }); }
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});
