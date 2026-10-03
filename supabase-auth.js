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
    saveCloudState,
    loadCloudState,
    updateProfile,
    uploadAvatar,
    loadLeaderboard,
    submitReport,
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
    // This is the app destination after Supabase finishes OAuth. Google's
    // authorized redirect URI is the Supabase callback URL shown in
    // supabase-config.js, not this application URL.
    const redirectTo = window.__APP_AUTH_REDIRECT_URL__ || window.location.href.split('#')[0];
    await _client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
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
    const { data: existing } = await _client.from('profiles').select('display_name,avatar_url').eq('id', user.id).maybeSingle();
    const row = {
      id:           user.id,
      email:        user.email,
      display_name: existing?.display_name || meta.full_name || meta.name || user.email,
      avatar_url:   existing?.avatar_url || meta.avatar_url || meta.picture || null,
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

  async function updateProfile(fields) {
    if (!_client || !_session) throw new Error('Sign in to update your profile.');
    const allowed = { updated_at: new Date().toISOString() };
    if (typeof fields.display_name === 'string') allowed.display_name = fields.display_name.trim().slice(0, 80);
    if (typeof fields.avatar_url === 'string') allowed.avatar_url = fields.avatar_url;
    const { data, error } = await _client.from('profiles').update(allowed).eq('id', _session.user.id).select().single();
    if (error) throw error;
    _profile = data;
    return data;
  }

  async function uploadAvatar(file) {
    if (!_client || !_session) throw new Error('Sign in to change your photo.');
    if (!file || !file.type.startsWith('image/')) throw new Error('Choose an image file.');
    if (file.size > 5 * 1024 * 1024) throw new Error('Profile photos must be 5 MB or smaller.');
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${_session.user.id}/avatar.${ext}`;
    const { error } = await _client.storage.from('avatars').upload(path, file, { upsert: true, contentType: file.type });
    if (error) throw error;
    const { data } = _client.storage.from('avatars').getPublicUrl(path);
    return updateProfile({ avatar_url: `${data.publicUrl}?v=${Date.now()}` });
  }

  async function saveCloudState(state) {
    if (!_client || !_session) return;
    const { error } = await _client.from('user_cloud_state').upsert({ user_id: _session.user.id, state, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw error;
    const attempts = state.history || [], solved = new Set();
    for (const attempt of attempts) for (const [qid, grade] of Object.entries(attempt.evaluations || {})) if (grade?.status && !['unanswered', 'pending'].includes(grade.status)) solved.add(qid);
    const practiceDays = new Set(attempts.map(a => new Date(a.endedAt).toISOString().slice(0, 10)));
    let streak = 0, cursor = new Date();
    if (!practiceDays.has(cursor.toISOString().slice(0, 10))) cursor.setUTCDate(cursor.getUTCDate() - 1);
    while (practiceDays.has(cursor.toISOString().slice(0, 10))) { streak++; cursor.setUTCDate(cursor.getUTCDate() - 1); }
    const [{ count: solvedCount, error: solvedError }, { count: testCount, error: testError }] = await Promise.all([
      _client.from('question_progress').select('question_id', { count: 'exact', head: true }).eq('user_id', _session.user.id).gt('attempt_count', 0),
      _client.from('test_attempts').select('id', { count: 'exact', head: true }).eq('user_id', _session.user.id),
    ]);
    const { error: profileError } = await _client.from('profiles').update({ questions_solved: Math.max(solved.size, solvedError ? 0 : (solvedCount || 0)), tests_taken: Math.max(attempts.length, testError ? 0 : (testCount || 0)), streak_days: streak, stats_updated_at: new Date().toISOString() }).eq('id', _session.user.id);
    if (profileError) throw profileError;
  }

  async function loadCloudState() {
    if (!_client || !_session) return null;
    const { data, error } = await _client.from('user_cloud_state').select('state').eq('user_id', _session.user.id).maybeSingle();
    if (error) throw error;
    return data?.state || null;
  }

  async function loadLeaderboard() {
    if (!_client) return [];
    const { data, error } = await _client.rpc('get_public_leaderboard');
    if (error) throw error;
    return data || [];
  }

  async function submitReport(report) {
    if (!_client || !_session) throw new Error('Sign in to send a report.');
    const { data, error } = await _client.functions.invoke('report-question', { body: report });
    if (error) throw error;
    return data;
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
    const attemptIds = data.map(r => r.id), allResponses = [];
    // Keep each request below PostgREST's row cap, including large custom tests.
    for (let i = 0; i < attemptIds.length; i += 5) {
      let offset = 0;
      while (true) {
        const responseRows = await _client.from('question_responses').select('*').in('test_attempt_id', attemptIds.slice(i, i + 5)).order('question_index').range(offset, offset + 499);
        if (responseRows.error) { console.error('[SupaAuth] test response load error', responseRows.error); return null; }
        allResponses.push(...(responseRows.data || []));
        if ((responseRows.data || []).length < 500) break;
        offset += 500;
      }
    }
    const responsesByAttempt = new Map();
    for (const response of allResponses) {
      if (!responsesByAttempt.has(response.test_attempt_id)) responsesByAttempt.set(response.test_attempt_id, []);
      responsesByAttempt.get(response.test_attempt_id).push(response);
    }
    // Re-shape to match the local attempt format app.js expects
    return data.map(r => {
      const responses = (responsesByAttempt.get(r.id) || []).sort((a, b) => (a.question_index || 0) - (b.question_index || 0));
      const answers = {}, evaluations = {}, times = {};
      for (const response of responses) {
        if (response.selected_answer !== null) { try { answers[response.question_id] = JSON.parse(response.selected_answer); } catch { answers[response.question_id] = response.selected_answer; } }
        evaluations[response.question_id] = { status: response.status || 'unanswered', score: 0 };
        if (response.time_spent !== null) times[response.question_id] = Number(response.time_spent);
      }
      return ({
      id:            r.local_id,
      title:         r.title || 'Practice set',
      subject:       r.subject,
      topic:         r.topic,
      year:          r.year,
      session:       r.session,
      questionIds:   responses.map(response => response.question_id),
      answers,
      evaluations,
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
      times,
      visited:       responses.map((response, index) => response.question_index ?? index),
    });
    });
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
