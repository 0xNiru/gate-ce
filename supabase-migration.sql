-- GATE CE Practice – Supabase Database Migration
-- Run this in: Supabase Dashboard → SQL Editor
-- Creates all tables with RLS policies.
-- Safe to run multiple times (CREATE TABLE IF NOT EXISTS).

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Profiles
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        TEXT,
  display_name TEXT,
  avatar_url   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Users can only see and update their own profile
CREATE POLICY IF NOT EXISTS "profiles: select own"  ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY IF NOT EXISTS "profiles: insert own"  ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY IF NOT EXISTS "profiles: update own"  ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Bookmarks
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bookmarks (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, question_id)
);

ALTER TABLE public.bookmarks ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "bookmarks: select own"  ON public.bookmarks FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY IF NOT EXISTS "bookmarks: insert own"  ON public.bookmarks FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY IF NOT EXISTS "bookmarks: delete own"  ON public.bookmarks FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS bookmarks_user_id_idx ON public.bookmarks (user_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Mistakes
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mistakes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, question_id)
);

ALTER TABLE public.mistakes ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "mistakes: select own"  ON public.mistakes FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY IF NOT EXISTS "mistakes: insert own"  ON public.mistakes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY IF NOT EXISTS "mistakes: delete own"  ON public.mistakes FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS mistakes_user_id_idx ON public.mistakes (user_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Test Attempts
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.test_attempts (
  id               BIGSERIAL PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  local_id         TEXT NOT NULL,          -- app.js attempt id (e.g. result-1234567890)
  title            TEXT,
  subject          TEXT,
  topic            TEXT,
  year             INTEGER,
  session          TEXT,
  total_questions  INTEGER NOT NULL DEFAULT 0,
  attempted        INTEGER NOT NULL DEFAULT 0,
  correct          INTEGER NOT NULL DEFAULT 0,
  incorrect        INTEGER NOT NULL DEFAULT 0,
  unanswered       INTEGER NOT NULL DEFAULT 0,
  pending          INTEGER NOT NULL DEFAULT 0,
  score            NUMERIC(10,4) NOT NULL DEFAULT 0,
  total_marks      NUMERIC(10,4) NOT NULL DEFAULT 0,
  earned           NUMERIC(10,4) NOT NULL DEFAULT 0,
  negative         NUMERIC(10,4) NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  remaining_seconds INTEGER NOT NULL DEFAULT 0,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, local_id)
);

ALTER TABLE public.test_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "test_attempts: select own"  ON public.test_attempts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY IF NOT EXISTS "test_attempts: insert own"  ON public.test_attempts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY IF NOT EXISTS "test_attempts: update own"  ON public.test_attempts FOR UPDATE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS test_attempts_user_id_idx ON public.test_attempts (user_id);
CREATE INDEX IF NOT EXISTS test_attempts_completed_at_idx ON public.test_attempts (user_id, completed_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Question Responses (per-question answers for each attempt)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.question_responses (
  id               BIGSERIAL PRIMARY KEY,
  test_attempt_id  BIGINT NOT NULL REFERENCES public.test_attempts(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question_id      TEXT NOT NULL,
  selected_answer  TEXT,                   -- JSON-encoded value
  is_correct       BOOLEAN,
  is_incorrect     BOOLEAN,
  status           TEXT,                   -- 'correct' | 'incorrect' | 'unanswered' | 'pending'
  time_spent       NUMERIC(10,2),          -- seconds
  question_index   INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (test_attempt_id, question_id)
);

ALTER TABLE public.question_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "question_responses: select own"  ON public.question_responses FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY IF NOT EXISTS "question_responses: insert own"  ON public.question_responses FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY IF NOT EXISTS "question_responses: update own"  ON public.question_responses FOR UPDATE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS question_responses_user_id_idx ON public.question_responses (user_id, question_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Question Progress (cumulative per-question stats per user)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.question_progress (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question_id    TEXT NOT NULL,
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  correct_count  INTEGER NOT NULL DEFAULT 0,
  last_correct   BOOLEAN,
  last_incorrect BOOLEAN,
  last_attempted TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, question_id)
);

ALTER TABLE public.question_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "question_progress: select own"  ON public.question_progress FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY IF NOT EXISTS "question_progress: insert own"  ON public.question_progress FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY IF NOT EXISTS "question_progress: update own"  ON public.question_progress FOR UPDATE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS question_progress_user_id_idx ON public.question_progress (user_id, question_id);
