/**
 * S.H.I.T Journal PDF Proxy Worker
 *
 * 作用：缓存代理 Supabase 存储，避免直接打原站
 * - 每篇 PDF 只从 Supabase 取一次，之后走 Cloudflare 边缘缓存
 * - 论文列表 API 缓存 5 分钟
 * - 内置 IP 级别限流（每 IP 每分钟 10 次请求）
 *
 * 部署方式：Cloudflare Workers（免费额度 10万次/天，足够用）
 */

const SUPABASE_URL = 'https://bcgdqepzakcufaadgnda.supabase.co';
const API_KEY = 'sb_publishable_wHqWLjQwO2lMwkGLeBktng_Mk_xf5xd';
const STORAGE_BUCKET = 'manuscripts';

// Rate limit config
const RATE_LIMIT_MAX = 10;       // max requests per window
const RATE_LIMIT_WINDOW = 60;    // window in seconds

// CORS headers
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Only allow GET
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    // ====== Rate Limiting (using Cloudflare KV or in-memory for free tier) ======
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitResult = await checkRateLimit(env, clientIP);
    if (!rateLimitResult.ok) {
      return jsonResponse({
        error: 'Rate limit exceeded. Please wait before making more requests.',
        retryAfter: rateLimitResult.retryAfter
      }, 429, {
        'Retry-After': String(rateLimitResult.retryAfter),
        'X-RateLimit-Remaining': '0',
      });
    }

    // ====== Routes ======
    try {
      // GET /api/papers — cached paper list
      if (url.pathname === '/api/papers') {
        return await handlePaperList(request, ctx);
      }

      // GET /api/pdf/:id — cached PDF download
      if (url.pathname.startsWith('/api/pdf/')) {
        const filePath = decodeURIComponent(url.pathname.replace('/api/pdf/', ''));
        return await handlePdfDownload(request, ctx, filePath, {
          remaining: rateLimitResult.remaining
        });
      }

      // Serve static files (fallback to index.html)
      return new Response('Not Found. Available endpoints: /api/papers, /api/pdf/:path', {
        status: 404,
        headers: CORS_HEADERS
      });

    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  }
};

// ====== Paper List Handler (cached 5 min) ======
async function handlePaperList(request, ctx) {
  const cacheKey = new Request('https://cache.internal/api/papers', request);
  const cache = caches.default;

  // Check cache first
  let response = await cache.match(cacheKey);
  if (response) {
    return addCorsHeaders(response, { 'X-Cache': 'HIT' });
  }

  // Fetch from Supabase
  const supabaseRes = await fetch(
    `${SUPABASE_URL}/rest/v1/preprints_with_ratings_mat?select=id,manuscript_title,author_name,zone,file_path,file_size_bytes,created_at,avg_score,rating_count&order=created_at.desc&limit=500`,
    {
      headers: {
        'apikey': API_KEY,
        'Authorization': `Bearer ${API_KEY}`,
      }
    }
  );

  if (!supabaseRes.ok) {
    return jsonResponse({ error: `Supabase error: ${supabaseRes.status}` }, 502);
  }

  const data = await supabaseRes.json();

  // Create cacheable response (5 min TTL)
  response = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',  // 5 min
      ...CORS_HEADERS,
      'X-Cache': 'MISS',
    }
  });

  // Store in cache (non-blocking)
  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}

// ====== PDF Download Handler (cached 7 days) ======
async function handlePdfDownload(request, ctx, filePath, rateInfo) {
  // Validate file path (must look like uuid/filename.pdf)
  if (!filePath.match(/^[a-f0-9\-]+\/.+\.pdf$/i)) {
    return jsonResponse({ error: 'Invalid file path' }, 400);
  }

  const cacheKey = new Request(`https://cache.internal/api/pdf/${filePath}`, request);
  const cache = caches.default;

  // Check cache first
  let response = await cache.match(cacheKey);
  if (response) {
    const newHeaders = new Headers(response.headers);
    newHeaders.set('X-Cache', 'HIT');
    newHeaders.set('X-RateLimit-Remaining', String(rateInfo.remaining));
    Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
    return new Response(response.body, { status: 200, headers: newHeaders });
  }

  // Fetch from Supabase storage
  const supabaseRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${filePath}`,
    {
      headers: {
        'apikey': API_KEY,
        'Authorization': `Bearer ${API_KEY}`,
      }
    }
  );

  if (!supabaseRes.ok) {
    return jsonResponse({ error: `PDF not found or Supabase error: ${supabaseRes.status}` }, supabaseRes.status === 404 ? 404 : 502);
  }

  // Create cacheable response (7 day TTL — PDFs don't change)
  response = new Response(supabaseRes.body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'public, max-age=604800',  // 7 days
      ...CORS_HEADERS,
      'X-Cache': 'MISS',
      'X-RateLimit-Remaining': String(rateInfo.remaining),
    }
  });

  // Store in cache (non-blocking)
  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}

// ====== Rate Limiter (using CF Cache API as storage) ======
async function checkRateLimit(env, clientIP) {
  const cache = caches.default;
  const key = new Request(`https://ratelimit.internal/${clientIP}`);

  let entry = await cache.match(key);
  let data = { count: 0, resetAt: Date.now() + RATE_LIMIT_WINDOW * 1000 };

  if (entry) {
    try {
      data = await entry.json();
      // Window expired, reset
      if (Date.now() > data.resetAt) {
        data = { count: 0, resetAt: Date.now() + RATE_LIMIT_WINDOW * 1000 };
      }
    } catch {
      data = { count: 0, resetAt: Date.now() + RATE_LIMIT_WINDOW * 1000 };
    }
  }

  data.count++;
  const remaining = Math.max(0, RATE_LIMIT_MAX - data.count);
  const ttl = Math.max(1, Math.ceil((data.resetAt - Date.now()) / 1000));

  // Save updated count
  const updated = new Response(JSON.stringify(data), {
    headers: { 'Cache-Control': `public, max-age=${ttl}` }
  });
  // Fire-and-forget cache put
  await cache.put(key, updated);

  if (data.count > RATE_LIMIT_MAX) {
    return { ok: false, retryAfter: ttl };
  }
  return { ok: true, remaining };
}

// ====== Helpers ======
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...extraHeaders,
    }
  });
}

function addCorsHeaders(response, extra = {}) {
  const headers = new Headers(response.headers);
  Object.entries({ ...CORS_HEADERS, ...extra }).forEach(([k, v]) => headers.set(k, v));
  return new Response(response.body, { status: response.status, headers });
}
