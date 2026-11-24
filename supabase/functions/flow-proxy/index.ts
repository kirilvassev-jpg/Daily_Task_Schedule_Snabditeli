import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// ───────── Приложения ─────────
// secret   – един flow за приложението
// actions  – няколко flow-а (действие → Secret)
// fields   – кои полета се пропускат (ако raw не е зададено)
// raw      – данните се препращат без промяна, а отговорът на flow-а се връща към страницата
// restricted – служителят трябва да е в app_access за това приложение
// drivers  – разрешен е вход на шофьори с PIN
type AppCfg = {
  secret?: string; actions?: Record<string, string>; fields?: string[];
  raw?: boolean; restricted?: boolean; drivers?: boolean;
};
const FLOWS: Record<string, AppCfg> = {
  "supplier-evaluation": {
    secret: "FLOW_SUPPLIER_EVAL",
    fields: ["evaluator", "supplier", "date", "quality", "delivery",
             "documentation", "price", "total", "classification"],
  },
  "register-zayavki": {
    secret: "FLOW_REGISTER_ZAYAVKI",
    fields: ["direction", "object", "deadline", "transport", "staff"],
    restricted: true,
  },
  "daily-tasks": {
    actions: { save: "FLOW_DT_SAVE", get: "FLOW_DT_GET", update: "FLOW_DT_UPDATE", "edit-details": "FLOW_DT_UPDATE" },
    raw: true, restricted: true, drivers: true,
  },
};

const TASK_DETAIL_FIELDS = new Set(["supplier", "specialist", "direction", "deadline", "place", "officeNote"]);

function validTaskDetails(id: unknown, details: unknown): boolean {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 ||
      !details || typeof details !== "object" || Array.isArray(details)) return false;
  const fields = Object.entries(details);
  return fields.length > 0 && fields.every(([key, value]) => {
    if (!TASK_DETAIL_FIELDS.has(key)) return false;
    if (key !== "deadline") return typeof value === "string";
    if (value === null) return true;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + "T00:00:00Z");
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });
}

// ───────── CORS ─────────
const norm = (o: string) => o.trim().replace(/\/+$/, "").toLowerCase();
const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map(norm).filter(Boolean);

function cors(req: Request) {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED.includes(norm(origin)) ? origin : "null",
    "Access-Control-Allow-Headers":
      req.headers.get("Access-Control-Request-Headers") ??
      "authorization, apikey, content-type, x-client-info, x-driver-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const reply = (status: number, body: unknown, h: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...h, "Content-Type": "application/json" } });

// ───────── Пропуски за шофьори (HMAC-SHA256, 30 дни) ─────────
const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (s: string) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const hmacKey = () => crypto.subtle.importKey(
  "raw", enc.encode(Deno.env.get("DRIVER_TOKEN_SECRET") ?? ""),
  { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

async function makeDriverToken(name: string) {
  const payload = b64url(enc.encode(JSON.stringify({ d: name, exp: Math.floor(Date.now() / 1000) + 30 * 86400 })));
  const sig = b64url(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(payload)));
  return payload + "." + sig;
}
async function readDriverToken(tok: string): Promise<string | null> {
  try {
    const [p, s] = tok.split(".");
    if (!p || !s) return null;
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(), b64urlDecode(s), enc.encode(p));
    if (!ok) return null;
    const obj = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    if (!obj.exp || obj.exp < Date.now() / 1000) return null;
    return obj.d ?? null;
  } catch { return null; }
}

// ───────── Основна логика ─────────
Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") ?? "";
  const h = cors(req);

  if (req.method === "OPTIONS") {
    if (!ALLOWED.includes(norm(origin))) console.log("OPTIONS: origin not allowed:", origin, "allowed:", ALLOWED);
    return new Response("ok", { headers: h });
  }
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" }, h);
  if (!ALLOWED.includes(norm(origin))) { console.log("POST: origin not allowed:", origin); return reply(403, { error: "origin_not_allowed" }, h); }

  let body: any;
  try { body = await req.json(); } catch { return reply(400, { error: "bad_json" }, h); }
  if (body?.app === "daily-tasks" && typeof body.action !== "string") return reply(400, { error: "unknown_action" }, h);
  const cfg = typeof body?.app === "string" && Object.hasOwn(FLOWS, body.app) ? FLOWS[body.app] : undefined;
  if (!cfg) { console.log("unknown app:", body?.app); return reply(400, { error: "unknown_app" }, h); }

  const URL_ = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

  // A. Вход на шофьор: име + PIN → пропуск
  if (body.action === "driver-login") {
    if (!cfg.drivers) return reply(400, { error: "drivers_not_allowed" }, h);
    const name = String(body.data?.name ?? "").trim();
    const pin = String(body.data?.pin ?? "");
    if (!name || !/^\d{6}$/.test(pin)) return reply(400, { error: "bad_input" }, h);
    const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: res, error } = await admin.rpc("verify_driver_pin", { p_name: name, p_pin: pin });
    if (error) { console.log("pin check error:", error.message); return reply(500, { error: "pin_check_failed" }, h); }
    if (res === "ok") { console.log("driver login ok:", name); return reply(200, { token: await makeDriverToken(name), name }, h); }
    console.log("driver login", res, name);
    if (res === "locked") return reply(423, { error: "locked" }, h);
    return reply(401, { error: "wrong_pin" }, h);
  }

  // B. Кой изпраща заявката
  let who = "";
  const driverTok = req.headers.get("x-driver-token");
  if (driverTok && cfg.drivers) {
    const name = await readDriverToken(driverTok);
    if (!name) return reply(401, { error: "driver_session_expired" }, h);
    if (body.app === "daily-tasks" && body.action === "edit-details") {
      return reply(403, { error: "office_access_required" }, h);
    }
    who = "driver:" + name;
  } else {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return reply(401, { error: "not_signed_in" }, h);
    const { data: { user }, error } = await createClient(URL_, ANON).auth.getUser(token);
    if (error || !user) return reply(401, { error: "invalid_session" }, h);
    const providers: string[] = user.app_metadata?.providers ?? [user.app_metadata?.provider];
    if (!providers.includes("azure")) return reply(403, { error: "microsoft_login_required" }, h);
    if (cfg.restricted) {
      const userDb = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${token}` } } });
      const { data: acc, error: accErr } = await userDb.from("app_access").select("id")
        .eq("app", body.app).eq("is_active", true).limit(1);
      if (accErr || !acc?.length) { console.log("access denied:", user.email, body.app); return reply(403, { error: "not_authorized" }, h); }
    }
    who = user.email ?? "";
  }

  // C. Кой flow
  const secretName = cfg.actions ? cfg.actions[body.action] : cfg.secret;
  if (!secretName) return reply(400, { error: "unknown_action" }, h);
  const flowUrl = Deno.env.get(secretName);
  if (!flowUrl) { console.log("missing secret:", secretName); return reply(500, { error: "flow_not_configured" }, h); }

  // D. Данни
  let payload: Record<string, unknown>;
  if (cfg.raw) {
    payload = (body.data && typeof body.data === "object") ? body.data : {};
    if (body.app === "daily-tasks") {
      if (body.action !== "edit-details" && Object.hasOwn(payload, "details")) {
        return reply(400, { error: "use_edit_details" }, h);
      }
      if (body.action === "edit-details") {
        const { id, details } = payload;
        if (!validTaskDetails(id, details)) return reply(400, { error: "invalid_task_details" }, h);
        payload = { id, details };
      }
    }
    if (JSON.stringify(payload).length > 20000) return reply(413, { error: "too_large" }, h);
  } else {
    const data = body.data ?? {};
    payload = {};
    for (const f of cfg.fields ?? []) if (f in data) payload[f] = data[f];
    payload.submitted_by = who;
    payload.submitted_at = new Date().toISOString();
  }

  // E. Само портиерът има ключа за flow-а
  const resp = await fetch(flowUrl, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });

  if (cfg.raw) {
    if (!resp.ok) console.log("flow failed:", body.app, body.action, resp.status, who);
    const responseBody = resp.status === 204 || resp.status === 205 || resp.status === 304 ? null : await resp.text();
    return new Response(responseBody, {
      status: resp.status,
      headers: { ...h, "Content-Type": resp.headers.get("Content-Type") ?? "application/json" },
    });
  }
  if (!resp.ok) { console.log("flow failed:", resp.status, await resp.text()); return reply(502, { error: "flow_failed", status: resp.status }, h); }
  console.log("ok:", body.app, who);
  return reply(200, { ok: true }, h);
});
