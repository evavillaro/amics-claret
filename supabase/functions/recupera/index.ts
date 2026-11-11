// Reenvia l'enllaç del carnet al correu d'un Amic. Sempre respon igual, existeixi o no el correu.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// Envia el correu amb l'enllaç del carnet (Resend o Brevo).
async function enviaCarnet(a: { nom: string; email: string; token: string; num: number }): Promise<boolean> {
  const resend = Deno.env.get("RESEND_API_KEY"); const brevo = Deno.env.get("BREVO_API_KEY");
  const site = Deno.env.get("SITE_URL");
  const from = Deno.env.get("EMAIL_FROM") ?? "amicsclaret@gmail.com";
  if ((!resend && !brevo) || !site) { console.error("correu: falta RESEND_API_KEY o BREVO_API_KEY"); return false; }
  const url = `${site}/carnet.html?t=${a.token}`;
  const nom = a.nom.replace(/[<>&"]/g, "");
  const html = `<div style="font-family:Verdana,Arial,sans-serif;max-width:520px;margin:auto;background:#001034;color:#ffffff;padding:28px;border-radius:16px">
<p style="color:#f68f16;font-weight:bold;letter-spacing:1px;margin:0">AMICS DEL BÀSQUET CLARET</p>
<h1 style="font-style:italic;margin:8px 0 16px">Benvingut/da, ${nom}!</h1>
<p>Ja formes part de la família Amics Claret. El teu número d'Amic és el <b style="color:#f68f16">${String(a.num).padStart(4, "0")}</b>.</p>
<p>Aquest és el teu carnet digital. Ensenya'l al bar i a la Festa dels Amics:</p>
<p style="text-align:center;margin:26px 0"><a href="${url}" style="background:#f68f16;color:#1a0d00;font-weight:bold;text-decoration:none;padding:14px 26px;border-radius:10px;display:inline-block">Obre el meu carnet</a></p>
<p style="font-size:13px;color:#c5d4f5">Guarda aquest correu: l'enllaç és personal i no s'ha de compartir.</p>
<p style="color:#f68f16;font-style:italic;font-weight:bold;text-align:center;font-size:18px;margin:22px 0 0">Amics que sumen.</p></div>`;
  const subject = "El teu carnet d'Amic del Bàsquet Claret";
  // Resend (domini propi verificat) si hi ha clau; si no, Brevo (permet enviar des d'un Gmail verificat)
  const r = resend
    ? await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resend}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `Amics del Bàsquet Claret <${from}>`, to: [a.email], subject, html }),
      })
    : await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": brevo!, "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: { name: "Amics del Bàsquet Claret", email: from },
          to: [{ email: a.email, name: a.nom }], subject, htmlContent: html,
        }),
      });
  if (!r.ok) console.error("correu", resend ? "resend" : "brevo", r.status, (await r.text()).slice(0, 300));
  return r.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "METODE" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "JSON" }, 400); }
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "EMAIL" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data } = await db.from("amics").select("nom, email, token, num")
    .eq("email", email).in("estat", ["actiu", "cancellat"]).order("num", { ascending: false }).limit(1);
  if (data?.length) await enviaCarnet(data[0]).catch((e) => console.error("correu", String(e)));
  return json({ ok: true });
});
