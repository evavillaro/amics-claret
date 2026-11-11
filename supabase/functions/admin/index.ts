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
  } else if (accio !== "llista") {
    return json({ error: "ACCIO" }, 400);
  }

  // Sempre retorna l'estat complet actualitzat
  const { data: avui } = await db.rpc("avui_bcn");
  const { data: avantatges } = await db.from("avantatges")
    .select("id, codi, nom, descripcio, icona, tipus, limit_usos, actiu, ordre").order("ordre").order("nom");
  const { data: dies } = await db.from("dies_marcats").select("avantatge_id, dia, nota").gte("dia", avui).order("dia");
  const { data: amics } = await db.from("amics")
    .select("id, num, nom, email, mobil, talla, estat, valid_fins, created_at").neq("estat", "pendent").order("num");
  const unics = (avantatges ?? []).filter((a) => a.tipus === "unic").map((a) => a.id);
  const { data: usos } = unics.length
    ? await db.from("usos").select("amic_id, avantatge_id, dia").in("avantatge_id", unics)
    : { data: [] };

  return json({ admin: p.nom, avui, avantatges, dies, amics, usos });
});
