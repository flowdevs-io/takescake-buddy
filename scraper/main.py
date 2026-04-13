import os
import json
import re
import sqlite3
from pathlib import Path
import requests
import time

# Constants
LOG_DIR = Path(os.path.expandvars(r"%USERPROFILE%\AppData\LocalLow\Wizards Of The Coast\MTGA"))
DATA_DIR = Path(os.environ.get("TRACKER_DATA_DIR") or "scraper")
CACHE_FILE = DATA_DIR / "card_cache.json"
COLLECTION_FILE = DATA_DIR / "collection.json"
HISTORY_DB_FILE = DATA_DIR / "history.sqlite"

DATA_DIR.mkdir(parents=True, exist_ok=True)

def get_db_connection():
    conn = sqlite3.connect(HISTORY_DB_FILE)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def ensure_collection_tables(conn):
    conn.executescript("""
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
    """)

def load_cache_from_db():
    if not HISTORY_DB_FILE.exists():
        return {}

    try:
        with get_db_connection() as conn:
            ensure_collection_tables(conn)
            rows = conn.execute("""
                SELECT
                    grp_id,
                    name,
                    type_line,
                    rarity,
                    set_code,
                    collector_number,
                    legalities_json,
                    image_url,
                    local_image,
                    lookup_failed,
                    last_lookup_at
                FROM card_catalog
                ORDER BY grp_id ASC
            """).fetchall()
    except Exception:
        return {}

    cache = {}
    for row in rows:
        try:
            legalities = json.loads(row[6] or "{}")
        except Exception:
            legalities = {}

        cache[str(row[0])] = {
            "name": row[1] or f"Card #{row[0]}",
            "type_line": row[2] or "",
            "rarity": row[3] or "",
            "set": row[4] or "",
            "collectorNumber": row[5] or "",
            "legalities": legalities,
            "imageUrl": row[7] or "",
            "localImage": row[8] or "",
            "lookupFailed": bool(row[9]),
            "lastLookupAt": row[10]
        }

    return cache

def save_cache_to_db(cache):
    try:
        with get_db_connection() as conn:
            ensure_collection_tables(conn)
            now = int(time.time() * 1000)
            rows = []
            for grp_id, info in cache.items():
                if isinstance(info, str):
                    info = {"name": info}
                info = info or {}
                rows.append((
                    str(grp_id),
                    info.get("name") or f"Card #{grp_id}",
                    info.get("type_line") or "",
                    (info.get("rarity") or "").lower(),
                    (info.get("set") or "").upper(),
                    info.get("collectorNumber") or "",
                    json.dumps(info.get("legalities") or {}),
                    info.get("imageUrl") or "",
                    info.get("localImage") or "",
                    1 if info.get("lookupFailed") else 0,
                    info.get("lastLookupAt"),
                    now
                ))

            conn.executemany("""
                INSERT INTO card_catalog (
                    grp_id,
                    name,
                    type_line,
                    rarity,
                    set_code,
                    collector_number,
                    legalities_json,
                    image_url,
                    local_image,
                    lookup_failed,
                    last_lookup_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(grp_id) DO UPDATE SET
                    name = excluded.name,
                    type_line = excluded.type_line,
                    rarity = excluded.rarity,
                    set_code = excluded.set_code,
                    collector_number = excluded.collector_number,
                    legalities_json = excluded.legalities_json,
                    image_url = excluded.image_url,
                    local_image = excluded.local_image,
                    lookup_failed = excluded.lookup_failed,
                    last_lookup_at = excluded.last_lookup_at,
                    updated_at = excluded.updated_at
            """, rows)
            conn.commit()
    except Exception as exc:
        print(f"SQLite cache save failed: {exc}")

def save_collection_to_db(cards):
    try:
        with get_db_connection() as conn:
            ensure_collection_tables(conn)
            now = int(time.time() * 1000)
            conn.execute("DELETE FROM collection_cards")

            catalog_rows = []
            collection_rows = []
            for card in cards:
                grp_id = str(card.get("grpId") or "")
                quantity = int(card.get("quantity") or 0)
                if not grp_id or quantity <= 0:
                    continue

                catalog_rows.append((
                    grp_id,
                    card.get("name") or f"Card #{grp_id}",
                    card.get("type") or "",
                    (card.get("rarity") or "").lower(),
                    (card.get("set") or "").upper(),
                    card.get("collectorNumber") or "",
                    json.dumps(card.get("legalities") or {}),
                    card.get("imageUrl") or "",
                    card.get("localImage") or "",
                    1 if card.get("lookupFailed") else 0,
                    card.get("lastLookupAt"),
                    now
                ))
                collection_rows.append((grp_id, quantity, now))

            conn.executemany("""
                INSERT INTO card_catalog (
                    grp_id,
                    name,
                    type_line,
                    rarity,
                    set_code,
                    collector_number,
                    legalities_json,
                    image_url,
                    local_image,
                    lookup_failed,
                    last_lookup_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(grp_id) DO UPDATE SET
                    name = excluded.name,
                    type_line = excluded.type_line,
                    rarity = excluded.rarity,
                    set_code = excluded.set_code,
                    collector_number = excluded.collector_number,
                    legalities_json = excluded.legalities_json,
                    image_url = excluded.image_url,
                    local_image = excluded.local_image,
                    lookup_failed = excluded.lookup_failed,
                    last_lookup_at = excluded.last_lookup_at,
                    updated_at = excluded.updated_at
            """, catalog_rows)
            conn.executemany("""
                INSERT INTO collection_cards (grp_id, quantity, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(grp_id) DO UPDATE SET
                    quantity = excluded.quantity,
                    updated_at = excluded.updated_at
            """, collection_rows)
            conn.commit()
    except Exception as exc:
        print(f"SQLite collection save failed: {exc}")

def load_cache():
    db_cache = load_cache_from_db()
    if db_cache:
        return db_cache

    if CACHE_FILE.exists():
        with open(CACHE_FILE, "r") as f:
            try:
                return json.load(f)
            except:
                return {}
    return {}

def save_cache(cache):
    save_cache_to_db(cache)
    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f, indent=2)

def get_card_info(grp_id, cache):
    grp_id = str(grp_id)
    if grp_id in cache:
        return cache[grp_id]
    
    retries = 3
    for attempt in range(retries):
        try:
            url = f"https://api.scryfall.com/cards/arena/{grp_id}"
            response = requests.get(url, timeout=10)
            if response.status_code == 200:
                data = response.json()
                info = {
                    "name": data.get("name", "Unknown"),
                    "legalities": data.get("legalities", {}),
                    "type_line": data.get("type_line", ""),
                    "rarity": data.get("rarity", ""),
                    "set": data.get("set", "").upper()
                }
                cache[grp_id] = info
                time.sleep(0.1) # Respect Scryfall rate limit
                return info
            elif response.status_code == 429:
                print(f"Rate limited. Waiting longer... (Attempt {attempt+1})")
                time.sleep(2 * (attempt + 1))
            elif response.status_code == 404:
                return None
            else:
                print(f"Error {response.status_code} for {grp_id}")
        except Exception as e:
            print(f"Request failed for {grp_id}: {e}")
            time.sleep(1)
    return None

def get_json_objects(text):
    """Surgically extract JSON objects using bracket counting."""
    objs = []
    bracket_count = 0
    start_pos = -1
    
    for i, char in enumerate(text):
        if char == '{':
            if bracket_count == 0:
                start_pos = i
            bracket_count += 1
        elif char == '}':
            bracket_count -= 1
            if bracket_count == 0 and start_pos != -1:
                try:
                    obj = json.loads(text[start_pos:i+1])
                    objs.append(obj)
                except:
                    pass
                start_pos = -1
    return objs

def extract_collection():
    collection = {} # grpId -> quantity
    has_full_collection = False
    cache = load_cache()
    
    print(f"Scanning MTGA logs for collection and deck data...")
    
    # Process previous then current to ensure current overrides
    for log_name in ["Player-prev.log", "Player.log"]:
        log_path = LOG_DIR / log_name
        if not log_path.exists(): continue
        
        print(f"Processing {log_name}...")
        with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
            
            # 1. Look for Full Collection (Inventory.GetPlayerCardsV2)
            objs = get_json_objects(content)
            for obj in objs:
                if not isinstance(obj, dict): continue
                if obj.get("method") == "Inventory.GetPlayerCardsV2":
                    payload = obj.get("payload", {})
                    if isinstance(payload, dict) and len(payload) > 100:
                        print(f"  -> Found full collection in {log_name} ({len(payload)} cards)")
                        has_full_collection = True
                        for gid, qty in payload.items():
                            collection[str(gid)] = int(qty)
            
            # 2. Fallback: Aggregate from Decks (only if we didn't find full collection yet)
            if not has_full_collection:
                # Find "MainDeck":[...]
                matches = re.finditer(r'"MainDeck":\s*\[(.*?)\]', content, re.DOTALL)
                for match in matches:
                    try:
                        array_str = "[" + match.group(1) + "]"
                        cards = json.loads(array_str)
                        for card in cards:
                            gid = str(card.get("cardId") or card.get("grpId") or card.get("GrpId"))
                            qty = card.get("quantity") or card.get("Quantity") or 1
                            if gid != 'None':
                                collection[gid] = max(collection.get(gid, 0), qty)
                    except: pass

                # Find "DeckCards":{...}
                matches = re.finditer(r'"DeckCards":\s*\{(.*?)\}', content, re.DOTALL)
                for match in matches:
                    try:
                        obj_str = "{" + match.group(1) + "}"
                        cards = json.loads(obj_str)
                        for gid, qty in cards.items():
                            collection[str(gid)] = max(collection.get(str(gid), 0), int(qty))
                    except: pass

    if not collection:
        print("No collection data found.")
        return

    print(f"Found {len(collection)} unique IDs. Resolving metadata...")
    
    resolved_collection = []
    sorted_ids = sorted(collection.keys(), key=int)
    
    for i, gid in enumerate(sorted_ids):
        if i % 100 == 0:
            print(f"Progress: {i}/{len(collection)}...")
            save_cache(cache)
            
        info = get_card_info(gid, cache)
        if info:
            resolved_collection.append({
                "grpId": gid,
                "name": info["name"],
                "quantity": collection[gid],
                "legalities": info["legalities"],
                "type": info["type_line"],
                "rarity": info["rarity"],
                "set": info["set"]
            })

    # Save final results
    with open(COLLECTION_FILE, "w") as f:
        json.dump(resolved_collection, f, indent=2)
    
    save_collection_to_db(resolved_collection)
    save_cache(cache)
    print(f"\nSuccessfully exported {len(resolved_collection)} cards to {COLLECTION_FILE}")

if __name__ == "__main__":
    extract_collection()
