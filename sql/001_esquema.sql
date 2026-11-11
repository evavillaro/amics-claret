-- Amics del Bàsquet Claret · esquema inicial
-- Tot l'accés passa per les Edge Functions (service role). RLS activat sense polítiques
-- públiques: ningú pot llegir ni escriure directament amb la clau pública.

create extension if not exists pgcrypto;

-- ───────── Amics ─────────
create sequence if not exists amics_num_seq start 1;

create table amics (
  id                     uuid primary key default gen_random_uuid(),
  num                    integer unique not null default nextval('amics_num_seq'),
  nom                    text not null,
  email                  text not null,
  mobil                  text,
  talla                  text,
  -- token secret del carnet (va dins l'enllaç i el QR); no es pot endevinar
  token                  text unique not null default encode(gen_random_bytes(16), 'hex'),
  estat                  text not null default 'pendent'
                         check (estat in ('pendent', 'actiu', 'caducat', 'cancellat')),
  valid_fins             date,
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  accepta_condicions_at  timestamptz,
  created_at             timestamptz not null default now()
);
create index amics_email_idx on amics (lower(email));

-- ───────── Avantatges (configurables pel club) ─────────
-- tipus: 'per_dia'       → límit per cada dia marcat (p. ex. 2 cerveses)
--        'per_temporada' → límit per temporada (p. ex. 1 entrada a la festa)
--        'unic'          → un sol cop per alta (p. ex. samarreta)
create table avantatges (
  id         uuid primary key default gen_random_uuid(),
  codi       text unique not null,
  nom        text not null,
  tipus      text not null check (tipus in ('per_dia', 'per_temporada', 'unic')),
  limit_usos integer not null default 1 check (limit_usos > 0),
  actiu      boolean not null default true,
  ordre      integer not null default 0
);

insert into avantatges (codi, nom, tipus, limit_usos, ordre) values
  ('cervesa',   'Cervesa gratis',       'per_dia',       2, 1),
  ('festa',     'Festa dels Amics',     'per_temporada', 1, 2),
  ('samarreta', 'Samarreta de benvinguda', 'unic',       1, 3);

-- Dies en què un avantatge 'per_dia' està disponible
create table dies_marcats (
  avantatge_id uuid not null references avantatges (id) on delete cascade,
  dia          date not null,
  nota         text,
  primary key (avantatge_id, dia)
);

-- ───────── Personal (bar, porta, junta) ─────────
create table personal (
  id         uuid primary key default gen_random_uuid(),
  nom        text not null,
  pin_hash   text not null,          -- crypt(pin, gen_salt('bf'))
  rol        text not null default 'bar' check (rol in ('bar', 'admin')),
  actiu      boolean not null default true,
  created_at timestamptz not null default now()
);

-- ───────── Usos ─────────
create table usos (
  id           bigint generated always as identity primary key,
  amic_id      uuid not null references amics (id) on delete cascade,
  avantatge_id uuid not null references avantatges (id),
  dia          date not null,
  temporada    text not null,
  personal_id  uuid references personal (id),
  created_at   timestamptz not null default now()
);
create index usos_amic_idx on usos (amic_id, avantatge_id, dia);

-- ───────── RLS ─────────
alter table amics        enable row level security;
alter table avantatges   enable row level security;
alter table dies_marcats enable row level security;
alter table personal     enable row level security;
alter table usos         enable row level security;

-- ───────── Funcions ─────────
-- Temporada d'una data: d'octubre a setembre → '2026-2027'
create or replace function temporada_de(d date) returns text
language sql immutable set search_path = public as $$
  select case when extract(month from d) >= 10
    then extract(year from d)::int || '-' || (extract(year from d)::int + 1)
    else (extract(year from d)::int - 1) || '-' || extract(year from d)::int end;
$$;

create or replace function avui_bcn() returns date
language sql stable set search_path = public as $$
  select (now() at time zone 'Europe/Madrid')::date;
$$;

-- Quants usos li queden avui a un amic d'un avantatge (null = avui no està disponible)
create or replace function usos_restants(p_amic uuid, p_avantatge uuid) returns integer
language plpgsql stable set search_path = public as $$
declare
  a avantatges; fets integer; avui date := avui_bcn();
begin
  select * into a from avantatges where id = p_avantatge and actiu;
  if not found then return null; end if;

  if a.tipus = 'per_dia' then
    if not exists (select 1 from dies_marcats where avantatge_id = a.id and dia = avui) then
      return null;
    end if;
    select count(*) into fets from usos where amic_id = p_amic and avantatge_id = a.id and dia = avui;
  elsif a.tipus = 'per_temporada' then
    select count(*) into fets from usos
      where amic_id = p_amic and avantatge_id = a.id and temporada = temporada_de(avui);
  else
    select count(*) into fets from usos where amic_id = p_amic and avantatge_id = a.id;
  end if;

  return greatest(a.limit_usos - fets, 0);
end $$;

-- Gasta un ús de manera atòmica. Retorna els que queden després, o error.
create or replace function consumir(p_amic uuid, p_avantatge uuid, p_personal uuid)
returns integer
language plpgsql set search_path = public as $$
declare
  am amics; queden integer; avui date := avui_bcn();
begin
  -- bloqueig per amic: evita dobles escanejos simultanis
  select * into am from amics where id = p_amic for update;
  if not found then raise exception 'AMIC_NO_TROBAT'; end if;
  if am.estat not in ('actiu', 'cancellat') or am.valid_fins is null or am.valid_fins < avui then
    raise exception 'CARNET_NO_ACTIU';
  end if;

  queden := usos_restants(p_amic, p_avantatge);
  if queden is null then raise exception 'AVUI_NO_DISPONIBLE'; end if;
  if queden <= 0 then raise exception 'LIMIT_ASSOLIT'; end if;

  insert into usos (amic_id, avantatge_id, dia, temporada, personal_id)
  values (p_amic, p_avantatge, avui, temporada_de(avui), p_personal);

  return queden - 1;
end $$;

-- Comprova el PIN del personal
create or replace function personal_per_pin(p_pin text) returns personal
language sql stable set search_path = public, extensions as $$
  select * from personal where actiu and pin_hash = crypt(p_pin, pin_hash) limit 1;
$$;

-- Aquestes funcions només les ha de cridar el backend
revoke execute on function usos_restants(uuid, uuid)   from public, anon, authenticated;
revoke execute on function consumir(uuid, uuid, uuid)  from public, anon, authenticated;
revoke execute on function personal_per_pin(text)      from public, anon, authenticated;

-- ───────── Panell i límit d'intents de PIN ─────────
alter table avantatges add column descripcio text not null default '', add column icona text not null default '⭐';

create table intents_pin (created_at timestamptz not null default now());
create index intents_pin_idx on intents_pin (created_at);
alter table intents_pin enable row level security;

create or replace function entra_pin(p_pin text) returns personal
language plpgsql set search_path = public, extensions as $$
declare p personal;
begin
  if (select count(*) from intents_pin where created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'BLOQUEJAT';
  end if;
  select * into p from personal where actiu and pin_hash = crypt(p_pin, pin_hash) limit 1;
  if p.id is null then
    insert into intents_pin default values;
    delete from intents_pin where created_at < now() - interval '1 day';
  end if;
  return p;
end $$;
revoke execute on function entra_pin(text) from public, anon, authenticated;
