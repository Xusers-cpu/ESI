# Experimental Science Institution: Notes

A static, multi-page science learning website for CBSE Classes 9–10. Built with HTML, CSS and vanilla JavaScript so it can be hosted directly on GitHub Pages without a backend or build step.

## Included pages

- `index.html` — homepage and subject overview
- `subjects.html` — searchable subject directory
- `cells.html` — cell biology
- `electricity.html` — electric current, resistance and power
- `light.html` — reflection, refraction, mirrors, lenses and the eye
- `sound.html` — sound waves and wave properties
- `magnetism.html` — magnetic fields and electromagnetic effects
- `motion.html` — motion and Newton’s laws
- `lab.html` — interactive Ohm’s law and sound-wave visual simulations
- `quiz.html` — mixed 10-question quiz with feedback and hints
- `notes.html` — searchable formula and revision cards; print/save as PDF
- `progress.html` — local lesson completion, bookmarks and quiz history
- `404.html` — friendly not-found page

## Run locally

1. Extract the ZIP file.
2. Open the extracted folder.
3. Double-click `index.html` to open it in a modern browser.

For a local web-server preview, open a terminal in the project folder and run:

```bash
python -m http.server 8000
```

Then visit `http://localhost:8000`.

## Publish on GitHub Pages

1. Create a GitHub repository, for example `experimental-science-institution-notes`.
2. Upload all files and folders in this project. Keep `index.html` at the repository root.
3. In the repository, open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Select branch `main` and folder `/(root)`, then save.
6. Wait for GitHub Pages to publish the site. The public URL will be shown in the Pages settings.

If you use a project repository, the URL usually looks like:

`https://YOUR-USERNAME.github.io/experimental-science-institution-notes/`

Replace `YOUR-USERNAME` with your GitHub username. GitHub Pages may take a few minutes to deploy.

## Progress and privacy

Lesson completion, bookmarks and quiz history are saved in the visitor's own browser with `localStorage`. They are not uploaded to GitHub or sent to a server. Each browser/device has its own progress. Clearing browser storage may remove it.

## Customisation

- Edit the content in each subject HTML file.
- Change colours, typography and layout in `style.css`.
- Add quiz questions in the `QUESTIONS` array in `app.js`.
- Add new subject metadata in the `SUBJECTS` array in `app.js`, then create a matching HTML page.
- Google Fonts are loaded from Google Fonts when internet access is available; system fallback fonts are used if they cannot load.

## Educational note

This is an independent learning resource and is not an official CBSE website. Verify exam-specific syllabus coverage, sign conventions and definitions with the current NCERT/CBSE textbook and teacher.

## Study Circle community widget (Supabase)

A compact **Study Circle** widget is added at the bottom-right of every page. It supports email/password sign-in, an opt-in member directory, one-to-one messages and live updates through Supabase Realtime. It is intentionally labelled as a community feature so visitors understand when they are messaging.

1. Read `SUPABASE_SETUP.md`.
2. Create the tables and Row Level Security policies by running `supabase-schema.sql` in the Supabase SQL Editor.
3. Put only your Supabase Project URL and public anon/publishable key in `supabase-config.js`.
4. Enable `public.direct_messages` in the `supabase_realtime` publication.
5. Test with two accounts before sharing the site.

**Important:** never put a Supabase `service_role` key in frontend code. The SQL uses Row Level Security to restrict profiles and messages. Before inviting a student community, add moderation, reporting, blocking, rate limits, and a privacy policy, and get appropriate school/parent/guardian approval.
