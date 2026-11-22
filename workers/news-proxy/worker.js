const ALLOWED_ORIGINS = [
  "https://aguilarealmexicana.org",
  "https://www.aguilarealmexicana.org"
];
const TOKEN_TTL_SECONDS = 60 * 60 * 6;
const NEWS_INDEX_KEY = "news:index";
const NEWS_ITEM_PREFIX = "news:item:";
const TOKEN_PREFIX = "news:token:";
const XC_CACHE_KEY = "xenocanto:aquila-chrysaetos:v1";
const XC_CACHE_FRESH_MS = 1000 * 60 * 60 * 24 * 7;
const XC_CACHE_TTL_SEC = 60 * 60 * 24 * 30;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const isAllowed =
      ALLOWED_ORIGINS.includes(origin) ||
      origin.includes("localhost") ||
      origin.includes("127.0.0.1");
    const corsHeaders = isAllowed
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-News-Token"
        }
      : {};

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (!env.NEWS_KV) {
      return json({ error: "KV no configurado (binding NEWS_KV)" }, 500, corsHeaders);
    }

    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "";

    try {
      if (action === "feed" && request.method === "GET") {
        const items = await getActiveFeed(env);
        return json({ ok: true, items }, 200, corsHeaders);
      }
      if (action === "eagle-sounds" && request.method === "GET") {
        const recordings = await getEagleSounds(env);
        return json({ ok: true, recordings }, 200, corsHeaders);
      }
      if (action === "img" && request.method === "GET") {
        return await handleGetImage(request, env, corsHeaders);
      }
      if (action === "login" && request.method === "POST") {
        return await handleLogin(request, env, corsHeaders);
      }

      const token = request.headers.get("X-News-Token") || "";
      const authed = token && (await env.NEWS_KV.get(TOKEN_PREFIX + token));
      if (!authed) {
        return json({ error: "No autorizado" }, 401, corsHeaders);
      }
      if (action === "list" && request.method === "GET") {
        const items = await getAllItems(env);
        return json({ ok: true, items }, 200, corsHeaders);
      }
      if (action === "create" && request.method === "POST") {
        return await handleCreate(request, env, corsHeaders);
      }
      if (action === "update" && request.method === "POST") {
        return await handleUpdate(request, env, corsHeaders);
      }
      if (action === "delete" && request.method === "POST") {
        return await handleDelete(request, env, corsHeaders);
      }
      if (action === "toggle" && request.method === "POST") {
        return await handleToggle(request, env, corsHeaders);
      }
      if (action === "upload_img" && request.method === "POST") {
        return await handleUploadImage(request, env, corsHeaders, url);
      }
      return json({ error: "Accion desconocida" }, 400, corsHeaders);
    } catch (err) {
      return json({ error: "Error interno: " + err.message }, 500, corsHeaders);
    }
  }
};

async function handleGetImage(request, env, corsHeaders) {
  if (!env.NEWS_IMAGES) {
    return json({ error: "R2 no configurado (binding NEWS_IMAGES)" }, 500, corsHeaders);
  }
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  if (!id) return json({ error: "Falta id" }, 400, corsHeaders);
  const obj = await env.NEWS_IMAGES.get(id);
  if (!obj) return json({ error: "Imagen no encontrada" }, 404, corsHeaders);
  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", obj.httpMetadata?.contentType || "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { status: 200, headers });
}

async function handleUploadImage(request, env, corsHeaders, reqUrl) {
  if (!env.NEWS_IMAGES) {
    return json({ error: "R2 no configurado (binding NEWS_IMAGES)" }, 500, corsHeaders);
  }
  const token = request.headers.get("X-News-Token") || "";
  const authed = token && (await env.NEWS_KV.get(TOKEN_PREFIX + token));
  if (!authed) return json({ error: "No autorizado" }, 401, corsHeaders);
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Solicitud invalida (se esperaba FormData)" }, 400, corsHeaders);
  }
  const file = form.get("image") || form.get("file") || form.get("img");
  if (!file || typeof file === "string") {
    return json({ error: "Falta archivo de imagen" }, 400, corsHeaders);
  }
  const MAX_BYTES = 5 * 1024 * 1024;
  if (file.size > MAX_BYTES) {
    return json({ error: "Imagen demasiado grande (max 5 MB)" }, 400, corsHeaders);
  }
  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const contentType = file.type || "application/octet-stream";
  if (!allowedTypes.includes(contentType)) {
    return json({ error: "Tipo de imagen no permitido (usa jpg, png, webp o gif)" }, 400, corsHeaders);
  }
  const ext = contentType.split("/")[1] || "bin";
  const id = crypto.randomUUID() + "." + ext;
  const buf = await file.arrayBuffer();
  await env.NEWS_IMAGES.put(id, buf, { httpMetadata: { contentType } });
  const imgUrl = `${reqUrl.origin}${reqUrl.pathname}?action=img&id=${encodeURIComponent(id)}`;
  return json({ ok: true, url: imgUrl, img: imgUrl }, 200, corsHeaders);
}

async function handleLogin(request, env, corsHeaders) {
  if (!env.NEWS_PASSWORD) {
    return json({ error: "Contrasena no configurada (Secret NEWS_PASSWORD)" }, 500, corsHeaders);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Solicitud invalida" }, 400, corsHeaders);
  }
  const pwd = String(body?.password || "");
  if (!pwd || pwd !== env.NEWS_PASSWORD) {
    return json({ error: "Contrasena incorrecta" }, 401, corsHeaders);
  }
  const token = crypto.randomUUID();
  await env.NEWS_KV.put(TOKEN_PREFIX + token, "1", { expirationTtl: TOKEN_TTL_SECONDS });
  return json({ ok: true, token }, 200, corsHeaders);
}

async function getIndex(env) {
  const raw = await env.NEWS_KV.get(NEWS_INDEX_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function saveIndex(env, ids) {
  await env.NEWS_KV.put(NEWS_INDEX_KEY, JSON.stringify(ids));
}

async function getAllItems(env) {
  const ids = await getIndex(env);
  const items = [];
  for (const id of ids) {
    const raw = await env.NEWS_KV.get(NEWS_ITEM_PREFIX + id);
    if (raw) items.push(JSON.parse(raw));
  }
  items.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return items;
}

async function getActiveFeed(env) {
  const items = await getAllItems(env);
  const now = Date.now();
  return items.filter((it) => {
    if (!it.active) return false;
    if (it.expiry) {
      const exp = Date.parse(it.expiry);
      if (!isNaN(exp) && exp < now) return false;
    }
    return true;
  });
}

function sanitizeItem(body, existing) {
  const s = (v, max) => String(v ?? "").slice(0, max || 2000);
  return {
    id: existing?.id,
    title: s(body.title, 200),
    title_en: s(body.title_en, 200),
    summary: s(body.summary, 800),
    summary_en: s(body.summary_en, 800),
    url: s(body.url, 500),
    tag: s(body.tag, 40),
    expiry: s(body.expiry, 40),
    img: s(body.img, 500),
    active: body.active !== undefined ? !!body.active : existing?.active !== false,
    created_at: existing?.created_at || new Date().toISOString()
  };
}

async function handleCreate(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Solicitud invalida" }, 400, corsHeaders);
  }
  const id = crypto.randomUUID();
  const item = sanitizeItem(body, null);
  item.id = id;
  await env.NEWS_KV.put(NEWS_ITEM_PREFIX + id, JSON.stringify(item));
  const ids = await getIndex(env);
  ids.push(id);
  await saveIndex(env, ids);
  return json({ ok: true, item }, 200, corsHeaders);
}

async function handleUpdate(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Solicitud invalida" }, 400, corsHeaders);
  }
  const id = String(body?.id || "");
  if (!id) return json({ error: "Falta id" }, 400, corsHeaders);
  const raw = await env.NEWS_KV.get(NEWS_ITEM_PREFIX + id);
  if (!raw) return json({ error: "No encontrado" }, 404, corsHeaders);
  const existing = JSON.parse(raw);
  const item = sanitizeItem(body, existing);
  await env.NEWS_KV.put(NEWS_ITEM_PREFIX + id, JSON.stringify(item));
  return json({ ok: true, item }, 200, corsHeaders);
}

async function handleDelete(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Solicitud invalida" }, 400, corsHeaders);
  }
  const id = String(body?.id || "");
  if (!id) return json({ error: "Falta id" }, 400, corsHeaders);
  await env.NEWS_KV.delete(NEWS_ITEM_PREFIX + id);
  const ids = await getIndex(env);
  await saveIndex(
    env,
    ids.filter((x) => x !== id)
  );
  return json({ ok: true }, 200, corsHeaders);
}

async function handleToggle(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Solicitud invalida" }, 400, corsHeaders);
  }
  const id = String(body?.id || "");
  if (!id) return json({ error: "Falta id" }, 400, corsHeaders);
  const raw = await env.NEWS_KV.get(NEWS_ITEM_PREFIX + id);
  if (!raw) return json({ error: "No encontrado" }, 404, corsHeaders);
  const item = JSON.parse(raw);
  item.active = !item.active;
  await env.NEWS_KV.put(NEWS_ITEM_PREFIX + id, JSON.stringify(item));
  return json({ ok: true, item }, 200, corsHeaders);
}

async function getEagleSounds(env) {
  const cached = await env.NEWS_KV.get(XC_CACHE_KEY, "json");
  const cacheFresh =
    cached &&
    Array.isArray(cached.recordings) &&
    cached.recordings.length > 0 &&
    Date.now() - cached.fetchedAt < XC_CACHE_FRESH_MS;
  if (cacheFresh) return cached.recordings;

  const stale =
    cached && Array.isArray(cached.recordings) && cached.recordings.length
      ? cached.recordings
      : null;

  if (!env.XENOCANTO_API_KEY) {
    if (stale) return stale;
    throw new Error("XENOCANTO_API_KEY no configurada");
  }

  try {
    const query = encodeURIComponent('sp:"Aquila chrysaetos"');
    const apiUrl =
      "https://xeno-canto.org/api/3/recordings?query=" +
      query +
      "&per_page=100&key=" +
      env.XENOCANTO_API_KEY;
    const resp = await fetch(apiUrl, {
      headers: { Accept: "application/json" }
    });
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (!resp.ok || !ct.includes("application/json")) {
      if (stale) return stale;
      throw new Error(
        "xeno-canto API blocked or non-JSON (" +
          resp.status +
          ", " +
          (ct || "no-ct") +
          ")"
      );
    }
    const text = await resp.text();
    if (!text || text.trimStart().startsWith("<")) {
      if (stale) return stale;
      throw new Error("xeno-canto API returned HTML (Anubis/WAF)");
    }
    const raw = JSON.parse(text);
    const recordings = (raw.recordings || []).map((r) => ({
      id: r.id,
      genus: r.gen,
      species: r.sp,
      recordist: r.rec,
      country: r.cnt,
      locality: r.loc,
      date: r.date,
      time: r.time,
      quality: r.q,
      type: r.type || null,
      remarks: r.rmk || null,
      lic: r.lic,
      fileUrl: r.file,
      sonoUrl: (r.sono && r.sono.med) || null,
      length: r.length,
      url: r.url
    }));
    if (!recordings.length) {
      if (stale) return stale;
      return [];
    }
    await env.NEWS_KV.put(
      XC_CACHE_KEY,
      JSON.stringify({ fetchedAt: Date.now(), recordings }),
      { expirationTtl: XC_CACHE_TTL_SEC }
    );
    return recordings;
  } catch (err) {
    if (stale) return stale;
    throw err;
  }
}

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders }
  });
}
