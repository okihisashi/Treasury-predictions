// Cloudflare Worker: serves static dashboard + state API backed by GitHub
//
// Routes:
//   GET  /api/state    → load shared state from GitHub
//   PUT  /api/state    → save shared state to GitHub (with optimistic locking via SHA)
//   *                  → fall through to static assets (./public/index.html etc.)

const GITHUB_API = 'https://api.github.com';
const REPO       = 'okihisashi/Treasury-predictions';
const STATE_PATH = 'state.json';
const BRANCH     = 'main';

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    try {
      if (path === '/api/state' && method === 'GET') {
        return await loadState(env);
      }
      if (path === '/api/state' && method === 'PUT') {
        return await saveState(request, env);
      }
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }

    // Default: serve static asset (the dashboard HTML)
    return env.ASSETS.fetch(request);
  }
};

async function loadState(env) {
  const r = await fetch(
    `${GITHUB_API}/repos/${REPO}/contents/${STATE_PATH}?ref=${BRANCH}`,
    {
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'User-Agent': 'treasury-dashboard',
        'Accept': 'application/vnd.github.v3+json'
      }
    }
  );

  if (r.status === 404) {
    return jsonResponse({ state: null, sha: null });
  }
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`GitHub GET ${r.status}: ${txt.slice(0,200)}`);
  }
  const data    = await r.json();
  const content = decodeBase64(data.content);
  const state   = JSON.parse(content);
  return jsonResponse({ state, sha: data.sha });
}

async function saveState(request, env) {
  const body = await request.json();
  const { state, sha } = body;
  if (!state) {
    return jsonResponse({ error: 'state is required' }, 400);
  }

  const payload = {
    message: `Update dashboard state ${new Date().toISOString()}`,
    content: encodeBase64(JSON.stringify(state, null, 2)),
    branch:  BRANCH
  };
  if (sha) payload.sha = sha;

  const r = await fetch(
    `${GITHUB_API}/repos/${REPO}/contents/${STATE_PATH}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'User-Agent': 'treasury-dashboard',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  if (r.status === 409 || r.status === 422) {
    // SHA mismatch: someone else saved first
    return jsonResponse({ error: 'conflict' }, 409);
  }
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`GitHub PUT ${r.status}: ${txt.slice(0,200)}`);
  }
  const data = await r.json();
  return jsonResponse({ sha: data.content.sha });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
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
