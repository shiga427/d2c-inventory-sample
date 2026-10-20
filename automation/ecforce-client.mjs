/* ecforce Admin API v2 の最小クライアント（参照のみ・GET だけ）
   ecforce Admin API v2 の仕様に合わせた:
   - すべてのリクエストを直列化し最低 1100ms 空ける（IP 単位 1秒1リクエスト・24時間1万）
   - 429 は Retry-After か指数バックオフで最大3回再試行
   - 認証は Authorization: Token token="..."。トークンはログに出さない。URL のクエリもログに出さない
   - q は q[属性_述語]=値（Ransack）。日付は 'YYYY-MM-DD HH:MM:SS'。空白は %20
   - JSON:API の data[].attributes を平坦化。meta.total_pages でページ送り
   - 1回の走査に使える請求数の上限（maxRequests）を持ち、超えたら打ち切って呼び出し元に知らせる */

export class EcforceClient {
  constructor(opts) {
    if (!opts || !opts.baseUrl) throw new Error('baseUrl が必要です（環境変数 ECFORCE_BASE_URL）');
    if (!opts.token) throw new Error('token が必要です（環境変数 ECFORCE_API_TOKEN）');
    this.baseUrl = String(opts.baseUrl).replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.minIntervalMs = opts.minIntervalMs === undefined ? 1100 : opts.minIntervalMs;
    this.maxRetries = opts.maxRetries === undefined ? 3 : opts.maxRetries;
    this.backoffBaseMs = opts.backoffBaseMs === undefined ? 2000 : opts.backoffBaseMs;
    this.timeoutMs = opts.timeoutMs === undefined ? 60000 : opts.timeoutMs;
    this.maxRequests = opts.maxRequests === undefined ? 2000 : opts.maxRequests;
    this.log = opts.log || (() => {});
    this.chain = Promise.resolve();
    this.lastRequestAt = 0;
    this.requestCount = 0;
  }

  static buildQuery(params) {
    const sp = new URLSearchParams();
    const put = (k, v) => {
      if (v === null || v === undefined) return;
      if (Array.isArray(v)) { if (v.length) sp.append(k, v.join(',')); return; }
      if (typeof v === 'boolean') { sp.append(k, v ? '1' : '0'); return; }
      sp.append(k, String(v));
    };
    for (const [k, v] of Object.entries(params || {})) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'object' && !Array.isArray(v)) { for (const [sk, sv] of Object.entries(v)) put(`${k}[${sk}]`, sv); continue; }
      put(k, v);
    }
    return sp.toString().replace(/\+/g, '%20');
  }

  async get(path, params = {}) {
    const run = this.chain.then(() => this.requestWithRetry(path, params), () => this.requestWithRetry(path, params));
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async requestWithRetry(path, params) {
    let attempt = 0;
    for (;;) {
      if (this.requestCount >= this.maxRequests) { const e = new Error(`このプロセスの請求数の上限（${this.maxRequests}）に達したので打ち切りました`); e.code = 'BUDGET'; throw e; }
      await this.waitForSlot();
      try { return await this.request(path, params); }
      catch (e) {
        const retriable = e.code === 'RATE_LIMIT' || e.code === 'NETWORK';
        if (!retriable || attempt >= this.maxRetries) throw e;
        let waitMs = this.backoffBaseMs * 2 ** attempt;
        if (e.retryAfterSec) waitMs = Math.max(waitMs, e.retryAfterSec * 1000);
        attempt += 1;
        this.log(`${e.code} のため ${waitMs}ms 待って再試行（${attempt}/${this.maxRetries}）: GET ${path}`);
        await this.sleep(waitMs);
      }
    }
  }

  async waitForSlot() {
    if (this.minIntervalMs <= 0) return;
    const wait = this.minIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async request(path, params) {
    const query = EcforceClient.buildQuery(params);
    const url = `${this.baseUrl}/api/v2${path}.json${query ? `?${query}` : ''}`;
    this.requestCount += 1;
    this.log(`GET ${path}（${this.requestCount}件目）`);
    let res;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers: { Authorization: `Token token="${this.token}"`, Accept: 'application/json' }, signal: AbortSignal.timeout ? AbortSignal.timeout(this.timeoutMs) : undefined });
    } catch (e) { const err = new Error(`接続できませんでした: ${e && e.message ? e.message : e}`); err.code = 'NETWORK'; throw err; }
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (res.status === 429) {
      const ra = Number(res.headers && res.headers.get ? res.headers.get('retry-after') : null);
      const err = new Error('ecforce API のリクエスト上限（1秒1回・24時間1万回・IP単位）'); err.code = 'RATE_LIMIT'; err.retryAfterSec = Number.isFinite(ra) && ra > 0 ? ra : null; throw err;
    }
    if (!res.ok) { const err = new Error(`ecforce API がエラーを返しました（status ${res.status}）${body && body.errors ? ': ' + JSON.stringify(body.errors).slice(0, 300) : ''}`); err.code = 'HTTP'; err.status = res.status; throw err; }
    return body;
  }

  /* 一覧を全ページ取る。戻りは平坦化した attributes の配列と、打ち切り情報 */
  async fetchAll(path, params = {}, opts = {}) {
    const per = Math.min(100, Math.max(1, opts.perPage || 100));
    const maxPages = opts.maxPages || 200;
    const items = []; let meta = null; let truncated = false;
    for (let page = 1; ; page++) {
      const body = await this.get(path, { ...params, page, per });
      const data = body && Array.isArray(body.data) ? body.data : (body && body.data ? [body.data] : []);
      data.forEach((r) => items.push(flatten(r)));
      meta = body && body.meta ? body.meta : meta;
      const totalPages = meta && Number.isFinite(Number(meta.total_pages)) ? Number(meta.total_pages) : null;
      if (totalPages === null || page >= totalPages || data.length === 0) break;
      if (page >= maxPages) { truncated = true; break; }
    }
    return { items, meta, truncated, pages: Math.min(items.length ? Math.ceil(items.length / per) : 1, maxPages) };
  }
}

export function flatten(resource) {
  if (!resource || typeof resource !== 'object') return resource;
  const out = { ...(resource.attributes || {}) };
  if (out.id === undefined && resource.id !== undefined) out.id = resource.id;
  return out;
}

/* ---- fixture（ダミー）モード ----
   automation/fixtures/orders.json（受注の attributes の配列）を、本物の API と同じ形（JSON:API＋meta）で返す fetch。
   created_at / updated_at の gteq・lt、page・per を解釈する。トークン不要。 */
export function makeFixtureFetch(orders) {
  const norm = (s) => String(s || '').replace(/\//g, '-').slice(0, 19);
  return async (url) => {
    const u = new URL(url);
    const q = {}; for (const [k, v] of u.searchParams) q[k] = v;
    const m = u.pathname.match(/\/api\/v2(\/.+)\.json$/);
    if (!m || m[1] !== '/admin/orders') return { status: 404, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ errors: [{ title: 'not found' }] }) };
    let rows = orders.filter((o) => {
      const c = norm(o.created_at), uAt = norm(o.updated_at || o.created_at);
      if (q['q[created_at_gteq]'] && c < norm(q['q[created_at_gteq]'])) return false;
      if (q['q[created_at_lt]'] && c >= norm(q['q[created_at_lt]'])) return false;
      if (q['q[updated_at_gteq]'] && uAt < norm(q['q[updated_at_gteq]'])) return false;
      if (q['q[updated_at_lt]'] && uAt >= norm(q['q[updated_at_lt]'])) return false;
      return true;
    });
    rows = rows.slice().sort((a, b) => Number(b.id) - Number(a.id));
    const per = Math.min(100, Number(q.per) || 20), page = Number(q.page) || 1;
    const total = rows.length, totalPages = Math.max(1, Math.ceil(total / per));
    const slice = rows.slice((page - 1) * per, page * per);
    const body = { data: slice.map((o) => ({ id: String(o.id), type: 'order', attributes: o })), meta: { total_count: total, total_pages: totalPages, page, per, count: slice.length } };
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
}
