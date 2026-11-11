// Panell del club. Cal PIN d'un membre del personal amb rol 'admin'.
// POST { pin, accio, ... }
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const TIPUS = ["per_dia", "per_temporada", "unic"];
const esData = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "METODE" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "JSON" }, 400); }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const pin = String(b.pin ?? "");
  if (!/^\d{6,10}$/.test(pin)) return json({ error: "PIN" }, 401);
  const { data: p, error: ep } = await db.rpc("entra_pin", { p_pin: pin });
  if (ep) return json({ error: ep.message.includes("BLOQUEJAT") ? "BLOQUEJAT" : "ERROR" }, ep.message.includes("BLOQUEJAT") ? 429 : 500);
  if (!p?.id || p.rol !== "admin") return json({ error: "PIN" }, 401);

  const accio = String(b.accio ?? "llista");

  if (accio === "desa_avantatge") {
    const nom = String(b.nom ?? "").trim().slice(0, 60);
    const tipus = String(b.tipus ?? "");
    const limit = Number(b.limit_usos);
    if (nom.length < 2) return json({ error: "NOM" }, 400);
    if (!TIPUS.includes(tipus)) return json({ error: "TIPUS" }, 400);
    if (!Number.isInteger(limit) || limit < 1 || limit > 99) return json({ error: "LIMIT" }, 400);
    const fila = {
      nom, tipus, limit_usos: limit,
      descripcio: String(b.descripcio ?? "").trim().slice(0, 160),
      icona: String(b.icona ?? "").trim().slice(0, 8) || "⭐",
      actiu: b.actiu !== false,
      ordre: Number.isInteger(Number(b.ordre)) ? Number(b.ordre) : 99,
    };
    if (b.id) {
      const { error } = await db.from("avantatges").update(fila).eq("id", String(b.id));
      if (error) return json({ error: "DB" }, 500);
    } else {
      const codi = "av_" + crypto.randomUUID().slice(0, 8);
      const { error } = await db.from("avantatges").insert({ ...fila, codi });
      if (error) return json({ error: "DB" }, 500);
    }
  } else if (accio === "afegeix_dia") {
    if (!esData(b.dia)) return json({ error: "DIA" }, 400);
    const { error } = await db.from("dies_marcats").upsert({
      avantatge_id: String(b.avantatge_id), dia: b.dia, nota: String(b.nota ?? "").trim().slice(0, 80) || null,
    });
    if (error) return json({ error: "DB" }, 500);
  } else if (accio === "treu_dia") {
    if (!esData(b.dia)) return json({ error: "DIA" }, 400);
    const { error } = await db.from("dies_marcats").delete().eq("avantatge_id", String(b.avantatge_id)).eq("dia", b.dia);
    if (error) return json({ error: "DB" }, 500);
  } else if (accio === "marca_us" || accio === "desmarca_us") {
    // Marca (o desfà) un avantatge d'un sol cop per a un Amic: p. ex. samarreta lliurada
    const { data: av } = await db.from("avantatges").select("id, tipus").eq("id", String(b.avantatge_id)).maybeSingle();
    if (!av || av.tipus !== "unic") return json({ error: "AVANTATGE" }, 400);
    if (accio === "marca_us") {
      const { data: ja } = await db.from("usos").select("id").eq("amic_id", String(b.amic_id)).eq("avantatge_id", av.id).limit(1);
      if (!ja?.length) {
        const { data: avui } = await db.rpc("avui_bcn");
        const { data: temporada } = await db.rpc("temporada_de", { d: avui });
        const { error } = await db.from("usos").insert({ amic_id: String(b.amic_id), avantatge_id: av.id, dia: avui, temporada, personal_id: p.id });
        if (error) return json({ error: "DB" }, 500);
      }
    } else {
      const { error } = await db.from("usos").delete().eq("amic_id", String(b.amic_id)).eq("avantatge_id", av.id);
      if (error) return json({ error: "DB" }, 500);
    }
  } else if (accio === "crea_amic") {
    // Alta manual (regal, pagament en mà...): actiu sense renovació fins a la data indicada. No passa per Stripe.
    const nom = String(b.nom ?? "").trim().slice(0, 80);
    const email = String(b.email ?? "").trim().toLowerCase().slice(0, 120);
    const talla = String(b.talla ?? "").trim().toUpperCase();
    if (nom.length < 3) return json({ error: "NOM" }, 400);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "EMAIL" }, 400);
    if (!esData(b.valid_fins)) return json({ error: "DIA" }, 400);
    const { error } = await db.from("amics").insert({
      nom, email, mobil: String(b.mobil ?? "").trim().slice(0, 20) || null,
      talla: ["XS", "S", "M", "L", "XL", "XXL"].includes(talla) ? talla : null,
      estat: "cancellat", valid_fins: b.valid_fins,
    });
    if (error) return json({ error: "DB" }, 500);
    if (email && b.envia_correu === true) {
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/recupera`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
      }).catch((e) => console.error("correu", String(e)));
    }
  } else if (["atura_renovacio", "baixa", "valid_fins", "esborra"].includes(accio)) {
    // Gestió d'un Amic. Si té subscripció a Stripe, primer s'hi aplica el canvi: si Stripe falla, no es toca res.
    const { data: am } = await db.from("amics").select("id, estat, stripe_subscription_id").eq("id", String(b.amic_id)).maybeSingle();
    if (!am) return json({ error: "AMIC" }, 404);
    const key = Deno.env.get("STRIPE_SECRET_KEY");
    const stripe = async (method: string, cos?: URLSearchParams) => {
      if (!am.stripe_subscription_id) return true;
      if (!key) return false;
      const r = await fetch(`https://api.stripe.com/v1/subscriptions/${am.stripe_subscription_id}`, {
        method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" }, body: cos,
      });
      if (r.ok || r.status === 404) return true; // 404: ja no existeix a Stripe
      const e = await r.json().catch(() => ({}));
      if (e?.error?.code === "resource_missing") return true;
      console.error("stripe admin", r.status, e?.error?.message);
      return false;
    };
    const { data: avui } = await db.rpc("avui_bcn");

    if (accio === "atura_renovacio") {
      if (!(await stripe("POST", new URLSearchParams({ cancel_at_period_end: "true" })))) return json({ error: "STRIPE" }, 502);
      const { error } = await db.from("amics").update({ estat: "cancellat" }).eq("id", am.id);
      if (error) return json({ error: "DB" }, 500);
    } else if (accio === "baixa") {
      // Baixa immediata: cancel·la la subscripció i el carnet caduca avui mateix
      if (!(await stripe("DELETE"))) return json({ error: "STRIPE" }, 502);
      const ahir = new Date(new Date(avui + "T12:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
      const { error } = await db.from("amics").update({ estat: "caducat", valid_fins: ahir }).eq("id", am.id);
      if (error) return json({ error: "DB" }, 500);
    } else if (accio === "valid_fins") {
      if (!esData(b.valid_fins)) return json({ error: "DIA" }, 400);
      // Manté la renovació si en té; si no, queda actiu sense renovació fins a la data indicada
      const estat = am.estat === "actiu" && am.stripe_subscription_id ? "actiu" : "cancellat";
      const { error } = await db.from("amics").update({ valid_fins: b.valid_fins, estat }).eq("id", am.id);
      if (error) return json({ error: "DB" }, 500);
    } else {
      // Esborra l'Amic i tots els seus registres. No es pot desfer.
      if (!(await stripe("DELETE"))) return json({ error: "STRIPE" }, 502);
      const { error } = await db.from("amics").delete().eq("id", am.id);
      if (error) return json({ error: "DB" }, 500);
    }
  } else if (accio !== "llista") {
    return json({ error: "ACCIO" }, 400);
  }

  // Sempre retorna l'estat complet actualitzat
  const { data: avui } = await db.rpc("avui_bcn");
  const { data: avantatges } = await db.from("avantatges")
    .select("id, codi, nom, descripcio, icona, tipus, limit_usos, actiu, ordre").order("ordre").order("nom");
  const { data: dies } = await db.from("dies_marcats").select("avantatge_id, dia, nota").gte("dia", avui).order("dia");
  const { data: amics } = await db.from("amics")
    .select("id, num, nom, email, mobil, talla, estat, valid_fins, created_at, token, stripe_subscription_id").neq("estat", "pendent").order("num");
  const amicsNet = (amics ?? []).map(({ stripe_subscription_id, ...a }) => ({ ...a, te_subscripcio: !!stripe_subscription_id }));
  const unics = (avantatges ?? []).filter((a) => a.tipus === "unic").map((a) => a.id);
  const { data: usos } = unics.length
    ? await db.from("usos").select("amic_id, avantatge_id, dia").in("avantatge_id", unics)
    : { data: [] };

  return json({ admin: p.nom, avui, avantatges, dies, amics: amicsNet, usos });
});
