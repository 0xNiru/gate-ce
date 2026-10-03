import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_REPORT_CHAT_ID');
  const authHeader = req.headers.get('Authorization');
  if (!token || !chatId || !authHeader) return json({ error: 'Report service is not configured.' }, 503);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return json({ error: 'Sign in to report an issue.' }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Invalid report.' }, 400); }
  const questionId = String(body.question_id || '').slice(0, 80);
  const reason = String(body.reason || '').slice(0, 80);
  const allowed = ['Wrong question', 'Wrong answer key', 'Missing data', 'Question formatting or image issue', 'Other'];
  if (!questionId || !allowed.includes(reason)) return json({ error: 'Choose a valid issue type.' }, 400);

  const { data: profile } = await supabase.from('profiles').select('display_name,email').eq('id', user.id).maybeSingle();
  const reporter = profile?.display_name || profile?.email || user.email || 'Candidate';
  const question = `${String(body.year || '')} ${String(body.session || '')} · Q${String(body.question_no || '')} (${String(body.topic || '')})`;
  const details = String(body.details || '').trim().slice(0, 1000);
  const message = `GATE CE question report\nuser ${reporter} reported ${reason} for ${question}\nQuestion ID: ${questionId}${details ? `\nDetails: ${details}` : ''}`;
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
  } catch (error) {
    console.error('Telegram request failed:', error);
    return json({ error: 'Supabase could not reach Telegram. Check the Edge Function logs and try again.' }, 502);
  }
  let result: { ok?: boolean; description?: string };
  try { result = await response.json(); }
  catch { return json({ error: 'Telegram returned an unreadable response.' }, 502); }
  if (!response.ok || !result.ok) {
    const description = String(result.description || 'Check the bot token and destination chat ID.').slice(0, 240);
    return json({ error: `Telegram could not deliver this report: ${description}` }, 502);
  }
  return json({ ok: true }, 200);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
}
