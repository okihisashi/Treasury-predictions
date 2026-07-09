// Cloudflare Worker: static dashboard + state API + regime proxy (GitHub-backed)

const GITHUB_API = 'https://api.github.com';
const REPO       = 'okihisashi/Treasury-predictions';
const STATE_PATH = 'state.json';
const REGIME_PATH = 'predictions/regime.json';
const BRANCH     = 'main';

export default {
  async fetch(request, env, ctx) {
    const url       = new URL(request.url);
    const path      = url.pathname;
    const method    = request.method;
    const userEmail = request.headers.get('Cf-Access-Authenticated-User-Email') || '';
    const isEditor  = userEmail && env.EDITOR_EMAIL && userEmail.toLowerCase() === env.EDITOR_EMAIL.toLowerCase();

    try {
      if (path === '/api/whoami' && method === 'GET') {
        return jsonResponse({ email: userEmail, editor_email: env.EDITOR_EMAIL || '', is_editor: isEditor });
      }
      if (path === '/api/regime' && method === 'GET') {
        return await loadFile(env, REGIME_PATH);
      }
      if (path === '/api/state' && method === 'GET') {
        return await loadState(env);
      }
      if (path === '/api/state' && method === 'PUT') {
        if (!isEditor) return jsonResponse({ error: 'forbidden', reason: 'read-only access' }, 403);
        return await saveState(request, env);
      }
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }

    return env.ASSETS.fetch(request);
  }
};

async function ghGet(env, filePath) {
  const r = await fetch(`${GITHUB_API}/repos/${REPO}/contents/${filePath}?ref=${BRANCH}`, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'treasury-dashboard',
      'Accept': 'application/vnd.github.v3+json'
    }
  });
  return r;
}

async function loadFile(env, filePath) {
  const r = await ghGet(env, filePath);
  if (r.status === 404) return jsonResponse({ error: 'not found' }, 404);
  if (!r.ok) throw new Error(`GitHub GET ${r.status}`);
  const data = await r.json();
  return new Response(decodeBase64(data.content), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' }
  });
}

async function loadState(env) {
  const r = await ghGet(env, STATE_PATH);
  if (r.status === 404) return jsonResponse({ state: null, sha: null });
  if (!r.ok) throw new Error(`GitHub GET ${r.status}`);
  const data = await r.json();
  const state = JSON.parse(decodeBase64(data.content));
  return jsonResponse({ state, sha: data.sha });
}

async function saveState(request, env) {
  const { state, sha } = await request.json();
  if (!state) return jsonResponse({ error: 'state is required' }, 400);
  const payload = {
    message: `Update dashboard state ${new Date().toISOString()}`,
    content: encodeBase64(JSON.stringify(state, null, 2)),
    branch: BRANCH
  };
  if (sha) payload.sha = sha;
  const r = await fetch(`${GITHUB_API}/repos/${REPO}/contents/${STATE_PATH}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'treasury-dashboard',
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (r.status === 409 || r.status === 422) return jsonResponse({ error: 'conflict' }, 409);
  if (!r.ok) throw new Error(`GitHub PUT ${r.status}`);
  const data = await r.json();
  return jsonResponse({ sha: data.content.sha });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function decodeBase64(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
