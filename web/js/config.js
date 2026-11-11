// Adreça de les funcions del servidor (Supabase del club)
const API = "https://bugaggeqrylgqyuawpwu.supabase.co/functions/v1";
async function crida(nom, opcions) {
  const r = await fetch(`${API}/${nom}`, opcions);
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { ok: r.ok, status: r.status, d };
}
const post = (nom, cos) => crida(nom, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cos) });
const pin = {
  get() { try { return localStorage.getItem("amics_pin") || ""; } catch (_) { return ""; } },
  set(v) { try { localStorage.setItem("amics_pin", v); } catch (_) {} },
  clear() { try { localStorage.removeItem("amics_pin"); } catch (_) {} },
};
