import * as fs from "node:fs";
import * as path from "node:path";
import { Database } from "bun:sqlite";

// ── Paths ────────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? "",
  "AppData", "LocalLow", "Wizards Of The Coast", "MTGA"
);
const DATA_DIR = process.env.TRACKER_DATA_DIR ?? "scraper";
const COLLECTION_FILE = path.join(DATA_DIR, "collection.json");
const DB_FILE = path.join(DATA_DIR, "history.sqlite");

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── SQLite ───────────────────────────────────────────────────────────────────

function openDb(): Database {
  const db = new Database(DB_FILE);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS collection_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS card_catalog (
      grp_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type_line TEXT,
      rarity TEXT,
      set_code TEXT,
      collector_number TEXT,
      legalities_json TEXT NOT NULL DEFAULT '{}',
      image_url TEXT,
      local_image TEXT,
      lookup_failed INTEGER NOT NULL DEFAULT 0,
      last_lookup_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collection_cards (
      grp_id TEXT PRIMARY KEY,
      quantity INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (grp_id) REFERENCES card_catalog (grp_id) ON DELETE CASCADE
    );
  `);
  return db;
}

interface CacheEntry {
  name: string;
  type_line: string;
  rarity: string;
  set: string;
  collectorNumber: string;
  legalities: Record<string, string>;
  imageUrl: string;
  localImage: string;
  lookupFailed: boolean;
  lastLookupAt: number | null;
}

function loadCacheFromDb(): Record<string, CacheEntry> {
  if (!fs.existsSync(DB_FILE)) return {};
  try {
    const db = openDb();
    const rows = db.query<any, []>(`
      SELECT grp_id, name, type_line, rarity, set_code, collector_number,
             legalities_json, image_url, local_image, lookup_failed, last_lookup_at
      FROM card_catalog ORDER BY grp_id ASC
    `).all();
    db.close();

    const cache: Record<string, CacheEntry> = {};
    for (const row of rows) {
      let legalities: Record<string, string> = {};
      try { legalities = JSON.parse(row.legalities_json || "{}"); } catch {}
      cache[String(row.grp_id)] = {
        name: row.name || `Card #${row.grp_id}`,
        type_line: row.type_line || "",
        rarity: row.rarity || "",
        set: row.set_code || "",
        collectorNumber: row.collector_number || "",
        legalities,
        imageUrl: row.image_url || "",
        localImage: row.local_image || "",
        lookupFailed: Boolean(row.lookup_failed),
        lastLookupAt: row.last_lookup_at ?? null,
      };
    }
    return cache;
  } catch {
    return {};
  }
}

function saveCacheToDb(cache: Record<string, CacheEntry>): void {
  try {
    const db = openDb();
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO card_catalog (
        grp_id, name, type_line, rarity, set_code, collector_number,
        legalities_json, image_url, local_image, lookup_failed, last_lookup_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(grp_id) DO UPDATE SET
        name = excluded.name, type_line = excluded.type_line, rarity = excluded.rarity,
        set_code = excluded.set_code, collector_number = excluded.collector_number,
        legalities_json = excluded.legalities_json, image_url = excluded.image_url,
        local_image = excluded.local_image, lookup_failed = excluded.lookup_failed,
        last_lookup_at = excluded.last_lookup_at, updated_at = excluded.updated_at
    `);
    const insertMany = db.transaction((entries: [string, CacheEntry][]) => {
      for (const [grpId, info] of entries) {
        stmt.run(
          grpId,
          info.name || `Card #${grpId}`,
          info.type_line || "",
          (info.rarity || "").toLowerCase(),
          (info.set || "").toUpperCase(),
          info.collectorNumber || "",
          JSON.stringify(info.legalities || {}),
          info.imageUrl || "",
          info.localImage || "",
          info.lookupFailed ? 1 : 0,
          info.lastLookupAt ?? null,
          now
        );
      }
    });
    insertMany(Object.entries(cache));
    db.close();
  } catch (e) {
    console.error("SQLite cache save failed:", e);
  }
}

interface CollectionCard {
  grpId: string;
  name: string;
  quantity: number;
  legalities: Record<string, string>;
  type: string;
  rarity: string;
  set: string;
}

function saveCollectionToDb(cards: CollectionCard[]): void {
  try {
    const db = openDb();
    const now = Date.now();

    const upsertCatalog = db.prepare(`
      INSERT INTO card_catalog (
        grp_id, name, type_line, rarity, set_code, collector_number,
        legalities_json, image_url, local_image, lookup_failed, last_lookup_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
      ON CONFLICT(grp_id) DO UPDATE SET
        name = excluded.name, type_line = excluded.type_line, rarity = excluded.rarity,
        set_code = excluded.set_code, legalities_json = excluded.legalities_json,
        updated_at = excluded.updated_at
    `);
    const upsertCard = db.prepare(`
      INSERT INTO collection_cards (grp_id, quantity, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(grp_id) DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at
    `);

    const persist = db.transaction((items: CollectionCard[]) => {
      db.exec("DELETE FROM collection_cards");
      for (const card of items) {
        upsertCatalog.run(
          card.grpId,
          card.name || `Card #${card.grpId}`,
          card.type || "",
          (card.rarity || "").toLowerCase(),
          (card.set || "").toUpperCase(),
          "",
          JSON.stringify(card.legalities || {}),
          "",
          now
        );
        upsertCard.run(card.grpId, card.quantity, now);
      }
    });
    persist(cards);
    db.close();
  } catch (e) {
    console.error("SQLite collection save failed:", e);
  }
}

// ── Scryfall ─────────────────────────────────────────────────────────────────

async function fetchCardInfo(grpId: string, cache: Record<string, CacheEntry>): Promise<CacheEntry | null> {
  if (cache[grpId]) return cache[grpId];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.scryfall.com/cards/arena/${grpId}`, {
        headers: { "User-Agent": "MTGA-Tracker/1.0" },
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        const data: any = await res.json();
        const entry: CacheEntry = {
          name: data.name ?? "Unknown",
          type_line: data.type_line ?? "",
          rarity: data.rarity ?? "",
          set: (data.set ?? "").toUpperCase(),
          collectorNumber: data.collector_number ?? "",
          legalities: data.legalities ?? {},
          imageUrl: data.image_uris?.normal ?? data.image_uris?.small ?? "",
          localImage: "",
          lookupFailed: false,
          lastLookupAt: Date.now(),
        };
        cache[grpId] = entry;
        await Bun.sleep(100); // respect Scryfall rate limit
        return entry;
      } else if (res.status === 429) {
        console.log(`Rate limited — waiting (attempt ${attempt + 1})`);
        await Bun.sleep(2000 * (attempt + 1));
      } else if (res.status === 404) {
        return null;
      } else {
        console.log(`HTTP ${res.status} for grpId ${grpId}`);
      }
    } catch (e) {
      console.error(`Request failed for ${grpId}:`, e);
      await Bun.sleep(1000);
    }
  }
  return null;
}

// ── Log parsing ──────────────────────────────────────────────────────────────

function extractJsonObjects(text: string): any[] {
  const objs: any[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        try { objs.push(JSON.parse(text.slice(start, i + 1))); } catch {}
        start = -1;
      }
    }
  }
  return objs;
}

async function extractCollection(): Promise<void> {
  const collection: Record<string, number> = {};
  let hasFullCollection = false;
  const cache = loadCacheFromDb();

  console.log("Scanning MTGA logs for collection data...");

  for (const logName of ["Player-prev.log", "Player.log"]) {
    const logPath = path.join(LOG_DIR, logName);
    if (!fs.existsSync(logPath)) continue;

    console.log(`Processing ${logName}...`);
    const content = fs.readFileSync(logPath, "utf-8");

    // 1. Full collection via Inventory.GetPlayerCardsV2
    for (const obj of extractJsonObjects(content)) {
      if (obj?.method === "Inventory.GetPlayerCardsV2") {
        const payload = obj?.payload;
        if (payload && typeof payload === "object" && Object.keys(payload).length > 100) {
          console.log(`  -> Found full collection in ${logName} (${Object.keys(payload).length} cards)`);
          hasFullCollection = true;
          for (const [gid, qty] of Object.entries(payload)) {
            collection[String(gid)] = Number(qty);
          }
        }
      }
    }

    // 2. Fallback: aggregate from deck data
    if (!hasFullCollection) {
      for (const match of content.matchAll(/"MainDeck":\s*\[(.*?)\]/gs)) {
        try {
          const cards = JSON.parse("[" + match[1] + "]");
          for (const card of cards) {
            const gid = String(card.cardId ?? card.grpId ?? card.GrpId ?? "");
            const qty = Number(card.quantity ?? card.Quantity ?? 1);
            if (gid && gid !== "undefined") collection[gid] = Math.max(collection[gid] ?? 0, qty);
          }
        } catch {}
      }

      for (const match of content.matchAll(/"DeckCards":\s*\{(.*?)\}/gs)) {
        try {
          const cards = JSON.parse("{" + match[1] + "}");
          for (const [gid, qty] of Object.entries(cards)) {
            collection[String(gid)] = Math.max(collection[String(gid)] ?? 0, Number(qty));
          }
        } catch {}
      }
    }
  }

  if (Object.keys(collection).length === 0) {
    console.log("No collection data found in logs.");
    return;
  }

  const ids = Object.keys(collection).sort((a, b) => Number(a) - Number(b));
  console.log(`Found ${ids.length} unique card IDs. Resolving metadata from Scryfall...`);

  const resolved: CollectionCard[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (i % 100 === 0) {
      console.log(`Progress: ${i}/${ids.length}...`);
      saveCacheToDb(cache);
    }

    const gid = ids[i];
    const info = await fetchCardInfo(gid, cache);
    if (info) {
      resolved.push({
        grpId: gid,
        name: info.name,
        quantity: collection[gid],
        legalities: info.legalities,
        type: info.type_line,
        rarity: info.rarity,
        set: info.set,
      });
    }
  }

  fs.writeFileSync(COLLECTION_FILE, JSON.stringify(resolved, null, 2));
  saveCollectionToDb(resolved);
  saveCacheToDb(cache);
  console.log(`\nExported ${resolved.length} cards to ${COLLECTION_FILE}`);
}

// ── Entry point ──────────────────────────────────────────────────────────────

(async () => { await extractCollection(); })();
