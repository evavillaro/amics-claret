// Validació al bar / a la porta: cal PIN de personal.
// POST { pin, token }                → estat de l'Amic i avantatges disponibles avui
// POST { pin, token, consumir: codi } → gasta un ús i retorna l'estat actualitzat
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "METODE" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "JSON" }, 400); }

  const pin = String(b.pin ?? "");
  const token = String(b.token ?? "");
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  if (!/^\d{6,10}$/.test(pin)) return json({ error: "PIN" }, 401);
  const { data: p, error: ep } = await db.rpc("entra_pin", { p_pin: pin });
  if (ep) return json({ error: ep.message.includes("BLOQUEJAT") ? "BLOQUEJAT" : "ERROR" }, ep.message.includes("BLOQUEJAT") ? 429 : 500);
  if (!p?.id) return json({ error: "PIN" }, 401);
  // Només comprovar el PIN (pantalla d'entrada del personal)
  if (!token) return json({ personal: p.nom, rol: p.rol });

  if (!/^[0-9a-f]{32}$/.test(token)) return json({ error: "NO_TROBAT" }, 404);
  const { data: a } = await db.from("amics").select("id, num, nom, estat, valid_fins, talla").eq("token", token).maybeSingle();
  if (!a) return json({ error: "NO_TROBAT" }, 404);

  let avis: string | null = null;
  if (b.consumir) {
    const { data: av } = await db.from("avantatges").select("id").eq("codi", String(b.consumir)).eq("actiu", true).maybeSingle();
    if (!av) return json({ error: "AVANTATGE" }, 400);
    const { error } = await db.rpc("consumir", { p_amic: a.id, p_avantatge: av.id, p_personal: p.id });
    if (error) {
      const m = error.message;
      avis = ["CARNET_NO_ACTIU", "AVUI_NO_DISPONIBLE", "LIMIT_ASSOLIT"].find((c) => m.includes(c)) ?? "ERROR";
    }
  }

  const { data: avui } = await db.rpc("avui_bcn");
  const vigent = a.valid_fins && a.valid_fins >= avui;
  const actiu = (a.estat === "actiu" || a.estat === "cancellat") && vigent;

  const { data: avs } = await db.from("avantatges").select("id, codi, nom, tipus, limit_usos").eq("actiu", true).order("ordre");
  const avantatges = [];
  for (const v of avs ?? []) {
    const { data: restants } = await db.rpc("usos_restants", { p_amic: a.id, p_avantatge: v.id });
    avantatges.push({ codi: v.codi, nom: v.nom, tipus: v.tipus, limit: v.limit_usos, restants }); // null = avui no toca
  }

  return json({
    personal: p.nom,
    amic: { num: String(a.num).padStart(4, "0"), nom: a.nom, talla: a.talla, actiu, valid_fins: a.valid_fins },
    avantatges,
    avis,
  });
});
