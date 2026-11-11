// Dades del carnet a partir del token secret (enllaç personal i QR).
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const t = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^[0-9a-f]{32}$/.test(t)) return json({ error: "NO_TROBAT" }, 404);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: a } = await db.from("amics").select("num, nom, estat, valid_fins").eq("token", t).maybeSingle();
  if (!a) return json({ error: "NO_TROBAT" }, 404);

  const { data: avui } = await db.rpc("avui_bcn");
  const { data: temporada } = await db.rpc("temporada_de", { d: avui });
  const vigent = a.valid_fins && a.valid_fins >= avui;
  const estat = a.estat === "pendent" ? "pendent"
    : (a.estat === "actiu" || a.estat === "cancellat") && vigent ? "actiu" : "caducat";

  return json({
    num: String(a.num).padStart(4, "0"),
    nom: a.nom,
    estat,
    renovacio_automatica: a.estat === "actiu",
    valid_fins: a.valid_fins,
    temporada,
  });
});
