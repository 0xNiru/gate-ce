jyada kuch nahi bss gate civil ke pyqs hai actual GATE ke jaise interface me

translation ; nothing much, i've accumulated every gate civil pyqs in a real GATE like interface at one place


[check it out here](https://gate-ce.vercel.app/)

### Google sign-in configuration

For the Supabase project configured in `supabase-config.js`, add this exact URL to the Google OAuth client's **Authorized redirect URIs** in Google Cloud Console:

`https://wnylknpdkrpwubmrrlxn.supabase.co/auth/v1/callback`

In the Supabase Dashboard, enable Google under **Authentication → Sign In / Providers** with credentials from that same Google OAuth client. Under **Authentication → URL Configuration → Redirect URLs**, allow:

`https://gate-ce.vercel.app/`

The Google callback URI above is different from the app redirect URL. If the Google error still occurs, confirm the request's `client_id` belongs to the OAuth client where that callback was added, then save the Google and Supabase provider settings.
