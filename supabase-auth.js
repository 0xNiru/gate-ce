// supabase-auth.js  v1
// Handles Google OAuth via Supabase, user profile sync, and cloud persistence.
// All Supabase calls are isolated here. app.js calls the exported API.
// Only the anon key is used – it is safe to include in frontend code.

(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────
  // Replace the two values below with your actual project details.
  // These are PUBLIC values (anon key). Do NOT put the service-role key here.
  const SUPABASE_URL   = window.__SUPABASE_URL__   || '';
  const SUPABASE_ANON  = window.__SUPABASE_ANON__  || '';

  // ── State ─────────────────────────────────────────────────────────────────
  let _client   = null;   // Supabase JS client
  let _session  = null;   // Current session (or null)
  let _profile  = null;   // Profiles row for current user
  let _ready    = false;  // True after init() completes
  let _listeners = [];    // Callbacks registered via onAuthChange()

  // ── Public API (attached to window.SupaAuth) ─────────────────────────────
  const api = {
    /** Returns true after init() has resolved. */
    isReady:    () => _ready,
    /** Returns the current Supabase User object, or null. */
    user:       () => _session?.user ?? null,
    /** Returns the profile row (display_name, avatar_url, …), or null. */
    profile:    () => _profile,
    /** Returns the current access token, or null. */
    token:      () => _session?.access_token ?? null,

    init,
    signInWithGoogle,
    signOut,
    onAuthChange,

    // Cloud persistence helpers
    syncBookmarks,
    loadBookmarks,
    syncMistakes,
    loadMistakes,
    saveTestAttempt,
    loadTestHistory,
    saveQuestionProgress,
    loadQuestionProgress,
  };
  window.SupaAuth = api;

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    if (!SUPABASE_URL || !SUPABASE_ANON) {
      console.warn('[SupaAuth] Supabase URL / anon key not configured. Auth disabled.');
      _ready = true;
      return;
    }

    // Dynamically load the Supabase JS v2 ESM build from CDN.
    // We use a script tag + global so this works without a bundler.
    if (!window.supabase) {
      await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
    }

    _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      }
    });

    // Subscribe to auth changes (login, logout, token refresh)
    _client.auth.onAuthStateChange(async (event, session) => {
      _session = session;
      if (session?.user) {
        await upsertProfile(session.user);
      } else {
        _profile = null;
      }
      _listeners.forEach(fn => fn(event, session, _profile));
    });

    // Restore an existing session from localStorage
    const { data } = await _client.auth.getSession();
    _session = data?.session ?? null;
    if (_session?.user) {
      await upsertProfile(_session.user);
    }

    _ready = true;
  }

  // ── Auth Actions ──────────────────────────────────────────────────────────
  async function signInWithGoogle() {
    if (!_client) return;
    await _client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
        queryParams: { access_type: 'offline', prompt: 'consent' },
      }
    });
  }

  async function signOut() {
    if (!_client) return;
    await _client.auth.signOut();
    _session = null;
    _profile = null;
    _listeners.forEach(fn => fn('SIGNED_OUT', null, null));
  }

  function onAuthChange(fn) {
    _listeners.push(fn);
    // Immediately call with current state if already initialised
    if (_ready) {
      const event = _session ? 'INITIAL_SESSION' : 'SIGNED_OUT';
      fn(event, _session, _profile);
    }
  }

  // ── Profile ───────────────────────────────────────────────────────────────
  async function upsertProfile(user) {
    if (!_client || !user) return;
    const meta = user.user_metadata || {};
    const row = {
      id:           user.id,
      email:        user.email,
      display_name: meta.full_name || meta.name || user.email,
      avatar_url:   meta.avatar_url || meta.picture || null,
      updated_at:   new Date().toISOString(),
    };
    const { data, error } = await _client
      .from('profiles')
      .upsert(row, { onConflict: 'id' })
      .select()
      .single();
    if (error) { console.error('[SupaAuth] profile upsert error', error); return; }
    _profile = data;
  }

  // ── Bookmarks ─────────────────────────────────────────────────────────────
  /** Push the local bookmarks array to Supabase.
   *  Deletes rows that are no longer in the list and inserts new ones. */
  async function syncBookmarks(questionIds) {
    if (!_client || !_session) return;
    const uid = _session.user.id;

    // Delete all existing rows for this user, then insert current set.
    // Simple approach: delete + insert in a transaction-like pattern.
    const { error: delErr } = await _client
      .from('bookmarks')
      .delete()
      .eq('user_id', uid);
    if (delErr) { console.error('[SupaAuth] bookmark delete error', delErr); return; }

    if (!questionIds.length) return;
    const rows = questionIds.map(qid => ({ user_id: uid, question_id: qid }));
    const { error: insErr } = await _client.from('bookmarks').insert(rows);
    if (insErr) console.error('[SupaAuth] bookmark insert error', insErr);
  }

  /** Load bookmarks from Supabase; returns array of question_id strings. */
  async function loadBookmarks() {
    if (!_client || !_session) return null;
    const { data, error } = await _client
      .from('bookmarks')
      .select('question_id')
      .eq('user_id', _session.user.id);
    if (error) { console.error('[SupaAuth] bookmark load error', error); return null; }
    return data.map(r => r.question_id);
  }

  // ── Mistakes ──────────────────────────────────────────────────────────────
  async function syncMistakes(questionIds) {
    if (!_client || !_session) return;
    const uid = _session.user.id;
    const { error: delErr } = await _client
      .from('mistakes')
      .delete()
      .eq('user_id', uid);
    if (delErr) { console.error('[SupaAuth] mistake delete error', delErr); return; }
    if (!questionIds.length) return;
    const rows = questionIds.map(qid => ({ user_id: uid, question_id: qid }));
    const { error: insErr } = await _client.from('mistakes').insert(rows);
    if (insErr) console.error('[SupaAuth] mistake insert error', insErr);
  }

  async function loadMistakes() {
    if (!_client || !_session) return null;
    const { data, error } = await _client
      .from('mistakes')
      .select('question_id')
      .eq('user_id', _session.user.id);
    if (error) { console.error('[SupaAuth] mistake load error', error); return null; }
    return data.map(r => r.question_id);
  }

  // ── Test Attempts ─────────────────────────────────────────────────────────
  /** Save a completed test attempt + per-question responses to Supabase. */
  async function saveTestAttempt(attempt) {
    if (!_client || !_session) return;
    const uid = _session.user.id;

    // Upsert the attempt row (use attempt.id as local_id for idempotency)
    const row = {
      user_id:          uid,
      local_id:         attempt.id,
      title:            attempt.title || null,
      subject:          attempt.subject || null,
      topic:            attempt.topic || null,
      year:             attempt.year || null,
      session:          attempt.session || null,
      total_questions:  (attempt.questionIds || []).length,
      attempted:        (attempt.correct || 0) + (attempt.incorrect || 0),
      correct:          attempt.correct || 0,
      incorrect:        attempt.incorrect || 0,
      unanswered:       attempt.unanswered || 0,
      pending:          attempt.pending || 0,
      score:            attempt.score || 0,
      total_marks:      attempt.totalMarks || 0,
      earned:           attempt.earned || 0,
      negative:         attempt.negative || 0,
      duration_seconds: attempt.durationSeconds || 0,
      remaining_seconds:attempt.remainingSeconds || 0,
      started_at:       attempt.endedAt
        ? new Date(attempt.endedAt - (attempt.durationSeconds - attempt.remainingSeconds) * 1000).toISOString()
        : null,
      completed_at:     attempt.endedAt ? new Date(attempt.endedAt).toISOString() : null,
    };

    const { data: attemptRow, error: attemptErr } = await _client
      .from('test_attempts')
      .upsert(row, { onConflict: 'user_id,local_id' })
      .select('id')
      .single();
    if (attemptErr) { console.error('[SupaAuth] test_attempt upsert error', attemptErr); return; }

    // Per-question responses
    const qids = attempt.questionIds || [];
    if (!qids.length || !attemptRow?.id) return;
    const qRows = qids.map((qid, idx) => {
      const eval_ = (attempt.evaluations || {})[qid] || {};
      const answer = (attempt.answers || {})[qid];
      const timeSpent = (attempt.times || {})[qid] || null;
      return {
        test_attempt_id: attemptRow.id,
        user_id:         uid,
        question_id:     qid,
        selected_answer: answer !== undefined ? JSON.stringify(answer) : null,
        is_correct:      eval_.status === 'correct',
        is_incorrect:    eval_.status === 'incorrect',
        status:          eval_.status || 'unanswered',
        time_spent:      timeSpent,
        question_index:  idx,
      };
    });
    const { error: qErr } = await _client
      .from('question_responses')
      .upsert(qRows, { onConflict: 'test_attempt_id,question_id' });
    if (qErr) console.error('[SupaAuth] question_responses upsert error', qErr);

    // Update question_progress table for each answered question
    await updateQuestionProgress(uid, attempt);
  }

  async function updateQuestionProgress(uid, attempt) {
    if (!_client) return;
    const qids = attempt.questionIds || [];
    for (const qid of qids) {
      const eval_ = (attempt.evaluations || {})[qid] || {};
      if (eval_.status === 'unanswered') continue;
      // Upsert: increment attempt_count, update last_attempted
      const { data: existing } = await _client
        .from('question_progress')
        .select('attempt_count, correct_count')
        .eq('user_id', uid)
        .eq('question_id', qid)
        .maybeSingle();
      const prevCount = existing?.attempt_count || 0;
      const prevCorrect = existing?.correct_count || 0;
      const row = {
        user_id:        uid,
        question_id:    qid,
        attempt_count:  prevCount + 1,
        correct_count:  prevCorrect + (eval_.status === 'correct' ? 1 : 0),
        last_correct:   eval_.status === 'correct',
        last_incorrect: eval_.status === 'incorrect',
        last_attempted: new Date().toISOString(),
      };
      const { error } = await _client
        .from('question_progress')
        .upsert(row, { onConflict: 'user_id,question_id' });
      if (error) console.error('[SupaAuth] question_progress upsert error', error);
    }
  }

  async function loadTestHistory() {
    if (!_client || !_session) return null;
    const { data, error } = await _client
      .from('test_attempts')
      .select('*')
      .eq('user_id', _session.user.id)
      .order('completed_at', { ascending: false })
      .limit(150);
    if (error) { console.error('[SupaAuth] test history load error', error); return null; }
    // Re-shape to match the local attempt format app.js expects
    return data.map(r => ({
      id:            r.local_id,
      title:         r.title || 'Practice set',
      subject:       r.subject,
      topic:         r.topic,
      year:          r.year,
      session:       r.session,
      questionIds:   [],   // full question list not stored in this table
      answers:       {},
      evaluations:   {},
      endedAt:       r.completed_at ? new Date(r.completed_at).getTime() : Date.now(),
      durationSeconds: r.duration_seconds || 0,
      remainingSeconds: r.remaining_seconds || 0,
      totalMarks:    r.total_marks || 0,
      earned:        r.earned || 0,
      negative:      r.negative || 0,
      score:         r.score || 0,
      correct:       r.correct || 0,
      incorrect:     r.incorrect || 0,
      unanswered:    r.unanswered || 0,
      pending:       r.pending || 0,
      times:         {},
      visited:       [],
    }));
  }

  /** Save per-question progress manually (called when marking a mistake/bookmark). */
  async function saveQuestionProgress(questionId, fields) {
    if (!_client || !_session) return;
    const uid = _session.user.id;
    const { data: existing } = await _client
      .from('question_progress')
      .select('attempt_count, correct_count')
      .eq('user_id', uid)
      .eq('question_id', questionId)
      .maybeSingle();
    const row = {
      user_id:      uid,
      question_id:  questionId,
      attempt_count: existing?.attempt_count || 0,
      correct_count: existing?.correct_count || 0,
      last_attempted: new Date().toISOString(),
      ...fields,
    };
    const { error } = await _client
      .from('question_progress')
      .upsert(row, { onConflict: 'user_id,question_id' });
    if (error) console.error('[SupaAuth] question_progress manual upsert error', error);
  }

  async function loadQuestionProgress() {
    if (!_client || !_session) return null;
    const { data, error } = await _client
      .from('question_progress')
      .select('*')
      .eq('user_id', _session.user.id);
    if (error) { console.error('[SupaAuth] question_progress load error', error); return null; }
    return data;
  }

  // ── Utility ───────────────────────────────────────────────────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
})();
