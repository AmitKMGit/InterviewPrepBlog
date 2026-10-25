const NOTES_PATH = "site/notes.json";
const SESSION_TTL = 60 * 60 * 24 * 30;
const MAX_NOTES = 500;
const MAX_CONTENT_LENGTH = 200_000;

function jsonResponse(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== env.SITE_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function secureRandom(length = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function validNotes(value) {
  return Array.isArray(value) && value.length <= MAX_NOTES && value.every((note) =>
    note && typeof note.id === "string" && note.id.length <= 100
    && typeof note.title === "string" && note.title.length <= 500
    && typeof note.content === "string" && note.content.length <= MAX_CONTENT_LENGTH
  );
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "personal-notebook-sync"
  };
}

function githubUrl(env, path = "") {
  return `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}${path}`;
}

async function getGithubNotes(env, token) {
  const response = await fetch(githubUrl(env, `/contents/${NOTES_PATH}?ref=main`), {
    headers: githubHeaders(token)
  });
  if (response.status === 404) return { notes: [], sha: null };
  if (!response.ok) throw new Error(`GitHub notes read failed (${response.status}).`);
  const file = await response.json();
  const parsed = JSON.parse(decodeBase64(file.content));
  if (!validNotes(parsed)) throw new Error("The repository notes file has an invalid format.");
  return { notes: parsed, sha: file.sha };
}

async function currentNotes(request, env) {
  const session = await getSession(request, env);
  if (!session) return jsonResponse({ error: "Sign in with GitHub to sync notes." }, 401, corsHeaders(request, env));

  const pending = await env.NOTEBOOK_DATA.get("pending-notes", "json");
  if (pending) return jsonResponse({ notes: pending.notes, pending: true }, 200, corsHeaders(request, env));

  try {
    const remote = await getGithubNotes(env, session.githubToken);
    return jsonResponse({ notes: remote.notes, pending: false }, 200, corsHeaders(request, env));
  } catch (error) {
    console.error("Could not read GitHub notes.", error);
    return jsonResponse({ error: "Could not load notes from GitHub." }, 502, corsHeaders(request, env));
  }
}

async function getSession(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer ([a-f0-9]{64})$/);
  if (!match) return null;
  return env.NOTEBOOK_DATA.get(`session:${match[1]}`, "json");
}

async function queueNotes(request, env) {
  const session = await getSession(request, env);
  if (!session) return jsonResponse({ error: "Sign in with GitHub to sync notes." }, 401, corsHeaders(request, env));

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request must contain valid JSON." }, 400, corsHeaders(request, env));
  }

  if (!body || !validNotes(body.notes)
    || new TextEncoder().encode(JSON.stringify(body.notes)).byteLength > 900_000) {
    return jsonResponse({ error: "Notes are invalid or exceed the allowed size." }, 400, corsHeaders(request, env));
  }

  await env.NOTEBOOK_DATA.put("pending-notes", JSON.stringify({
    notes: body.notes,
    queuedAt: new Date().toISOString()
  }));
  return jsonResponse({ queued: true, message: "Queued for the next scheduled GitHub publish." }, 202, corsHeaders(request, env));
}

async function startLogin(request, env) {
  const state = secureRandom();
  await env.NOTEBOOK_DATA.put(`oauth-state:${state}`, "valid", { expirationTtl: 600 });
  const callback = `${new URL(request.url).origin}/api/auth/callback`;
  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", callback);
  authorizeUrl.searchParams.set("scope", "public_repo");
  authorizeUrl.searchParams.set("state", state);
  return Response.redirect(authorizeUrl.toString(), 302);
}

async function finishLogin(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code");
  const stateKey = `oauth-state:${state}`;
  const validState = /^[a-f0-9]{64}$/.test(state) && await env.NOTEBOOK_DATA.get(stateKey);
  if (!validState || !code) return Response.redirect(`${env.SITE_URL}?sync=failed`, 302);
  await env.NOTEBOOK_DATA.delete(stateKey);

  const callback = `${url.origin}/api/auth/callback`;
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callback
    })
  });
  if (!tokenResponse.ok) throw new Error(`GitHub OAuth failed (${tokenResponse.status}).`);
  const tokenResult = await tokenResponse.json();
  if (!tokenResult.access_token) throw new Error("GitHub did not return an access token.");

  const userResponse = await fetch("https://api.github.com/user", {
    headers: githubHeaders(tokenResult.access_token)
  });
  if (!userResponse.ok) throw new Error(`Could not verify GitHub account (${userResponse.status}).`);
  const user = await userResponse.json();
  if (user.login.toLocaleLowerCase() !== env.GITHUB_OWNER.toLocaleLowerCase()) {
    return Response.redirect(`${env.SITE_URL}?sync=wrong-account`, 302);
  }

  await env.NOTEBOOK_DATA.put("github-access-token", tokenResult.access_token);
  const sessionToken = secureRandom();
  await env.NOTEBOOK_DATA.put(`session:${sessionToken}`, JSON.stringify({
    githubToken: tokenResult.access_token,
    login: user.login
  }), { expirationTtl: SESSION_TTL });
  return Response.redirect(`${env.SITE_URL}#session=${sessionToken}`, 302);
}

async function schedulePublish(env) {
  const queued = await env.NOTEBOOK_DATA.get("pending-notes", "json");
  if (!queued) return;
  const token = await env.NOTEBOOK_DATA.get("github-access-token");
  if (!token) {
    console.error("Queued notes cannot publish until the notebook owner connects GitHub.");
    return;
  }

  const remote = await getGithubNotes(env, token);
  const content = `${JSON.stringify(queued.notes, null, 2)}\n`;
  if (JSON.stringify(remote.notes) !== JSON.stringify(queued.notes)) {
    const response = await fetch(githubUrl(env, `/contents/${NOTES_PATH}`), {
      method: "PUT",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Update notebook notes",
        content: encodeBase64(content),
        ...(remote.sha ? { sha: remote.sha } : {}),
        branch: "main"
      })
    });
    if (!response.ok) throw new Error(`GitHub note commit failed (${response.status}): ${await response.text()}`);
  }

  const dispatch = await fetch(githubUrl(env, "/dispatches"), {
    method: "POST",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ event_type: "notes-updated" })
  });
  if (!dispatch.ok) throw new Error(`GitHub Pages deploy request failed (${dispatch.status}): ${await dispatch.text()}`);
  const latestQueued = await env.NOTEBOOK_DATA.get("pending-notes", "json");
  if (latestQueued?.queuedAt === queued.queuedAt
    && JSON.stringify(latestQueued.notes) === JSON.stringify(queued.notes)) {
    await env.NOTEBOOK_DATA.delete("pending-notes");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/api/auth/login" && request.method === "GET") return await startLogin(request, env);
      if (url.pathname === "/api/auth/callback" && request.method === "GET") return await finishLogin(request, env);
      if (url.pathname === "/api/notes" && request.method === "GET") return await currentNotes(request, env);
      if (url.pathname === "/api/notes" && request.method === "PUT") return await queueNotes(request, env);
      return jsonResponse({ error: "Not found." }, 404, cors);
    } catch (error) {
      console.error("Notebook sync request failed.", error);
      return jsonResponse({ error: "Notebook sync failed. Check the Worker logs." }, 500, cors);
    }
  },

  async scheduled(_event, env, context) {
    context.waitUntil(schedulePublish(env).catch((error) => {
      console.error("Scheduled notebook publish failed.", error);
    }));
  }
};
