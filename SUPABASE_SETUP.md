# Study Circle — Supabase setup

The floating **Study Circle** widget is an opt-in community feature for Experimental Science Institution: Notes. It supports account sign-in, an opted-in member directory, private one-to-one messages, and live message updates. It is not a bot that automatically answers science questions.

## 1. Create a Supabase project

1. Create a project at https://supabase.com/dashboard.
2. In **Project Settings → API**, copy the Project URL and the **publishable/anon key**.
3. Edit `supabase-config.js` and replace the two placeholder strings. These values are intended for browser use. **Never use the `service_role` key in this repository.**
4. In **Authentication → URL Configuration**, add your GitHub Pages URL to Site URL / Redirect URLs as appropriate. For local testing, you can use a local static server and configure its URL too.
5. In **Authentication → Providers → Email**, choose whether email confirmation is required. If confirmation is on, users must confirm their email before signing in.

## 2. Create the tables and access rules

Open **SQL Editor**, paste the contents of `supabase-schema.sql`, and run it. The SQL enables Row Level Security (RLS): users can see listed profiles, update only their own profile, and read only messages where they are the sender or recipient. Messages can be sent only by the authenticated sender to a listed member.

The script also turns on Realtime for `public.direct_messages` (so new messages appear without refreshing) and adds the policies for the **typing indicator**, which uses private Realtime Broadcast channels. If you ran an older version of the script, just run this one again: it is safe to re-run and adds the new `read_at` column (unread counters / auto-mark-as-read) and the typing policies. Until it is re-run, the chat keeps working but unread badges and the typing indicator stay off. Check the Supabase RLS policies before opening the site to visitors.

## 3. Publish to GitHub Pages

Commit and push all files. Keep `supabase-config.js` in the repo with only the Project URL and public anon/publishable key. GitHub Pages serves static files; Supabase provides authentication, database access, and realtime updates.

## 4. Test safely

- Create two test accounts with different emails.
- Each account must opt in to be listed during signup.
- Sign in as one account and send a message to the other, then check live updates.
- Test that signing out hides the directory and conversation.
- Test RLS by trying to read a message from a third account; it should not be visible.
- Keep the directory opt-in and remind members not to share passwords, addresses, phone numbers, school schedules, or other sensitive information.
- For a school community, get appropriate school/parent/guardian approval and add a clear reporting/moderation process before inviting students.

## Notes

This is a starter implementation, not a fully moderated production messaging service. Add reporting, blocking, rate limits, abuse handling, and a privacy policy before a public student rollout. Username changes and account deletion should be handled with deliberate policies. The widget shows a clear **Study Circle** label rather than pretending messaging is a different feature.
