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

-- Delete one of the signed-in user's completed tests and recalculate affected
-- per-question aggregates so history deletion stays consistent with the board.
CREATE OR REPLACE FUNCTION public.delete_own_test_attempt(p_local_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  target_id BIGINT;
  affected_questions TEXT[];
  qid TEXT;
  attempt_total INTEGER;
  correct_total INTEGER;
  latest_status TEXT;
  latest_time TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT id INTO target_id FROM public.test_attempts
    WHERE user_id = auth.uid() AND local_id = p_local_id FOR UPDATE;
  IF target_id IS NULL THEN RETURN FALSE; END IF;

  SELECT array_agg(DISTINCT question_id) INTO affected_questions
    FROM public.question_responses WHERE user_id = auth.uid() AND test_attempt_id = target_id;
  DELETE FROM public.test_attempts WHERE id = target_id AND user_id = auth.uid();

  FOREACH qid IN ARRAY COALESCE(affected_questions, ARRAY[]::TEXT[]) LOOP
    SELECT
      COUNT(*) FILTER (WHERE qr.status <> 'unanswered'),
      COUNT(*) FILTER (WHERE qr.status = 'correct'),
      (array_agg(qr.status ORDER BY ta.completed_at DESC))[1],
      MAX(ta.completed_at)
    INTO attempt_total, correct_total, latest_status, latest_time
    FROM public.question_responses qr
    JOIN public.test_attempts ta ON ta.id = qr.test_attempt_id
    WHERE qr.user_id = auth.uid() AND qr.question_id = qid;

    IF COALESCE(attempt_total, 0) = 0 THEN
      DELETE FROM public.question_progress WHERE user_id = auth.uid() AND question_id = qid;
    ELSE
      INSERT INTO public.question_progress(user_id, question_id, attempt_count, correct_count, last_correct, last_incorrect, last_attempted)
      VALUES (auth.uid(), qid, attempt_total, COALESCE(correct_total, 0), latest_status = 'correct', latest_status = 'incorrect', latest_time)
      ON CONFLICT (user_id, question_id) DO UPDATE SET
        attempt_count = EXCLUDED.attempt_count,
        correct_count = EXCLUDED.correct_count,
        last_correct = EXCLUDED.last_correct,
        last_incorrect = EXCLUDED.last_incorrect,
        last_attempted = EXCLUDED.last_attempted;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.delete_own_test_attempt(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_own_test_attempt(TEXT) TO authenticated;

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
