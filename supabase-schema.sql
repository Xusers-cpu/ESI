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

-- =====================================================================
-- NEW: GROUP CHATS (WhatsApp-style)
-- Anyone in the directory can create a group, add other directory members,
-- and chat. Admins can rename the group and add/remove members; anyone can
-- leave. New members only see messages sent after they joined.
-- Clients never write groups/memberships directly: they call the functions
-- below, which check permissions on the server.
-- =====================================================================

create table if not exists public.groups (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 40),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id bigint not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists group_members_user_idx on public.group_members (user_id);

create table if not exists public.group_messages (
  id bigint generated always as identity primary key,
  group_id bigint not null references public.groups(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  sender_name text,                      -- filled in by a trigger, so names survive people leaving
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists group_messages_group_created_idx
  on public.group_messages (group_id, created_at);

alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_messages enable row level security;

-- Permission helpers. SECURITY DEFINER avoids recursive row-level-security
-- checks; each one only ever answers about the signed-in user.
create or replace function public.is_group_member(p_group bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group and user_id = (select auth.uid())
  );
$$;

create or replace function public.is_group_admin(p_group bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group and user_id = (select auth.uid()) and role = 'admin'
  );
$$;

-- A member can read a message only if they had joined by the time it was sent.
create or replace function public.can_read_group_message(p_group bigint, p_sent timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group and user_id = (select auth.uid()) and joined_at <= p_sent
  );
$$;

-- Used by the typing-indicator policy: topic must look like esi-gtyping-<groupId>.
create or replace function public.is_group_topic_member(p_topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when p_topic ~ '^esi-gtyping-[0-9]{1,18}$'
      then public.is_group_member(substr(p_topic, 13)::bigint)
    else false
  end;
$$;

-- Save the sender's name on each message.
create or replace function public.set_group_sender_name()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.sender_name := coalesce(
    (select coalesce(nullif(p.display_name, ''), p.username) from public.profiles p where p.user_id = new.sender_id),
    'Member');
  return new;
end;
$$;
drop trigger if exists group_messages_sender_name on public.group_messages;
create trigger group_messages_sender_name
  before insert on public.group_messages
  for each row execute function public.set_group_sender_name();

-- Privileges (RLS policies below narrow them further).
revoke all on public.groups from anon;
revoke all on public.group_members from anon;
revoke all on public.group_messages from anon;
grant select on public.groups to authenticated;
grant update (name) on public.groups to authenticated;                 -- rename (admins only, see policy)
grant select on public.group_members to authenticated;
grant update (last_read_at) on public.group_members to authenticated;  -- "I have read up to here"
grant select, insert on public.group_messages to authenticated;
grant usage, select on sequence public.group_messages_id_seq to authenticated;

drop policy if exists "members see their groups" on public.groups;
create policy "members see their groups"
  on public.groups for select to authenticated
  using (public.is_group_member(id));

drop policy if exists "admins rename groups" on public.groups;
create policy "admins rename groups"
  on public.groups for update to authenticated
  using (public.is_group_admin(id))
  with check (public.is_group_admin(id));

drop policy if exists "members see fellow members" on public.group_members;
create policy "members see fellow members"
  on public.group_members for select to authenticated
  using (public.is_group_member(group_id));

drop policy if exists "members update own read marker" on public.group_members;
create policy "members update own read marker"
  on public.group_members for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "members read group messages" on public.group_messages;
create policy "members read group messages"
  on public.group_messages for select to authenticated
  using (public.can_read_group_message(group_id, created_at));

drop policy if exists "members send group messages" on public.group_messages;
create policy "members send group messages"
  on public.group_messages for insert to authenticated
  with check (sender_id = (select auth.uid()) and public.is_group_member(group_id));

-- Create a group: you become its admin; the others must be directory members.
create or replace function public.create_group(p_name text, p_members uuid[])
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  gid bigint;
  ids uuid[];
begin
  if me is null then raise exception 'Please sign in first'; end if;
  p_name := btrim(coalesce(p_name, ''));
  if char_length(p_name) not between 1 and 40 then
    raise exception 'Group name must be 1 to 40 characters';
  end if;
  if not exists (select 1 from public.profiles where user_id = me) then
    raise exception 'Finish your community profile first';
  end if;
  select coalesce(array_agg(distinct t.u), '{}'::uuid[]) into ids
    from unnest(p_members) as t(u)
    where t.u <> me
      and exists (select 1 from public.profiles p where p.user_id = t.u and p.is_listed);
  if cardinality(ids) > 49 then raise exception 'A group can have at most 50 members'; end if;
  insert into public.groups (name, created_by) values (p_name, me) returning id into gid;
  insert into public.group_members (group_id, user_id, role) values (gid, me, 'admin');
  insert into public.group_members (group_id, user_id) select gid, u from unnest(ids) as u;
  return gid;
end;
$$;

create or replace function public.add_group_members(p_group bigint, p_members uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  ids uuid[];
  cur int;
begin
  if not public.is_group_admin(p_group) then raise exception 'Only group admins can add members'; end if;
  select coalesce(array_agg(distinct t.u), '{}'::uuid[]) into ids
    from unnest(p_members) as t(u)
    where exists (select 1 from public.profiles p where p.user_id = t.u and p.is_listed)
      and not exists (select 1 from public.group_members gm where gm.group_id = p_group and gm.user_id = t.u);
  select count(*) into cur from public.group_members where group_id = p_group;
  if cur + cardinality(ids) > 50 then raise exception 'A group can have at most 50 members'; end if;
  insert into public.group_members (group_id, user_id) select p_group, u from unnest(ids) as u;
end;
$$;

create or replace function public.remove_group_member(p_group bigint, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_group_admin(p_group) then raise exception 'Only group admins can remove members'; end if;
  if p_user = (select auth.uid()) then raise exception 'Use "Leave group" to leave'; end if;
  delete from public.group_members
    where group_id = p_group and user_id = p_user and role <> 'admin';
end;
$$;

-- Leave a group. If no admin is left the longest-standing member becomes admin;
-- if nobody is left the group is deleted.
create or replace function public.leave_group(p_group bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  next_admin uuid;
begin
  delete from public.group_members where group_id = p_group and user_id = me;
  if not found then return; end if;
  if not exists (select 1 from public.group_members where group_id = p_group) then
    delete from public.groups where id = p_group;
  elsif not exists (select 1 from public.group_members where group_id = p_group and role = 'admin') then
    select gm.user_id into next_admin from public.group_members gm
      where gm.group_id = p_group order by gm.joined_at, gm.user_id limit 1;
    update public.group_members set role = 'admin'
      where group_id = p_group and user_id = next_admin;
  end if;
end;
$$;

-- Member list with names (so people who later unlist themselves still show up).
create or replace function public.get_group_members(p_group bigint)
returns table (user_id uuid, username text, display_name text, role text, joined_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_group_member(p_group) then raise exception 'Not a member of this group'; end if;
  return query
    select gm.user_id, coalesce(p.username, 'member'), coalesce(p.display_name, p.username, 'Member'), gm.role, gm.joined_at
    from public.group_members gm
    left join public.profiles p on p.user_id = gm.user_id
    where gm.group_id = p_group
    order by (gm.role = 'admin') desc, p.username;
end;
$$;

-- Unread messages per group (runs with your own permissions).
create or replace function public.group_unread_counts()
returns table (group_id bigint, unread bigint)
language sql stable security invoker set search_path = '' as $$
  select m.group_id, count(*)::bigint
  from public.group_members gm
  join public.group_messages m
    on m.group_id = gm.group_id and m.created_at > gm.last_read_at and m.sender_id <> gm.user_id
  where gm.user_id = (select auth.uid())
  group by m.group_id;
$$;

-- Only signed-in users may call these.
revoke all on function public.is_group_member(bigint) from public, anon;
revoke all on function public.is_group_admin(bigint) from public, anon;
revoke all on function public.can_read_group_message(bigint, timestamptz) from public, anon;
revoke all on function public.is_group_topic_member(text) from public, anon;
revoke all on function public.create_group(text, uuid[]) from public, anon;
revoke all on function public.add_group_members(bigint, uuid[]) from public, anon;
revoke all on function public.remove_group_member(bigint, uuid) from public, anon;
revoke all on function public.leave_group(bigint) from public, anon;
revoke all on function public.get_group_members(bigint) from public, anon;
revoke all on function public.group_unread_counts() from public, anon;
grant execute on function public.is_group_member(bigint) to authenticated;
grant execute on function public.is_group_admin(bigint) to authenticated;
grant execute on function public.can_read_group_message(bigint, timestamptz) to authenticated;
grant execute on function public.is_group_topic_member(text) to authenticated;
grant execute on function public.create_group(text, uuid[]) to authenticated;
grant execute on function public.add_group_members(bigint, uuid[]) to authenticated;
grant execute on function public.remove_group_member(bigint, uuid) to authenticated;
grant execute on function public.leave_group(bigint) to authenticated;
grant execute on function public.get_group_members(bigint) to authenticated;
grant execute on function public.group_unread_counts() to authenticated;

-- Live delivery for group messages, and for being added to a group.
do $$
begin
  alter publication supabase_realtime add table public.group_messages;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.group_members;
exception when duplicate_object then null;
end $$;

-- Group "is typing…": private Broadcast channels named esi-gtyping-<groupId>,
-- joinable only by members of that group.
drop policy if exists "group members receive typing" on realtime.messages;
create policy "group members receive typing"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and public.is_group_topic_member(realtime.topic())
  );

drop policy if exists "group members send typing" on realtime.messages;
create policy "group members send typing"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and public.is_group_topic_member(realtime.topic())
  );

-- Never expose the service_role key in any frontend file.

-- =====================================================================
-- NEW: CHAT REQUESTS, BLOCKING, MESSAGE EDIT/DELETE
-- For private messaging: users send requests, accept/deny, and can block.
-- Messages can be edited or soft-deleted by the sender.
-- =====================================================================

create table if not exists public.chat_requests (
  id bigint generated always as identity primary key,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'denied')),
  created_at timestamptz not null default now(),
  unique (sender_id, recipient_id)
);

create table if not exists public.blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

-- Add edit support to messages
alter table public.direct_messages add column if not exists edited_at timestamptz;
alter table public.group_messages add column if not exists edited_at timestamptz;

alter table public.chat_requests enable row level security;
alter table public.blocks enable row level security;

revoke all on public.chat_requests from anon;
revoke all on public.blocks from anon;
grant select, insert, update on public.chat_requests to authenticated;
grant select, insert, delete on public.blocks to authenticated;

-- Requests: sender and recipient can see
drop policy if exists "participants see requests" on public.chat_requests;
create policy "participants see requests"
  on public.chat_requests for select to authenticated
  using (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()));

drop policy if exists "senders create requests" on public.chat_requests;
create policy "senders create requests"
  on public.chat_requests for insert to authenticated
  with check (sender_id = (select auth.uid()) and recipient_id <> (select auth.uid()));

drop policy if exists "recipients update request status" on public.chat_requests;
create policy "recipients update request status"
  on public.chat_requests for update to authenticated
  using (recipient_id = (select auth.uid()))
  with check (recipient_id = (select auth.uid()));

-- Blocks: only the blocker can manage
drop policy if exists "users see own blocks" on public.blocks;
create policy "users see own blocks"
  on public.blocks for select to authenticated
  using (blocker_id = (select auth.uid()));

drop policy if exists "users create blocks" on public.blocks;
create policy "users create blocks"
  on public.blocks for insert to authenticated
  with check (blocker_id = (select auth.uid()));

drop policy if exists "users delete own blocks" on public.blocks;
create policy "users delete own blocks"
  on public.blocks for delete to authenticated
  using (blocker_id = (select auth.uid()));

-- Update message insert policy to require accepted request and no block
drop policy if exists "senders create messages to listed members" on public.direct_messages;
create policy "senders create messages to accepted contacts"
  on public.direct_messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and recipient_id <> (select auth.uid())
    and exists (
      select 1 from public.chat_requests r
      where ((r.sender_id = (select auth.uid()) and r.recipient_id = recipient_id)
          or (r.recipient_id = (select auth.uid()) and r.sender_id = recipient_id))
        and r.status = 'accepted'
    )
    and not exists (
      select 1 from public.blocks b
      where (b.blocker_id = (select auth.uid()) and b.blocked_id = recipient_id)
         or (b.blocker_id = recipient_id and b.blocked_id = (select auth.uid()))
    )
  );

-- Allow sender to edit or delete own messages
grant update (body, edited_at) on public.direct_messages to authenticated;
grant delete on public.direct_messages to authenticated;
grant update (body, edited_at) on public.group_messages to authenticated;
grant delete on public.group_messages to authenticated;

drop policy if exists "senders edit own messages" on public.direct_messages;
create policy "senders edit own messages"
  on public.direct_messages for update to authenticated
  using (sender_id = (select auth.uid()))
  with check (sender_id = (select auth.uid()));

drop policy if exists "senders delete own messages" on public.direct_messages;
create policy "senders delete own messages"
  on public.direct_messages for delete to authenticated
  using (sender_id = (select auth.uid()));

drop policy if exists "senders edit own group messages" on public.group_messages;
create policy "senders edit own group messages"
  on public.group_messages for update to authenticated
  using (sender_id = (select auth.uid()))
  with check (sender_id = (select auth.uid()));

drop policy if exists "senders delete own group messages" on public.group_messages;
create policy "senders delete own group messages"
  on public.group_messages for delete to authenticated
  using (sender_id = (select auth.uid()));

-- Add realtime for new tables if needed
do $$
begin
  alter publication supabase_realtime add table public.chat_requests;
exception when duplicate_object then null;
end $$;

-- =====================================================================
-- PHASE 2: Moderation, Replies, Reactions, Presence, Mute, Multi-admin, Group meta
-- =====================================================================

-- Reports for admin moderation (manage manually in Supabase dashboard)
create table if not exists public.reports (
  id bigint generated always as identity primary key,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reported_user_id uuid references auth.users(id) on delete set null,
  message_id bigint,
  reason text not null check (char_length(reason) between 1 and 500),
  status text not null default 'open' check (status in ('open','reviewed','closed')),
  created_at timestamptz not null default now()
);
alter table public.reports enable row level security;
revoke all on public.reports from anon;
grant insert, select on public.reports to authenticated;
drop policy if exists "users create reports" on public.reports;
create policy "users create reports" on public.reports for insert to authenticated
  with check (reporter_id = (select auth.uid()));
drop policy if exists "users see own reports" on public.reports;
create policy "users see own reports" on public.reports for select to authenticated
  using (reporter_id = (select auth.uid()));

-- Reply / quote support
alter table public.direct_messages add column if not exists reply_to bigint references public.direct_messages(id) on delete set null;
alter table public.group_messages add column if not exists reply_to bigint references public.group_messages(id) on delete set null;

-- Read receipts already exist via read_at; add delivered_at for ✓
alter table public.direct_messages add column if not exists delivered_at timestamptz;

-- Last seen / online (updated by client heartbeat)
alter table public.profiles add column if not exists last_seen_at timestamptz default now();

-- Emoji reactions
create table if not exists public.reactions (
  id bigint generated always as identity primary key,
  message_id bigint not null,
  message_table text not null check (message_table in ('direct_messages','group_messages')),
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 8),
  created_at timestamptz not null default now(),
  unique (message_id, message_table, user_id, emoji)
);
alter table public.reactions enable row level security;
revoke all on public.reactions from anon;
grant select, insert, delete on public.reactions to authenticated;
drop policy if exists "members see reactions" on public.reactions;
create policy "members see reactions" on public.reactions for select to authenticated using (true);
drop policy if exists "users add reactions" on public.reactions;
create policy "users add reactions" on public.reactions for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists "users remove own reactions" on public.reactions;
create policy "users remove own reactions" on public.reactions for delete to authenticated
  using (user_id = (select auth.uid()));

-- Mute group
alter table public.group_members add column if not exists muted boolean not null default false;

-- Multiple admins: already supported via role; add promote function
create or replace function public.promote_to_admin(p_group bigint, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_group_admin(p_group) then raise exception 'Only admins can promote'; end if;
  update public.group_members set role = 'admin'
    where group_id = p_group and user_id = p_user;
end;
$$;
grant execute on function public.promote_to_admin(bigint, uuid) to authenticated;

-- Group pictures, descriptions, member limit already enforced
alter table public.groups add column if not exists description text check (char_length(description) <= 200);
alter table public.groups add column if not exists avatar_url text;

-- Realtime for reactions and reports
do $$
begin
  alter publication supabase_realtime add table public.reactions;
exception when duplicate_object then null;
end $$;

-- Never expose the service_role key in any frontend file.

