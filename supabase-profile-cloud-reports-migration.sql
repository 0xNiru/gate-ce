-- Additive migration for profile editing, private full-state cloud backups,
-- aggregate leaderboard stats, and avatar storage. Safe to run repeatedly.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS questions_solved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS tests_taken INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS streak_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS stats_updated_at TIMESTAMPTZ;

-- This RPC exposes only profile display fields and aggregate counts.
-- Test history and response tables keep their existing per-user RLS policies.
CREATE OR REPLACE FUNCTION public.get_public_leaderboard()
RETURNS TABLE(display_name TEXT, avatar_url TEXT, questions_solved INTEGER, tests_taken INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p.display_name, p.avatar_url, p.questions_solved, p.tests_taken
  FROM public.profiles p
  WHERE p.display_name IS NOT NULL
  ORDER BY p.questions_solved DESC, p.tests_taken DESC, p.display_name ASC
  LIMIT 20
$$;
REVOKE ALL ON FUNCTION public.get_public_leaderboard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_leaderboard() TO anon, authenticated;

-- Store the app's complete per-user state (notes, active test, detailed history,
-- overrides, theme, bookmarks, mistakes, and todos) as a private JSON snapshot.
CREATE TABLE IF NOT EXISTS public.user_cloud_state (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.user_cloud_state ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_cloud_state TO authenticated;
DO $$ BEGIN
  CREATE POLICY "users manage own cloud state" ON public.user_cloud_state
    FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Publicly readable avatar objects; writes remain limited to the owner's folder.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 5242880, ARRAY['image/jpeg','image/png','image/webp','image/gif'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 5242880,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
DO $$ BEGIN
  CREATE POLICY "gate ce avatar public read" ON storage.objects FOR SELECT USING (bucket_id = 'avatars');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "gate ce avatar owner insert" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "gate ce avatar owner update" ON storage.objects FOR UPDATE TO authenticated
    USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
    WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "gate ce avatar owner delete" ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
