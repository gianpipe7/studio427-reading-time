import { createClient } from "../vendor/supabase.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";

// config.js sin tocar => mostramos la pantalla de setup en vez de fallar feo.
export const configured =
  /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)/i.test(SUPABASE_URL) &&
  SUPABASE_ANON_KEY.length > 40;

export const supabase = configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: "pdfsync.auth",
      },
      // La posición se manda como mucho cada 2 s por dispositivo; 5/s sobra.
      realtime: { params: { eventsPerSecond: 5 } },
    })
  : null;

export const BUCKET = "pdfs";
