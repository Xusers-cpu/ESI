-- Experimental Science Institution: Notes — Study Circle schema
-- Run in Supabase SQL Editor. Safe to re-run: it creates what is missing and updates what exists.
-- Enables opt-in profiles, private one-to-one messages, unread tracking (read receipts),
-- live message delivery, and the "is typing…" indicator.

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

-- NEW: when the recipient opened the message (null = unread).
alter table public.direct_messages add column if not exists read_at timestamptz;

create index if not exists direct_messages_pair_created_idx
  on public.direct_messages (sender_id, recipient_id, created_at);
-- NEW: fast "how many unread do I have, and from whom?" lookups.
create index if not exists direct_messages_unread_idx
  on public.direct_messages (recipient_id, sender_id) where read_at is null;

alter table public.profiles enable row level security;
alter table public.direct_messages enable row level security;

-- Keep privileges narrow; policies below further restrict each row.
revoke all on public.profiles from anon;
revoke all on public.direct_messages from anon;
grant select, insert, update on public.profiles to authenticated;
grant select, insert on public.direct_messages to authenticated;
-- NEW: recipients may change ONLY the read_at column (never the text or sender).
grant update (read_at) on public.direct_messages to authenticated;
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

-- NEW: only the recipient can mark a message as read.
drop policy if exists "recipients mark messages read" on public.direct_messages;
create policy "recipients mark messages read"
  on public.direct_messages for update to authenticated
  using (recipient_id = (select auth.uid()))
  with check (recipient_id = (select auth.uid()));

-- Live delivery: add direct_messages to the Realtime publication
-- (no dashboard clicking needed; ignored if it is already added).
do $$
begin
  alter publication supabase_realtime add table public.direct_messages;
exception when duplicate_object then null;
end $$;

-- NEW: "is typing…" uses Realtime Broadcast on private channels named
-- esi-typing-<userIdA>-<userIdB>. These policies let a signed-in user join
-- only channels whose name contains their own user id, i.e. their own chats.
drop policy if exists "chat partners receive typing" on realtime.messages;
create policy "chat partners receive typing"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() like 'esi-typing-%'
    and position((select auth.uid())::text in realtime.topic()) > 0
  );

drop policy if exists "chat partners send typing" on realtime.messages;
create policy "chat partners send typing"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() like 'esi-typing-%'
    and position((select auth.uid())::text in realtime.topic()) > 0
  );

-- Never expose the service_role key in any frontend file.
