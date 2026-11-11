# Amics del Bàsquet Claret

Web d'altes, carnet digital i validació dels Amics del Bàsquet Claret.

- `web/` — pàgines estàtiques (landing, carnet, validació). És la carpeta que es publica.
- `supabase/functions/` — funcions del servidor (alta amb Stripe, webhook, carnet, validació, portal).
- `sql/` — esquema de la base de dades.

Secrets necessaris a Supabase (Edge Functions → Secrets): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SITE_URL`.
