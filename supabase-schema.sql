-- Experimental Science Institution: Notes — Study Circle schema
-- Run in Supabase SQL Editor. This enables opt-in profiles and private one-to-one messages.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[A-Za-z0-9_]{3,24}$'),
  display_name text not null default 'Learner' check (char_length(display_name) between 1 and 40),
  is_listed boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.direct_messages (
  id bigint generated always as identity primary key,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  constraint direct_messages_not_self check (sender_id <> recipient_id)
);
create index if not exists direct_messages_pair_created_idx
  on public.direct_messages (sender_id, recipient_id, created_at);

alter table public.profiles enable row level security;
alter table public.direct_messages enable row level security;

-- Keep privileges narrow; policies below further restrict each row.
revoke all on public.profiles from anon;
revoke all on public.direct_messages from anon;
grant select, insert, update on public.profiles to authenticated;
grant select, insert on public.direct_messages to authenticated;
grant usage, select on sequence public.direct_messages_id_seq to authenticated;

 drop policy if exists "listed profiles visible to signed-in users" on public.profiles;
create policy "listed profiles visible to signed-in users"
  on public.profiles for select to authenticated
  using (is_listed = true or user_id = (select auth.uid()));

drop policy if exists "users create own profile" on public.profiles;
create policy "users create own profile"
  on public.profiles for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile"
  on public.profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "participants read their messages" on public.direct_messages;
create policy "participants read their messages"
  on public.direct_messages for select to authenticated
  using ((select auth.uid()) = sender_id or (select auth.uid()) = recipient_id);

drop policy if exists "senders create messages to listed members" on public.direct_messages;
create policy "senders create messages to listed members"
  on public.direct_messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and recipient_id <> (select auth.uid())
    and exists (
      select 1 from public.profiles p
      where p.user_id = recipient_id and p.is_listed = true
    )
  );

-- Enable Realtime for direct_messages in Supabase Dashboard:
-- Database → Publications → supabase_realtime → add public.direct_messages.
-- Never expose the service_role key in any frontend file.
