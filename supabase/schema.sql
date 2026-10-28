-- SIGI database schema. Paste into Supabase: SQL Editor → New query → Run.
-- Each person can only see and change their own rows (row-level security).

create table if not exists public.watch_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('product', 'car')),
  label       text not null check (char_length(label) between 1 and 200),
  q           text,
  make        text,
  model       text,
  year        text,
  added       date not null default current_date,
  created_at  timestamptz not null default now()
);
create unique index if not exists watch_items_user_label on public.watch_items (user_id, lower(label));

create table if not exists public.checks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('product', 'car')),
  label       text not null check (char_length(label) between 1 and 200),
  q           text,
  make        text,
  model       text,
  year        text,
  verdict     text check (verdict in ('get', 'check', 'skip', 'none')),
  at          timestamptz not null default now()
);
create index if not exists checks_user_at on public.checks (user_id, at desc);

alter table public.watch_items enable row level security;
alter table public.checks      enable row level security;

drop policy if exists "own watch items" on public.watch_items;
create policy "own watch items" on public.watch_items
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "own checks" on public.checks;
create policy "own checks" on public.checks
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Keep only the 30 most recent checks per person.
create or replace function public.trim_checks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.checks
  where user_id = new.user_id
    and id not in (select id from public.checks where user_id = new.user_id order by at desc limit 30);
  return null;
end $$;

drop trigger if exists checks_trim on public.checks;
create trigger checks_trim after insert on public.checks
  for each row execute function public.trim_checks();
