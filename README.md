jyada kuch nahi bss gate civil ke pyqs hai actual GATE ke jaise interface me

translation ; nothing much, i've accumulated every gate civil pyqs in a real GATE like interface at one place


[check it out here](https://gate-ce.vercel.app/)

### Google sign-in configuration

For the Supabase project configured in `supabase-config.js`, add this exact URL to the Google OAuth client's **Authorized redirect URIs** in Google Cloud Console:

`https://wnylknpdkrpwubmrrlxn.supabase.co/auth/v1/callback`

In the Supabase Dashboard, enable Google under **Authentication → Sign In / Providers** with credentials from that same Google OAuth client. Under **Authentication → URL Configuration → Redirect URLs**, allow:

`https://gate-ce.vercel.app/`

The Google callback URI above is different from the app redirect URL. If the Google error still occurs, confirm the request's `client_id` belongs to the OAuth client where that callback was added, then save the Google and Supabase provider settings.

### Profile, cloud backup, and question reports

Apply `supabase-profile-cloud-reports-migration.sql` in the Supabase SQL Editor. It adds a private full-state cloud snapshot, profile image storage, aggregate leaderboard access, and profile statistics. Existing test-attempt and response rows remain protected by their per-user RLS policies; the leaderboard RPC exposes aggregate counts and profile name/photo only.

After linking the repository to your Supabase project (`supabase link --project-ref <project-ref>`), deploy the Telegram report function from the repository root:

```sh
supabase functions deploy report-question
supabase secrets set TELEGRAM_BOT_TOKEN='your-rotated-bot-token' TELEGRAM_REPORT_CHAT_ID='your-chat-id'
```

Never put the Telegram bot token in a browser file or Git. The bot must have access to the destination chat; start a direct chat with it and obtain the numeric chat ID before setting the secret.
