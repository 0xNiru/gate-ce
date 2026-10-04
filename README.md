jyada kuch nahi bss gate civil ke pyqs hai actual GATE ke jaise interface me

translation ; nothing much, i've accumulated every gate civil pyqs in a real GATE like interface at one place


[check it out here](https://gate-ce.vercel.app/)

### Maintaining the question bank

Question data lives in `data/questions/`, with one JSON file per subject. Edit the relevant subject file to update questions, answer keys, or explanations, then rebuild the compressed files and manifest before deploying:

```sh
node scripts/build-question-bank.mjs
```

The home page starts from the small summary manifest. Opening a subject loads only that subject’s questions; year-wide practice, custom tests, analytics, and saved-question views load the full bank when opened.

### Google sign-in configuration

For the Supabase project configured in `supabase-config.js`, add this exact URL to the Google OAuth client's **Authorized redirect URIs** in Google Cloud Console:

`https://wnylknpdkrpwubmrrlxn.supabase.co/auth/v1/callback`

In the Supabase Dashboard, enable Google under **Authentication → Sign In / Providers** with credentials from that same Google OAuth client. Under **Authentication → URL Configuration → Redirect URLs**, allow:

`https://gate-ce.vercel.app/`

The Google callback URI above is different from the app redirect URL. If the Google error still occurs, confirm the request's `client_id` belongs to the OAuth client where that callback was added, then save the Google and Supabase provider settings.

### Profile, cloud backup, and question reports

Apply `supabase-profile-cloud-reports-migration.sql` in the Supabase SQL Editor. It adds a private full-state cloud snapshot, profile image storage, aggregate leaderboard access, and profile statistics. Existing test-attempt and response rows remain protected by their per-user RLS policies; the `get_public_leaderboard_v2` RPC exposes profile name/photo, solved-question and test counts, streaks, and rank only.

The same additive migration installs `delete_own_test_attempt`, used by the Recent Practice delete control. Re-run the updated SQL after pulling code changes. It sends a PostgREST schema reload notification so the RPC is available immediately; if Supabase still reports it missing, refresh the app and wait a few seconds before trying again.

After linking the repository to your Supabase project (`supabase link --project-ref <project-ref>`), deploy the Telegram report function from the repository root:

```sh
supabase functions deploy report-question
supabase secrets set TELEGRAM_BOT_TOKEN='your-rotated-bot-token' TELEGRAM_REPORT_CHAT_ID='your-chat-id'
```

Never put the Telegram bot token in a browser file or Git. The bot must have access to the destination chat; start a direct chat with it and obtain the numeric chat ID before setting the secret.
