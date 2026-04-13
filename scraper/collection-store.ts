import { existsSync, readFileSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";

const COLLECTION_SCHEMA_VERSION = 3;
const DEFAULT_AI_CARD_LIMIT = 96;
const COLOR_ORDER = ["W", "U", "B", "R", "G", "C"] as const;

export type CardCatalogEntry = {
    grpId: string;
    name: string;
    type_line?: string;
    rarity?: string;
    set?: string;
    collectorNumber?: string;
    legalities?: Record<string, string>;
    imageUrl?: string;
    localImage?: string;
    colors?: string[];
    colorsKnown?: boolean;
    lookupFailed?: boolean;
    lastLookupAt?: number | null;
};

export type CollectionCard = {
    grpId: string;
    name: string;
    quantity: number;
    legalities: Record<string, string>;
    type: string;
    rarity: string;
    set: string;
    collectorNumber?: string;
    imageUrl?: string;
    localImage?: string;
    colors?: string[];
    colorsKnown?: boolean;
    lookupFailed?: boolean;
    lastLookupAt?: number | null;
};

type RawCatalogRow = {
    grp_id: string;
    name: string;
    type_line: string | null;
    rarity: string | null;
    set_code: string | null;
    collector_number: string | null;
    legalities_json: string | null;
    image_url: string | null;
    local_image: string | null;
    colors_json: string | null;
    colors_known: number | null;
    lookup_failed: number | null;
    last_lookup_at: number | null;
};

type RawCollectionRow = RawCatalogRow & {
    quantity: number;
};

type CollectionQueryOptions = {
    query?: string | null;
    format?: string | null;
    includeBasicLands?: boolean;
    limit?: number | null;
};

type CollectionSummaryOptions = CollectionQueryOptions & {
    maxCards?: number | null;
};

function parseJsonValue<T>(value: string | null | undefined, fallback: T): T {
    if (!value) return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

function normalizeText(value: unknown) {
    return String(value ?? "").trim();
}

function normalizeUppercase(value: unknown) {
    return normalizeText(value).toUpperCase();
}

function normalizeLowercase(value: unknown) {
    return normalizeText(value).toLowerCase();
}

function normalizeInteger(value: unknown, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : fallback;
}

function normalizeColors(value: unknown) {
    if (!Array.isArray(value)) return [];

    const unique = new Set<string>();
    for (const entry of value) {
        const normalized = normalizeUppercase(entry);
        if (!COLOR_ORDER.includes(normalized as typeof COLOR_ORDER[number])) continue;
        unique.add(normalized);
    }

    return COLOR_ORDER.filter((color) => unique.has(color));
}

function isPlaceholderName(name: string | undefined, grpId: string) {
    return !normalizeText(name) || normalizeText(name) === `Card #${grpId}`;
}

function mergeLegalities(
    base: Record<string, string> | undefined,
    patch: Record<string, string> | undefined
) {
    const merged: Record<string, string> = { ...(base || {}) };
    for (const [format, status] of Object.entries(patch || {})) {
        if (!normalizeText(format) || !normalizeText(status)) continue;
        merged[format] = status;
    }
    return merged;
}

function mergeCatalogEntry(
    grpId: string,
    base: Partial<CardCatalogEntry> | null | undefined,
    patch: Partial<CardCatalogEntry> | null | undefined
): CardCatalogEntry {
    const baseName = normalizeText(base?.name);
    const patchName = normalizeText(patch?.name);
    const resolvedName = patchName && !isPlaceholderName(patchName, grpId)
        ? patchName
        : baseName || patchName || `Card #${grpId}`;
    const hasResolvedName = !isPlaceholderName(resolvedName, grpId);
    const lookupFailed = hasResolvedName
        ? false
        : Boolean(patch?.lookupFailed ?? base?.lookupFailed);
    const resolvedColorsKnown = patch?.colorsKnown == null
        ? Boolean(base?.colorsKnown)
        : Boolean(patch.colorsKnown);
    const resolvedColors = patch?.colors == null
        ? normalizeColors(base?.colors)
        : normalizeColors(patch.colors);

    return {
        grpId,
        name: resolvedName,
        type_line: normalizeText(patch?.type_line) || normalizeText(base?.type_line) || "",
        rarity: normalizeLowercase(patch?.rarity) || normalizeLowercase(base?.rarity) || "",
        set: normalizeUppercase(patch?.set) || normalizeUppercase(base?.set) || "",
        collectorNumber: normalizeText(patch?.collectorNumber) || normalizeText(base?.collectorNumber) || "",
        legalities: mergeLegalities(base?.legalities, patch?.legalities),
        imageUrl: normalizeText(patch?.imageUrl) || normalizeText(base?.imageUrl) || "",
        localImage: normalizeText(patch?.localImage) || normalizeText(base?.localImage) || "",
        colors: resolvedColors,
        colorsKnown: resolvedColorsKnown,
        lookupFailed,
        lastLookupAt: patch?.lastLookupAt ?? base?.lastLookupAt ?? null
    };
}

function rowToCatalogEntry(row: RawCatalogRow): CardCatalogEntry {
    return {
        grpId: String(row.grp_id),
        name: normalizeText(row.name) || `Card #${row.grp_id}`,
        type_line: normalizeText(row.type_line),
        rarity: normalizeLowercase(row.rarity),
        set: normalizeUppercase(row.set_code),
        collectorNumber: normalizeText(row.collector_number),
        legalities: parseJsonValue<Record<string, string>>(row.legalities_json, {}),
        imageUrl: normalizeText(row.image_url),
        localImage: normalizeText(row.local_image),
        colors: parseJsonValue<string[]>(row.colors_json, []),
        colorsKnown: Boolean(row.colors_known),
        lookupFailed: Boolean(row.lookup_failed),
        lastLookupAt: row.last_lookup_at ?? null
    };
}

function rowToCollectionCard(row: RawCollectionRow): CollectionCard {
    const catalog = rowToCatalogEntry(row);
    return {
        grpId: catalog.grpId,
        name: catalog.name,
        quantity: normalizeInteger(row.quantity),
        legalities: catalog.legalities || {},
        type: catalog.type_line || "",
        rarity: catalog.rarity || "",
        set: catalog.set || "",
        collectorNumber: catalog.collectorNumber || "",
        imageUrl: catalog.imageUrl || "",
        localImage: catalog.localImage || "",
        colors: catalog.colors || [],
        colorsKnown: Boolean(catalog.colorsKnown),
        lookupFailed: catalog.lookupFailed,
        lastLookupAt: catalog.lastLookupAt ?? null
    };
}

function normalizeCatalogPatch(grpId: string, value: unknown): Partial<CardCatalogEntry> | null {
    const key = normalizeText(grpId);
    if (!key) return null;

    if (typeof value === "string") {
        return { grpId: key, name: normalizeText(value) || `Card #${key}` };
    }

    if (!value || typeof value !== "object") {
        return { grpId: key, name: `Card #${key}` };
    }

    const source = value as Record<string, unknown>;
    const hasColors = Array.isArray(source.colors) || Array.isArray(source.color_identity);
    const hasKnownColorsFlag = typeof source.colorsKnown === "boolean";
    return {
        grpId: key,
        name: normalizeText(source.name) || `Card #${key}`,
        type_line: normalizeText(source.type_line),
        rarity: normalizeLowercase(source.rarity),
        set: normalizeUppercase(source.set),
        collectorNumber: normalizeText(source.collectorNumber),
        legalities: source.legalities && typeof source.legalities === "object"
            ? source.legalities as Record<string, string>
            : {},
        imageUrl: normalizeText(source.imageUrl),
        localImage: normalizeText(source.localImage),
        colors: hasColors ? normalizeColors(source.colors ?? source.color_identity) : undefined,
        colorsKnown: hasKnownColorsFlag ? Boolean(source.colorsKnown) : hasColors,
        lookupFailed: Boolean(source.lookupFailed),
        lastLookupAt: source.lastLookupAt == null ? null : normalizeInteger(source.lastLookupAt)
    };
}

function normalizeCollectionCard(value: unknown): CollectionCard | null {
    if (!value || typeof value !== "object") return null;
    const source = value as Record<string, unknown>;
    const grpId = normalizeText(source.grpId);
    const quantity = normalizeInteger(source.quantity);
    const hasColors = Array.isArray(source.colors) || Array.isArray(source.color_identity);
    const hasKnownColorsFlag = typeof source.colorsKnown === "boolean";
    if (!grpId || quantity <= 0) return null;

    return {
        grpId,
        name: normalizeText(source.name) || `Card #${grpId}`,
        quantity,
        legalities: source.legalities && typeof source.legalities === "object"
            ? source.legalities as Record<string, string>
            : {},
        type: normalizeText(source.type),
        rarity: normalizeLowercase(source.rarity),
        set: normalizeUppercase(source.set),
        collectorNumber: normalizeText(source.collectorNumber),
        imageUrl: normalizeText(source.imageUrl),
        localImage: normalizeText(source.localImage),
        colors: hasColors ? normalizeColors(source.colors ?? source.color_identity) : [],
        colorsKnown: hasKnownColorsFlag ? Boolean(source.colorsKnown) : hasColors,
        lookupFailed: Boolean(source.lookupFailed),
        lastLookupAt: source.lastLookupAt == null ? null : normalizeInteger(source.lastLookupAt)
    };
}

function buildFileSignature(path: string) {
    if (!path || !existsSync(path)) return "";
    const stats = statSync(path);
    return `${Math.floor(stats.mtimeMs)}:${stats.size}`;
}

function isBasicLand(card: Pick<CollectionCard, "name" | "type">) {
    return /\bbasic land\b/i.test(String(card.type || "")) || /^plains$|^island$|^swamp$|^mountain$|^forest$/i.test(String(card.name || ""));
}

function matchesCollectionQuery(card: CollectionCard, query?: string | null) {
    const token = normalizeText(query).toLowerCase();
    if (!token) return true;
    const haystack = [card.name, card.type, card.rarity, card.set].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(token);
}

function matchesFormat(card: CollectionCard, format?: string | null) {
    const normalizedFormat = normalizeLowercase(format);
    if (!normalizedFormat || normalizedFormat === "all") return true;
    return card.legalities?.[normalizedFormat] === "legal";
}

function toBroadType(typeLine: string) {
    const value = String(typeLine || "").toLowerCase();
    if (value.includes("planeswalker")) return "planeswalkers";
    if (value.includes("creature")) return "creatures";
    if (value.includes("instant") || value.includes("sorcery") || value.includes("enchantment") || value.includes("artifact")) {
        return "spells";
    }
    if (value.includes("land")) return "lands";
    return "other";
}

function rarityScore(rarity: string) {
    switch (normalizeLowercase(rarity)) {
        case "mythic":
            return 4;
        case "rare":
            return 3;
        case "uncommon":
            return 2;
        case "common":
            return 1;
        default:
            return 0;
    }
}

function cardSignalScore(card: CollectionCard) {
    const quantityScore = Math.min(card.quantity || 0, 4) * 20;
    const rarityWeight = rarityScore(card.rarity) * 8;
    const typeWeight = toBroadType(card.type) === "lands" ? 2 : 0;
    return quantityScore + rarityWeight - typeWeight;
}

function filterCards(cards: CollectionCard[], options?: CollectionQueryOptions) {
    const filtered = cards.filter((card) => {
        if (!options?.includeBasicLands && isBasicLand(card)) return false;
        if (!matchesCollectionQuery(card, options?.query)) return false;
        if (!matchesFormat(card, options?.format)) return false;
        return true;
    });

    filtered.sort((left, right) => {
        return (right.quantity || 0) - (left.quantity || 0)
            || rarityScore(right.rarity) - rarityScore(left.rarity)
            || (left.name || "").localeCompare(right.name || "");
    });

    if (options?.limit && options.limit > 0) {
        return filtered.slice(0, options.limit);
    }

    return filtered;
}

function buildHighSignalCards(cards: CollectionCard[], maxCards = DEFAULT_AI_CARD_LIMIT) {
    const buckets = new Map<string, CollectionCard[]>();
    for (const card of [...cards].sort((left, right) => {
        return cardSignalScore(right) - cardSignalScore(left)
            || (right.quantity || 0) - (left.quantity || 0)
            || (left.name || "").localeCompare(right.name || "");
    })) {
        const bucket = toBroadType(card.type);
        if (!buckets.has(bucket)) buckets.set(bucket, []);
        buckets.get(bucket)!.push(card);
    }

    const limits: Record<string, number> = {
        planeswalkers: Math.max(6, Math.floor(maxCards * 0.12)),
        creatures: Math.max(24, Math.floor(maxCards * 0.36)),
        spells: Math.max(22, Math.floor(maxCards * 0.32)),
        lands: Math.max(14, Math.floor(maxCards * 0.14)),
        other: Math.max(6, Math.floor(maxCards * 0.06))
    };

    const selected: CollectionCard[] = [];
    for (const bucket of ["planeswalkers", "creatures", "spells", "lands", "other"]) {
        selected.push(...(buckets.get(bucket) || []).slice(0, limits[bucket]));
    }

    return selected
        .sort((left, right) => {
            return toBroadType(left.type).localeCompare(toBroadType(right.type))
                || cardSignalScore(right) - cardSignalScore(left)
                || (right.quantity || 0) - (left.quantity || 0)
                || (left.name || "").localeCompare(right.name || "");
        })
        .slice(0, maxCards);
}

function ensureCollectionSchema(db: Database) {
    db.exec(`
        create table if not exists collection_meta (
            key text primary key,
            value text not null
        );

        create table if not exists card_catalog (
            grp_id text primary key,
            name text not null,
            type_line text,
            rarity text,
            set_code text,
            collector_number text,
            legalities_json text not null default '{}',
            image_url text,
            local_image text,
            colors_json text not null default '[]',
            colors_known integer not null default 0,
            lookup_failed integer not null default 0,
            last_lookup_at integer,
            updated_at integer not null
        );

        create table if not exists collection_cards (
            grp_id text primary key,
            quantity integer not null,
            updated_at integer not null,
            foreign key (grp_id) references card_catalog (grp_id) on delete cascade
        );
    `);

    const currentVersion = Number(
        (db.query("select value from collection_meta where key = 'schema_version'").get() as { value?: string } | null)?.value ?? "1"
    );

    if (currentVersion < 2) {
        try {
            db.exec("alter table card_catalog add column colors_json text not null default '[]'");
        } catch {
            // Column already exists.
        }
    }

    if (currentVersion < 3) {
        try {
            db.exec("alter table card_catalog add column colors_known integer not null default 0");
        } catch {
            // Column already exists.
        }
    }

    db.query(`
        insert into collection_meta (key, value)
        values ('schema_version', $value)
        on conflict(key) do update set value = excluded.value
    `).run({ $value: String(COLLECTION_SCHEMA_VERSION) });
}

export function createCollectionStore(dbPath: string) {
    const db = new Database(dbPath);
    db.exec("pragma journal_mode = WAL;");
    db.exec("pragma foreign_keys = ON;");
    ensureCollectionSchema(db);

    const getMetaStatement = db.query(`
        select value
        from collection_meta
        where key = $key
    `);

    const upsertMetaStatement = db.query(`
        insert into collection_meta (key, value)
        values ($key, $value)
        on conflict(key) do update set value = excluded.value
    `);

    const loadCatalogStatement = db.query(`
        select
            grp_id,
            name,
            type_line,
            rarity,
            set_code,
            collector_number,
            legalities_json,
            image_url,
            local_image,
            colors_json,
            colors_known,
            lookup_failed,
            last_lookup_at
        from card_catalog
        order by name asc, grp_id asc
    `);

    const loadCollectionStatement = db.query(`
        select
            c.grp_id,
            catalog.name,
            catalog.type_line,
            catalog.rarity,
            catalog.set_code,
            catalog.collector_number,
            catalog.legalities_json,
            catalog.image_url,
            catalog.local_image,
            catalog.colors_json,
            catalog.colors_known,
            catalog.lookup_failed,
            catalog.last_lookup_at,
            c.quantity
        from collection_cards c
        left join card_catalog catalog
            on catalog.grp_id = c.grp_id
        order by c.quantity desc, catalog.name asc, c.grp_id asc
    `);

    const getCatalogEntryStatement = db.query(`
        select
            grp_id,
            name,
            type_line,
            rarity,
            set_code,
            collector_number,
            legalities_json,
            image_url,
            local_image,
            colors_json,
            colors_known,
            lookup_failed,
            last_lookup_at
        from card_catalog
        where grp_id = $grpId
    `);

    const clearCollectionStatement = db.query("delete from collection_cards");

    const upsertCatalogEntryStatement = db.query(`
        insert into card_catalog (
            grp_id,
            name,
            type_line,
            rarity,
            set_code,
            collector_number,
            legalities_json,
            image_url,
            local_image,
            colors_json,
            colors_known,
            lookup_failed,
            last_lookup_at,
            updated_at
        ) values (
            $grpId,
            $name,
            $typeLine,
            $rarity,
            $setCode,
            $collectorNumber,
            $legalitiesJson,
            $imageUrl,
            $localImage,
            $colorsJson,
            $colorsKnown,
            $lookupFailed,
            $lastLookupAt,
            $updatedAt
        )
        on conflict(grp_id) do update set
            name = excluded.name,
            type_line = excluded.type_line,
            rarity = excluded.rarity,
            set_code = excluded.set_code,
            collector_number = excluded.collector_number,
            legalities_json = excluded.legalities_json,
            image_url = excluded.image_url,
            local_image = excluded.local_image,
            colors_json = excluded.colors_json,
            colors_known = excluded.colors_known,
            lookup_failed = excluded.lookup_failed,
            last_lookup_at = excluded.last_lookup_at,
            updated_at = excluded.updated_at
    `);

    const upsertCollectionEntryStatement = db.query(`
        insert into collection_cards (grp_id, quantity, updated_at)
        values ($grpId, $quantity, $updatedAt)
        on conflict(grp_id) do update set
            quantity = excluded.quantity,
            updated_at = excluded.updated_at
    `);

    function getMetaValue(key: string) {
        const row = getMetaStatement.get({ $key: key }) as { value?: string } | null;
        return row?.value ?? "";
    }

    function setMetaValue(key: string, value: string) {
        upsertMetaStatement.run({ $key: key, $value: value });
    }

    function loadCatalogMap() {
        const rows = loadCatalogStatement.all() as RawCatalogRow[];
        return new Map(rows.map((row) => [String(row.grp_id), rowToCatalogEntry(row)]));
    }

    function writeCatalogEntry(entry: CardCatalogEntry) {
        upsertCatalogEntryStatement.run({
            $grpId: entry.grpId,
            $name: normalizeText(entry.name) || `Card #${entry.grpId}`,
            $typeLine: normalizeText(entry.type_line),
            $rarity: normalizeLowercase(entry.rarity),
            $setCode: normalizeUppercase(entry.set),
            $collectorNumber: normalizeText(entry.collectorNumber),
            $legalitiesJson: JSON.stringify(entry.legalities || {}),
            $imageUrl: normalizeText(entry.imageUrl),
            $localImage: normalizeText(entry.localImage),
            $colorsJson: JSON.stringify(normalizeColors(entry.colors)),
            $colorsKnown: entry.colorsKnown ? 1 : 0,
            $lookupFailed: entry.lookupFailed ? 1 : 0,
            $lastLookupAt: entry.lastLookupAt ?? null,
            $updatedAt: Date.now()
        });
    }

    const replaceCollectionTransaction = db.transaction((cards: CollectionCard[]) => {
        const existingCatalog = loadCatalogMap();
        clearCollectionStatement.run();

        for (const card of cards) {
            const merged = mergeCatalogEntry(card.grpId, existingCatalog.get(card.grpId), {
                grpId: card.grpId,
                name: card.name,
                type_line: card.type,
                rarity: card.rarity,
                set: card.set,
                collectorNumber: card.collectorNumber,
                legalities: card.legalities,
                imageUrl: card.imageUrl,
                localImage: card.localImage,
                lookupFailed: card.lookupFailed,
                lastLookupAt: card.lastLookupAt ?? null
            });
            existingCatalog.set(card.grpId, merged);
            writeCatalogEntry(merged);
            upsertCollectionEntryStatement.run({
                $grpId: card.grpId,
                $quantity: card.quantity,
                $updatedAt: Date.now()
            });
        }
    });

    const mergeCatalogSnapshotTransaction = db.transaction((entries: Array<[string, Partial<CardCatalogEntry>]>) => {
        const existingCatalog = loadCatalogMap();
        for (const [grpId, patch] of entries) {
            const merged = mergeCatalogEntry(grpId, existingCatalog.get(grpId), patch);
            existingCatalog.set(grpId, merged);
            writeCatalogEntry(merged);
        }
    });

    function selectCollectionCards(options?: CollectionQueryOptions) {
        const rows = loadCollectionStatement.all() as RawCollectionRow[];
        return filterCards(rows.map(rowToCollectionCard), options);
    }

    return {
        syncFromLegacyFiles(paths: { collectionPath?: string | null; cachePath?: string | null }) {
            let changed = false;
            const collectionPath = normalizeText(paths.collectionPath);
            const cachePath = normalizeText(paths.cachePath);

            const collectionSignature = buildFileSignature(collectionPath);
            if (collectionSignature && collectionSignature !== getMetaValue("legacy_collection_signature")) {
                const rawCards = parseJsonValue<unknown[]>(readFileSync(collectionPath, "utf-8"), []);
                const normalizedCards = rawCards
                    .map(normalizeCollectionCard)
                    .filter((card): card is CollectionCard => Boolean(card));
                replaceCollectionTransaction(normalizedCards);
                setMetaValue("legacy_collection_signature", collectionSignature);
                changed = true;
            }

            const cacheSignature = buildFileSignature(cachePath);
            if (cacheSignature && cacheSignature !== getMetaValue("legacy_cache_signature")) {
                const rawCache = parseJsonValue<Record<string, unknown>>(readFileSync(cachePath, "utf-8"), {});
                const entries = Object.entries(rawCache)
                    .map(([grpId, value]) => [grpId, normalizeCatalogPatch(grpId, value)] as [string, Partial<CardCatalogEntry> | null])
                    .filter((entry): entry is [string, Partial<CardCatalogEntry>] => Boolean(entry[1]));
                mergeCatalogSnapshotTransaction(entries);
                setMetaValue("legacy_cache_signature", cacheSignature);
                changed = true;
            }

            return changed;
        },
        loadCardCatalogCacheObject() {
            const rows = loadCatalogStatement.all() as RawCatalogRow[];
            return rows.reduce<Record<string, Record<string, unknown>>>((acc, row) => {
                const entry = rowToCatalogEntry(row);
                acc[entry.grpId] = {
                    name: entry.name,
                    type_line: entry.type_line || "",
                    rarity: entry.rarity || "",
                    set: entry.set || "",
                    collectorNumber: entry.collectorNumber || "",
                    legalities: entry.legalities || {},
                    imageUrl: entry.imageUrl || "",
                    localImage: entry.localImage || "",
                    colors: entry.colors || [],
                    colorsKnown: Boolean(entry.colorsKnown),
                    lookupFailed: Boolean(entry.lookupFailed),
                    lastLookupAt: entry.lastLookupAt ?? null
                };
                return acc;
            }, {});
        },
        loadCollectionIndexMap() {
            const rows = loadCollectionStatement.all() as RawCollectionRow[];
            return new Map(
                rows.map((row) => {
                    const card = rowToCollectionCard(row);
                    return [
                        card.grpId,
                        {
                            name: card.name,
                            type_line: card.type,
                            rarity: card.rarity,
                            set: card.set,
                            legalities: card.legalities || {},
                            colors: card.colors || [],
                            colorsKnown: Boolean(card.colorsKnown)
                        }
                    ];
                })
            );
        },
        upsertCardCatalogEntry(grpId: string, patch: Record<string, unknown>) {
            const normalizedPatch = normalizeCatalogPatch(grpId, patch);
            if (!normalizedPatch) return false;

            const row = getCatalogEntryStatement.get({ $grpId: String(grpId) }) as RawCatalogRow | null;
            const merged = mergeCatalogEntry(String(grpId), row ? rowToCatalogEntry(row) : null, normalizedPatch);
            writeCatalogEntry(merged);
            return true;
        },
        loadCollectionCards(options?: CollectionQueryOptions) {
            return selectCollectionCards(options);
        },
        buildCollectionSummary(options?: CollectionSummaryOptions) {
            const cards = selectCollectionCards(options);
            const totalCopies = cards.reduce((sum, card) => sum + (card.quantity || 0), 0);
            const setCount = new Set(cards.map((card) => card.set).filter(Boolean)).size;
            const rarityBuckets = {
                mythic: 0,
                rare: 0,
                uncommon: 0,
                common: 0,
                other: 0
            };
            const typeBuckets = {
                planeswalkers: 0,
                creatures: 0,
                spells: 0,
                lands: 0,
                other: 0
            };

            for (const card of cards) {
                const rarity = normalizeLowercase(card.rarity);
                if (rarity in rarityBuckets) {
                    rarityBuckets[rarity as keyof typeof rarityBuckets] += card.quantity || 0;
                } else {
                    rarityBuckets.other += card.quantity || 0;
                }
                typeBuckets[toBroadType(card.type) as keyof typeof typeBuckets] += card.quantity || 0;
            }

            return {
                filter: {
                    query: normalizeText(options?.query),
                    format: normalizeLowercase(options?.format) || "all",
                    includeBasicLands: Boolean(options?.includeBasicLands)
                },
                totals: {
                    uniqueCards: cards.length,
                    copies: totalCopies,
                    sets: setCount
                },
                rarity: rarityBuckets,
                types: typeBuckets,
                highSignalCards: buildHighSignalCards(cards, options?.maxCards || 24)
            };
        },
        buildCollectionAiContext(options?: CollectionSummaryOptions & { prompt?: string | null }) {
            const format = normalizeLowercase(options?.format) || "all";
            const query = normalizeText(options?.query);
            const maxCards = options?.maxCards || DEFAULT_AI_CARD_LIMIT;
            const summary = this.buildCollectionSummary({
                query,
                format,
                includeBasicLands: false,
                maxCards
            });
            const cards = summary.highSignalCards as CollectionCard[];
            const grouped = new Map<string, CollectionCard[]>();
            for (const card of cards) {
                const bucket = toBroadType(card.type);
                if (!grouped.has(bucket)) grouped.set(bucket, []);
                grouped.get(bucket)!.push(card);
            }

            const lines = [
                "MTGA collection brief",
                format === "all"
                    ? "Scope: non-basic cards from the full collection"
                    : `Scope: non-basic cards legal in ${format}`,
                query ? `Focus filter: ${query}` : "Focus filter: none",
                `Totals: ${summary.totals.uniqueCards} unique cards, ${summary.totals.copies} owned copies, ${summary.totals.sets} sets`,
                `Rarity mix: ${summary.rarity.mythic} mythic, ${summary.rarity.rare} rare, ${summary.rarity.uncommon} uncommon, ${summary.rarity.common} common`,
                `Type mix: ${summary.types.planeswalkers} PW, ${summary.types.creatures} creatures, ${summary.types.spells} spells/artifacts, ${summary.types.lands} lands`,
                "",
                "High-signal inventory:"
            ];

            const labels: Record<string, string> = {
                planeswalkers: "Planeswalkers",
                creatures: "Creatures",
                spells: "Spells and Artifacts",
                lands: "Lands",
                other: "Other"
            };

            for (const bucket of ["planeswalkers", "creatures", "spells", "lands", "other"]) {
                const entries = grouped.get(bucket) || [];
                if (!entries.length) continue;
                lines.push(`${labels[bucket]}:`);
                for (const card of entries) {
                    lines.push(`- ${card.quantity}x ${card.name} [${card.rarity || "unknown"}] (${card.type || "Unknown"}${card.set ? `; ${card.set}` : ""})`);
                }
                lines.push("");
            }

            lines.push(
                normalizeText(options?.prompt)
                || "Build the strongest coherent MTGA deck you can from this pool. Prefer plans supported by repeated cards, strong rares/mythics, and a stable mana base. Explain the game plan, core package, and mana considerations."
            );

            return lines.join("\n").trim();
        }
    };
}
