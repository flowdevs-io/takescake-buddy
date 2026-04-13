import * as fs from "node:fs";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import {
    createHistoryStore,
    type CardCountRecord,
    type CardSnapshot,
    type GameRecord as HistoryGameRecord,
    type TurnRecord as HistoryTurnRecord
} from "./history-store";
import { createCollectionStore } from "./collection-store";

const DATA_DIR = path.resolve(Bun.env.TRACKER_DATA_DIR || "scraper");
const COLLECTION_FILE = path.join(DATA_DIR, "collection.json");
const CACHE_FILE = path.join(DATA_DIR, "card_cache.json");
const CARD_IMAGE_DIR = path.join(DATA_DIR, "card_images");
const CARD_IMAGE_ROUTE = "/card-images";
const HISTORY_DB_PATH = path.join(DATA_DIR, "history.sqlite");
const LLM_CONTEXT_FILE = path.join(DATA_DIR, "llm-context.txt");
const LOG_PATH = Bun.env.TRACKER_LOG_PATH || (Bun.env.USERPROFILE + "\\AppData\\LocalLow\\Wizards Of The Coast\\MTGA\\Player.log");
const LOOKUP_RETRY_AFTER_MS = 30 * 60 * 1000;
const SERVER_PORT = Number(Bun.env.PORT || 3000);
const STARTUP_SCAN_WINDOW_BYTES = 2 * 1024 * 1024;
const RECOVERY_SCAN_WINDOW_BYTES = 8 * 1024 * 1024;
const DECK_RECOVERY_SCAN_WINDOW_BYTES = 8 * 1024 * 1024;
const DECK_RECOVERY_THROTTLE_MS = 3000;
const COMPLETED_MATCH_RECOVERY_THROTTLE_MS = 4000;
const RUNTIME_STATE_VERSION = 1;
const MTGA_RAW_RELATIVE_PATHS = [
    "SteamLibrary\\steamapps\\common\\MTGA\\MTGA_Data\\Downloads\\Raw",
    "Program Files (x86)\\Steam\\steamapps\\common\\MTGA\\MTGA_Data\\Downloads\\Raw",
    "Program Files\\Steam\\steamapps\\common\\MTGA\\MTGA_Data\\Downloads\\Raw",
    "Program Files\\Wizards of the Coast\\MTGA\\MTGA_Data\\Downloads\\Raw",
    "Program Files (x86)\\Wizards of the Coast\\MTGA\\MTGA_Data\\Downloads\\Raw",
    "Games\\MTGA\\MTGA_Data\\Downloads\\Raw"
];
const RARITY_CODE_MAP = {
    2: "common",
    3: "uncommon",
    4: "rare",
    5: "mythic"
};

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CARD_IMAGE_DIR, { recursive: true });

const historyStore = createHistoryStore(HISTORY_DB_PATH);
const collectionStore = createCollectionStore(HISTORY_DB_PATH);

type LiveArchiveState = {
    myTeamId: number | null;
    maxHandSize: number;
    onPlay: boolean | null;
    startingPlayerSeatId: number | null;
    chooseStartingSeatId: number | null;
    mulliganCount: number;
    awaitingMulliganDecision: boolean;
    openingHand: CardSnapshot[];
    openingHandSize: number | null;
    openingHandFrozen: boolean;
    handSnapshots: Array<{
        key: string;
        timestamp: number;
        size: number;
        awaitingMulliganDecision: boolean;
        cards: CardSnapshot[];
    }>;
    cardsDrawn: Map<string, number>;
    drawnInstanceIds: Set<number>;
    cardsSeen: Map<string, number>;
    seenInstanceIds: Map<number, string>;
    turnRecords: Map<number, HistoryTurnRecord>;
    /** Uncapped full-game timeline for archival — never trimmed, unlike gameState.timeline. */
    fullTimeline: Array<Record<string, unknown>>;
    resultCode: "win" | "loss" | "unknown";
    resultText: string;
    resultReason: string | null;
    winningTeamId: number | null;
    eventCounts: {
        draws: number;
        plays: number;
        casts: number;
        zoneTransfers: number;
    };
    persisted: boolean;
};

// --- Game State Engine ---
let cardCache = {};
let instanceToGrp = new Map();
let instanceState = new Map();
let pendingCardFetches = new Set();
let cardFetchQueue = Promise.resolve();
let seenTimelineEntries = new Set();
let zoneMetadataById = new Map();
let collectionIndex = new Map();
let localCardMetadataByGrp = new Map();
let localCardDatabase = null;
let localCardLookupStatement = null;
let detectedMtgaRawDir = undefined;
const knownDecksById = new Map();
const knownDecksBySignature = new Map();
const DECK_CONTAINER_KEYS = [
    "CourseDeck",
    "courseDeck",
    "SelectedDeck",
    "selectedDeck",
    "CurrentDeck",
    "currentDeck",
    "Deck",
    "deck"
];
const DECK_SUMMARY_KEYS = [
    "CourseDeckSummary",
    "courseDeckSummary",
    "SelectedDeckSummary",
    "selectedDeckSummary",
    "CurrentDeckSummary",
    "currentDeckSummary",
    "DeckSummary",
    "deckSummary"
];

function createGameState() {
    return {
        active: false,
        mySeatId: null,
        deckName: "Unknown Deck",
        format: "Unknown",
        matchState: "Monitoring Logs",
        matchId: null,
        gameNumber: 0,
        gameEnded: false,
        gameArchived: false,
        gameStartedAt: null,
        gameEndedAt: null,
        startingDeck: new Map(), // grpId -> quantity
        turn: {
            number: 0,
            phase: "Waiting",
            step: "",
            activePlayer: null,
            priorityPlayer: null,
            decisionPlayer: null
        },
        zones: {
            hand: [],
            myBattlefield: [],
            oppBattlefield: [],
            myGraveyard: [],
            oppGraveyard: [],
            myExile: [],
            oppExile: [],
            stack: []
        },
        libraryCount: 0,
        oppLibraryCount: 0,
        oppHandCount: 0,
        life: { me: 20, opp: 20 },
        timeline: [],
        lastUpdate: Date.now()
    };
}

function createLiveArchiveState(): LiveArchiveState {
    return {
        myTeamId: null,
        maxHandSize: 7,
        onPlay: null,
        startingPlayerSeatId: null,
        chooseStartingSeatId: null,
        mulliganCount: 0,
        awaitingMulliganDecision: false,
        openingHand: [],
        openingHandSize: null,
        openingHandFrozen: false,
        handSnapshots: [],
        cardsDrawn: new Map(),
        drawnInstanceIds: new Set(),
        cardsSeen: new Map(),
        seenInstanceIds: new Map(),
        turnRecords: new Map(),
        fullTimeline: [],
        resultCode: "unknown",
        resultText: "",
        resultReason: null,
        winningTeamId: null,
        eventCounts: {
            draws: 0,
            plays: 0,
            casts: 0,
            zoneTransfers: 0
        },
        persisted: false
    };
}

let gameState = createGameState();
let liveArchive = createLiveArchiveState();
let matchHistory = historyStore.loadRecentMatchPreview(12);
let lastDeckRecoveryAt = 0;
let lastCompletedMatchRecoveryAt = 0;

function resetRuntimeTracking() {
    instanceToGrp.clear();
    instanceState.clear();
    seenTimelineEntries.clear();
    zoneMetadataById.clear();
}

function resetGameTracking() {
    resetRuntimeTracking();
    liveArchive = createLiveArchiveState();
    gameState.active = false;
    gameState.gameEnded = false;
    gameState.gameArchived = false;
    gameState.gameStartedAt = null;
    gameState.gameEndedAt = null;
    gameState.turn = {
        number: 0,
        phase: "Waiting",
        step: "",
        activePlayer: null,
        priorityPlayer: null,
        decisionPlayer: null
    };
    gameState.zones = {
        hand: [],
        myBattlefield: [],
        oppBattlefield: [],
        myGraveyard: [],
        oppGraveyard: [],
        myExile: [],
        oppExile: [],
        stack: []
    };
    gameState.libraryCount = 0;
    gameState.oppLibraryCount = 0;
    gameState.oppHandCount = 0;
    gameState.life = { me: 20, opp: 20 };
    gameState.timeline = [];
}

function resetMatchTracking() {
    resetRuntimeTracking();
}

function replaceMap(target, entries) {
    target.clear();
    if (!Array.isArray(entries)) return target;
    for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        target.set(entry[0], entry[1]);
    }
    return target;
}

function replaceSet(target, values) {
    target.clear();
    if (!Array.isArray(values)) return target;
    for (const value of values) target.add(value);
    return target;
}

function serializeGameState() {
    return {
        ...gameState,
        startingDeck: [...gameState.startingDeck.entries()]
    };
}

function restoreGameState(snapshot) {
    const next = createGameState();
    Object.assign(next, snapshot || {});
    next.startingDeck = new Map(Array.isArray(snapshot?.startingDeck) ? snapshot.startingDeck : []);
    next.turn = { ...next.turn, ...(snapshot?.turn || {}) };
    next.zones = { ...next.zones, ...(snapshot?.zones || {}) };
    next.life = { ...next.life, ...(snapshot?.life || {}) };
    next.timeline = Array.isArray(snapshot?.timeline) ? snapshot.timeline : [];
    gameState = next;
}

function serializeLiveArchive() {
    return {
        ...liveArchive,
        cardsDrawn: [...liveArchive.cardsDrawn.entries()],
        drawnInstanceIds: [...liveArchive.drawnInstanceIds.values()],
        cardsSeen: [...liveArchive.cardsSeen.entries()],
        seenInstanceIds: [...liveArchive.seenInstanceIds.entries()],
        turnRecords: [...liveArchive.turnRecords.entries()],
        fullTimeline: liveArchive.fullTimeline
    };
}

function restoreLiveArchive(snapshot) {
    const next = createLiveArchiveState();
    Object.assign(next, snapshot || {});
    next.cardsDrawn = new Map(Array.isArray(snapshot?.cardsDrawn) ? snapshot.cardsDrawn : []);
    next.drawnInstanceIds = new Set(Array.isArray(snapshot?.drawnInstanceIds) ? snapshot.drawnInstanceIds : []);
    next.cardsSeen = new Map(Array.isArray(snapshot?.cardsSeen) ? snapshot.cardsSeen : []);
    next.seenInstanceIds = new Map(Array.isArray(snapshot?.seenInstanceIds) ? snapshot.seenInstanceIds : []);
    next.turnRecords = new Map(Array.isArray(snapshot?.turnRecords) ? snapshot.turnRecords : []);
    next.handSnapshots = Array.isArray(snapshot?.handSnapshots) ? snapshot.handSnapshots : [];
    next.openingHand = Array.isArray(snapshot?.openingHand) ? snapshot.openingHand : [];
    next.fullTimeline = Array.isArray(snapshot?.fullTimeline) ? snapshot.fullTimeline : [];
    liveArchive = next;
}

function humanizeToken(value) {
    const raw = String(value || "");
    const withoutPrefix = raw.includes("_") ? raw.split("_").slice(1).join(" ") : raw;
    return withoutPrefix
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Za-z])(\d)/g, "$1 $2")
        .replace(/_/g, " ")
        .trim() || "Unknown";
}

function safeJsonParse(value) {
    let current = value;
    for (let depth = 0; depth < 2; depth += 1) {
        if (typeof current !== "string") return current;
        try {
            current = JSON.parse(current);
        } catch {
            return depth === 0 ? null : current;
        }
    }
    return current;
}

function readLogTailWindow(filePath, maxBytes) {
    if (!fs.existsSync(filePath)) return "";
    const stats = fs.statSync(filePath);
    const length = Math.min(Math.max(maxBytes, 0), stats.size);
    if (!length) return "";

    const buffer = Buffer.alloc(length);
    const start = stats.size - length;
    const fd = fs.openSync(filePath, "r");
    try {
        fs.readSync(fd, buffer, 0, length, start);
    } finally {
        fs.closeSync(fd);
    }
    return buffer.toString("utf-8");
}

function extractJsonObjectsFromText(text) {
    const objects = [];
    let cursor = 0;

    while (cursor < text.length) {
        const startIdx = text.indexOf("{", cursor);
        if (startIdx === -1) break;

        let bracketCount = 0;
        let endIdx = -1;
        for (let index = startIdx; index < text.length; index += 1) {
            if (text[index] === "{") bracketCount += 1;
            if (text[index] === "}") bracketCount -= 1;
            if (bracketCount === 0) {
                endIdx = index;
                break;
            }
        }

        if (endIdx === -1) break;

        try {
            objects.push(JSON.parse(text.slice(startIdx, endIdx + 1)));
        } catch {
            // Ignore unrelated brace-delimited log fragments.
        }
        cursor = endIdx + 1;
    }

    return objects;
}

function normalizeLogTimestamp(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    if (numeric > 100000000000000) {
        const epochMs = Math.floor((numeric - 621355968000000000) / 10000);
        return Number.isFinite(epochMs) && epochMs > 0 ? epochMs : null;
    }
    if (numeric > 1000000000000) return Math.floor(numeric);
    if (numeric > 1000000000) return Math.floor(numeric * 1000);
    return null;
}

function getObjectTimestampMs(obj) {
    return normalizeLogTimestamp(obj?.timestamp || obj?.Timestamp) || Date.now();
}

function stripMarkup(value) {
    return String(value || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function currentGameRecordKey() {
    return `${gameState.matchId ?? "unknown"}:${gameState.gameNumber || 0}`;
}

function buildResultText(resultCode, reason, fallback = "Game Complete") {
    const cleanedReason = reason ? humanizeToken(reason) : "";
    if (resultCode === "win") return `Win${cleanedReason ? ` · ${cleanedReason}` : ""}`;
    if (resultCode === "loss") return `Loss${cleanedReason ? ` · ${cleanedReason}` : ""}`;
    return fallback;
}

function startFreshMatchContext(matchId = null, gameNumber = 1) {
    gameState = createGameState();
    liveArchive = createLiveArchiveState();
    resetMatchTracking();
    gameState.matchId = matchId;
    gameState.gameNumber = gameNumber;
    gameState.matchState = "Match detected";
}

function applyDeckDataToGameState(deckData, options = {}) {
    if (!deckData || typeof deckData !== "object") return false;

    const overwriteEntries = Boolean(options.overwriteEntries);
    let changed = false;

    if (deckData.name && deckData.name !== gameState.deckName) {
        gameState.deckName = deckData.name;
        changed = true;
    }

    if (deckData.format && deckData.format !== gameState.format) {
        gameState.format = deckData.format;
        changed = true;
    }

    if (Array.isArray(deckData.entries) && deckData.entries.length && (overwriteEntries || !gameState.startingDeck.size)) {
        const nextEntries = deckData.entries.map((entry) => ({
            grpId: String(entry.grpId),
            quantity: Number(entry.quantity || 0)
        })).filter((entry) => entry.grpId && Number.isFinite(entry.quantity) && entry.quantity > 0);
        const nextSignature = buildDeckSignature(nextEntries);
        const currentSignature = buildDeckSignature(
            [...gameState.startingDeck.entries()].map(([grpId, quantity]) => ({ grpId, quantity }))
        );

        if (nextEntries.length && (overwriteEntries || !gameState.startingDeck.size || nextSignature !== currentSignature)) {
            gameState.startingDeck = new Map();
            for (const entry of nextEntries) {
                gameState.startingDeck.set(entry.grpId, entry.quantity);
            }
            changed = true;
        }
    }

    if (changed) {
        queueKnownCardAssetsFromState();
    }

    return changed;
}

function createCardSnapshot(card): CardSnapshot {
    return {
        instanceId: card?.instanceId ?? null,
        grpId: card?.grpId ? String(card.grpId) : null,
        name: card?.name || "Unknown",
        typeLine: card?.typeLine || "",
        statLine: card?.statLine || "",
        tapped: Boolean(card?.tapped)
    };
}

function snapshotZoneCards(cards) {
    return Array.isArray(cards) ? cards.map((card) => createCardSnapshot(card)) : [];
}

function incrementCountMap(map, key, amount = 1) {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + amount);
}

function isPlaceholderName(name, grpId) {
    return !stripMarkup(name) || stripMarkup(name) === `Card #${grpId}`;
}

function normalizeColorList(value) {
    if (!Array.isArray(value)) return [];

    const unique = new Set();
    for (const entry of value) {
        const normalized = String(entry || "").trim().toUpperCase();
        if (!normalized) continue;
        unique.add(normalized);
    }

    return ["W", "U", "B", "R", "G", "C"].filter((color) => unique.has(color));
}

function extractCardColors(source) {
    if (!source || typeof source !== "object") return null;

    const colors = normalizeColorList(source.colors);
    if (colors.length) return colors;

    const colorIdentity = normalizeColorList(source.color_identity || source.colorIdentity);
    if (colorIdentity.length) return colorIdentity;

    return Array.isArray(source.colors) || Array.isArray(source.color_identity) || Array.isArray(source.colorIdentity)
        ? []
        : null;
}

function applyCardInfo(target, source, grpId) {
    if (!source || typeof source !== "object") return target;

    const next = { ...target };
    const normalizedName = stripMarkup(source.name || source.Name || "");
    if (normalizedName && (!next.name || isPlaceholderName(next.name, grpId))) {
        next.name = normalizedName;
    }

    const normalizedTypeLine = stripMarkup(source.type_line || source.type || source.Type || "");
    if (normalizedTypeLine && !next.type_line) next.type_line = normalizedTypeLine;

    const normalizedSet = String(
        source.set || source.Set || source.setCode || source.ExpansionCode || source.digitalSetCode || source.DigitalReleaseSet || ""
    ).toUpperCase();
    if (normalizedSet && !next.set) next.set = normalizedSet;

    const collectorNumber = String(source.collectorNumber || source.collector_number || source.CollectorNumber || "").trim();
    if (collectorNumber && !next.collectorNumber) next.collectorNumber = collectorNumber;

    const normalizedRarity = String(source.rarity || source.Rarity || "").toLowerCase();
    if (normalizedRarity && !next.rarity) next.rarity = normalizedRarity;

    if (source.imageUrl && !next.imageUrl) next.imageUrl = source.imageUrl;
    if (source.image_url && !next.imageUrl) next.imageUrl = source.image_url;
    if (source.localImage && !next.localImage) next.localImage = source.localImage;
    if (source.legalities && !next.legalities) next.legalities = source.legalities;
    const resolvedColors = extractCardColors(source);
    if (resolvedColors) next.colors = resolvedColors;
    if (typeof source.colorsKnown === "boolean") next.colorsKnown = Boolean(source.colorsKnown);
    if (source.lookupFailed && !next.lookupFailed) next.lookupFailed = true;
    if (source.lastLookupAt && !next.lastLookupAt) next.lastLookupAt = source.lastLookupAt;

    return next;
}

function buildMergedCardInfo(grpId, ...sources) {
    let merged = {};
    for (const source of sources) {
        merged = applyCardInfo(merged, source, grpId);
    }

    if (!Object.keys(merged).length) return null;
    if (!isPlaceholderName(merged.name, grpId)) delete merged.lookupFailed;
    return merged;
}

function mapRarityCode(value) {
    return RARITY_CODE_MAP[Number(value)] || "";
}

function getMtgaRawDirCandidates() {
    const driveLetters = "CDEFGHIJKLMNOPQRSTUVWXYZ"
        .split("")
        .filter((letter) => fs.existsSync(`${letter}:\\`));
    const candidates = driveLetters.flatMap((letter) =>
        MTGA_RAW_RELATIVE_PATHS.map((relativePath) => `${letter}:\\${relativePath}`)
    );

    if (Bun.env.LOCALAPPDATA) {
        candidates.push(`${Bun.env.LOCALAPPDATA}\\Programs\\MTGA\\MTGA_Data\\Downloads\\Raw`);
    }

    return [...new Set(candidates)];
}

function detectMtgaRawDir() {
    if (detectedMtgaRawDir !== undefined) return detectedMtgaRawDir;
    detectedMtgaRawDir = getMtgaRawDirCandidates().find((candidate) => fs.existsSync(candidate)) || null;
    return detectedMtgaRawDir;
}

function getLatestRawDatabasePath(prefix) {
    const rawDir = detectMtgaRawDir();
    if (!rawDir) return null;

    const matches = fs.readdirSync(rawDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".mtga"))
        .map((entry) => {
            const fullPath = `${rawDir}\\${entry.name}`;
            const stats = fs.statSync(fullPath);
            return {
                fullPath,
                mtimeMs: stats.mtimeMs
            };
        })
        .sort((left, right) => right.mtimeMs - left.mtimeMs);

    return matches[0]?.fullPath || null;
}

function ensureLocalCardLookupStatement() {
    if (localCardLookupStatement) return localCardLookupStatement;

    const cardDbPath = getLatestRawDatabasePath("Raw_CardDatabase_");
    if (!cardDbPath) return null;

    try {
        localCardDatabase = new Database(cardDbPath);
        localCardLookupStatement = localCardDatabase.query(`
            select
                c.GrpId as grpId,
                c.CollectorNumber as collectorNumber,
                c.ExpansionCode as expansionCode,
                c.DigitalReleaseSet as digitalSetCode,
                c.Rarity as rarityCode,
                c.IsToken as isToken,
                coalesce(titlePlain.Loc, titleFormatted.Loc) as name,
                coalesce(typePlain.Loc, typeFormatted.Loc) as typeText,
                coalesce(subtypePlain.Loc, subtypeFormatted.Loc) as subtypeText
            from Cards c
            left join Localizations_enUS titlePlain
                on titlePlain.LocId = c.TitleId and titlePlain.Formatted = 0
            left join Localizations_enUS titleFormatted
                on titleFormatted.LocId = c.TitleId and titleFormatted.Formatted = 1
            left join Localizations_enUS typePlain
                on typePlain.LocId = c.TypeTextId and typePlain.Formatted = 0
            left join Localizations_enUS typeFormatted
                on typeFormatted.LocId = c.TypeTextId and typeFormatted.Formatted = 1
            left join Localizations_enUS subtypePlain
                on subtypePlain.LocId = c.SubtypeTextId and subtypePlain.Formatted = 0
            left join Localizations_enUS subtypeFormatted
                on subtypeFormatted.LocId = c.SubtypeTextId and subtypeFormatted.Formatted = 1
            where c.GrpId = $grpId
        `);
        return localCardLookupStatement;
    } catch (error) {
        console.error("Failed to open MTGA card database:", error);
        return null;
    }
}

function getLocalCardInfo(grpId) {
    if (!grpId) return null;

    const key = String(grpId);
    if (localCardMetadataByGrp.has(key)) {
        return localCardMetadataByGrp.get(key);
    }

    const statement = ensureLocalCardLookupStatement();
    if (!statement) {
        localCardMetadataByGrp.set(key, null);
        return null;
    }

    const row = statement.get({ $grpId: Number(key) });
    if (!row) {
        localCardMetadataByGrp.set(key, null);
        return null;
    }

    const typeText = stripMarkup(row.typeText);
    const subtypeText = stripMarkup(row.subtypeText);
    const typeLine = typeText && subtypeText ? `${typeText} — ${subtypeText}` : typeText || subtypeText || "";
    const info = {
        name: stripMarkup(row.name) || `Card #${key}`,
        type_line: typeLine,
        rarity: mapRarityCode(row.rarityCode),
        set: String(row.digitalSetCode || row.expansionCode || "").toUpperCase(),
        collectorNumber: String(row.collectorNumber || "").trim()
    };

    localCardMetadataByGrp.set(key, info);
    return info;
}

function buildCard(instanceId) {
    const info = instanceState.get(instanceId) || {};
    const resolvedGrpId = info.type === "GameObjectType_Ability"
        ? info.overlayGrpId || info.objectSourceGrpId || info.grpId || instanceToGrp.get(instanceId)
        : info.overlayGrpId || info.grpId || info.objectSourceGrpId || instanceToGrp.get(instanceId);
    const grpId = resolvedGrpId ? String(resolvedGrpId) : null;
    const power = info.power?.value ?? info.power;
    const toughness = info.toughness?.value ?? info.toughness;
    const cachedTypeLine = grpId ? getCachedCardInfo(grpId)?.type_line || "" : "";

    return {
        instanceId,
        grpId,
        name: resolveName(resolvedGrpId),
        imagePath: resolveImage(resolvedGrpId),
        ownerSeatId: info.ownerSeatId ?? null,
        controllerSeatId: info.controllerSeatId ?? null,
        tapped: Boolean(info.isTapped),
        objectType: info.type || "",
        typeLine: Array.isArray(info.cardTypes) ? info.cardTypes.map(humanizeToken).join(" ") : cachedTypeLine,
        statLine: power != null && toughness != null ? `${power}/${toughness}` : ""
    };
}

function compareCards(left, right) {
    return Number(left.tapped) - Number(right.tapped) || String(left.name || "").localeCompare(String(right.name || ""));
}

function normalizeDeckCardArray(cards) {
    if (!Array.isArray(cards) || !cards.length) return [];

    if (typeof cards[0] === "object" && cards[0] !== null) {
        return cards
            .map((card) => ({
                grpId: card?.grpId ?? card?.GrpId ?? card?.cardId ?? card?.CardId,
                quantity: Number(card?.quantity ?? card?.Quantity ?? 1)
            }))
            .filter((card) => card.grpId != null && Number.isFinite(card.quantity) && card.quantity > 0);
    }

    const counts = new Map();
    for (const rawGrpId of cards) {
        if (rawGrpId == null) continue;
        const grpId = String(rawGrpId);
        counts.set(grpId, (counts.get(grpId) || 0) + 1);
    }

    return [...counts.entries()].map(([grpId, quantity]) => ({ grpId, quantity }));
}

function normalizeDeckEntries(source) {
    if (!source || typeof source !== "object") return [];

    const mainDeck = source.mainDeck || source.MainDeck;
    const mainDeckEntries = normalizeDeckCardArray(mainDeck);
    if (mainDeckEntries.length) return mainDeckEntries;

    const deckCards = source.deckCards || source.DeckCards;
    const deckCardEntries = normalizeDeckCardArray(deckCards);
    if (deckCardEntries.length) return deckCardEntries;

    if (deckCards && typeof deckCards === "object" && !Array.isArray(deckCards)) {
        return Object.entries(deckCards)
            .map(([grpId, quantity]) => ({
                grpId,
                quantity: Number(quantity ?? 0)
            }))
            .filter((card) => card.grpId != null && Number.isFinite(card.quantity) && card.quantity > 0);
    }

    return [];
}

function extractDeckFormat(source) {
    const directFormat = source?.format || source?.Format;
    if (directFormat) return humanizeToken(String(directFormat).replace(/^"+|"+$/g, ""));

    const attributes = Array.isArray(source?.Attributes)
        ? source.Attributes
        : Array.isArray(source?.attributes)
            ? source.attributes
            : [];
    if (attributes.length) {
        const formatAttribute = attributes.find((item) => item?.name === "Format");
        if (formatAttribute?.value) {
            return humanizeToken(String(formatAttribute.value).replace(/^"+|"+$/g, ""));
        }
    }

    return null;
}

function cleanDeckString(value) {
    if (value == null) return null;
    const text = String(value).replace(/^"+|"+$/g, "").trim();
    return text || null;
}

function isPlaceholderDeckName(value) {
    const cleaned = cleanDeckString(value);
    if (!cleaned) return true;
    const normalized = cleaned.toLowerCase();
    return normalized === "unknown deck"
        || normalized === "untitled deck"
        || normalized.startsWith("?=?loc/")
        || normalized.startsWith("loc/");
}

function normalizeDeckName(value) {
    const cleaned = cleanDeckString(value);
    return cleaned && !isPlaceholderDeckName(cleaned) ? cleaned : null;
}

function normalizeDeckFormat(value) {
    const cleaned = cleanDeckString(value);
    if (!cleaned) return null;
    const normalized = humanizeToken(cleaned);
    return normalized === "Unknown" ? null : normalized;
}

function extractDeckName(source) {
    return (
        normalizeDeckName(source?.name) ||
        normalizeDeckName(source?.Name) ||
        normalizeDeckName(source?.deckName) ||
        normalizeDeckName(source?.DeckName) ||
        normalizeDeckName(source?.deckTitle) ||
        normalizeDeckName(source?.DeckTitle)
    );
}

function extractDeckId(source) {
    return cleanDeckString(source?.deckId) || cleanDeckString(source?.DeckId) || null;
}

function buildDeckSignature(entries) {
    if (!Array.isArray(entries) || !entries.length) return null;
    return entries
        .map((entry) => `${String(entry.grpId)}:${Number(entry.quantity || 0)}`)
        .sort()
        .join("|");
}

function mergeKnownDeckRecord(existing = null, incoming = null) {
    return {
        deckId: incoming?.deckId || existing?.deckId || null,
        name: incoming?.name || existing?.name || null,
        format: incoming?.format || existing?.format || null,
        signature: incoming?.signature || existing?.signature || null
    };
}

function rememberDeckIdentity(identity) {
    const deckId = extractDeckId(identity) || null;
    const name = extractDeckName(identity) || null;
    const format = normalizeDeckFormat(identity?.format) || normalizeDeckFormat(extractDeckFormat(identity)) || null;
    const entries = Array.isArray(identity?.entries) ? identity.entries : normalizeDeckEntries(identity);
    const signature = buildDeckSignature(entries);
    if (!deckId && !signature) return;

    const existingById = deckId ? knownDecksById.get(deckId) : null;
    const existingBySignature = signature ? knownDecksBySignature.get(signature) : null;
    const merged = mergeKnownDeckRecord(
        mergeKnownDeckRecord(existingById, existingBySignature),
        { deckId, name, format, signature }
    );

    if (merged.deckId) knownDecksById.set(merged.deckId, merged);
    if (merged.signature) knownDecksBySignature.set(merged.signature, merged);
}

function rememberDeckCatalog(root) {
    if (!root || typeof root !== "object") return;

    const queue = [root];
    const seen = new Set();
    let visited = 0;

    while (queue.length && visited < 8000) {
        const current = queue.shift();
        if (!current || typeof current !== "object" || seen.has(current)) continue;
        seen.add(current);
        visited += 1;

        for (const key of DECK_SUMMARY_KEYS) {
            if (current[key]) rememberDeckIdentity(current[key]);
        }

        for (const key of DECK_CONTAINER_KEYS) {
            if (current[key]) rememberDeckIdentity(current[key]);
        }

        for (const deckKey of DECK_CONTAINER_KEYS) {
            const deckSource = current[deckKey];
            if (!deckSource) continue;
            for (const summaryKey of DECK_SUMMARY_KEYS) {
                if (!current[summaryKey]) continue;
                rememberDeckIdentity({
                    DeckId: extractDeckId(deckSource) || extractDeckId(current[summaryKey]),
                    Name: extractDeckName(deckSource) || extractDeckName(current[summaryKey]),
                    Format: extractDeckFormat(deckSource) || extractDeckFormat(current[summaryKey]),
                    entries: normalizeDeckEntries(deckSource)
                });
            }
        }

        if (Array.isArray(current)) {
            for (const value of current) queue.push(value);
        } else {
            for (const value of Object.values(current)) queue.push(value);
        }
    }
}

function hasDeckSignal(value) {
    if (!value || typeof value !== "object") return false;

    if (Array.isArray(value)) {
        return value.slice(0, 5).some((item) => hasDeckSignal(item));
    }

    return Object.keys(value).some((key) => {
        const normalized = key.toLowerCase();
        return normalized.includes("deck") || normalized === "courses";
    });
}

function resolveKnownDeckIdentity(deckId, signature) {
    return (deckId && knownDecksById.get(deckId)) || (signature && knownDecksBySignature.get(signature)) || null;
}

function buildResolvedDeckData(deckSource, summarySource = null, fallbackSource = null) {
    const entries = normalizeDeckEntries(deckSource);
    if (!entries.length) return null;

    const deckId =
        extractDeckId(deckSource) ||
        extractDeckId(summarySource) ||
        extractDeckId(fallbackSource) ||
        null;
    const signature = buildDeckSignature(entries);
    const known = resolveKnownDeckIdentity(deckId, signature);
    const name =
        extractDeckName(deckSource) ||
        extractDeckName(summarySource) ||
        extractDeckName(fallbackSource) ||
        known?.name ||
        "Untitled Deck";
    const format =
        normalizeDeckFormat(extractDeckFormat(deckSource)) ||
        normalizeDeckFormat(extractDeckFormat(summarySource)) ||
        normalizeDeckFormat(extractDeckFormat(fallbackSource)) ||
        known?.format ||
        null;

    rememberDeckIdentity({
        DeckId: deckId,
        Name: name,
        Format: format,
        entries
    });

    return {
        name,
        format,
        entries
    };
}

function findRelevantDeckData(root) {
    if (!root || typeof root !== "object") return null;

    const queue = [root];
    const seen = new Set();
    let visited = 0;

    while (queue.length && visited < 4000) {
        const current = queue.shift();
        if (!current || typeof current !== "object" || seen.has(current)) continue;
        seen.add(current);
        visited += 1;

        for (const deckKey of DECK_CONTAINER_KEYS) {
            const deckSource = current[deckKey];
            if (!deckSource) continue;

            const summarySource = DECK_SUMMARY_KEYS
                .map((key) => current[key])
                .find(Boolean);
            const pairedCandidate = buildResolvedDeckData(deckSource, summarySource, current);
            if (pairedCandidate) return pairedCandidate;
        }

        if (current === root) {
            const directCandidate = buildResolvedDeckData(current, null, null);
            if (directCandidate) return directCandidate;
        }

        if (Array.isArray(current)) {
            for (const value of current) queue.push(value);
        } else {
            for (const value of Object.values(current)) queue.push(value);
        }
    }

    return null;
}

function findDeckData(obj) {
    const parsedPayload = safeJsonParse(obj?.params?.payload);
    const greEvent = obj?.greToClientEvent || obj?.GreToClientEvent;
    const greMessages = greEvent?.greToClientMessages || greEvent?.GreToClientMessages || [];
    const connectDeckCandidates = Array.isArray(greMessages)
        ? greMessages.flatMap((msg) => [
            msg?.connectResp?.deckMessage,
            msg?.ConnectResp?.deckMessage,
            msg?.connectResp,
            msg?.ConnectResp
        ])
        : [];
    const candidates = [
        obj?.Deck,
        obj?.deck,
        obj?.payload,
        parsedPayload,
        obj?.connectResp?.deckMessage,
        obj?.ConnectResp?.deckMessage,
        obj?.connectResp,
        obj?.ConnectResp,
        ...connectDeckCandidates,
        obj?.CourseDeckSummary && obj?.CourseDeck
            ? { CourseDeckSummary: obj.CourseDeckSummary, CourseDeck: obj.CourseDeck }
            : null,
        obj?.courseDeckSummary && obj?.courseDeck
            ? { courseDeckSummary: obj.courseDeckSummary, courseDeck: obj.courseDeck }
            : null,
        obj
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (hasDeckSignal(candidate)) rememberDeckCatalog(candidate);
    }

    for (const candidate of candidates) {
        const resolved = findRelevantDeckData(candidate);
        if (resolved) return resolved;
    }

    return null;
}

function refreshCollectionMemory(force = false) {
    const changed = collectionStore.syncFromLegacyFiles({
        collectionPath: COLLECTION_FILE,
        cachePath: CACHE_FILE
    });

    if (changed || force) {
        cardCache = collectionStore.loadCardCatalogCacheObject();
        collectionIndex = collectionStore.loadCollectionIndexMap();
    }

    return changed;
}
refreshCollectionMemory(true);

function saveCardCacheEntry(grpId, info = cardCache[String(grpId)]) {
    if (!grpId || !info) return;
    collectionStore.upsertCardCatalogEntry(String(grpId), info);
}

function getLocalImagePath(grpId) {
    return `${CARD_IMAGE_DIR}/${grpId}.jpg`;
}

function getLocalImageRoute(grpId) {
    return `${CARD_IMAGE_ROUTE}/${grpId}.jpg`;
}

function getCachedCardInfo(grpId) {
    const key = String(grpId);
    const cached = cardCache[key];
    const normalizedCache = !cached
        ? null
        : typeof cached === "string"
            ? { name: cached }
            : cached;
    const collectionInfo = collectionIndex.get(key) || null;
    const localInfo = getLocalCardInfo(key);
    return buildMergedCardInfo(key, localInfo, collectionInfo, normalizedCache);
}

function selectImageUrl(data) {
    if (data?.image_uris?.normal) return data.image_uris.normal;
    if (data?.image_uris?.small) return data.image_uris.small;

    if (Array.isArray(data?.card_faces)) {
        for (const face of data.card_faces) {
            if (face?.image_uris?.normal) return face.image_uris.normal;
            if (face?.image_uris?.small) return face.image_uris.small;
        }
    }

    return null;
}

async function downloadCardImage(grpId, imageUrl) {
    if (!imageUrl) return null;

    const localImagePath = getLocalImagePath(grpId);
    if (!fs.existsSync(localImagePath)) {
        const response = await fetch(imageUrl, {
            headers: { "User-Agent": "mtga-tracker-pro/1.0" }
        });
        if (!response.ok) return null;

        const arrayBuffer = await response.arrayBuffer();
        fs.writeFileSync(localImagePath, Buffer.from(arrayBuffer));
    }

    return getLocalImageRoute(grpId);
}

async function fetchScryfallCardData(grpId, info) {
    const key = String(grpId);
    const candidateUrls = [];

    if (info?.set && info?.collectorNumber) {
        candidateUrls.push(`https://api.scryfall.com/cards/${String(info.set).toLowerCase()}/${encodeURIComponent(String(info.collectorNumber))}`);
    }
    if (info?.name && !isPlaceholderName(info.name, key)) {
        candidateUrls.push(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(info.name)}`);
    }
    candidateUrls.push(`https://api.scryfall.com/cards/arena/${key}`);

    for (const url of [...new Set(candidateUrls)]) {
        const response = await fetch(url, {
            headers: { "User-Agent": "mtga-tracker-pro/1.0" }
        });

        if (!response.ok) {
            if (response.status === 400 || response.status === 404) continue;
            continue;
        }

        return response.json();
    }

    return null;
}

async function fetchAndCacheCardAsset(grpId) {
    const key = String(grpId);
    let info = getCachedCardInfo(key) || {};
    let imageUrl = info.imageUrl || info.image_url || null;
    const hasColorMetadata = info?.colorsKnown === true;
    info = {
        ...info,
        lastLookupAt: Date.now()
    };

    if (isPlaceholderName(info.name, key) || (!info.localImage && !imageUrl) || !hasColorMetadata) {
        const data = await fetchScryfallCardData(key, info);
        if (data) {
            imageUrl = selectImageUrl(data) || imageUrl;
            info = buildMergedCardInfo(key, info, {
                name: data.name,
                legalities: data.legalities || {},
                type_line: data.type_line || "",
                rarity: data.rarity || "",
                set: (data.set || "").toUpperCase(),
                collectorNumber: data.collector_number || "",
                colors: extractCardColors(data) || [],
                colorsKnown: true,
                imageUrl
            }) || info;
        }
    }

    const localImage = await downloadCardImage(key, imageUrl);
    if (localImage) info.localImage = localImage;
    if (!info.name) info.name = `Card #${key}`;
    if (isPlaceholderName(info.name, key) && !info.localImage && !imageUrl) {
        info.lookupFailed = true;
    } else {
        delete info.lookupFailed;
    }

    cardCache[key] = info;
    saveCardCacheEntry(key, info);
    broadcast("state-update", getEnhancedState());
}

function queueCardAssetFetch(grpId) {
    if (!grpId) return;

    const key = String(grpId);
    const info = getCachedCardInfo(key);
    const localImagePath = getLocalImagePath(key);
    const hasResolvedName = info?.name && !isPlaceholderName(info.name, key);
    const hasColorMetadata = info?.colorsKnown === true;
    const recentlyFailed = info?.lookupFailed && info?.lastLookupAt && (Date.now() - info.lastLookupAt) < LOOKUP_RETRY_AFTER_MS;

    if (pendingCardFetches.has(key) || recentlyFailed) return;

    if (info?.name && info?.localImage && fs.existsSync(localImagePath) && hasColorMetadata) {
        return;
    }

    if (hasResolvedName && hasColorMetadata && info?.lastLookupAt && !info?.localImage && (Date.now() - info.lastLookupAt) < LOOKUP_RETRY_AFTER_MS) {
        return;
    }

    if (info?.name && !info?.localImage && fs.existsSync(localImagePath)) {
        cardCache[key] = { ...info, localImage: getLocalImageRoute(key) };
        saveCardCacheEntry(key, cardCache[key]);
        if (hasColorMetadata) return;
    }

    pendingCardFetches.add(key);
    cardFetchQueue = cardFetchQueue
        .then(async () => {
            try {
                await fetchAndCacheCardAsset(key);
            } catch (error) {
                console.error(`Failed to cache card asset ${key}:`, error);
            } finally {
                pendingCardFetches.delete(key);
            }
        });
}

function resolveImage(gid) {
    if (!gid) return null;

    const key = String(gid);
    const info = getCachedCardInfo(key);
    if (info?.localImage && fs.existsSync(getLocalImagePath(key))) {
        return info.localImage;
    }

    queueCardAssetFetch(key);
    return null;
}

const clients = new Set();
function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
        try { client.enqueue(msg); } catch (e) { clients.delete(client); }
    }
}

function resolveName(gid) {
    if (!gid) return null;
    const key = String(gid);
    const info = getCachedCardInfo(key);
    if (!info || !info.localImage) queueCardAssetFetch(key);
    if (!info) return `Card #${gid}`;
    return info.name || `Card #${gid}`;
}

function resolveColors(gid) {
    if (!gid) return [];
    const info = getCachedCardInfo(String(gid));
    if (!info || info.colorsKnown !== true) queueCardAssetFetch(String(gid));
    return info?.colors || [];
}

function queueKnownCardAssetsFromState() {
    const grpIds = new Set([...gameState.startingDeck.keys()].map((grpId) => String(grpId)));
    const visibleZones = [
        gameState.zones.hand,
        gameState.zones.myBattlefield,
        gameState.zones.oppBattlefield,
        gameState.zones.myGraveyard,
        gameState.zones.oppGraveyard,
        gameState.zones.myExile,
        gameState.zones.oppExile,
        gameState.zones.stack
    ];

    for (const cards of visibleZones) {
        for (const card of cards) {
            if (card?.grpId) grpIds.add(String(card.grpId));
        }
    }

    for (const grpId of grpIds) {
        queueCardAssetFetch(grpId);
    }
}

function updateObjectsFromState(state) {
    let changed = false;

    if (Array.isArray(state.diffDeletedInstanceIds)) {
        for (const instanceId of state.diffDeletedInstanceIds) {
            instanceState.delete(instanceId);
            instanceToGrp.delete(instanceId);
            changed = true;
        }
    }

    if (Array.isArray(state.gameObjects)) {
        for (const obj of state.gameObjects) {
            if (!obj?.instanceId) continue;
            const previous = instanceState.get(obj.instanceId) || {};
            const next = { ...previous, ...obj };
            instanceState.set(obj.instanceId, next);

            const grpId = next.overlayGrpId || next.grpId || next.objectSourceGrpId;
            if (grpId) {
                instanceToGrp.set(obj.instanceId, String(grpId));
            }
            changed = true;
        }
    }

    return changed;
}

function updateTurnInfo(turnInfo) {
    if (!turnInfo) return false;

    const nextTurn = {
        number: turnInfo.turnNumber ?? gameState.turn.number ?? 0,
        phase: humanizeToken(turnInfo.phase || gameState.turn.phase),
        step: humanizeToken(turnInfo.step || gameState.turn.step || ""),
        activePlayer: turnInfo.activePlayer ?? gameState.turn.activePlayer,
        priorityPlayer: turnInfo.priorityPlayer ?? gameState.turn.priorityPlayer,
        decisionPlayer: turnInfo.decisionPlayer ?? gameState.turn.decisionPlayer
    };

    const changed =
        nextTurn.number !== gameState.turn.number ||
        nextTurn.phase !== gameState.turn.phase ||
        nextTurn.step !== gameState.turn.step ||
        nextTurn.activePlayer !== gameState.turn.activePlayer ||
        nextTurn.priorityPlayer !== gameState.turn.priorityPlayer ||
        nextTurn.decisionPlayer !== gameState.turn.decisionPlayer;

    if (changed) gameState.turn = nextTurn;
    if (!gameState.gameEnded && (nextTurn.number || nextTurn.activePlayer)) gameState.active = true;
    return changed;
}

function updateLocalSeatFromMessage(msg) {
    const seatIds = msg?.systemSeatIds || msg?.SystemSeatIds;
    if (!Array.isArray(seatIds) || !seatIds.length) return false;

    const nextSeatId = Number(seatIds[0]);
    if (!Number.isFinite(nextSeatId) || nextSeatId === gameState.mySeatId) return false;

    gameState.mySeatId = nextSeatId;
    return true;
}

function getReservedPlayerSeatId(player) {
    const rawSeatId = player?.systemSeatId ?? player?.systemSeatNumber ?? player?.seatId ?? null;
    const nextSeatId = Number(rawSeatId);
    return Number.isFinite(nextSeatId) ? nextSeatId : null;
}

function identifyLocalReservedPlayer(players) {
    if (!Array.isArray(players) || !players.length) return null;
    const normalizedPlayers = players.filter((player) => player && typeof player === "object");
    if (!normalizedPlayers.length) return null;

    const steamPlayers = normalizedPlayers.filter((player) => /steam/i.test(String(player?.platformId || "")));
    if (steamPlayers.length === 1) return steamPlayers[0];

    const windowsPlayers = normalizedPlayers.filter((player) => /windows/i.test(String(player?.platformId || "")));
    if (windowsPlayers.length === 1) return windowsPlayers[0];

    return null;
}

function resolveLocalReservedPlayer(players, options = {}) {
    if (!Array.isArray(players) || !players.length) return null;
    const normalizedPlayers = players.filter((player) => player && typeof player === "object");
    if (!normalizedPlayers.length) return null;

    const preferRuntimeHints = options.preferRuntimeHints !== false;
    if (preferRuntimeHints && gameState.mySeatId != null) {
        const bySeat = normalizedPlayers.find((player) => getReservedPlayerSeatId(player) === gameState.mySeatId);
        if (bySeat) return bySeat;
    }

    const heuristicMatch = identifyLocalReservedPlayer(normalizedPlayers);
    if (heuristicMatch) return heuristicMatch;

    if (preferRuntimeHints && liveArchive.myTeamId != null) {
        const byTeam = normalizedPlayers.find((player) => Number(player?.teamId ?? NaN) === liveArchive.myTeamId);
        if (byTeam) return byTeam;
    }

    return null;
}

function syncLocalIdentityFromReservedPlayers(players) {
    const localPlayer = resolveLocalReservedPlayer(players);
    if (!localPlayer) return false;

    let changed = false;
    const nextSeatId = getReservedPlayerSeatId(localPlayer);
    if (nextSeatId != null && nextSeatId !== gameState.mySeatId) {
        gameState.mySeatId = nextSeatId;
        changed = true;
    }

    const nextTeamId = Number(localPlayer?.teamId ?? NaN);
    if (Number.isFinite(nextTeamId) && nextTeamId !== liveArchive.myTeamId) {
        liveArchive.myTeamId = nextTeamId;
        changed = true;
    }

    return changed;
}

function rememberZoneMetadata(zones) {
    if (!Array.isArray(zones)) return;

    for (const zone of zones) {
        if (!zone?.zoneId) continue;
        zoneMetadataById.set(Number(zone.zoneId), {
            zoneId: Number(zone.zoneId),
            type: zone.type || "",
            ownerSeatId: zone.ownerSeatId ?? null
        });
    }
}

function getAnnotationDetail(annotation, key) {
    const details = Array.isArray(annotation?.details) ? annotation.details : [];
    for (const item of details) {
        if (item?.key !== key) continue;
        if (Array.isArray(item.valueString) && item.valueString.length) return item.valueString[0];
        if (Array.isArray(item.valueInt32) && item.valueInt32.length) return item.valueInt32[0];
        if (Array.isArray(item.valueUInt32) && item.valueUInt32.length) return item.valueUInt32[0];
    }
    return null;
}

function seatLabelForTimeline(seatId) {
    if (!seatId) return "Game";
    return seatId === gameState.mySeatId ? "You" : "Opponent";
}

function applyGameResultSnapshot(resultCode, resultText, resultReason, winningTeamId = null) {
    const normalizedCode = resultCode === "win" || resultCode === "loss" ? resultCode : "unknown";
    const nextText = String(resultText || liveArchive.resultText || "Unknown").trim();
    const nextReason = resultReason ? humanizeToken(resultReason) : liveArchive.resultReason;
    const changed =
        liveArchive.resultCode !== normalizedCode ||
        liveArchive.resultText !== nextText ||
        liveArchive.resultReason !== nextReason ||
        liveArchive.winningTeamId !== winningTeamId;

    if (!changed) return false;
    liveArchive.resultCode = normalizedCode;
    liveArchive.resultText = nextText;
    liveArchive.resultReason = nextReason;
    liveArchive.winningTeamId = winningTeamId;

    // If the game was already persisted with "unknown", patch the DB now
    if (normalizedCode !== "unknown" && liveArchive.persisted && gameState.matchId) {
        const gameKey = currentGameRecordKey();
        const patched = historyStore.updateGameResult(
            gameKey,
            gameState.matchId,
            normalizedCode,
            nextText,
            nextReason,
            gameState.gameEndedAt || null
        );
        if (patched) {
            console.log(`[history] Patched result for ${gameKey}: ${normalizedCode}`);
            matchHistory = historyStore.loadRecentMatchPreview(12);
        }
    }

    return true;
}

function applyResultsList(results, preferredScope = "MatchScope_Game", localTeamId = liveArchive.myTeamId) {
    if (!Array.isArray(results) || !results.length) return false;

    const result = results.find((entry) => entry?.scope === preferredScope) || results[0];
    const winningTeamId = result?.winningTeamId ?? null;
    const resultCode =
        winningTeamId != null && localTeamId != null
            ? winningTeamId === localTeamId
                ? "win"
                : "loss"
            : "unknown";
    const reason = humanizeToken(result?.reason || "");
    const resultText = resultCode === "win"
        ? `Win${reason ? ` · ${reason}` : ""}`
        : resultCode === "loss"
            ? `Loss${reason ? ` · ${reason}` : ""}`
            : gameState.matchState || "Game Complete";

    return applyGameResultSnapshot(resultCode, resultText, result?.reason || null, winningTeamId);
}

function maybeResolveOnPlayFromTurn(turnInfo) {
    const activePlayer = turnInfo?.activePlayer ?? gameState.turn.activePlayer;
    if (liveArchive.onPlay != null || !activePlayer || !gameState.mySeatId) return false;

    liveArchive.startingPlayerSeatId = activePlayer;
    liveArchive.onPlay = activePlayer === gameState.mySeatId;
    return true;
}

function capturePreGameHandSnapshot(timestampMs) {
    if (!gameState.zones.hand.length) return false;
    if (gameState.turn.number > 1) return false;
    if (
        gameState.zones.myBattlefield.length ||
        gameState.zones.oppBattlefield.length ||
        gameState.zones.myGraveyard.length ||
        gameState.zones.oppGraveyard.length ||
        gameState.zones.myExile.length ||
        gameState.zones.oppExile.length ||
        gameState.zones.stack.length
    ) {
        return false;
    }

    const cards = snapshotZoneCards(gameState.zones.hand);
    const key = `${cards.map((card) => card.instanceId ?? card.grpId ?? card.name).join(",")}:${cards.length}:${liveArchive.awaitingMulliganDecision}`;
    if (liveArchive.handSnapshots.some((snapshot) => snapshot.key === key)) return false;

    liveArchive.handSnapshots.push({
        key,
        timestamp: timestampMs,
        size: cards.length,
        awaitingMulliganDecision: liveArchive.awaitingMulliganDecision,
        cards
    });
    if (liveArchive.handSnapshots.length > 12) {
        liveArchive.handSnapshots.splice(0, liveArchive.handSnapshots.length - 12);
    }
    return true;
}

function tryFinalizeOpeningHand() {
    if (liveArchive.openingHandFrozen) return false;

    const expectedSize = Math.max(0, liveArchive.maxHandSize - (liveArchive.mulliganCount || 0));
    if (!expectedSize) return false;

    const candidate =
        [...liveArchive.handSnapshots].reverse().find((snapshot) => !snapshot.awaitingMulliganDecision && snapshot.size === expectedSize) ||
        [...liveArchive.handSnapshots].reverse().find((snapshot) => snapshot.size === expectedSize) ||
        null;

    if (!candidate) return false;

    liveArchive.openingHand = candidate.cards;
    liveArchive.openingHandSize = expectedSize;
    liveArchive.openingHandFrozen = true;
    for (const card of candidate.cards) {
        if (!card?.grpId) continue;
        // Only count if not already tracked by zone transfer handler
        if (card.instanceId != null && !liveArchive.seenInstanceIds.has(card.instanceId)) {
            liveArchive.seenInstanceIds.set(card.instanceId, String(card.grpId));
            incrementCountMap(liveArchive.cardsSeen, String(card.grpId));
        } else if (card.instanceId == null) {
            incrementCountMap(liveArchive.cardsSeen, String(card.grpId));
        }
    }
    return true;
}

function updateArchiveFromPlayers(players) {
    if (!Array.isArray(players)) return false;

    let changed = false;
    for (const player of players) {
        if (player?.systemSeatNumber !== gameState.mySeatId) continue;

        const nextTeamId = player?.teamId ?? null;
        const nextMaxHandSize = Number(player?.maxHandSize ?? liveArchive.maxHandSize) || liveArchive.maxHandSize;
        const nextMulliganCount = Number(player?.mulliganCount ?? liveArchive.mulliganCount) || 0;
        const nextAwaitingMulligan = String(player?.pendingMessageType || "").includes("MulliganResp");

        if (nextTeamId != null && nextTeamId !== liveArchive.myTeamId) {
            liveArchive.myTeamId = nextTeamId;
            changed = true;
        }
        if (nextMaxHandSize !== liveArchive.maxHandSize) {
            liveArchive.maxHandSize = nextMaxHandSize;
            changed = true;
        }
        if (nextMulliganCount !== liveArchive.mulliganCount) {
            liveArchive.mulliganCount = nextMulliganCount;
            changed = true;
        }
        if (nextAwaitingMulligan !== liveArchive.awaitingMulliganDecision) {
            liveArchive.awaitingMulliganDecision = nextAwaitingMulligan;
            changed = true;
        }
    }

    return changed;
}

function updateArchivedTurnRecord(timestampMs) {
    if (!gameState.turn.number && !gameState.turn.phase) return false;

    const turnNumber = gameState.turn.number || 0;
    const nextRecord: HistoryTurnRecord = {
        turnNumber,
        activeSeatId: gameState.turn.activePlayer ?? null,
        activeLabel: seatLabelForTimeline(gameState.turn.activePlayer ?? null),
        phase: gameState.turn.phase || "Waiting",
        step: gameState.turn.step || "",
        yourLife: gameState.life.me,
        oppLife: gameState.life.opp,
        yourHandCount: gameState.zones.hand.length,
        oppHandCount: gameState.oppHandCount,
        yourBattlefieldCount: gameState.zones.myBattlefield.length,
        oppBattlefieldCount: gameState.zones.oppBattlefield.length,
        yourGraveyardCount: gameState.zones.myGraveyard.length,
        oppGraveyardCount: gameState.zones.oppGraveyard.length,
        yourExileCount: gameState.zones.myExile.length,
        oppExileCount: gameState.zones.oppExile.length,
        libraryCount: gameState.libraryCount,
        oppLibraryCount: gameState.oppLibraryCount,
        recordedAt: timestampMs
    };

    const previous = liveArchive.turnRecords.get(turnNumber);
    if (previous && JSON.stringify(previous) === JSON.stringify(nextRecord)) return false;
    liveArchive.turnRecords.set(turnNumber, nextRecord);
    return true;
}

function describeZoneForTimeline(zone) {
    if (!zone?.type) return "unknown zone";

    switch (zone.type) {
        case "ZoneType_Hand":
            return zone.ownerSeatId === gameState.mySeatId ? "your hand" : "opponent hand";
        case "ZoneType_Library":
            return zone.ownerSeatId === gameState.mySeatId ? "your library" : "opponent library";
        case "ZoneType_Graveyard":
            return zone.ownerSeatId === gameState.mySeatId ? "your graveyard" : "opponent graveyard";
        case "ZoneType_Battlefield":
            return "the battlefield";
        case "ZoneType_Stack":
            return "the stack";
        case "ZoneType_Exile":
            return "exile";
        default:
            return humanizeToken(zone.type);
    }
}

function getTimelineCardLabel(card, destinationZone, seatId) {
    if (card?.name) return card.name;
    if (destinationZone?.type === "ZoneType_Hand" && seatId !== gameState.mySeatId) return "a card";
    if (destinationZone?.type === "ZoneType_Stack") return "a spell";
    if (destinationZone?.type === "ZoneType_Battlefield") return "a permanent";
    return "a card";
}

function appendTimelineEntry(key, summary, detail, kind = "event", seatId = null) {
    if (!summary || seenTimelineEntries.has(key)) return false;

    seenTimelineEntries.add(key);
    const entry = {
        id: key,
        kind,
        actor: seatLabelForTimeline(seatId),
        turnNumber: gameState.turn.number || 0,
        phase: gameState.turn.phase || "Waiting",
        step: gameState.turn.step || "",
        summary,
        detail,
        timestamp: Date.now()
    };

    gameState.timeline.push(entry);
    // Mirror every entry into the uncapped archival timeline so no history is lost.
    liveArchive.fullTimeline.push(entry);

    if (gameState.timeline.length > 120) {
        const overflow = gameState.timeline.length - 120;
        gameState.timeline.splice(0, overflow);
    }

    return true;
}

function getGameLabel(gameNumber) {
    return gameNumber ? `Game ${gameNumber}` : "Game";
}

function markGameComplete(detail) {
    if (gameState.gameEnded) return false;

    gameState.gameEnded = true;
    gameState.active = false;
    gameState.gameEndedAt = Date.now();
    const timelineChanged = appendTimelineEntry(
        `game:end:${gameState.matchId ?? "unknown"}:${gameState.gameNumber || 0}`,
        `${getGameLabel(gameState.gameNumber)} complete`,
        detail || "Waiting for next game",
        "turn"
    );

    // Defer persist by one event-loop tick so the rest of the current log
    // batch (which may include the result code) processes first.
    if (hasTrackableGameState()) {
        setTimeout(() => {
            persistCurrentGameToHistory();
        }, 0);
    }

    return timelineChanged;
}

function hasTrackableGameState() {
    return Boolean(
        gameState.matchId ||
        gameState.gameNumber ||
        gameState.turn.number ||
        gameState.timeline.length ||
        gameState.zones.hand.length ||
        gameState.zones.myBattlefield.length ||
        gameState.zones.oppBattlefield.length ||
        gameState.zones.myGraveyard.length ||
        gameState.zones.oppGraveyard.length ||
        gameState.zones.myExile.length ||
        gameState.zones.oppExile.length ||
        gameState.zones.stack.length
    );
}

function buildTrackedGameRecord(statusOverride = null) {
    const recordKey = `${gameState.matchId ?? "unknown"}:${gameState.gameNumber || 0}`;
    const status = statusOverride || (gameState.gameEnded ? "complete" : gameState.active ? "live" : "pending");

    return {
        key: recordKey,
        matchId: gameState.matchId ?? "unknown",
        gameNumber: gameState.gameNumber || 0,
        label: getGameLabel(gameState.gameNumber),
        deckName: gameState.deckName,
        format: gameState.format,
        status,
        result: gameState.matchState || (gameState.gameEnded ? "Game Complete" : "In Progress"),
        startedAt: gameState.gameStartedAt || gameState.lastUpdate,
        endedAt: gameState.gameEndedAt || null,
        turnNumber: gameState.turn.number || 0,
        timelineCount: gameState.timeline.length,
        life: { ...gameState.life },
        counts: {
            hand: gameState.zones.hand.length,
            myBattlefield: gameState.zones.myBattlefield.length,
            oppBattlefield: gameState.zones.oppBattlefield.length,
            myGraveyard: gameState.zones.myGraveyard.length,
            oppGraveyard: gameState.zones.oppGraveyard.length,
            myExile: gameState.zones.myExile.length,
            oppExile: gameState.zones.oppExile.length,
            stack: gameState.zones.stack.length
        }
    };
}

function findOrCreateMatchRecord(matchId) {
    const key = matchId || "unknown";
    let record = matchHistory.find((entry) => entry.matchId === key);
    if (record) return record;

    record = {
        matchId: key,
        deckName: gameState.deckName,
        format: gameState.format,
        startedAt: gameState.gameStartedAt || Date.now(),
        updatedAt: Date.now(),
        completedAt: null,
        games: []
    };
    matchHistory.unshift(record);
    if (matchHistory.length > 12) matchHistory = matchHistory.slice(0, 12);
    return record;
}

/**
 * Generates a compact, human-readable plain-text game narrative from the full archival timeline.
 * This is stored alongside the game record so an LLM can immediately understand what happened
 * in the game without having to parse raw JSON event arrays.
 *
 * Format example:
 *   Win · T8 · On Play · Azorius Soldiers (Standard)
 *   Opening hand (7): Recruitment Officer, Harbin, Plains, Plains, Sunlance, Thalia's Lieutenant, Hopeful Initiate
 *   T1 You: played Plains
 *   T2 You: played Plains · cast Recruitment Officer
 *   T2 Opp: played Swamp
 *   T3 You: played Plains · cast Harbin, Vanguard Aviator
 *   T3 Opp: cast Go for the Throat → Recruitment Officer went to your graveyard
 *   ...
 *   Final board: You 20 life (4 permanents) | Opp 4 life (1 permanent)
 *   Opponent cards seen: Lightning Bolt, Fatal Push, Thoughtseize
 */
function buildGameNarrative(fullTimeline: Array<Record<string, unknown>>): string {
    const lines: string[] = [];

    // --- Header ---
    const resultLabel = liveArchive.resultCode === "win" ? "Win"
        : liveArchive.resultCode === "loss" ? "Loss"
        : "Unknown";
    const onPlayLabel = liveArchive.onPlay == null ? "" : liveArchive.onPlay ? " · On Play" : " · On Draw";
    const mulliganLabel = (liveArchive.mulliganCount ?? 0) > 0 ? ` · ${liveArchive.mulliganCount}x mulligan` : "";
    const turnLabel = gameState.turn.number ? ` · T${gameState.turn.number}` : "";
    const deckLabel = [gameState.deckName, gameState.format].filter((v) => v && v !== "Unknown").join(" · ");
    lines.push(resultLabel + turnLabel + onPlayLabel + mulliganLabel + (deckLabel ? " \u00b7 " + deckLabel : ""));

    // --- Opening hand ---
    if (liveArchive.openingHand.length) {
        const handNames = liveArchive.openingHand.map((card) => card.name || "Unknown").join(", ");
        lines.push(`Opening hand (${liveArchive.openingHandSize ?? liveArchive.openingHand.length}): ${handNames}`);
    }

    // --- Turn-by-turn action log ---
    // Group non-"turn-header" timeline entries by turn number, collecting their summaries.
    // We skip pure phase/step markers (kind === "turn" with no card action) since they're noise.
    const actionsByTurn = new Map<number, { actor: string; summary: string }[]>();
    for (const entry of fullTimeline) {
        const kind = String(entry.kind || "");
        const summary = String(entry.summary || "");
        const turnNumber = Number(entry.turnNumber || 0);
        const actor = String(entry.actor || "");

        // Skip turn-progression markers that are just "Turn N · You" or "Phase update"
        if (kind === "turn") continue;
        // Skip low-information draw events for the opponent (we don't know what they drew)
        if (summary.startsWith("Opponent drew a card")) continue;

        if (!actionsByTurn.has(turnNumber)) actionsByTurn.set(turnNumber, []);
        actionsByTurn.get(turnNumber)!.push({ actor, summary });
    }

    const sortedTurns = [...actionsByTurn.keys()].sort((a, b) => a - b);
    for (const turnNum of sortedTurns) {
        if (turnNum === 0) continue; // pre-game setup events
        const actions = actionsByTurn.get(turnNum)!;

        // Group consecutive actions by the same actor within the turn
        const grouped: { actor: string; summaries: string[] }[] = [];
        for (const action of actions) {
            const last = grouped[grouped.length - 1];
            if (last && last.actor === action.actor) {
                last.summaries.push(action.summary);
            } else {
                grouped.push({ actor: action.actor, summaries: [action.summary] });
            }
        }

        for (const group of grouped) {
            lines.push(`T${turnNum} ${group.actor}: ${group.summaries.join(" · ")}`);
        }
    }

    // --- Final board state ---
    const fb = gameState.zones;
    const myPerm = fb.myBattlefield?.length ?? 0;
    const oppPerm = fb.oppBattlefield?.length ?? 0;
    const myLife = gameState.life.me;
    const oppLife = gameState.life.opp;
    lines.push(`Final board: You ${myLife} life (${myPerm} permanent${myPerm !== 1 ? "s" : ""}) | Opp ${oppLife} life (${oppPerm} permanent${oppPerm !== 1 ? "s" : ""})`);

    // --- Opponent cards seen ---
    const oppSeen = [...liveArchive.cardsSeen.entries()]
        .map(([grpId, count]) => {
            const info = getCachedCardInfo(grpId);
            return info?.name || `Card #${grpId}`;
        })
        .filter((name) => !name.startsWith("Card #"));
    if (oppSeen.length) {
        lines.push(`Opponent cards seen: ${oppSeen.join(", ")}`);
    }

    return lines.join("\n");
}

function buildFullGameRecord(): HistoryGameRecord {
    const gameKey = currentGameRecordKey();
    const now = Date.now();

    const cardsDrawn: CardCountRecord[] = [...liveArchive.cardsDrawn.entries()].map(([grpId, count]) => {
        const info = getCachedCardInfo(grpId);
        return {
            grpId,
            name: info?.name || `Card #${grpId}`,
            count,
            typeLine: info?.type_line || "",
            set: info?.set || "",
            rarity: info?.rarity || ""
        };
    });

    const cardsSeen: CardCountRecord[] = [...liveArchive.cardsSeen.entries()].map(([grpId, count]) => {
        const info = getCachedCardInfo(grpId);
        return {
            grpId,
            name: info?.name || `Card #${grpId}`,
            count,
            typeLine: info?.type_line || "",
            set: info?.set || "",
            rarity: info?.rarity || ""
        };
    });

    const turnRecords: HistoryTurnRecord[] = [...liveArchive.turnRecords.values()]
        .sort((a, b) => a.turnNumber - b.turnNumber);

    const startAt = gameState.gameStartedAt || null;
    const endAt = gameState.gameEndedAt || (gameState.gameEnded ? now : null);
    const durationMs = startAt && endAt ? endAt - startAt : null;

    return {
        gameKey,
        matchId: gameState.matchId ?? "unknown",
        gameNumber: gameState.gameNumber || 0,
        deckName: gameState.deckName || "Unknown Deck",
        format: gameState.format || "Unknown",
        startAt,
        endAt,
        durationMs,
        resultCode: liveArchive.resultCode,
        result: liveArchive.resultText || (gameState.gameEnded ? "Game Complete" : "In Progress"),
        resultReason: liveArchive.resultReason,
        turnCount: gameState.turn.number || 0,
        onPlay: liveArchive.onPlay,
        openingHandSize: liveArchive.openingHandSize,
        openingHand: liveArchive.openingHand,
        mulliganCount: liveArchive.mulliganCount || 0,
        cardsDrawn,
        cardsSeen,
        finalBoard: {
            life: { ...gameState.life },
            counts: {
                hand: gameState.zones.hand.length,
                myBattlefield: gameState.zones.myBattlefield.length,
                oppBattlefield: gameState.zones.oppBattlefield.length,
                myGraveyard: gameState.zones.myGraveyard.length,
                oppGraveyard: gameState.zones.oppGraveyard.length,
                myExile: gameState.zones.myExile.length,
                oppExile: gameState.zones.oppExile.length,
                stack: gameState.zones.stack.length
            },
            zones: {
                hand: snapshotZoneCards(gameState.zones.hand),
                myBattlefield: snapshotZoneCards(gameState.zones.myBattlefield),
                oppBattlefield: snapshotZoneCards(gameState.zones.oppBattlefield),
                myGraveyard: snapshotZoneCards(gameState.zones.myGraveyard),
                oppGraveyard: snapshotZoneCards(gameState.zones.oppGraveyard),
                myExile: snapshotZoneCards(gameState.zones.myExile),
                oppExile: snapshotZoneCards(gameState.zones.oppExile),
                stack: snapshotZoneCards(gameState.zones.stack)
            }
        },
        eventSummary: {
            total: liveArchive.eventCounts.draws + liveArchive.eventCounts.plays + liveArchive.eventCounts.casts + liveArchive.eventCounts.zoneTransfers,
            draws: liveArchive.eventCounts.draws,
            plays: liveArchive.eventCounts.plays,
            casts: liveArchive.eventCounts.casts,
            zoneTransfers: liveArchive.eventCounts.zoneTransfers,
            timelineCount: liveArchive.fullTimeline.length
        },
        // Use the uncapped fullTimeline so the complete game history is stored,
        // not just the last 60 display entries.
        timeline: liveArchive.fullTimeline.map((entry) => ({ ...entry })),
        turnRecords,
        narrative: buildGameNarrative(liveArchive.fullTimeline),
        createdAt: startAt || now,
        updatedAt: now
    };
}

function persistCurrentGameToHistory() {
    if (liveArchive.persisted) return false;

    const gameKey = currentGameRecordKey();
    if (historyStore.hasGame(gameKey)) {
        liveArchive.persisted = true;
        return false;
    }

    const fullRecord = buildFullGameRecord();
    const result = historyStore.persistCompletedGame(fullRecord);

    if (result.stored) {
        liveArchive.persisted = true;
        matchHistory = historyStore.loadRecentMatchPreview(12);
        console.log(`[history] Persisted game ${gameKey} (${fullRecord.resultCode})`);
        return true;
    }

    if (result.duplicate) {
        liveArchive.persisted = true;
    }

    return false;
}

function ensurePendingCompletedGamePersisted() {
    if (!gameState.gameEnded || liveArchive.persisted || !hasTrackableGameState()) return false;
    return persistCurrentGameToHistory();
}

function reconcileCurrentCompletedMatch(force = false) {
    if (!gameState.gameEnded || !gameState.matchId) return false;

    const gameKey = currentGameRecordKey();
    if (historyStore.hasGame(gameKey)) {
        liveArchive.persisted = true;
        return false;
    }

    liveArchive.persisted = false;
    const now = Date.now();
    if (!force && (now - lastCompletedMatchRecoveryAt) < COMPLETED_MATCH_RECOVERY_THROTTLE_MS) {
        return false;
    }
    lastCompletedMatchRecoveryAt = now;

    const recovered = recoverCompletedMatchesFromRecentLog();
    const stored = historyStore.hasGame(gameKey);
    if (!stored) return false;

    liveArchive.persisted = true;
    if (gameState.deckName && !isPlaceholderDeckName(gameState.deckName)) {
        historyStore.updateGameDeckInfo(gameKey, gameState.matchId, gameState.deckName, gameState.format || "Unknown");
    }
    if (recovered.inserted || recovered.updated) {
        console.log(`[history] Reconciled completed match ${gameKey} via recent-log recovery`);
    }
    matchHistory = historyStore.loadRecentMatchPreview(12);
    return true;
}

function recoverCompletedMatchesFromRecentLog() {
    const tail = readLogTailWindow(LOG_PATH, RECOVERY_SCAN_WINDOW_BYTES);
    if (!tail) return { inserted: 0, updated: 0 };

    const recoveredByMatch = new Map();
    for (const obj of extractJsonObjectsFromText(tail)) {
        const wrapper = obj?.matchGameRoomStateChangedEvent;
        const info = wrapper?.gameRoomInfo;
        const stateType = String(info?.stateType || "");
        if (!info || !stateType.includes("MatchCompleted")) continue;

        const matchId = info?.gameRoomConfig?.matchId || info?.gameRoomConfig?.matchID || info?.finalMatchResult?.matchId || null;
        const resultList = Array.isArray(info?.finalMatchResult?.resultList) ? info.finalMatchResult.resultList : [];
        const result = resultList.find((entry) => entry?.scope === "MatchScope_Game")
            || resultList.find((entry) => entry?.scope === "MatchScope_Match")
            || resultList[0]
            || null;
        const localPlayer = resolveLocalReservedPlayer(info?.gameRoomConfig?.reservedPlayers || [], { preferRuntimeHints: false });
        const localTeamId = Number(localPlayer?.teamId ?? NaN);
        const winningTeamId = Number(result?.winningTeamId ?? NaN);
        if (!matchId || !Number.isFinite(localTeamId) || !Number.isFinite(winningTeamId)) continue;

        const resultCode = winningTeamId === localTeamId ? "win" : "loss";
        const rawReason = result?.reason ? String(result.reason) : null;
        const reason = rawReason ? humanizeToken(rawReason) : null;
        const resultText = buildResultText(resultCode, rawReason, "Recovered Match Result");
        const endAt = normalizeLogTimestamp(obj?.timestamp) || Date.now();
        const existing = recoveredByMatch.get(matchId);
        if (!existing || endAt >= existing.endAt) {
            recoveredByMatch.set(matchId, {
                matchId,
                resultCode,
                resultText,
                reason,
                endAt
            });
        }
    }

    let inserted = 0;
    let updated = 0;
    for (const recovered of recoveredByMatch.values()) {
        const gameKey = `${recovered.matchId}:1`;
        if (historyStore.hasGame(gameKey)) {
            updated += Number(historyStore.updateGameResult(
                gameKey,
                recovered.matchId,
                recovered.resultCode,
                recovered.resultText,
                recovered.reason,
                recovered.endAt
            ));
            continue;
        }

        const recoveredRecord: HistoryGameRecord = {
            gameKey,
            matchId: recovered.matchId,
            gameNumber: 1,
            deckName: "Unknown Deck",
            format: "Constructed",
            startAt: null,
            endAt: recovered.endAt,
            durationMs: null,
            resultCode: recovered.resultCode,
            result: recovered.resultText,
            resultReason: recovered.reason,
            turnCount: 0,
            onPlay: null,
            openingHandSize: null,
            openingHand: [],
            mulliganCount: 0,
            cardsDrawn: [],
            cardsSeen: [],
            finalBoard: {
                life: { me: 20, opp: 20 },
                counts: {},
                zones: {}
            },
            eventSummary: {
                total: 0,
                draws: 0,
                plays: 0,
                casts: 0,
                zoneTransfers: 0,
                timelineCount: 0
            },
            timeline: [{
                id: `recovered:${recovered.matchId}`,
                kind: "event",
                actor: "Game",
                turnNumber: 0,
                phase: "Recovered",
                step: "",
                summary: "Recovered completed match",
                detail: recovered.resultText,
                timestamp: recovered.endAt
            }],
            turnRecords: [],
            createdAt: recovered.endAt,
            updatedAt: recovered.endAt
        };

        const result = historyStore.persistCompletedGame(recoveredRecord);
        inserted += Number(result.stored);
    }

    if (inserted || updated) {
        matchHistory = historyStore.loadRecentMatchPreview(12);
    }

    return { inserted, updated };
}

function needsDeckRecovery() {
    return !gameState.startingDeck.size
        || isPlaceholderDeckName(gameState.deckName)
        || !gameState.format
        || gameState.format === "Unknown";
}

function recoverDeckStateFromRecentLog(force = false) {
    if (!force && !needsDeckRecovery()) return false;

    const now = Date.now();
    if (!force && (now - lastDeckRecoveryAt) < DECK_RECOVERY_THROTTLE_MS) return false;
    lastDeckRecoveryAt = now;

    const tail = readLogTailWindow(LOG_PATH, DECK_RECOVERY_SCAN_WINDOW_BYTES);
    if (!tail) return false;

    let recoveredDeckData = null;
    for (const obj of extractJsonObjectsFromText(tail)) {
        const deckData = findDeckData(obj);
        if (deckData?.entries?.length) {
            recoveredDeckData = deckData;
        }
    }

    if (!recoveredDeckData) return false;

    const changed = applyDeckDataToGameState(recoveredDeckData, {
        overwriteEntries: !gameState.startingDeck.size
    });
    if (changed) {
        console.log(`[deck] Recovered deck state from recent log: ${recoveredDeckData.name || "Unknown Deck"}`);
    }
    return changed;
}

function archiveCurrentGame(statusOverride = "complete") {
    if (gameState.gameArchived || !hasTrackableGameState()) return false;

    const matchRecord = findOrCreateMatchRecord(gameState.matchId);
    const gameRecord = buildTrackedGameRecord(statusOverride);
    const existingIndex = matchRecord.games.findIndex((entry) => entry.key === gameRecord.key);

    if (existingIndex >= 0) {
        matchRecord.games[existingIndex] = gameRecord;
    } else {
        matchRecord.games.push(gameRecord);
        matchRecord.games.sort((left, right) => (left.gameNumber || 0) - (right.gameNumber || 0));
    }

    matchRecord.deckName = gameState.deckName || matchRecord.deckName;
    matchRecord.format = gameState.format || matchRecord.format;
    matchRecord.updatedAt = Date.now();

    // Persist to SQLite history when the game is complete
    if (statusOverride === "complete" && gameState.gameEnded) {
        persistCurrentGameToHistory();
    }

    gameState.gameArchived = true;
    return true;
}

function getGamesForCurrentMatch() {
    const matchId = gameState.matchId ?? "unknown";
    const archivedGames = matchHistory.find((entry) => entry.matchId === matchId)?.games ?? [];
    const games = [...archivedGames];

    if (!gameState.gameArchived && hasTrackableGameState()) {
        const liveRecord = buildTrackedGameRecord(gameState.gameEnded ? "complete" : "live");
        const existingIndex = games.findIndex((entry) => entry.key === liveRecord.key);
        if (existingIndex >= 0) {
            games[existingIndex] = liveRecord;
        } else {
            games.push(liveRecord);
        }
    }

    return games.sort((left, right) => (left.gameNumber || 0) - (right.gameNumber || 0));
}

function finalizeCurrentMatchArchive() {
    const matchId = gameState.matchId ?? "unknown";
    const matchRecord = matchHistory.find((entry) => entry.matchId === matchId);
    if (!matchRecord) return false;

    matchRecord.updatedAt = Date.now();
    matchRecord.completedAt = Date.now();
    return true;
}

function syncGameInfo(gameInfo) {
    if (!gameInfo) return false;

    let changed = false;
    const nextMatchId = gameInfo.matchID || gameInfo.matchId || null;
    const parsedGameNumber = Number(gameInfo.gameNumber ?? 0);
    const nextGameNumber = Number.isFinite(parsedGameNumber) && parsedGameNumber > 0 ? parsedGameNumber : 0;
    const stageToken = String(gameInfo.stage || "");
    const matchStateToken = String(gameInfo.matchState || "");
    const startedNewGame =
        (nextMatchId && nextMatchId !== gameState.matchId) ||
        (nextGameNumber && nextGameNumber !== gameState.gameNumber);

    if (startedNewGame) {
        archiveCurrentGame();
        resetGameTracking();
        if (nextMatchId) gameState.matchId = nextMatchId;
        if (nextGameNumber) gameState.gameNumber = nextGameNumber;
        gameState.active = true;
        gameState.gameStartedAt = Date.now();
        changed = appendTimelineEntry(
            `game:start:${gameState.matchId ?? "unknown"}:${gameState.gameNumber || 0}`,
            `${getGameLabel(gameState.gameNumber)} started`,
            [gameState.deckName, gameState.format].filter(Boolean).join(" · ") || "Waiting for opening hand",
            "turn"
        ) || changed;
    } else {
        if (nextMatchId && nextMatchId !== gameState.matchId) {
            gameState.matchId = nextMatchId;
            changed = true;
        }
        if (nextGameNumber && nextGameNumber !== gameState.gameNumber) {
            gameState.gameNumber = nextGameNumber;
            changed = true;
        }
    }

    const nextMatchState = humanizeToken(gameInfo.matchState || gameInfo.stage);
    if (nextMatchState !== gameState.matchState) {
        gameState.matchState = nextMatchState;
        changed = true;
    }

    const nextFormat = humanizeToken(gameInfo.superFormat || "");
    if (nextFormat && (gameState.format === "Unknown" || gameState.format === "Constructed")) {
        if (nextFormat !== gameState.format) {
            gameState.format = nextFormat;
            changed = true;
        }
    }

    if (!gameState.gameEnded && (matchStateToken.includes("InProgress") || stageToken.includes("Start") || stageToken.includes("Play"))) {
        if (!gameState.active) {
            gameState.active = true;
            changed = true;
        }
        if (!gameState.gameStartedAt) {
            gameState.gameStartedAt = Date.now();
            changed = true;
        }
    }

    // Capture results BEFORE marking complete so they're available for persistence
    if (Array.isArray(gameInfo.results) && gameInfo.results.length) {
        changed = applyResultsList(gameInfo.results) || changed;
    }

    if (stageToken.includes("GameOver") || matchStateToken.includes("GameComplete") || matchStateToken.includes("MatchComplete")) {
        changed = markGameComplete(nextMatchState) || changed;
    }

    return changed;
}

function recordTurnProgression() {
    if (!gameState.turn.number && !gameState.turn.phase) return false;

    const key = `turn:${gameState.turn.number}:${gameState.turn.phase}:${gameState.turn.step}:${gameState.turn.activePlayer ?? "none"}`;
    const actor = gameState.turn.activePlayer ? seatLabelForTimeline(gameState.turn.activePlayer) : "Game";
    const summary = gameState.turn.number ? `Turn ${gameState.turn.number} · ${actor}` : `Phase update · ${actor}`;
    const detail = [gameState.turn.phase, gameState.turn.step].filter(Boolean).join(" / ") || "Waiting";

    return appendTimelineEntry(key, summary, detail, "turn", gameState.turn.activePlayer ?? null);
}

function buildZoneTransferEntry(card, sourceZone, destinationZone, category, seatId) {
    if (!destinationZone?.type) return null;
    if (destinationZone.type === "ZoneType_Limbo" || destinationZone.type === "ZoneType_Revealed") return null;

    const actor = seatLabelForTimeline(seatId);
    const cardLabel = getTimelineCardLabel(card, destinationZone, seatId);
    const sourceLabel = describeZoneForTimeline(sourceZone);
    const destinationLabel = describeZoneForTimeline(destinationZone);

    if (category === "Draw") {
        return {
            summary: `${actor} drew ${cardLabel}`,
            detail: `${sourceLabel} -> ${destinationLabel}`
        };
    }

    if (category === "PlayLand") {
        return {
            summary: `${actor} played ${cardLabel}`,
            detail: `${sourceLabel} -> ${destinationLabel}`
        };
    }

    if (destinationZone.type === "ZoneType_Stack") {
        return {
            summary: `${actor} cast ${cardLabel}`,
            detail: `${sourceLabel} -> ${destinationLabel}`
        };
    }

    if (destinationZone.type === "ZoneType_Battlefield") {
        return {
            summary: `${actor} put ${cardLabel} onto the battlefield`,
            detail: `${sourceLabel} -> ${destinationLabel}`
        };
    }

    if (destinationZone.type === "ZoneType_Graveyard") {
        return {
            summary: `${cardLabel} went to ${destinationLabel}`,
            detail: `${sourceLabel} -> ${destinationLabel}`
        };
    }

    if (destinationZone.type === "ZoneType_Hand") {
        return {
            summary: `${cardLabel} moved to ${destinationLabel}`,
            detail: `${sourceLabel} -> ${destinationLabel}`
        };
    }

    if (destinationZone.type === "ZoneType_Exile" || destinationZone.type === "ZoneType_Library") {
        return {
            summary: `${cardLabel} moved to ${destinationLabel}`,
            detail: `${sourceLabel} -> ${destinationLabel}`
        };
    }

    return null;
}

function recordZoneTransferTimeline(state) {
    if (!Array.isArray(state.annotations)) return false;

    let changed = false;

    for (const annotation of state.annotations) {
        const types = annotation?.type || annotation?.Type || [];
        if (!Array.isArray(types) || !types.includes("AnnotationType_ZoneTransfer")) continue;

        const sourceZoneId = Number(getAnnotationDetail(annotation, "zone_src"));
        const destinationZoneId = Number(getAnnotationDetail(annotation, "zone_dest"));
        const category = getAnnotationDetail(annotation, "category");
        const sourceZone = zoneMetadataById.get(sourceZoneId) || null;
        const destinationZone = zoneMetadataById.get(destinationZoneId) || null;
        const instanceId = Array.isArray(annotation.affectedIds) ? annotation.affectedIds[0] : null;
        const card = instanceId ? buildCard(instanceId) : null;
        const seatId = destinationZone?.ownerSeatId ?? sourceZone?.ownerSeatId ?? card?.controllerSeatId ?? card?.ownerSeatId ?? null;
        const entry = buildZoneTransferEntry(card, sourceZone, destinationZone, category, seatId);

        if (!entry) continue;

        // Track event counts and card seen/drawn in liveArchive
        const isMine = seatId === gameState.mySeatId;
        liveArchive.eventCounts.zoneTransfers += 1;
        if (category === "Draw" && isMine) {
            liveArchive.eventCounts.draws += 1;
            if (card?.grpId) {
                incrementCountMap(liveArchive.cardsDrawn, String(card.grpId));
                // Mark as seen here so the general handler below doesn't double-count
                if (instanceId != null) {
                    liveArchive.drawnInstanceIds.add(instanceId);
                    if (!liveArchive.seenInstanceIds.has(instanceId)) {
                        liveArchive.seenInstanceIds.set(instanceId, String(card.grpId));
                        incrementCountMap(liveArchive.cardsSeen, String(card.grpId));
                    }
                } else {
                    incrementCountMap(liveArchive.cardsSeen, String(card.grpId));
                }
            }
        } else if (category === "PlayLand" && isMine) {
            liveArchive.eventCounts.plays += 1;
        } else if (destinationZone?.type === "ZoneType_Stack") {
            liveArchive.eventCounts.casts += 1;
        }
        // Track OUR cards that appear in a visible zone for the first time (non-draw).
        // Only count cards owned by us (or whose owner is unknown) to avoid polluting
        // cardsSeen with opponent cards.
        if (isMine && card?.grpId && instanceId != null && !liveArchive.seenInstanceIds.has(instanceId)) {
            liveArchive.seenInstanceIds.set(instanceId, String(card.grpId));
            incrementCountMap(liveArchive.cardsSeen, String(card.grpId));
        }

        changed = appendTimelineEntry(`annotation:${annotation.id ?? `${sourceZoneId}:${destinationZoneId}:${instanceId}`}`, entry.summary, entry.detail, "event", seatId) || changed;
    }

    return changed;
}

function hasLossOfGameAnnotation(state) {
    const annotations = Array.isArray(state?.persistentAnnotations) ? state.persistentAnnotations : [];
    return annotations.some((annotation) => {
        const types = annotation?.type || annotation?.Type || [];
        return Array.isArray(types) && types.includes("AnnotationType_LossOfGame");
    });
}

function toPercent(value) {
    return Number((Math.max(0, value) * 100).toFixed(1));
}

function calculateHitChance(targetCount, population, draws) {
    const safePopulation = Math.max(0, Number(population) || 0);
    const safeTargetCount = Math.min(Math.max(0, Number(targetCount) || 0), safePopulation);
    const safeDraws = Math.min(Math.max(0, Number(draws) || 0), safePopulation);

    if (!safePopulation || !safeTargetCount || !safeDraws) return 0;

    let missChance = 1;
    for (let index = 0; index < safeDraws; index++) {
        missChance *= (safePopulation - safeTargetCount - index) / (safePopulation - index);
    }

    return toPercent(1 - missChance);
}

function getCardTypeFlags(typeLine) {
    const normalizedTypeLine = String(typeLine || "");
    if (!normalizedTypeLine.trim()) {
        return {
            isLand: false,
            isCreature: false,
            isAction: false,
            isNonLand: false
        };
    }

    const isLand = /\bLand\b/i.test(normalizedTypeLine);
    const isCreature = /\bCreature\b/i.test(normalizedTypeLine);

    return {
        isLand,
        isCreature,
        isAction: !isLand && !isCreature,
        isNonLand: !isLand
    };
}

function getTypeLineForGrpId(grpId) {
    if (!grpId) return "";

    const info = getCachedCardInfo(grpId);
    if (!info) {
        queueCardAssetFetch(grpId);
        return "";
    }

    return String(info.type_line || "");
}

function summarizeDeckEntries(entries) {
    const summary = {
        total: 0,
        lands: 0,
        creatures: 0,
        action: 0,
        nonLand: 0
    };

    for (const [grpId, count] of entries) {
        const copies = Math.max(0, Number(count) || 0);
        const flags = getCardTypeFlags(getTypeLineForGrpId(grpId));
        summary.total += copies;

        if (flags.isLand) summary.lands += copies;
        if (flags.isCreature) summary.creatures += copies;
        if (flags.isAction) summary.action += copies;
        if (flags.isNonLand) summary.nonLand += copies;
    }

    return summary;
}

function summarizeVisibleCards(cards) {
    const summary = {
        total: 0,
        unique: 0,
        lands: 0,
        creatures: 0,
        action: 0,
        nonLand: 0
    };

    const uniqueCards = new Set();
    for (const card of cards) {
        if (!card) continue;

        const typeLine = card.typeLine || getTypeLineForGrpId(card.grpId);
        const flags = getCardTypeFlags(typeLine);
        summary.total += 1;

        if (card.grpId) uniqueCards.add(String(card.grpId));
        if (flags.isLand) summary.lands += 1;
        if (flags.isCreature) summary.creatures += 1;
        if (flags.isAction) summary.action += 1;
        if (flags.isNonLand) summary.nonLand += 1;
    }

    summary.unique = uniqueCards.size;
    return summary;
}

function getObservedDeckCards() {
    const zoneGroups = [
        { cards: gameState.zones.hand, assumeMine: true },
        { cards: gameState.zones.myBattlefield, assumeMine: true },
        { cards: gameState.zones.oppBattlefield, assumeMine: false },
        { cards: gameState.zones.myGraveyard, assumeMine: true },
        { cards: gameState.zones.oppGraveyard, assumeMine: false },
        { cards: gameState.zones.myExile, assumeMine: true },
        { cards: gameState.zones.oppExile, assumeMine: false },
        { cards: gameState.zones.stack, assumeMine: false }
    ];

    const cards = [];
    for (const group of zoneGroups) {
        for (const card of group.cards) {
            if (!card?.grpId) continue;

            const ownerSeatId = card.ownerSeatId ?? null;
            const belongsToMe = ownerSeatId != null && gameState.mySeatId != null
                ? ownerSeatId === gameState.mySeatId
                : group.assumeMine;

            if (belongsToMe) cards.push(card);
        }
    }

    return cards;
}

function getRemainingDeckDetails() {
    const remainingDeck = new Map(gameState.startingDeck);
    const seen = getObservedDeckCards();

    for (const card of seen) {
        if (card.grpId && remainingDeck.has(card.grpId)) {
            const count = remainingDeck.get(card.grpId);
            if (count > 0) remainingDeck.set(card.grpId, count - 1);
        }
    }

    return remainingDeck;
}

function getDrawStats(remainingEntries, libraryCount, probabilities) {
    const remainingCards = remainingEntries.reduce((sum, [, count]) => sum + count, 0);
    const denominator = libraryCount || remainingCards || 1;
    const breakdown = summarizeDeckEntries(remainingEntries);
    const topCard = probabilities[0] || null;

    return {
        remainingCards,
        uniqueCards: remainingEntries.length,
        topCard,
        topCardNextTwo: topCard?.nextTwoChance || 0,
        topCardNextThree: topCard?.nextThreeChance || 0,
        landChance: toPercent(breakdown.lands / denominator),
        landNextTwo: calculateHitChance(breakdown.lands, denominator, 2),
        creatureChance: toPercent(breakdown.creatures / denominator),
        creatureNextTwo: calculateHitChance(breakdown.creatures, denominator, 2),
        actionChance: toPercent(breakdown.action / denominator),
        actionNextTwo: calculateHitChance(breakdown.action, denominator, 2),
        nonLandChance: toPercent(breakdown.nonLand / denominator),
        nonLandNextTwo: calculateHitChance(breakdown.nonLand, denominator, 2),
        breakdown
    };
}

function buildDeckProbabilityList(entries, denominator) {
    return entries
        .map(([gid, count]) => {
            const deckCount = Math.max(Number(gameState.startingDeck.get(String(gid)) || 0), Number(count || 0));
            return {
                grpId: gid,
                name: resolveName(gid),
                imagePath: resolveImage(gid),
                colors: resolveColors(gid),
                count,
                deckCount,
                chance: toPercent(count / denominator),
                nextTwoChance: calculateHitChance(count, denominator, 2),
                nextThreeChance: calculateHitChance(count, denominator, 3)
            };
        })
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
        .slice(0, 24);
}

function handleGameStateMessage(msg) {
    const state = msg.gameStateMessage || msg.GameStateMessage || msg.queuedGameStateMessage || msg.QueuedGameStateMessage;
    if (!state) return;

    let changed = false;
    changed = updateLocalSeatFromMessage(msg) || changed;
    changed = syncGameInfo(state.gameInfo) || changed;
    changed = updateObjectsFromState(state) || changed;

    const turnChanged = updateTurnInfo(state.turnInfo);
    changed = turnChanged || changed;
    if (turnChanged) {
        changed = recordTurnProgression() || changed;
    }

    if (Array.isArray(state.zones)) {
        rememberZoneMetadata(state.zones);

        for (const zone of state.zones) {
            const ids = Array.isArray(zone.objectInstanceIds) ? zone.objectInstanceIds : [];
            const cards = ids.map((id) => buildCard(id)).filter((card) => card.name);

            if (zone.type === "ZoneType_Hand") {
                if (zone.ownerSeatId === gameState.mySeatId) {
                    gameState.zones.hand = cards.sort(compareCards);
                    changed = true;
                } else if (zone.ownerSeatId) {
                    gameState.oppHandCount = ids.length;
                    changed = true;
                }
            } else if (zone.type === "ZoneType_Battlefield") {
                gameState.zones.myBattlefield = cards
                    .filter((card) => (card.controllerSeatId || card.ownerSeatId) === gameState.mySeatId)
                    .sort(compareCards);
                gameState.zones.oppBattlefield = cards
                    .filter((card) => (card.controllerSeatId || card.ownerSeatId) !== gameState.mySeatId)
                    .sort(compareCards);
                changed = true;
            } else if (zone.type === "ZoneType_Graveyard") {
                if (zone.ownerSeatId === gameState.mySeatId) {
                    gameState.zones.myGraveyard = cards.sort(compareCards);
                    changed = true;
                } else if (zone.ownerSeatId) {
                    gameState.zones.oppGraveyard = cards.sort(compareCards);
                    changed = true;
                }
            } else if (zone.type === "ZoneType_Exile") {
                if (zone.ownerSeatId === gameState.mySeatId) {
                    gameState.zones.myExile = cards.sort(compareCards);
                    changed = true;
                } else if (zone.ownerSeatId) {
                    gameState.zones.oppExile = cards.sort(compareCards);
                    changed = true;
                }
            } else if (zone.type === "ZoneType_Library") {
                if (zone.ownerSeatId === gameState.mySeatId) {
                    gameState.libraryCount = ids.length;
                    changed = true;
                } else if (zone.ownerSeatId) {
                    gameState.oppLibraryCount = ids.length;
                    changed = true;
                }
            } else if (zone.type === "ZoneType_Stack") {
                gameState.zones.stack = cards.sort(compareCards);
                changed = true;
            }
        }
    }

    changed = recordZoneTransferTimeline(state) || changed;
    if (hasLossOfGameAnnotation(state)) {
        changed = markGameComplete(gameState.matchState) || changed;
    }

    if (Array.isArray(state.players)) {
        for (const player of state.players) {
            if (!gameState.mySeatId && player?.controllerSeatId === player?.systemSeatNumber) {
                gameState.mySeatId = player.systemSeatNumber;
                changed = true;
            }

            if (player.systemSeatNumber === gameState.mySeatId) {
                if (gameState.life.me !== player.lifeTotal) {
                    gameState.life.me = player.lifeTotal;
                    changed = true;
                }
            } else if (gameState.life.opp !== player.lifeTotal) {
                gameState.life.opp = player.lifeTotal;
                changed = true;
            }
        }

        updateArchiveFromPlayers(state.players);
    }

    // Archive tracking: turn records, opening hand, play/draw detection
    const timestampMs = getObjectTimestampMs(state) || Date.now();
    if (turnChanged) {
        maybeResolveOnPlayFromTurn(state.turnInfo);
        updateArchivedTurnRecord(timestampMs);
    }
    capturePreGameHandSnapshot(timestampMs);
    tryFinalizeOpeningHand();

    if (
        !gameState.gameEnded && (
        gameState.turn.number ||
        gameState.zones.hand.length ||
        gameState.zones.myBattlefield.length ||
        gameState.zones.oppBattlefield.length ||
        gameState.zones.myGraveyard.length ||
        gameState.zones.oppGraveyard.length ||
        gameState.zones.myExile.length ||
        gameState.zones.oppExile.length
    )) {
        gameState.active = true;
        if (!gameState.gameStartedAt) gameState.gameStartedAt = Date.now();
    }

    queueKnownCardAssetsFromState();

    if (changed) {
        gameState.lastUpdate = Date.now();
        broadcast("state-update", getEnhancedState());
    }
}

function getEnhancedState() {
    const remainingDeck = getRemainingDeckDetails();
    const startingDeckSize = [...gameState.startingDeck.values()].reduce((sum, count) => sum + count, 0);
    const remainingEntries = [...remainingDeck.entries()].filter(([, count]) => count > 0);
    const libTotal = gameState.libraryCount || remainingEntries.reduce((sum, [, count]) => sum + count, 0) || 1;
    const seenEntries = [...gameState.startingDeck.entries()]
        .map(([gid, count]) => [gid, Math.max(count - (remainingDeck.get(gid) || 0), 0)])
        .filter(([, count]) => count > 0);
    const seenTotal = seenEntries.reduce((sum, [, count]) => sum + count, 0) || 1;
    const probabilities = buildDeckProbabilityList(remainingEntries, libTotal);
    const drawnProbabilities = buildDeckProbabilityList(seenEntries, seenTotal);
    const drawStats = getDrawStats(remainingEntries, libTotal, probabilities);
    const handProfile = summarizeVisibleCards(gameState.zones.hand);
    const seenProfile = summarizeDeckEntries(seenEntries);
    const gamesInMatch = getGamesForCurrentMatch();

    return {
        active: gameState.gameEnded ? false : gameState.active,
        gameEnded: gameState.gameEnded,
        mySeatId: gameState.mySeatId,
        deckName: gameState.deckName,
        format: gameState.format,
        matchState: gameState.matchState,
        gameStartedAt: gameState.gameStartedAt,
        gameEndedAt: gameState.gameEndedAt,
        turn: gameState.turn,
        zones: gameState.zones,
        libraryCount: gameState.libraryCount,
        oppLibraryCount: gameState.oppLibraryCount,
        oppHandCount: gameState.oppHandCount,
        life: gameState.life,
        lastUpdate: gameState.lastUpdate,
        startingDeckSize,
        seenCards: Math.max(startingDeckSize - libTotal, 0),
        drawStats,
        counts: {
            hand: gameState.zones.hand.length,
            myBattlefield: gameState.zones.myBattlefield.length,
            oppBattlefield: gameState.zones.oppBattlefield.length,
            myGraveyard: gameState.zones.myGraveyard.length,
            oppGraveyard: gameState.zones.oppGraveyard.length,
            myExile: gameState.zones.myExile.length,
            oppExile: gameState.zones.oppExile.length,
            stack: gameState.zones.stack.length
        },
        deckProfile: {
            remaining: drawStats.breakdown,
            seen: seenProfile,
            hand: handProfile
        },
        probabilities,
        drawnProbabilities,
        drawnSummary: {
            total: seenEntries.reduce((sum, [, count]) => sum + count, 0),
            uniqueCards: seenEntries.length,
            topCard: drawnProbabilities[0] || null
        },
        gamesInMatch,
        timeline: gameState.timeline
    };
}

function handleMatchRoomStateChangedEvent(event) {
    const info = event?.gameRoomInfo;
    if (!info) return false;

    let changed = false;
    const reservedPlayers = info?.gameRoomConfig?.reservedPlayers || [];
    const nextMatchId = info?.gameRoomConfig?.matchId || info?.gameRoomConfig?.matchID || info?.finalMatchResult?.matchId || null;
    const stateType = String(info.stateType || "");
    const switchingMatch = Boolean(nextMatchId && gameState.matchId && nextMatchId !== gameState.matchId);

    if (switchingMatch) {
        archiveCurrentGame();
        finalizeCurrentMatchArchive();
        startFreshMatchContext(nextMatchId, 1);
        changed = true;
    } else if (nextMatchId && nextMatchId !== gameState.matchId) {
        gameState.matchId = nextMatchId;
        changed = true;
    }

    changed = syncLocalIdentityFromReservedPlayers(reservedPlayers) || changed;

    if (!gameState.gameEnded && stateType.includes("Playing") && !gameState.active) {
        gameState.active = true;
        if (!gameState.gameStartedAt) gameState.gameStartedAt = Date.now();
        changed = true;
    }

    if (stateType.includes("MatchCompleted")) {
        if (gameState.matchState !== "Match Complete") {
            gameState.matchState = "Match Complete";
            changed = true;
        }

        // Capture results from finalMatchResult
        if (Array.isArray(info?.finalMatchResult?.resultList)) {
            changed = applyResultsList(info.finalMatchResult.resultList, "MatchScope_Match", liveArchive.myTeamId) || changed;
        }

        changed = markGameComplete("Waiting for next game") || changed;
        changed = appendTimelineEntry(
            `match:end:${gameState.matchId ?? "unknown"}:${gameState.gameNumber || 0}`,
            "Match complete",
            humanizeToken(info?.finalMatchResult?.matchCompletedReason || stateType),
            "turn"
        ) || changed;
        changed = archiveCurrentGame() || changed;
        changed = finalizeCurrentMatchArchive() || changed;
        changed = ensurePendingCompletedGamePersisted() || changed;
        changed = reconcileCurrentCompletedMatch(true) || changed;
    }

    return changed;
}

function handleLogObject(obj) {
    if (!obj) return;

    let changed = false;
    const deckData = findDeckData(obj);
    if (deckData) {
        const shouldReset = obj.method === "Event.Join";
        if (shouldReset) {
            archiveCurrentGame();
            finalizeCurrentMatchArchive();
            gameState = createGameState();
            resetMatchTracking();
            gameState.matchState = "Match detected";
            changed = true;
        }

        changed = applyDeckDataToGameState(deckData, { overwriteEntries: true }) || changed;

        // Update the in-memory match record with better deck info when it arrives
        const deckNameLooksReal = gameState.deckName && gameState.deckName !== "Unknown Deck" && gameState.deckName !== "Untitled Deck";
        if (deckNameLooksReal && gameState.matchId) {
            const inMemRecord = matchHistory.find((entry) => entry.matchId === gameState.matchId);
            if (inMemRecord && (!inMemRecord.deckName || inMemRecord.deckName === "Unknown Deck" || inMemRecord.deckName === "Untitled Deck")) {
                inMemRecord.deckName = gameState.deckName;
                inMemRecord.format = gameState.format || inMemRecord.format;
            }

            // Also patch DB if the game was already persisted with a placeholder name
            if (liveArchive.persisted) {
                const gameKey = currentGameRecordKey();
                const patched = historyStore.updateGameDeckInfo(gameKey, gameState.matchId, gameState.deckName, gameState.format || "Unknown");
                if (patched) {
                    console.log(`[history] Patched deck info for ${gameKey}: ${gameState.deckName} / ${gameState.format}`);
                    matchHistory = historyStore.loadRecentMatchPreview(12);
                }
            }
        }

        if (shouldReset) {
            changed = appendTimelineEntry("match:start", "Match detected", [gameState.deckName, gameState.format].filter(Boolean).join(" · "), "turn") || changed;
        }
    }

    const roomStateEvent = obj.matchGameRoomStateChangedEvent || obj.MatchGameRoomStateChangedEvent;
    if (roomStateEvent) {
        changed = handleMatchRoomStateChangedEvent(roomStateEvent) || changed;
    }

    const greEvent = obj.greToClientEvent || obj.GreToClientEvent;
    if (greEvent) {
        const msgs = greEvent.greToClientMessages || greEvent.GreToClientMessages || [];
        let handledGameState = false;
        for (const msg of msgs) {
            if ((msg.type || msg.Type || "").includes("GameStateMessage")) {
                handledGameState = true;
                handleGameStateMessage(msg);
            }
        }

        if (changed && !handledGameState) {
            gameState.lastUpdate = Date.now();
            broadcast("state-update", getEnhancedState());
        }
        return;
    }

    if (changed) {
        gameState.lastUpdate = Date.now();
        broadcast("state-update", getEnhancedState());
    }
}

let logBuffer = "";
function processBuffer() {
    let cursor = 0;
    while (cursor < logBuffer.length) {
        const startIdx = logBuffer.indexOf('{', cursor);
        if (startIdx === -1) { logBuffer = ""; break; }
        let bracketCount = 0, endIdx = -1;
        for (let i = startIdx; i < logBuffer.length; i++) {
            if (logBuffer[i] === '{') bracketCount++;
            else if (logBuffer[i] === '}') bracketCount--;
            if (bracketCount === 0) { endIdx = i; break; }
        }
        if (endIdx !== -1) {
            try { handleLogObject(JSON.parse(logBuffer.slice(startIdx, endIdx + 1))); } catch (e) {}
            logBuffer = logBuffer.slice(endIdx + 1);
            cursor = 0;
        } else {
            logBuffer = logBuffer.slice(startIdx);
            break;
        }
    }
}

function restoreRuntimeStateFromDisk(checkpoint, currentLogSize) {
    const snapshot = historyStore.loadRuntimeState(null);
    if (!snapshot || snapshot.version !== RUNTIME_STATE_VERSION) return false;
    if (snapshot.logPath !== LOG_PATH) return false;
    if (!checkpoint || checkpoint.offset > currentLogSize) return false;

    restoreGameState(snapshot.gameState);
    restoreLiveArchive(snapshot.liveArchive);
    replaceMap(instanceToGrp, snapshot.instanceToGrp);
    replaceMap(instanceState, snapshot.instanceState);
    replaceSet(seenTimelineEntries, snapshot.seenTimelineEntries);
    replaceMap(zoneMetadataById, snapshot.zoneMetadataById);
    replaceMap(knownDecksById, snapshot.knownDecksById);
    replaceMap(knownDecksBySignature, snapshot.knownDecksBySignature);
    logBuffer = typeof snapshot.logBuffer === "string" ? snapshot.logBuffer : "";
    return true;
}

function serializeRuntimeState() {
    return {
        version: RUNTIME_STATE_VERSION,
        savedAt: Date.now(),
        logPath: LOG_PATH,
        gameState: serializeGameState(),
        liveArchive: serializeLiveArchive(),
        instanceToGrp: [...instanceToGrp.entries()],
        instanceState: [...instanceState.entries()],
        seenTimelineEntries: [...seenTimelineEntries.values()],
        zoneMetadataById: [...zoneMetadataById.entries()],
        knownDecksById: [...knownDecksById.entries()],
        knownDecksBySignature: [...knownDecksBySignature.entries()],
        logBuffer
    };
}

function resolveStartupScanPlan(checkpoint, logSize, restoredRuntimeState) {
    if (restoredRuntimeState && checkpoint && checkpoint.offset <= logSize) {
        return {
            bootSource: "resume",
            startOffset: checkpoint.offset
        };
    }

    if (checkpoint && checkpoint.offset <= logSize) {
        return {
            bootSource: "warm_bootstrap",
            startOffset: Math.max(0, checkpoint.offset - STARTUP_SCAN_WINDOW_BYTES)
        };
    }

    return {
        bootSource: "tail_bootstrap",
        startOffset: Math.max(0, logSize - STARTUP_SCAN_WINDOW_BYTES)
    };
}

let lastSize = 0, isScanning = true;
let trackerRunId = "";
let trackerRunProcessedBytes = 0;
let trackerRunClosed = false;

function persistRuntimeState(endedAt = null) {
    ensurePendingCompletedGamePersisted();
    reconcileCurrentCompletedMatch();
    historyStore.saveRuntimeState(serializeRuntimeState());
    historyStore.saveCheckpoint({
        logPath: LOG_PATH,
        offset: lastSize,
        size: lastSize,
        updatedAt: Date.now()
    });
    if (trackerRunId) {
        historyStore.updateRun(trackerRunId, {
            endedAt,
            finalLogOffset: lastSize,
            processedBytes: trackerRunProcessedBytes
        });
    }
}

function closeTrackerRun() {
    if (trackerRunClosed) return;
    trackerRunClosed = true;
    persistRuntimeState(Date.now());
}

async function runScan() {
    if (!fs.existsSync(LOG_PATH)) { isScanning = false; return; }
    const stats = fs.statSync(LOG_PATH);
    const checkpoint = historyStore.getCheckpoint(LOG_PATH);
    const restoredRuntimeState = restoreRuntimeStateFromDisk(checkpoint, stats.size);
    const plan = resolveStartupScanPlan(checkpoint, stats.size, restoredRuntimeState);
    trackerRunId = historyStore.startRun({
        logPath: LOG_PATH,
        bootSource: plan.bootSource,
        initialLogOffset: plan.startOffset
    });

    if (plan.startOffset < stats.size) {
        const stream = fs.createReadStream(LOG_PATH, { start: plan.startOffset });
        for await (const chunk of stream) {
            trackerRunProcessedBytes += chunk.length;
            logBuffer += chunk.toString();
            processBuffer();
        }
    }
    const recovered = recoverCompletedMatchesFromRecentLog();
    if (recovered.inserted || recovered.updated) {
        console.log(`[history] Recovered ${recovered.inserted} missing games and refreshed ${recovered.updated} existing results`);
    }
    const recoveredDeck = recoverDeckStateFromRecentLog(true);
    if (recoveredDeck) {
        gameState.lastUpdate = Date.now();
    }
    lastSize = stats.size;
    persistRuntimeState();
    isScanning = false;
    broadcast("state-update", getEnhancedState());
}
runScan();

setInterval(async () => {
    if (isScanning || !fs.existsSync(LOG_PATH)) return;
    const stats = fs.statSync(LOG_PATH);
    if (stats.size < lastSize) {
        gameState = createGameState();
        liveArchive = createLiveArchiveState();
        resetRuntimeTracking();
        logBuffer = "";
        lastSize = 0;
        persistRuntimeState();
    }
    if (stats.size > lastSize) {
        const stream = fs.createReadStream(LOG_PATH, { start: lastSize, end: stats.size - 1 });
        for await (const chunk of stream) {
            trackerRunProcessedBytes += chunk.length;
            logBuffer += chunk.toString();
            processBuffer();
        }
        lastSize = stats.size;
        reconcileCurrentCompletedMatch(true);
        if (recoverDeckStateFromRecentLog()) {
            gameState.lastUpdate = Date.now();
            broadcast("state-update", getEnhancedState());
        }
        persistRuntimeState();
    }
}, 1000);

process.on("beforeExit", closeTrackerRun);
process.on("SIGINT", () => {
    closeTrackerRun();
    process.exit(0);
});
process.on("SIGTERM", () => {
    closeTrackerRun();
    process.exit(0);
});

function buildHistoryPageBody() {
    return `
    <div class="space-y-6">
        <section class="glass arena-panel relative overflow-hidden rounded-[3rem] border border-white/5 p-8 shadow-[0_40px_120px_rgba(2,6,23,0.68)]">
            <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(249,115,22,0.18),transparent_24%),radial-gradient(circle_at_bottom_left,rgba(56,189,248,0.12),transparent_28%),linear-gradient(160deg,rgba(15,23,42,0.1),rgba(2,6,23,0.84))]"></div>
            <div class="relative">
                <div class="mb-4 flex flex-wrap items-center gap-3">
                    <span class="rounded-full border border-orange-400/25 bg-orange-500/10 px-4 py-2 text-[10px] font-black uppercase tracking-[0.42em] text-orange-100">Match History</span>
                </div>
                <h1 class="display-face text-4xl font-black uppercase tracking-[0.02em] text-white md:text-6xl">Game Analytics</h1>
                <p class="mt-4 max-w-2xl text-sm leading-6 text-slate-300">Post-game statistics, win rates, play/draw splits, mulligan data, and card performance across your tracked matches.</p>

                <div class="mt-6 flex flex-wrap gap-3">
                    <select id="histDeckFilter" class="rounded-2xl border border-white/10 bg-slate-900/70 px-5 py-3 text-[10px] font-black uppercase tracking-[0.3em] text-white outline-none">
                        <option value="">All Decks</option>
                    </select>
                    <button id="histRefresh" class="rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-[10px] font-black uppercase tracking-[0.3em] text-slate-300 transition hover:bg-white/10">Refresh</button>
                </div>

                <div id="histTotals" class="mt-8 grid gap-3 md:grid-cols-3 xl:grid-cols-6"></div>
            </div>
        </section>

        <div class="grid gap-6 xl:grid-cols-2">
            <section class="glass rounded-[2.8rem] border border-white/5 p-8">
                <div class="text-[10px] font-black uppercase tracking-[0.42em] text-slate-500">Play / Draw Split</div>
                <div id="histPlayDraw" class="mt-4 grid gap-3 md:grid-cols-3"></div>
            </section>
            <section class="glass rounded-[2.8rem] border border-white/5 p-8">
                <div class="text-[10px] font-black uppercase tracking-[0.42em] text-slate-500">Mulligan Breakdown</div>
                <div id="histMulligans" class="mt-4 space-y-3"></div>
            </section>
        </div>

        <section class="glass rounded-[2.8rem] border border-white/5 p-8">
            <div class="text-[10px] font-black uppercase tracking-[0.42em] text-slate-500">Deck Performance</div>
            <div id="histDecks" class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3"></div>
        </section>

        <div class="grid gap-6 xl:grid-cols-2">
            <section class="glass rounded-[2.8rem] border border-white/5 p-8">
                <div class="text-[10px] font-black uppercase tracking-[0.42em] text-slate-500">Opening Hand Cards</div>
                <div class="mt-2 text-[9px] font-bold uppercase tracking-[0.2em] text-slate-600">Cards seen in opening hands and their win rates</div>
                <div id="histOpeningHands" class="mt-4 space-y-2"></div>
            </section>
            <section class="glass rounded-[2.8rem] border border-white/5 p-8">
                <div class="text-[10px] font-black uppercase tracking-[0.42em] text-slate-500">Cards Seen Performance</div>
                <div class="mt-2 text-[9px] font-bold uppercase tracking-[0.2em] text-slate-600">Cards drawn/seen in games and win rate when present</div>
                <div id="histCardsSeen" class="mt-4 space-y-2"></div>
            </section>
        </div>

        <section class="glass rounded-[2.8rem] border border-white/5 p-8">
            <div class="text-[10px] font-black uppercase tracking-[0.42em] text-slate-500">Recent Games</div>
            <div id="histRecentGames" class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3"></div>
        </section>

        <section class="glass rounded-[2.8rem] border border-white/5 p-8">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <div class="text-[10px] font-black uppercase tracking-[0.42em] text-slate-500">Tracker Runs</div>
                    <div class="mt-2 text-[9px] font-bold uppercase tracking-[0.2em] text-slate-600">Local app boot history, log checkpoint progress, and resume mode</div>
                </div>
            </div>
            <div id="histRuns" class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3"></div>
        </section>
    </div>
    `;
}

Bun.serve({
  port: SERVER_PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
        return Response.redirect(new URL("/live", req.url), 302);
    }
    if (url.pathname.startsWith(CARD_IMAGE_ROUTE + "/")) {
        const filename = decodeURIComponent(url.pathname.slice((CARD_IMAGE_ROUTE + "/").length)).replace(/[^a-zA-Z0-9._-]/g, "");
        const filePath = `${CARD_IMAGE_DIR}/${filename}`;
        if (!filename || !fs.existsSync(filePath)) {
            return new Response("Not found", { status: 404 });
        }
        return new Response(Bun.file(filePath));
    }
    if (url.pathname === "/api/state") {
        return new Response(JSON.stringify(getEnhancedState()), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/health") {
        return new Response(JSON.stringify({
            ok: true,
            pid: process.pid,
            port: SERVER_PORT,
            dataDir: DATA_DIR,
            logPath: LOG_PATH
        }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/collection/summary") {
        refreshCollectionMemory();
        const query = url.searchParams.get("q") || undefined;
        const format = url.searchParams.get("format") || undefined;
        const maxCards = Number(url.searchParams.get("maxCards") || 24);
        const data = collectionStore.buildCollectionSummary({ query, format, maxCards });
        return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/collection/llm-context") {
        refreshCollectionMemory();
        const query = url.searchParams.get("q") || undefined;
        const format = url.searchParams.get("format") || undefined;
        const maxCards = Number(url.searchParams.get("maxCards") || 96);
        const text = collectionStore.buildCollectionAiContext({ query, format, maxCards });
        return new Response(JSON.stringify({ text }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/collection") {
        refreshCollectionMemory();
        const query = url.searchParams.get("q") || undefined;
        const format = url.searchParams.get("format") || undefined;
        const data = collectionStore.loadCollectionCards({ query, format });
        return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/sync-llm" && req.method === "POST") {
        try {
            const body = await req.text();
            fs.writeFileSync(LLM_CONTEXT_FILE, body);
            return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
        } catch (err) {
            return new Response(JSON.stringify({ success: false, error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    }
    if (url.pathname === "/api/live-stream") {
        return new Response(new ReadableStream({
            start(controller) {
                clients.add(controller);
                controller.enqueue(`event: init\ndata: ${JSON.stringify(getEnhancedState())}\n\n`);
            },
            cancel(controller) { clients.delete(controller); }
        }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    }
    if (url.pathname === "/api/history") {
        const deckName = url.searchParams.get("deck") || undefined;
        const limitGames = Number(url.searchParams.get("limitGames") || 30);
        const limitMatches = Number(url.searchParams.get("limitMatches") || 15);
        const includeTurns = url.searchParams.get("turns") === "1";
        const data = historyStore.getHistory({ deckName, limitGames, limitMatches, includeTurns });
        return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/history/summary") {
        const deckName = url.searchParams.get("deck") || undefined;
        const data = historyStore.getHistorySummary({ deckName });
        return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/history/runs") {
        const limit = Number(url.searchParams.get("limit") || 20);
        const data = historyStore.loadRecentRuns(limit);
        return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/history/llm-context") {
        // Returns a plain-text block containing the narrative summaries of recent games.
        // Designed to be pasted directly into an LLM prompt for deck advice, pattern analysis, etc.
        const deckName = url.searchParams.get("deck") || undefined;
        const limit = Number(url.searchParams.get("limit") || 20);
        const data = historyStore.getHistory({ deckName, limitGames: limit, limitMatches: limit });
        const games = data.games || [];
        const lines: string[] = [
            "MTGA Game History \u2014 " + games.length + " game" + (games.length !== 1 ? "s" : "") + (deckName ? " \u00b7 Deck: " + deckName : ""),
            "=" .repeat(60)
        ];
        for (let i = 0; i < games.length; i++) {
            const game = games[i];
            lines.push(`\n--- Game ${i + 1} (${new Date(game.endAt || game.startAt || game.createdAt).toLocaleString()}) ---`);
            if (game.narrative) {
                lines.push(game.narrative);
            } else {
                // Fallback for games recorded before narrative support
                const resultLabel = game.resultCode === "win" ? "Win" : game.resultCode === "loss" ? "Loss" : "Unknown";
                lines.push(`${resultLabel} · T${game.turnCount} · ${game.deckName} (${game.format})`);
                if (game.openingHand?.length) {
                    lines.push(`Opening hand: ${game.openingHand.map((c) => c.name).join(", ")}`);
                }
                if (game.cardsSeen?.length) {
                    lines.push(`Opponent cards seen: ${game.cardsSeen.map((c) => c.name).join(", ")}`);
                }
            }
        }
        return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain" } });
    }

    if (url.pathname === "/overlay") {
        return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>MTGA Overlay</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
    width: 100vw;
    height: 100vh;
    background: transparent !important;
    overflow: hidden;
    font-family: 'Inter', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    color: #f8fafc;
}

#widget {
    position: absolute;
    top: 24px;
    right: 24px;
    width: 260px;
    opacity: 0;
    transform: translateY(-12px);
    transition: opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1), transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    pointer-events: none;
    display: flex;
    flex-direction: column;
    filter: drop-shadow(0 20px 40px rgba(0,0,0,0.5));
}
#widget.visible {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
}
#widget.minimized #list {
    display: none;
}
#widget.closed {
    display: none !important;
}

/* Header bar */
#header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: rgba(15, 23, 42, 0.85);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-bottom: 1px solid rgba(0, 0, 0, 0.5);
    border-radius: 12px 12px 0 0;
    padding: 10px 14px;
    cursor: grab;
    user-select: none;
    position: relative;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.1);
}
#header:active {
    cursor: grabbing;
}
#widget.minimized #header {
    border-radius: 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.header-left {
    display: flex;
    align-items: center;
    gap: 8px;
}

.drag-indicator {
    display: flex;
    flex-direction: column;
    gap: 3px;
    opacity: 0.5;
}
.drag-indicator div {
    width: 14px;
    height: 2px;
    background: #fff;
    border-radius: 2px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.5);
}

#header-label {
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    background: linear-gradient(to right, #f97316, #fcd34d);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    text-shadow: 0 2px 4px rgba(0,0,0,0.2);
}
#header-info {
    font-size: 10px;
    font-weight: 600;
    color: #94a3b8;
    letter-spacing: 0.05em;
}

/* Card list */
#list {
    background: rgba(15, 23, 42, 0.75);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-top: none;
    border-radius: 0 0 12px 12px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

.row {
    display: flex;
    align-items: center;
    padding: 8px 12px 8px 0;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    gap: 10px;
    position: relative;
    overflow: hidden;
    transition: background 0.2s;
}
.row:hover {
    background: rgba(255,255,255,0.03);
}
.row:last-child { border-bottom: none; }

.row-fill {
    position: absolute;
    left: 0; top: 0; bottom: 0;
    background: linear-gradient(90deg, rgba(249, 115, 22, 0.15) 0%, rgba(249, 115, 22, 0) 100%);
    pointer-events: none;
    transition: width 0.5s cubic-bezier(0.22, 1, 0.36, 1);
}

.row-stripe {
    width: 4px;
    align-self: stretch;
    flex-shrink: 0;
    border-radius: 0 2px 2px 0;
    box-shadow: 1px 0 4px rgba(0,0,0,0.3);
}

.row-left { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.row-name {
    font-size: 12px;
    font-weight: 700;
    color: #f8fafc;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-shadow: 0 1px 2px rgba(0,0,0,0.8);
}
.row-sub {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 9px;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}
.row-colors { display: inline-flex; gap: 3px; }
.row-color {
    width: 14px; height: 14px;
    border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 8px; font-weight: 800;
    border: 1px solid rgba(255,255,255,0.2);
    box-shadow: 0 1px 3px rgba(0,0,0,0.5);
}
.row-color.w { background: linear-gradient(180deg, #f8fafc, #cbd5e1); color: #0f172a; }
.row-color.u { background: linear-gradient(180deg, #60a5fa, #2563eb); color: #fff; }
.row-color.b { background: linear-gradient(180deg, #334155, #0f172a); color: #fff; }
.row-color.r { background: linear-gradient(180deg, #f87171, #dc2626); color: #fff; }
.row-color.g { background: linear-gradient(180deg, #4ade80, #16a34a); color: #fff; }
.row-color.c { background: linear-gradient(180deg, #94a3b8, #475569); color: #fff; }

.row-right { text-align: right; flex-shrink: 0; display: flex; flex-direction: column; gap: 2px; }
.row-pct {
    font-size: 15px;
    font-weight: 800;
    color: #fdba74;
    text-shadow: 0 1px 3px rgba(0,0,0,0.8);
}
.row-in2 {
    font-size: 9px;
    font-weight: 600;
    color: #64748b;
}
.row-in2 span { color: #cbd5e1; }

.hotkeys-help {
    position: absolute;
    bottom: -24px;
    right: 0;
    font-size: 10px;
    color: rgba(255,255,255,0.4);
    pointer-events: none;
    transition: opacity 0.3s;
    text-shadow: 0 1px 2px rgba(0,0,0,0.8);
    background: rgba(15, 23, 42, 0.4);
    padding: 2px 8px;
    border-radius: 4px;
}
#widget:hover .hotkeys-help {
    opacity: 1;
    color: #fff;
}

body.interactive #widget {
    outline: 2px solid #f97316;
    outline-offset: 2px;
    box-shadow: 0 0 20px rgba(249, 115, 22, 0.4);
}
body.interactive #widget::after {
    content: 'INTERACTIVE MODE (ALT+SHIFT+F to exit)';
    position: absolute;
    top: -24px;
    left: 0;
    font-size: 9px;
    font-weight: 800;
    color: #f97316;
    text-shadow: 0 1px 2px rgba(0,0,0,0.8);
}

</style>
</head>
<body>
<div id="widget">
    <div id="header">
        <div class="header-left">
            <div class="drag-indicator"><div></div><div></div><div></div></div>
            <span id="header-label">Draw Odds</span>
        </div>
        <span id="header-info">— / —</span>
    </div>
    <div id="list"></div>
    <div class="hotkeys-help">Alt+Shift+M (Min) | +F (Focus) | +X (Close) | +O (Open)</div>
</div>

<script>
const MAX_CARDS = 8;
const ev = new EventSource('/api/live-stream');

const widget = document.getElementById('widget');
const header = document.getElementById('header');
const headerInfo = document.getElementById('header-info');
const list = document.getElementById('list');

// Window Controls API
window.toggleMinimize = () => {
    widget.classList.toggle('minimized');
    widget.classList.remove('closed');
};
window.closeOverlay = () => widget.classList.add('closed');
window.openOverlay = () => {
    widget.classList.remove('closed');
    widget.classList.remove('minimized');
};

// Dragging Logic
let isDragging = false;
let startX, startY, initialLeft, initialTop;

header.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    
    const style = window.getComputedStyle(widget);
    const rect = widget.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    if (widget.style.right) {
        widget.style.right = 'auto';
        widget.style.left = initialLeft + 'px';
    }
});

window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    
    let newLeft = initialLeft + (e.clientX - startX);
    let newTop = initialTop + (e.clientY - startY);
    
    newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - widget.offsetWidth));
    newTop = Math.max(0, Math.min(newTop, window.innerHeight - widget.offsetHeight));

    widget.style.left = newLeft + 'px';
    widget.style.top = newTop + 'px';
});

window.addEventListener('mouseup', () => {
    isDragging = false;
});

function fmt(v) {
    return (isFinite(+v) ? (+v).toFixed(1) : '0.0') + '%';
}

function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const COLOR_STRIPE = {
    W: 'linear-gradient(180deg, #ffffff 0%, #cbd5e1 100%)',
    U: 'linear-gradient(180deg, #60a5fa 0%, #1d4ed8 100%)',
    B: 'linear-gradient(180deg, #a855f7 0%, #4c1d95 100%)',
    R: 'linear-gradient(180deg, #f87171 0%, #991b1b 100%)',
    G: 'linear-gradient(180deg, #4ade80 0%, #065f46 100%)',
    C: 'linear-gradient(180deg, #94a3b8 0%, #1e293b 100%)',
};

function stripeStyle(colors) {
    if (!colors || !colors.length) return \`background:\${COLOR_STRIPE.C}\`;
    if (colors.length === 1) return \`background:\${COLOR_STRIPE[colors[0]] || COLOR_STRIPE.C}\`;
    return 'background: linear-gradient(180deg, #fbbf24, #d97706)';
}

function normalizeColors(colors) {
    return Array.isArray(colors) && colors.length ? colors : ['C'];
}

function renderColorBadges(colors) {
    return \`<div class="row-colors">\${normalizeColors(colors).map(color => \`<span class="row-color \${String(color || 'C').toLowerCase()}">\${esc(color || 'C')}</span>\`).join('')}</div>\`;
}

function formatCopyTotal(card) {
    const current = Math.max(Number(card?.count || 0), 0);
    const total = Math.max(Number(card?.deckCount || 0), current);
    return total ? \`\${current}/\${total}\` : String(current);
}

function render(state) {
    const probs = state.probabilities || [];
    const lib = state.libraryCount || 0;
    const inGame = probs.length > 0 && lib > 0 && !state.gameEnded;

    widget.classList.toggle('visible', inGame);
    if (!inGame) return;

    headerInfo.textContent = lib + ' left · T' + (state.turn?.number || 0);

    const top = probs.slice(0, MAX_CARDS);
    list.innerHTML = top.map(p => {
        const pct = Math.min(+(p.chance) || 0, 100);
        return \`<div class="row">
            <div class="row-fill" style="width:\${pct}%"></div>
            <div class="row-stripe" style="\${stripeStyle(p.colors)}"></div>
            <div class="row-left">
                <div class="row-name">\${esc(p.name)}</div>
                <div class="row-sub">\${renderColorBadges(p.colors)}<span class="row-copy">\${formatCopyTotal(p)} remaining</span></div>
            </div>
            <div class="row-right">
                <div class="row-pct">\${fmt(p.chance)}</div>
                <div class="row-in2">in 2 · <span>\${fmt(p.nextTwoChance)}</span></div>
            </div>
        </div>\`;
    }).join('');
}

ev.addEventListener('init', e => render(JSON.parse(e.data)));
ev.addEventListener('state-update', e => render(JSON.parse(e.data)));
</script>
</body>
</html>`, { headers: { "Content-Type": "text/html" } });
    }

    const isLive = url.pathname === "/live";
    const isHistory = url.pathname === "/history";
    const activeNav = isLive ? "live" : isHistory ? "history" : "collection";
    const navClass = (key) => activeNav === key
        ? "bg-orange-600 shadow-lg"
        : "bg-slate-800 text-slate-400 hover:bg-slate-700";
    const liveNavClass = navClass("live");
    const collectionNavClass = navClass("collection");
    const historyNavClass = navClass("history");
    const lifeClass = isLive ? "" : "hidden";
    const pageBody = isHistory
        ? buildHistoryPageBody()
        : isLive
        ? `
        <div class="space-y-6">
            <section class="glass arena-panel relative overflow-hidden rounded-[2.5rem] border border-white/10 p-10 shadow-[0_60px_150px_-20px_rgba(0,0,0,0.8)]">
                <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(249,115,22,0.12),transparent_35%),radial-gradient(circle_at_bottom_left,rgba(56,189,248,0.08),transparent_40%),linear-gradient(165deg,rgba(15,23,42,0.2),rgba(1,4,12,0.95))]"></div>
                <div class="relative grid gap-10 xl:grid-cols-[1.2fr_0.8fr]">
                    <div>
                        <div class="mb-6 flex flex-wrap items-center gap-3">
                            <span class="inline-flex items-center rounded-full border border-orange-400/30 bg-orange-500/10 px-4 py-1.5 text-[9px] font-black uppercase tracking-[0.45em] text-orange-200 shadow-[0_0_15px_-5px_var(--orange-glow)]">Standard Pilot</span>
                            <span id="formatBadge" class="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-[9px] font-black uppercase tracking-[0.38em] text-slate-400">Awaiting Format</span>
                            <span id="activeStatePill" class="inline-flex items-center rounded-full border border-emerald-400/25 bg-emerald-500/10 px-4 py-1.5 text-[9px] font-black uppercase tracking-[0.38em] text-emerald-200 shadow-[0_0_15px_-5px_rgba(52,211,153,0.3)]">Log Monitor</span>
                        </div>
                        <h1 id="deckName" class="display-face text-5xl font-black uppercase tracking-tight text-white md:text-7xl" style="text-shadow: 0 4px 20px rgba(0,0,0,0.5);">Waiting <span class="text-orange-500">for match</span></h1>
                        <p id="deckMeta" class="mt-5 max-w-2xl text-base leading-relaxed text-slate-400">Monitoring the MTGA log stream for candidate deck registration and real-time board state synchronization.</p>

                        <div class="mt-8 grid gap-4 md:grid-cols-4">
                            <div class="rounded-[1.4rem] border border-white/10 bg-black/40 px-5 py-5 shadow-lg">
                                <div class="text-[8px] font-black uppercase tracking-[0.4em] text-slate-500">System Status</div>
                                <div id="statusText" class="mt-2 text-lg font-black uppercase tracking-tight text-white group-hover:text-orange-400 transition-colors">Monitoring Logs</div>
                            </div>
                            <div class="rounded-[1.4rem] border border-white/10 bg-black/40 px-5 py-5 shadow-lg">
                                <div class="text-[8px] font-black uppercase tracking-[0.4em] text-slate-500">Active Seat</div>
                                <div id="activePlayer" class="mt-2 text-lg font-black uppercase tracking-tight text-white">Unknown</div>
                            </div>
                            <div class="rounded-[1.4rem] border border-white/10 bg-black/40 px-5 py-5 shadow-lg">
                                <div class="text-[8px] font-black uppercase tracking-[0.4em] text-slate-500">Combat Priority</div>
                                <div id="priorityPlayer" class="mt-2 text-lg font-black uppercase tracking-tight text-white">Unknown</div>
                            </div>
                            <div class="rounded-[1.4rem] border border-white/10 bg-black/40 px-5 py-5 shadow-lg">
                                <div class="text-[8px] font-black uppercase tracking-[0.4em] text-slate-500">Registry Sync</div>
                                <div id="syncAge" class="mt-2 text-lg font-black uppercase tracking-tight text-white">Just now</div>
                            </div>
                        </div>
                    </div>

                    <div class="rounded-[2rem] border border-white/10 bg-black/60 p-8 shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)]">
                        <div class="flex items-end justify-between gap-4">
                            <div>
                                <div class="text-[9px] font-black uppercase tracking-[0.5em] text-slate-600">Deck Telemetry</div>
                                <div class="mt-4 flex items-end gap-5">
                                    <div id="turnPill" class="display-face text-7xl font-black leading-none text-orange-400" style="text-shadow: 0 0 30px rgba(249,115,22,0.3);">-</div>
                                    <div>
                                        <div class="text-[8px] font-black uppercase tracking-[0.4em] text-slate-600">Game Phase</div>
                                        <div id="phasePill" class="mt-2 text-xl font-black uppercase tracking-[0.2em] text-white">Standby</div>
                                    </div>
                                </div>
                            </div>
                            <div class="text-right">
                                <div class="text-[8px] font-black uppercase tracking-[0.4em] text-slate-600">Collection Insight</div>
                                <div id="deckSeen" class="mt-2 text-sm font-black uppercase tracking-[0.2em] text-orange-400">0 identified</div>
                            </div>
                        </div>

                        <div class="mt-6 grid grid-cols-2 gap-4">
                            <div class="rounded-[1.4rem] border border-white/5 bg-slate-900/40 px-5 py-5 transition-colors hover:bg-slate-900/60">
                                <div class="text-[8px] font-black uppercase tracking-[0.4em] text-slate-500">Registry Depth</div>
                                <div id="deckSize" class="display-face mt-2 text-4xl font-black text-white tabular-nums">0</div>
                            </div>
                            <div class="rounded-[1.4rem] border border-white/5 bg-slate-900/40 px-5 py-5 transition-colors hover:bg-slate-900/60">
                                <div class="text-[8px] font-black uppercase tracking-[0.4em] text-slate-500">Identified</div>
                                <div id="seenCardsPill" class="display-face mt-2 text-4xl font-black text-orange-400 tabular-nums" style="text-shadow: 0 0 15px rgba(249,115,22,0.2);">0</div>
                            </div>
                            <div class="rounded-[1.4rem] border border-white/5 bg-slate-900/40 px-5 py-5 transition-colors hover:bg-slate-900/60">
                                <div class="text-[8px] font-black uppercase tracking-[0.4em] text-slate-500">Calculated Lib</div>
                                <div id="liveDeckCount" class="display-face mt-2 text-4xl font-black text-cyan-400 tabular-nums">0</div>
                            </div>
                            <div class="rounded-[1.4rem] border border-white/5 bg-slate-900/40 px-5 py-5 transition-colors hover:bg-slate-900/60" style="border-left: 3px solid rgba(255,255,255,0.1);">
                                <div class="text-[8px] font-black uppercase tracking-[0.4em] text-slate-500">Command Hand</div>
                                <div id="myHandCount" class="display-face mt-2 text-4xl font-black text-white tabular-nums">0</div>
                            </div>
                            <div class="rounded-[1.4rem] border border-white/5 bg-slate-900/40 px-5 py-5 transition-colors hover:bg-slate-900/60">
                                <div class="text-[8px] font-black uppercase tracking-[0.4em] text-slate-500">Opponent Grip</div>
                                <div id="oppHand" class="display-face mt-2 text-4xl font-black text-white tabular-nums">0</div>
                            </div>
                            <div class="rounded-[1.4rem] border border-white/5 bg-slate-900/40 px-5 py-5 transition-colors hover:bg-slate-900/60">
                                <div class="text-[8px] font-black uppercase tracking-[0.4em] text-slate-500">Exiled Data</div>
                                <div id="myExileCount" class="display-face mt-2 text-4xl font-black text-white tabular-nums">0</div>
                            </div>
                        </div>

                        <div class="mt-8 rounded-[2rem] border border-white/8 bg-black/40 px-6 py-6 shadow-xl">
                            <div class="mb-5 flex items-end justify-between gap-4">
                                <div>
                                    <div class="text-[9px] font-black uppercase tracking-[0.4em] text-slate-600">Match Chronology</div>
                                    <div id="matchGamesMeta" class="mt-2 text-xs font-bold uppercase tracking-[0.25em] text-slate-500 italic">Waiting for sequence chunks</div>
                                </div>
                                <div id="matchGamesCount" class="display-face text-5xl font-black text-white tabular-nums">0</div>
                            </div>
                            <div id="matchGames" class="grid gap-4 md:grid-cols-2"></div>
                        </div>
                    </div>
                         <div class="grid gap-6 2xl:grid-cols-[1.1fr_0.95fr_0.95fr]">
                <section class="glass rounded-[2.5rem] border border-white/10 p-10 shadow-2xl">
                    <div class="mb-8 flex flex-wrap items-end justify-between gap-4">
                        <div>
                            <div class="text-[10px] font-black uppercase tracking-[0.5em] text-slate-500">Draw engine</div>
                            <div id="deckOddsMeta" class="mt-2 text-sm font-bold uppercase tracking-[0.25em] text-slate-400">Waiting for live signal</div>
                        </div>
                        <div id="stackChip" class="rounded-full border border-white/10 bg-white/5 px-5 py-2 text-[10px] font-black uppercase tracking-[0.4em] text-slate-300">Stack 0</div>
                    </div>
 
                    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        <div class="rounded-[1.5rem] border border-orange-500/20 bg-orange-500/10 px-6 py-6 shadow-lg transition-transform hover:scale-[1.02]">
                            <div class="text-[9px] font-black uppercase tracking-[0.4em] text-orange-200/60">Top Probability</div>
                            <div id="topDrawChance" class="display-face mt-3 text-5xl font-black text-orange-100" style="text-shadow: 0 0 20px var(--orange-glow);">0.0%</div>
                            <div id="topDrawName" class="mt-3 text-[10px] font-bold uppercase tracking-[0.28em] text-orange-200/80">Search pending...</div>
                        </div>
                        <div class="rounded-[1.5rem] border border-amber-500/20 bg-amber-500/10 px-6 py-6 shadow-lg transition-transform hover:scale-[1.02]">
                            <div class="text-[9px] font-black uppercase tracking-[0.4em] text-amber-200/60">Double Draw</div>
                            <div id="topDrawTwoChance" class="display-face mt-3 text-5xl font-black text-amber-50">0.0%</div>
                            <div class="mt-3 text-[10px] font-bold uppercase tracking-[0.28em] text-amber-200/70">Probability in two cycles</div>
                        </div>
                        <div class="rounded-[1.5rem] border border-cyan-500/20 bg-cyan-500/10 px-6 py-6 shadow-lg transition-transform hover:scale-[1.02]">
                            <div class="text-[9px] font-black uppercase tracking-[0.4em] text-cyan-200/60">Land Velocity</div>
                            <div id="landNextChance" class="display-face mt-3 text-5xl font-black text-cyan-50">0.0%</div>
                            <div class="mt-3 text-[10px] font-bold uppercase tracking-[0.28em] text-cyan-200/70">Immediate land drop</div>
                        </div>
                        <div class="rounded-[1.5rem] border border-sky-500/20 bg-sky-500/10 px-6 py-6 shadow-lg transition-transform hover:scale-[1.02]">
                            <div class="text-[9px] font-black uppercase tracking-[0.4em] text-sky-200/60">Land Orbit</div>
                            <div id="landNextTwoChance" class="display-face mt-3 text-5xl font-black text-sky-50">0.0%</div>
                            <div class="mt-3 text-[10px] font-bold uppercase tracking-[0.28em] text-sky-200/70">Two-cycle land hit rate</div>
                        </div>
                        <div class="rounded-[1.5rem] border border-emerald-500/20 bg-emerald-500/10 px-6 py-6 shadow-lg transition-transform hover:scale-[1.02]">
                            <div class="text-[9px] font-black uppercase tracking-[0.4em] text-emerald-200/60">Unit Potential</div>
                            <div id="creatureNextChance" class="display-face mt-3 text-5xl font-black text-emerald-50">0.0%</div>
                            <div class="mt-3 text-[10px] font-bold uppercase tracking-[0.28em] text-emerald-200/70">Creature pressure next</div>
                        </div>
                        <div class="rounded-[1.5rem] border border-fuchsia-500/20 bg-fuchsia-500/10 px-6 py-6 shadow-lg transition-transform hover:scale-[1.02]">
                            <div class="text-[9px] font-black uppercase tracking-[0.4em] text-fuchsia-200/60">Action Density</div>
                            <div id="nonLandNextChance" class="display-face mt-3 text-5xl font-black text-fuchsia-50">0.0%</div>
                            <div class="mt-3 text-[10px] font-bold uppercase tracking-[0.28em] text-fuchsia-200/70">Gas instead of mana</div>
                        </div>
                    </div>
                    </div>
                </section>

                    <div class="mt-6 grid gap-4 xl:grid-cols-3">
                        <div class="rounded-[1.8rem] border border-white/8 bg-slate-950/70 px-5 py-5">
                            <div class="mb-3 text-[10px] font-black uppercase tracking-[0.35em] text-slate-500">Remaining Mix</div>
                            <div id="profileRemaining"></div>
                        </div>
                        <div class="rounded-[1.8rem] border border-white/8 bg-slate-950/70 px-5 py-5">
                            <div class="mb-3 text-[10px] font-black uppercase tracking-[0.35em] text-slate-500">Seen Mix</div>
                            <div id="profileSeen"></div>
                        </div>
                        <div class="rounded-[1.8rem] border border-white/8 bg-slate-950/70 px-5 py-5">
                            <div class="mb-3 text-[10px] font-black uppercase tracking-[0.35em] text-slate-500">Hand Mix</div>
                            <div id="profileHand"></div>
                        </div>
                    </div>
                    <section class="glass rounded-[2.5rem] border border-white/10 p-10 shadow-2xl">
                        <div class="mb-8 flex items-end justify-between gap-4">
                            <div>
                                <div class="text-[10px] font-black uppercase tracking-[0.5em] text-slate-500">Live Hand</div>
                                <div id="handMeta" class="mt-2 text-sm font-bold uppercase tracking-[0.25em] text-slate-400">Scanning interface...</div>
                            </div>
                            <div id="handUnique" class="text-right text-sm font-black uppercase tracking-[0.2em] text-orange-400">0 unique</div>
                        </div>
                        <div id="handSummary" class="mb-8 grid gap-4 sm:grid-cols-3"></div>
                        <div id="hand" class="grid gap-4 sm:grid-cols-2"></div>
                    </section>
 
                    <section class="glass rounded-[2.5rem] border border-white/10 p-10 shadow-2xl">
                        <div class="mb-8 flex flex-wrap items-end justify-between gap-4">
                            <div>
                                <div class="text-[10px] font-black uppercase tracking-[0.5em] text-slate-500">Deck Radar</div>
                                <div id="radarMeta" class="mt-2 text-sm font-bold uppercase tracking-[0.25em] text-slate-400">Probability across cycle depths</div>
                            </div>
                            <div class="flex flex-wrap gap-4">
                                <button id="deckFilterRemaining" class="rounded-full border border-orange-500/30 bg-orange-500/10 px-6 py-2.5 text-[9px] font-black uppercase tracking-[0.35em] text-orange-200 transition-all hover:border-orange-400/50 hover:bg-orange-500/20 active:scale-95">
                                    REMAINING
                                </button>
                                <button id="deckFilterDrawn" class="rounded-full border border-white/10 bg-white/5 px-6 py-2.5 text-[9px] font-black uppercase tracking-[0.35em] text-slate-400 transition-all hover:border-white/20 hover:bg-white/10 active:scale-95">
                                    IDENTIFIED
                                </button>
                            </div>
                        </div>
                        <div id="deckList" class="space-y-3"></div>
                    </section>
                </div>
            </section>
            </div>

            <div class="grid gap-6 xl:grid-cols-[1fr_1fr]">
                <section class="glass rounded-[2.6rem] border border-white/5 p-8">
                    <div class="mb-6 flex items-center justify-between gap-3">
                        <div>
                            <div class="text-[10px] font-black uppercase tracking-[0.35em] text-slate-600">Your Battlefield</div>
                            <div id="myBattlefieldSummary" class="mt-2 text-sm font-bold uppercase tracking-[0.2em] text-slate-400">0 permanents</div>
                        </div>
                        <div id="myBattlefieldCount" class="display-face text-5xl font-black text-cyan-200 tabular-nums">0</div>
                    </div>
                    <div id="myBattlefield" class="grid gap-3 sm:grid-cols-2"></div>
                </section>

                <section class="glass rounded-[2.6rem] border border-white/5 p-8">
                    <div class="mb-6 flex items-center justify-between gap-3">
                        <div>
                            <div class="text-[10px] font-black uppercase tracking-[0.35em] text-slate-600">Opponent Battlefield</div>
                            <div id="oppBattlefieldSummary" class="mt-2 text-sm font-bold uppercase tracking-[0.2em] text-slate-400">0 permanents</div>
                        </div>
                        <div id="oppBattlefieldCount" class="display-face text-5xl font-black text-rose-200 tabular-nums">0</div>
                    </div>
                    <div id="oppBattlefield" class="grid gap-3 sm:grid-cols-2"></div>
                </section>
            </div>

            <div class="grid gap-6 xl:grid-cols-[0.88fr_0.88fr_0.88fr_1.36fr]">
                <section class="glass rounded-[2.4rem] border border-white/5 p-8">
                    <div class="mb-6 flex items-center justify-between gap-3">
                        <div class="text-[10px] font-black uppercase tracking-[0.35em] text-slate-600">Your Graveyard</div>
                        <div id="myGraveyardCount" class="display-face text-4xl font-black text-white tabular-nums">0</div>
                    </div>
                    <div id="myGraveyard" class="space-y-2"></div>
                </section>
                <section class="glass rounded-[2.4rem] border border-white/5 p-8">
                    <div class="mb-6 flex items-center justify-between gap-3">
                        <div class="text-[10px] font-black uppercase tracking-[0.35em] text-slate-600">Opponent Graveyard</div>
                        <div id="oppGraveyardCount" class="display-face text-4xl font-black text-white tabular-nums">0</div>
                    </div>
                    <div id="oppGraveyard" class="space-y-2"></div>
                </section>
                <section class="glass rounded-[2.4rem] border border-white/5 p-8">
                    <div class="mb-6 flex items-center justify-between gap-3">
                        <div class="text-[10px] font-black uppercase tracking-[0.35em] text-slate-600">Stack</div>
                        <div id="stackCount" class="display-face text-4xl font-black text-white tabular-nums">0</div>
                    </div>
                    <div id="stack" class="space-y-2"></div>
                </section>
                <section class="glass rounded-[2.6rem] border border-white/5 p-8">
                    <div class="mb-6 flex items-end justify-between gap-4">
                        <div>
                            <div class="text-[10px] font-black uppercase tracking-[0.35em] text-slate-600">Game Timeline</div>
                            <div id="timelineMeta" class="mt-2 text-sm font-bold uppercase tracking-[0.2em] text-slate-400">Waiting for tracked events</div>
                        </div>
                        <div id="timelineCount" class="display-face text-5xl font-black text-white tabular-nums">0</div>
                    </div>
                    <div id="timeline" class="max-h-[32rem] space-y-3 overflow-y-auto pr-2"></div>
                </section>
            </div>
        </div>
        `
        : `
        <div class="relative space-y-5">

            <!-- Hero Banner -->
            <div class="relative overflow-hidden rounded-[2.5rem] border border-white/10 shadow-[0_64px_160px_-40px_rgba(0,0,0,0.9)]" style="background: linear-gradient(135deg, #05080f 0%, #0c1424 35%, #12091e 70%, #05080f 100%);">
                <div class="pointer-events-none absolute inset-0" style="background: radial-gradient(ellipse 80% 70% at 15% 50%, rgba(249,115,22,0.12) 0%, transparent 55%), radial-gradient(ellipse 60% 80% at 85% 20%, rgba(38, 142, 232, 0.08) 0%, transparent 55%);"></div>
                <div class="pointer-events-none absolute inset-0 opacity-[0.03]" style="background-image: repeating-linear-gradient(90deg, rgba(255,255,255,1) 0px, rgba(255,255,255,1) 1px, transparent 1px, transparent 128px), repeating-linear-gradient(0deg, rgba(255,255,255,1) 0px, rgba(255,255,255,1) 1px, transparent 1px, transparent 128px);"></div>
                <div class="relative px-12 py-12 xl:px-16 xl:py-14 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-10">
                    <div>
                        <div class="mb-5 flex items-center gap-4">
                            <div class="h-[2px] w-12 bg-gradient-to-r from-transparent to-orange-500"></div>
                            <span class="text-[10px] font-black uppercase tracking-[0.6em] text-orange-500/80">Registry Inventory</span>
                        </div>
                        <h1 class="display-face font-black uppercase leading-[0.9] tracking-tight text-white mb-2" style="font-size: clamp(3rem, 7vw, 5.5rem);">My <span style="background: linear-gradient(90deg, #f97316 20%, #fb923c 80%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; filter: drop-shadow(0 0 30px rgba(249,115,22,0.4));">Vault</span></h1>
                        <p class="mt-6 text-base text-slate-400 max-w-xl leading-relaxed font-medium">Your decrypted MTGA library. Synchronized with the global card registry for real-time deck building and format validation.</p>
                    </div>
                    <div id="collectionSummary" class="flex flex-wrap gap-4 xl:justify-end"></div>
                </div>
            </div>

            <!-- Sticky Filter Bar -->
            <div class="sticky top-4 z-30 rounded-[2rem] border border-white/10 px-6 py-4 shadow-[0_8px_40px_rgba(2,6,23,0.9)]" style="background: rgba(6,9,18,0.96); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);">
                <div class="flex flex-wrap gap-3 items-center">
                    <label class="flex-1 min-w-[180px] flex items-center gap-3 rounded-[1.5rem] border border-white/10 bg-slate-950/60 px-4 py-3 transition-colors hover:border-white/20 cursor-text">
                        <svg class="w-3 h-3 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
                        <input id="collectionSearch" type="search" placeholder="Search by name, set, or type…" class="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-600">
                    </label>
                    <label class="rounded-[1.5rem] border border-white/10 bg-slate-950/60 px-4 py-3 min-w-[148px] transition-colors hover:border-white/20 cursor-pointer">
                        <div class="text-[8px] font-black uppercase tracking-[0.5em] text-slate-600 mb-1">Sort By</div>
                        <select id="collectionSort" class="w-full bg-transparent text-xs font-bold text-white outline-none cursor-pointer">
                            <option value="quantity">Most Owned</option>
                            <option value="name">Name A–Z</option>
                            <option value="set">Set Code</option>
                            <option value="rarity">Rarity</option>
                            <option value="llm">AI Deck Sort</option>
                        </select>
                    </label>
                    <label class="rounded-[1.5rem] border border-white/10 bg-slate-950/60 px-4 py-3 min-w-[148px] transition-colors hover:border-white/20 cursor-pointer">
                        <div class="text-[8px] font-black uppercase tracking-[0.5em] text-slate-600 mb-1">Format</div>
                        <select id="collectionFormat" class="w-full bg-transparent text-xs font-bold text-white outline-none cursor-pointer">
                            <option value="all">All Formats</option>
                            <option value="standard">Standard</option>
                            <option value="alchemy">Alchemy</option>
                            <option value="historic">Historic</option>
                            <option value="timeless">Timeless</option>
                            <option value="brawl">Brawl</option>
                            <option value="commander">Commander</option>
                        </select>
                    </label>
                    <div class="flex flex-wrap gap-2 ml-auto">
                        <button id="exportCsv" class="rounded-[1.2rem] border border-sky-500/25 bg-sky-500/10 px-4 py-3 text-[9px] font-black uppercase tracking-[0.3em] text-sky-200 transition hover:border-sky-400/50 hover:bg-sky-500/20">CSV</button>
                        <button id="exportJson" class="rounded-[1.2rem] border border-orange-500/25 bg-orange-500/10 px-4 py-3 text-[9px] font-black uppercase tracking-[0.3em] text-orange-200 transition hover:border-orange-400/50 hover:bg-orange-500/20">JSON</button>
                        <button id="exportLlm" class="rounded-[1.2rem] border border-purple-500/25 bg-purple-500/10 px-4 py-3 text-[9px] font-black uppercase tracking-[0.3em] text-purple-200 transition hover:border-purple-400/50 hover:bg-purple-500/20">AI Export</button>
                        <label class="cursor-pointer rounded-[1.2rem] border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-[9px] font-black uppercase tracking-[0.3em] text-emerald-200 transition hover:border-emerald-400/50 hover:bg-emerald-500/20">
                            Import CSV<input type="file" id="importCsv" accept=".csv" class="hidden" />
                        </label>
                    </div>
                </div>
                <div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/5 pt-3">
                    <div id="collectionCount" class="text-[9px] font-black uppercase tracking-[0.4em] text-slate-500">Loading collection…</div>
                    <div id="collectionHint" class="text-[9px] font-black uppercase tracking-[0.4em] text-slate-600">Basic lands hidden</div>
                </div>
            </div>

            <!-- Empty State -->
            <div id="collectionEmpty" class="hidden rounded-[2rem] border border-dashed border-slate-700/60 bg-slate-950/40 px-8 py-20 text-center">
                <div class="text-[9px] font-black uppercase tracking-[0.5em] text-slate-600">No Results</div>
                <div class="mt-4 text-2xl font-black uppercase tracking-tight text-white">No cards match your filter</div>
                <p class="mt-3 text-sm text-slate-500">Try broadening your search or switching the format.</p>
            </div>

            <!-- Card Grid -->
            <div id="collection" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-4 pb-24"></div>

        </div>
        `;
    const isOverlay = url.searchParams.get("overlay") === "true";
    const isLauncher = url.searchParams.get("launcher") === "true";
    return new Response(`
<!DOCTYPE html>
<html lang="en" class="${isOverlay ? 'overlay' : ''} ${isLauncher ? 'launcher' : ''}">
<head>
    <meta charset="UTF-8">
    <title>MTGA Standard Deck Tracker</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;700;800&family=Chakra+Petch:wght@400;500;600;700&display=swap');
        :root {
            --bg: #010409;
            --panel: rgba(8, 12, 24, 0.7);
            --line: rgba(255, 255, 255, 0.08);
            --ink: #f1f5f9;
            --muted: #64748b;
            --orange: #f97316;
            --orange-glow: rgba(249, 115, 22, 0.4);
            --cyan: #38bdf8;
            --metallic-border: linear-gradient(135deg, rgba(255,255,255,0.12), rgba(255,255,255,0.02) 50%, rgba(255,255,255,0.08));
        }
        @keyframes gradient-shift {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
        }
        body {
            min-height: 100vh;
            color: var(--ink);
            font-family: 'Chakra Petch', sans-serif;
            background: linear-gradient(-45deg, #020617, #0a0f24, #02040a, #0f172a);
            background-size: 400% 400%;
            animation: gradient-shift 20s ease infinite;
        }
        body::before {
            content: "";
            position: fixed;
            inset: 0;
            pointer-events: none;
            background-image:
                linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
            background-size: 64px 64px;
            mask-image: radial-gradient(circle at center, black 40%, transparent 95%);
            opacity: 0.8;
            z-index: -2;
        }
        body::after {
            content: "";
            position: fixed;
            inset: 0;
            pointer-events: none;
            background: radial-gradient(circle at top right, rgba(249, 115, 22, 0.08), transparent 40%),
                        radial-gradient(circle at bottom left, rgba(56, 189, 248, 0.08), transparent 40%);
            z-index: -1;
        }
        .display-face { font-family: 'Bricolage Grotesque', sans-serif; }
        
        /* Auto-Glassmorphism for all slate cards we can target by their tailwind border / bg classes */
        div[class*="bg-slate-950/70"], 
        div[class*="bg-slate-950/65"], 
        div[class*="bg-slate-950/75"],
        div[class*="bg-slate-950/60"],
        div[class*="bg-slate-950/80"] {
            background: linear-gradient(145deg, rgba(8, 12, 24, 0.6) 0%, rgba(2, 6, 12, 0.4) 100%) !important;
            backdrop-filter: blur(24px) saturate(180%) !important;
            -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
            border: 1px solid rgba(255, 255, 255, 0.08) !important;
            box-shadow: 0 12px 48px -12px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.05);
            transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        }
        
        div[class*="bg-slate-950/70"]:hover, 
        div[class*="bg-slate-950/65"]:hover, 
        div[class*="bg-slate-950/75"]:hover,
        .card-node:hover {
            border-color: rgba(255, 255, 255, 0.15) !important;
            box-shadow: 0 12px 40px 0 rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255,255,255,0.05);
            transform: translateY(-2px);
        }

        /* Neon Glows */
        #oppLife { text-shadow: 0 0 25px rgba(239, 68, 68, 0.7); }
        #myLife { text-shadow: 0 0 25px rgba(34, 197, 94, 0.7); }
        .text-orange-200 { text-shadow: 0 0 12px rgba(253, 186, 116, 0.6); }
        .text-cyan-100 { text-shadow: 0 0 12px rgba(207, 250, 254, 0.6); }
        .text-emerald-200 { text-shadow: 0 0 12px rgba(167, 243, 208, 0.6); }

        .card-node { animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; border-left: 4px solid var(--orange); }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); filter: blur(4px); } to { opacity: 1; transform: translateY(0); filter: blur(0); } }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-thumb { background: rgba(51, 65, 85, 0.5); border-radius: 999px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(51, 65, 85, 0.8); }

        /* Nav links animations */
        nav a {
            position: relative;
            overflow: hidden;
            transition: color 0.3s ease;
        }
        nav a::before {
            content: '';
            position: absolute;
            bottom: 0;
            left: 50%;
            width: 0;
            height: 2px;
            background: currentColor;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            transform: translateX(-50%);
            opacity: 0.5;
        }
        nav a:hover::before { width: 80%; opacity: 1; }
        nav a.bg-orange-600::before { display: none; }
        
        /* Overlay Mode Overrides */
        html.overlay, html.overlay body { background: transparent !important; animation: none !important; margin: 0; padding: 0 !important; }
        html.overlay body::before, html.overlay body::after { display: none !important; }
        html.overlay .main-content { margin-left: 0 !important; padding: 4px !important; max-width: 100% !important; }
        html.overlay section { border: none !important; box-shadow: none !important; padding: 10px !important; background: rgba(10, 15, 32, 0.85) !important; border-radius: 8px !important; margin-bottom: 10px; }
        html.overlay .xl\\:grid-cols-\\[1\\.15fr_0\\.85fr\\] > div:first-child { display: none !important; }
        html.overlay .xl\\:grid-cols-\\[1\\.15fr_0\\.85fr\\] { grid-template-columns: 1fr !important; }
        html.overlay .2xl\\:grid-cols-\\[1\\.08fr_0\\.92fr_0\\.95fr\\] { grid-template-columns: 1fr !important; display: flex; flex-direction: column; gap: 10px; }
        html.overlay .xl\\:grid-cols-\\[1fr_1fr\\] { display: none !important; } /* Hide battlefields */
        html.overlay #deckList { max-height: 50vh; overflow-y: auto; }

        /* Prevent dragging on transparent areas, enable on panels */
        html.overlay body { -webkit-app-region: drag; }
        html.overlay button, html.overlay .overflow-y-auto, html.overlay .card-node { -webkit-app-region: no-drag; }
        
        /* Launcher Mode Overrides */
        /* Sidebar layout */
        html.launcher .sidebar { display: none !important; }
        html.launcher .main-content { margin-left: 0 !important; }
        html.overlay .sidebar { display: none !important; }
        html.overlay .main-content { margin-left: 0 !important; padding: 0 !important; }
        .sidebar {
            position: fixed;
            top: 0;
            left: 0;
            bottom: 0;
            width: 240px;
            background: rgba(5, 7, 14, 0.97);
            border-right: 1px solid rgba(255,255,255,0.06);
            display: flex;
            flex-direction: column;
            z-index: 50;
            backdrop-filter: blur(20px);
        }
        .main-content {
            margin-left: 240px;
            min-height: 100vh;
            padding: 28px 32px;
            max-width: calc(1600px + 240px);
        }
        .sidebar-nav-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 16px;
            border-radius: 14px;
            font-size: 11px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: rgba(148,163,184,0.7);
            text-decoration: none;
            transition: background 0.15s, color 0.15s;
            cursor: pointer;
            border: 1px solid transparent;
            margin: 0 8px;
        }
        .sidebar-nav-item:hover {
            background: rgba(255,255,255,0.05);
            color: #f8fafc;
        }
        .sidebar-nav-item.active {
            background: linear-gradient(90deg, rgba(249, 115, 22, 0.15), transparent);
            border-left: 2px solid var(--orange);
            color: #fff;
            box-shadow: inset 4px 0 12px -4px var(--orange-glow);
        }
        .sidebar-nav-item.active .nav-icon { opacity: 1; }
        .nav-icon { opacity: 0.45; transition: opacity 0.15s; }
        .sidebar-nav-item:hover .nav-icon { opacity: 0.8; }
        html.launcher .top-nav-links { display: none !important; }
    </style>
</head>
<body class="${isOverlay ? 'p-0' : ''}">

    <!-- Sidebar -->
    <aside class="sidebar ${isOverlay || isLauncher ? 'hidden' : ''}">
        <!-- Logo -->
        <div class="px-6 py-6 border-b border-white/5">
            <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-xl flex items-center justify-center font-black text-sm text-white shadow-[0_0_20px_rgba(234,88,12,0.3)]" style="background: linear-gradient(135deg, #f97316, #ea580c); border: 1px solid rgba(255,255,255,0.2);">S</div>
                <div>
                    <div class="text-xs font-black uppercase tracking-widest text-white">Nexus Shell</div>
                    <div class="text-[9px] font-bold uppercase tracking-[0.4em] text-slate-600 mt-0.5">MTGA Tracker</div>
                </div>
            </div>
        </div>

        <!-- Nav -->
        <div class="flex-1 overflow-y-auto py-4">
            <div class="px-6 mb-3 mt-1">
                <div class="text-[8px] font-black uppercase tracking-[0.5em] text-slate-700">Tracker Modules</div>
            </div>
            <nav class="space-y-1">
                <a href="/collection" class="sidebar-nav-item ${activeNav === 'collection' ? 'active' : ''}">
                    <svg class="nav-icon w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/></svg>
                    Card Collection
                </a>
                <a href="/live" class="sidebar-nav-item ${activeNav === 'live' ? 'active' : ''}">
                    <span id="liveDot" class="nav-icon w-2 h-2 rounded-full bg-slate-600 shrink-0"></span>
                    Live Match
                </a>
                <a href="/history" class="sidebar-nav-item ${activeNav === 'history' ? 'active' : ''}">
                    <svg class="nav-icon w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                    Match History
                </a>
            </nav>

            <div class="px-6 mb-3 mt-6">
                <div class="text-[8px] font-black uppercase tracking-[0.5em] text-slate-700">System</div>
            </div>
            <nav class="space-y-1">
                <div class="sidebar-nav-item opacity-50 cursor-not-allowed">
                    <svg class="nav-icon w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><circle cx="12" cy="12" r="3"/></svg>
                    Preferences
                </div>
            </nav>
        </div>

        <!-- Life totals (live page only) -->
        <div id="life" class="${lifeClass} border-t border-white/5 px-5 py-4 grid grid-cols-2 gap-3">
            <div class="text-center rounded-2xl border border-white/8 py-3" style="background:rgba(10,15,32,0.6)">
                <div class="text-[8px] font-black uppercase tracking-[0.4em] text-slate-600 mb-1">Opponent</div>
                <div id="oppLife" class="text-3xl font-black text-red-400 tabular-nums italic">20</div>
            </div>
            <div class="text-center rounded-2xl border border-white/8 py-3" style="background:rgba(10,15,32,0.6)">
                <div class="text-[8px] font-black uppercase tracking-[0.4em] text-slate-600 mb-1">You</div>
                <div id="myLife" class="text-3xl font-black text-green-400 tabular-nums italic">20</div>
            </div>
        </div>

        <!-- Service Status -->
        <div class="px-5 py-4 border-t border-white/5">
            <div class="text-[8px] font-black uppercase tracking-[0.5em] text-slate-700 mb-2">Service Status</div>
            <div id="serviceStatus" class="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-3 py-2">
                <span class="w-2 h-2 rounded-full bg-emerald-400 shrink-0" style="box-shadow: 0 0 6px rgba(52,211,153,0.6);"></span>
                <span class="text-[9px] font-black uppercase tracking-[0.3em] text-emerald-300">Backend Online</span>
            </div>
        </div>
    </aside>

    <!-- Main content -->
    <div class="main-content ${isOverlay ? 'p-2' : ''} ${isLauncher ? 'ml-0 p-6' : ''}">
        ${pageBody}
    </div>

    <script>
        if (${isLive}) {
            const ev = new EventSource('/api/live-stream');
            let latestState = null;
            let deckFilterMode = 'remaining';
            const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, char => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            }[char]));
            const seatLabel = (state, seatId) => !seatId ? 'Unknown' : seatId === state.mySeatId ? 'You' : 'Opponent';
            const relativeAge = (timestamp) => {
                const elapsed = Math.max(0, Math.floor((Date.now() - Number(timestamp || 0)) / 1000));
                if (elapsed < 2) return 'Just now';
                if (elapsed < 60) return elapsed + 's ago';
                const minutes = Math.floor(elapsed / 60);
                if (minutes < 60) return minutes + 'm ago';
                return Math.floor(minutes / 60) + 'h ago';
            };
            const formatChance = value => (Number.isFinite(Number(value)) ? Number(value).toFixed(1) : '0.0') + '%';
            const deckColorTone = {
                W: 'border-slate-200/15 bg-slate-100/10 text-slate-100',
                U: 'border-sky-300/20 bg-sky-500/10 text-sky-100',
                B: 'border-violet-300/20 bg-violet-500/10 text-violet-100',
                R: 'border-rose-300/20 bg-rose-500/10 text-rose-100',
                G: 'border-emerald-300/20 bg-emerald-500/10 text-emerald-100',
                C: 'border-slate-400/20 bg-slate-500/10 text-slate-200'
            };

            function normalizeDeckColors(colors) {
                return Array.isArray(colors) && colors.length ? colors : ['C'];
            }

            function renderDeckColors(colors) {
                return normalizeDeckColors(colors).map(color => {
                    const key = String(color || 'C').toUpperCase();
                    return \`<span class="rounded-full border px-2 py-1 text-[8px] font-black uppercase tracking-[0.18em] \${deckColorTone[key] || deckColorTone.C}">\${escapeHtml(key)}</span>\`;
                }).join('');
            }

            function formatDeckCopyTotal(card) {
                const current = Math.max(Number(card?.count || 0), 0);
                const total = Math.max(Number(card?.deckCount || 0), current);
                return total ? \`\${current}/\${total}\` : String(current);
            }

            function renderCard(card, tone) {
                const subtitle = [card.typeLine, card.statLine].filter(Boolean).join(' · ');
                const artwork = card.imagePath
                    ? \`<img src="\${card.imagePath}" alt="\${escapeHtml(card.name || 'Card')}" class="h-20 w-14 rounded-[1rem] border border-white/10 object-cover shadow-[0_8px_30px_rgba(15,23,42,0.45)]" loading="lazy">\`
                    : '<div class="flex h-20 w-14 items-center justify-center rounded-[1rem] border border-dashed border-slate-700 bg-slate-950/80 text-[8px] font-black uppercase tracking-[0.25em] text-slate-500">Syncing</div>';
                return \`
                    <div class="rounded-[1.6rem] border border-white/8 \${tone} px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                        <div class="flex items-start gap-4">
                            \${artwork}
                            <div class="min-w-0 flex-1">
                                <div class="flex items-start justify-between gap-3">
                                    <div class="text-[9px] font-black uppercase tracking-[0.28em] text-slate-500">\${escapeHtml(card.objectType.replace('GameObjectType_', '') || 'Card')}</div>
                                    <span class="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[8px] font-black uppercase tracking-[0.28em] text-slate-300">\${card.tapped ? 'Tapped' : 'Ready'}</span>
                                </div>
                                <div class="mt-2 text-sm font-black leading-tight text-white">\${escapeHtml(card.name || 'Unknown')}</div>
                                <div class="mt-2 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">\${escapeHtml(subtitle || 'Public object')}</div>
                            </div>
                        </div>
                    </div>
                \`;
            }

            function renderCompactList(cards, emptyText) {
                if (!cards.length) {
                    return '<div class="rounded-[1.5rem] border border-dashed border-slate-700 bg-slate-950/60 px-4 py-8 text-center text-[10px] font-black uppercase tracking-[0.35em] text-slate-600">' + emptyText + '</div>';
                }

                return cards.map(card => \`
                    <div class="rounded-[1.2rem] border border-white/6 bg-slate-950/65 px-4 py-3">
                        <div class="flex items-start gap-3">
                            \${card.imagePath ? \`<img src="\${card.imagePath}" alt="\${escapeHtml(card.name || 'Card')}" class="h-12 w-9 rounded-[0.8rem] border border-white/10 object-cover" loading="lazy">\` : '<div class="flex h-12 w-9 items-center justify-center rounded-[0.8rem] border border-dashed border-slate-700 bg-slate-950/80 text-[7px] font-black uppercase tracking-[0.2em] text-slate-500">...</div>'}
                            <div class="min-w-0 flex-1">
                                <div class="truncate text-sm font-black text-white">\${escapeHtml(card.name || 'Unknown')}</div>
                                <div class="mt-1 text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">\${escapeHtml(card.typeLine || card.objectType || 'Card')}</div>
                            </div>
                            <span class="rounded-full border border-white/8 bg-white/5 px-2 py-1 text-[8px] font-black uppercase tracking-[0.24em] text-slate-300">\${card.tapped ? 'Tapped' : 'Ready'}</span>
                        </div>
                    </div>
                \`).join('');
            }

            function renderProfileBars(summary, emptyText) {
                const total = Number(summary?.total || 0);
                if (!total) {
                    return '<div class="rounded-[1.2rem] border border-dashed border-slate-700 bg-slate-950/60 px-4 py-6 text-center text-[10px] font-black uppercase tracking-[0.32em] text-slate-600">' + emptyText + '</div>';
                }

                const bands = [
                    { label: 'Lands', count: summary.lands || 0, tone: 'from-cyan-400 via-sky-300 to-cyan-100' },
                    { label: 'Creatures', count: summary.creatures || 0, tone: 'from-emerald-400 via-emerald-300 to-emerald-100' },
                    { label: 'Action', count: summary.action || 0, tone: 'from-fuchsia-400 via-violet-300 to-fuchsia-100' }
                ];

                return bands.map((band) => {
                    const percent = total ? Math.round((band.count / total) * 100) : 0;
                    return \`
                        <div class="mb-4 last:mb-0">
                            <div class="mb-2 flex items-center justify-between gap-3 text-[10px] font-black uppercase tracking-[0.25em] text-slate-300">
                                <span>\${band.label}</span>
                                <span>\${band.count} · \${percent}%</span>
                            </div>
                            <div class="h-2 overflow-hidden rounded-full bg-slate-800">
                                <div class="h-full rounded-full bg-gradient-to-r \${band.tone}" style="width:\${Math.max(percent, band.count ? 6 : 0)}%"></div>
                            </div>
                        </div>
                    \`;
                }).join('');
            }

            function renderHandSummary(summary) {
                const total = Number(summary?.total || 0);
                const items = [
                    { label: 'Cards', value: total, tone: 'text-white' },
                    { label: 'Lands', value: summary?.lands || 0, tone: 'text-cyan-100' },
                    { label: 'Action', value: summary?.action || 0, tone: 'text-fuchsia-100' }
                ];

                return items.map((item) => \`
                    <div class="rounded-[1.4rem] border border-white/8 bg-slate-950/70 px-4 py-4">
                        <div class="text-[9px] font-black uppercase tracking-[0.28em] text-slate-600">\${item.label}</div>
                        <div class="display-face mt-2 text-4xl font-black \${item.tone} tabular-nums">\${item.value}</div>
                    </div>
                \`).join('');
            }

            function renderMatchGames(games) {
                if (!games.length) {
                    return '<div class="rounded-[1.3rem] border border-dashed border-slate-700 bg-slate-950/60 px-4 py-8 text-center text-[10px] font-black uppercase tracking-[0.32em] text-slate-600 md:col-span-2">No game chunks captured yet</div>';
                }

                return games.map((game) => {
                    const tone = game.status === 'live'
                        ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100'
                        : 'border-white/10 bg-white/5 text-slate-200';
                    const result = game.result || (game.status === 'live' ? 'In Progress' : 'Complete');

                    return \`
                        <div class="rounded-[1.4rem] border border-white/8 bg-slate-950/75 px-4 py-4">
                            <div class="flex items-start justify-between gap-4">
                                <div>
                                    <div class="text-[9px] font-black uppercase tracking-[0.28em] text-slate-500">\${escapeHtml(game.label || 'Game')}</div>
                                    <div class="mt-2 text-xl font-black text-white">\${escapeHtml(result)}</div>
                                </div>
                                <span class="rounded-full border px-3 py-1 text-[8px] font-black uppercase tracking-[0.28em] \${tone}">\${escapeHtml(game.status || 'pending')}</span>
                            </div>
                            <div class="mt-4 grid grid-cols-3 gap-2 text-[10px] font-black uppercase tracking-[0.22em] text-slate-400">
                                <div class="rounded-[1rem] border border-white/6 bg-white/5 px-3 py-2">Turn <span class="text-white">\${game.turnNumber || 0}</span></div>
                                <div class="rounded-[1rem] border border-white/6 bg-white/5 px-3 py-2">Events <span class="text-white">\${game.timelineCount || 0}</span></div>
                                <div class="rounded-[1rem] border border-white/6 bg-white/5 px-3 py-2">Board <span class="text-white">\${game.counts?.myBattlefield || 0} / \${game.counts?.oppBattlefield || 0}</span></div>
                            </div>
                        </div>
                    \`;
                }).join('');
            }

            function renderOdds(probabilities) {
                if (!probabilities.length) {
                    return '<div class="rounded-[1.5rem] border border-dashed border-slate-700 bg-slate-950/60 px-4 py-8 text-center text-[10px] font-black uppercase tracking-[0.35em] text-slate-600">No cards match this filter yet</div>';
                }

                return probabilities.map(p => \`
                    <div class="rounded-[1.4rem] border border-white/6 bg-slate-950/65 px-4 py-4">
                        <div class="flex items-start justify-between gap-4">
                            <div class="min-w-0 flex-1">
                                <div class="truncate text-sm font-black text-white">\${escapeHtml(p.name)}</div>
                                <div class="mt-2 flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">
                                    <div class="flex flex-wrap gap-1">\${renderDeckColors(p.colors)}</div>
                                    <span>\${formatDeckCopyTotal(p)} \${deckFilterMode === 'drawn' ? 'seen' : 'remaining'}</span>
                                </div>
                            </div>
                            <div class="text-right">
                                <div class="text-[9px] font-black uppercase tracking-[0.24em] text-slate-500">Next</div>
                                <div class="display-face text-2xl font-black text-orange-200">\${formatChance(p.chance)}</div>
                            </div>
                        </div>
                        <div class="mt-3 grid grid-cols-2 gap-3 text-[10px] font-black uppercase tracking-[0.22em] text-slate-400">
                            <div class="rounded-[1rem] border border-white/6 bg-white/5 px-3 py-2">In 2 · <span class="text-white">\${formatChance(p.nextTwoChance)}</span></div>
                            <div class="rounded-[1rem] border border-white/6 bg-white/5 px-3 py-2">In 3 · <span class="text-white">\${formatChance(p.nextThreeChance)}</span></div>
                        </div>
                        <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-800">
                            <div class="h-full rounded-full bg-gradient-to-r from-orange-400 via-amber-200 to-orange-100" style="width:\${Math.min(Number(p.chance) || 0, 100)}%"></div>
                        </div>
                    </div>
                \`).join('');
            }

            function updateDeckFilterButtons() {
                const remainingBtn = document.getElementById('deckFilterRemaining');
                const drawnBtn = document.getElementById('deckFilterDrawn');
                const activeClasses = ['border-orange-400/30', 'bg-orange-500/15', 'text-orange-100'];
                const inactiveClasses = ['border-white/10', 'bg-white/5', 'text-slate-300'];

                [remainingBtn, drawnBtn].forEach(btn => {
                    btn.classList.remove(...activeClasses, ...inactiveClasses);
                    btn.classList.add(...inactiveClasses);
                });

                if (deckFilterMode === 'drawn') {
                    drawnBtn.classList.remove(...inactiveClasses);
                    drawnBtn.classList.add(...activeClasses);
                } else {
                    remainingBtn.classList.remove(...inactiveClasses);
                    remainingBtn.classList.add(...activeClasses);
                }
            }

            function getActiveDeckList(state) {
                return deckFilterMode === 'drawn'
                    ? (state.drawnProbabilities || [])
                    : (state.probabilities || []);
            }

            function renderTimeline(entries) {
                if (!entries.length) {
                    return '<div class="rounded-[1.5rem] border border-dashed border-slate-700 bg-slate-950/60 px-4 py-10 text-center text-[10px] font-black uppercase tracking-[0.35em] text-slate-600">No tracked events yet</div>';
                }

                return entries.map(entry => {
                    const isTurn = entry.kind === 'turn';
                    const actorTone = entry.actor === 'You'
                        ? 'border-cyan-500/20 bg-cyan-500/10 text-cyan-100'
                        : entry.actor === 'Opponent'
                            ? 'border-rose-500/20 bg-rose-500/10 text-rose-100'
                            : 'border-white/10 bg-white/5 text-slate-200';
                    const kindTone = isTurn
                        ? 'border-orange-500/20 bg-orange-500/10 text-orange-100'
                        : 'border-white/10 bg-white/5 text-slate-200';
                    const phaseLabel = [entry.phase, entry.step].filter(Boolean).join(' / ');

                    return \`
                        <div class="card-node rounded-[1.5rem] border border-white/6 bg-slate-950/65 px-5 py-4">
                            <div class="flex flex-wrap items-center justify-between gap-3">
                                <div class="flex flex-wrap items-center gap-2">
                                    <span class="rounded-full border px-2 py-1 text-[8px] font-black uppercase tracking-[0.28em] \${kindTone}">\${isTurn ? 'Turn Flow' : 'Card Event'}</span>
                                    <span class="rounded-full border px-2 py-1 text-[8px] font-black uppercase tracking-[0.28em] \${actorTone}">\${escapeHtml(entry.actor || 'Game')}</span>
                                    <span class="rounded-full border border-white/8 bg-white/5 px-2 py-1 text-[8px] font-black uppercase tracking-[0.28em] text-slate-300">Turn \${entry.turnNumber || '-'}</span>
                                </div>
                                <div class="text-[9px] font-black uppercase tracking-[0.3em] text-slate-500">\${escapeHtml(phaseLabel || 'Waiting')}</div>
                            </div>
                            <div class="mt-3 text-sm font-black leading-tight text-white">\${escapeHtml(entry.summary || 'Event')}</div>
                            \${entry.detail ? \`<div class="mt-2 text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">\${escapeHtml(entry.detail)}</div>\` : ''}
                        </div>
                    \`;
                }).join('');
            }

            function refreshMeta() {
                if (!latestState) return;
                document.getElementById('syncAge').innerText = relativeAge(latestState.lastUpdate);
            }

            function applyState(s) {
                latestState = s;
                refreshMeta();

                const phaseLabel = [s.turn.phase, s.turn.step].filter(Boolean).join(' / ');
                const metaParts = [];
                if (s.format && s.format !== 'Unknown') metaParts.push(s.format);
                if (s.startingDeckSize) metaParts.push(s.startingDeckSize + '-card deck');
                metaParts.push(s.matchState || 'Monitoring Logs');
                const topCard = s.drawStats && s.drawStats.topCard ? s.drawStats.topCard : null;
                const deckProfile = s.deckProfile || {};
                const handProfile = deckProfile.hand || {};
                const remainingProfile = deckProfile.remaining || {};
                const seenProfile = deckProfile.seen || {};
                const gamesInMatch = Array.isArray(s.gamesInMatch) ? s.gamesInMatch : [];
                const liveDeckCount = s.libraryCount || (s.drawStats ? s.drawStats.remainingCards : 0);
                const timelineEl = document.getElementById('timeline');
                const keepTimelinePinned = !timelineEl || timelineEl.scrollHeight - timelineEl.scrollTop - timelineEl.clientHeight < 80;

                document.getElementById('liveDot').className = \`w-2 h-2 rounded-full \${s.active ? 'bg-green-500 animate-pulse shadow-[0_0_10px_#22c55e]' : 'bg-slate-700'}\`;
                document.getElementById('formatBadge').innerText = s.format && s.format !== 'Unknown' ? s.format : 'Awaiting Format';
                const liveStateLabel = s.active ? 'Match Live' : s.gameEnded ? 'Game Ended' : gamesInMatch.length ? 'Between Games' : 'Log Monitor';
                document.getElementById('activeStatePill').innerText = liveStateLabel;
                document.getElementById('activeStatePill').className = \`rounded-full border px-4 py-2 text-[10px] font-black uppercase tracking-[0.34em] \${s.active ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100' : s.gameEnded ? 'border-amber-400/20 bg-amber-500/10 text-amber-100' : 'border-white/10 bg-white/5 text-slate-300'}\`;
                document.getElementById('deckName').innerText = s.deckName || 'Unknown Deck';
                document.getElementById('deckMeta').innerText = metaParts.join(' · ');
                document.getElementById('turnPill').innerText = s.turn.number ? String(s.turn.number) : '-';
                document.getElementById('phasePill').innerText = phaseLabel || 'Waiting';
                document.getElementById('statusText').innerText = s.matchState || (s.active ? 'Match Live' : 'Monitoring Logs');
                document.getElementById('activePlayer').innerText = seatLabel(s, s.turn.activePlayer);
                document.getElementById('priorityPlayer').innerText = seatLabel(s, s.turn.priorityPlayer || s.turn.decisionPlayer);
                document.getElementById('myLife').innerText = s.life.me;
                document.getElementById('oppLife').innerText = s.life.opp;
                document.getElementById('myHandCount').innerText = s.counts.hand;
                document.getElementById('oppHand').innerText = s.oppHandCount;
                document.getElementById('deckSize').innerText = String(s.startingDeckSize || 0);
                document.getElementById('seenCardsPill').innerText = String(s.seenCards || 0);
                document.getElementById('liveDeckCount').innerText = String(liveDeckCount || 0);
                document.getElementById('myExileCount').innerText = String(s.counts.myExile || 0);
                document.getElementById('stackCount').innerText = s.counts.stack;
                document.getElementById('stackChip').innerText = 'Stack ' + String(s.counts.stack || 0);
                document.getElementById('myBattlefieldCount').innerText = s.counts.myBattlefield;
                document.getElementById('oppBattlefieldCount').innerText = s.counts.oppBattlefield;
                document.getElementById('myBattlefieldSummary').innerText = s.counts.myBattlefield + ' permanents';
                document.getElementById('oppBattlefieldSummary').innerText = s.counts.oppBattlefield + ' permanents';
                document.getElementById('myGraveyardCount').innerText = s.counts.myGraveyard;
                document.getElementById('oppGraveyardCount').innerText = s.counts.oppGraveyard;
                document.getElementById('deckOddsMeta').innerText = !s.startingDeckSize
                    ? 'Waiting for deck list'
                    : deckFilterMode === 'drawn'
                        ? s.drawnSummary.total + ' cards seen · ' + s.drawnSummary.uniqueCards + ' unique seen'
                        : s.drawStats.remainingCards + ' cards live · ' + s.drawStats.uniqueCards + ' unique outs';
                document.getElementById('deckSeen').innerText = s.seenCards + ' seen';
                document.getElementById('topDrawChance').innerText = topCard ? formatChance(topCard.chance) : '0.0%';
                document.getElementById('topDrawName').innerText = topCard ? topCard.name : 'Waiting for deck';
                document.getElementById('topDrawTwoChance').innerText = formatChance(s.drawStats ? s.drawStats.topCardNextTwo : 0);
                document.getElementById('landNextChance').innerText = formatChance(s.drawStats ? s.drawStats.landChance : 0);
                document.getElementById('landNextTwoChance').innerText = formatChance(s.drawStats ? s.drawStats.landNextTwo : 0);
                document.getElementById('creatureNextChance').innerText = formatChance(s.drawStats ? s.drawStats.creatureChance : 0);
                document.getElementById('nonLandNextChance').innerText = formatChance(s.drawStats ? s.drawStats.nonLandChance : 0);
                document.getElementById('handMeta').innerText = handProfile.total
                    ? handProfile.total + ' cards in hand · ' + (handProfile.nonLand || 0) + ' non-lands'
                    : 'Waiting for visible hand';
                document.getElementById('handUnique').innerText = (handProfile.unique || 0) + ' unique';
                document.getElementById('handSummary').innerHTML = renderHandSummary(handProfile);
                document.getElementById('profileRemaining').innerHTML = renderProfileBars(remainingProfile, 'No remaining deck data');
                document.getElementById('profileSeen').innerHTML = renderProfileBars(seenProfile, 'No seen card data');
                document.getElementById('profileHand').innerHTML = renderProfileBars(handProfile, 'Hand is hidden or empty');
                document.getElementById('matchGamesCount').innerText = String(gamesInMatch.length);
                document.getElementById('matchGamesMeta').innerText = gamesInMatch.length
                    ? gamesInMatch.filter(game => game.status === 'complete').length + ' complete · ' + gamesInMatch.filter(game => game.status === 'live').length + ' live'
                    : 'Waiting for game chunks';
                document.getElementById('matchGames').innerHTML = renderMatchGames(gamesInMatch);
                document.getElementById('radarMeta').innerText = deckFilterMode === 'drawn'
                    ? 'Seen cards with frequency across this game'
                    : 'Remaining cards with single, double, and triple draw odds';
                document.getElementById('timelineCount').innerText = String((s.timeline || []).length);
                document.getElementById('timelineMeta').innerText = (s.timeline || []).length
                    ? 'Chronological match flow and card movements'
                    : 'Waiting for tracked events';

                document.getElementById('myBattlefield').innerHTML = s.zones.myBattlefield.length
                    ? s.zones.myBattlefield.map(card => renderCard(card, 'bg-cyan-500/8')).join('')
                    : '<div class="rounded-[1.5rem] border border-dashed border-slate-700 bg-slate-950/60 px-4 py-8 text-center text-[10px] font-black uppercase tracking-[0.35em] text-slate-600">No permanents on your board</div>';
                document.getElementById('oppBattlefield').innerHTML = s.zones.oppBattlefield.length
                    ? s.zones.oppBattlefield.map(card => renderCard(card, 'bg-rose-500/8')).join('')
                    : '<div class="rounded-[1.5rem] border border-dashed border-slate-700 bg-slate-950/60 px-4 py-8 text-center text-[10px] font-black uppercase tracking-[0.35em] text-slate-600">Opponent board is empty</div>';
                document.getElementById('hand').innerHTML = s.zones.hand.length
                    ? s.zones.hand.map(card => renderCard(card, 'bg-orange-500/8')).join('')
                    : '<div class="rounded-[1.5rem] border border-dashed border-slate-700 bg-slate-950/60 px-4 py-8 text-center text-[10px] font-black uppercase tracking-[0.35em] text-slate-600">Hand is empty</div>';
                document.getElementById('myGraveyard').innerHTML = renderCompactList(s.zones.myGraveyard, 'No cards in your graveyard');
                document.getElementById('oppGraveyard').innerHTML = renderCompactList(s.zones.oppGraveyard, 'No cards in opponent graveyard');
                document.getElementById('stack').innerHTML = renderCompactList(s.zones.stack, 'Stack is empty');
                updateDeckFilterButtons();
                document.getElementById('deckList').innerHTML = renderOdds(getActiveDeckList(s));
                timelineEl.innerHTML = renderTimeline(s.timeline || []);
                if (keepTimelinePinned) {
                    timelineEl.scrollTop = timelineEl.scrollHeight;
                }
            }

            document.getElementById('deckFilterRemaining').addEventListener('click', () => {
                deckFilterMode = 'remaining';
                if (latestState) applyState(latestState);
            });
            document.getElementById('deckFilterDrawn').addEventListener('click', () => {
                deckFilterMode = 'drawn';
                if (latestState) applyState(latestState);
            });
            ev.addEventListener('init', e => applyState(JSON.parse(e.data)));
            ev.addEventListener('state-update', e => applyState(JSON.parse(e.data)));
            setInterval(refreshMeta, 1000);
        } else if (${isHistory}) {
            const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, char => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            }[char]));
            const fmtPct = v => (v != null && Number.isFinite(v)) ? v + '%' : '-';
            const fmtDur = ms => {
                if (!ms || !Number.isFinite(ms)) return '-';
                const totalSec = Math.round(ms / 1000);
                const min = Math.floor(totalSec / 60);
                const sec = totalSec % 60;
                return min + ':' + String(sec).padStart(2, '0');
            };
            const fmtBytes = bytes => {
                if (!bytes || !Number.isFinite(bytes)) return '0 B';
                const units = ['B', 'KB', 'MB', 'GB'];
                let value = bytes;
                let unitIndex = 0;
                while (value >= 1024 && unitIndex < units.length - 1) {
                    value /= 1024;
                    unitIndex += 1;
                }
                return (value >= 10 || unitIndex === 0 ? value.toFixed(unitIndex === 0 ? 0 : 0) : value.toFixed(1)) + ' ' + units[unitIndex];
            };
            const fmtDate = ts => {
                if (!ts) return '-';
                const d = new Date(ts);
                return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
            };
            const resultTone = code => code === 'win' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-100'
                : code === 'loss' ? 'border-rose-500/20 bg-rose-500/10 text-rose-100'
                : 'border-white/10 bg-white/5 text-slate-300';

            function renderTotals(t) {
                const items = [
                    { label: 'Matches', value: t.matches || 0, meta: (t.inProgressMatches || 0) > 0 ? (t.inProgressMatches || 0) + ' live' : (t.completeMatches || 0) + ' complete' },
                    { label: 'Games', value: t.games || 0, meta: (t.unresolvedGames || 0) > 0 ? (t.unresolvedGames || 0) + ' unresolved' : (t.resolvedGames || 0) + ' resolved' },
                    { label: 'Record', value: (t.wins || 0) + '-' + (t.losses || 0), meta: (t.resolvedGames || 0) + ' resolved' },
                    { label: 'Win Rate', value: fmtPct(t.winRate), meta: (t.resolvedGames || 0) > 0 ? 'Resolved games only' : 'Waiting for a result' },
                    { label: 'Avg Turns', value: t.avgTurnCount || '-', meta: (t.resolvedGames || 0) > 0 ? 'Across finished games' : '' },
                    { label: 'Avg Duration', value: fmtDur(t.avgDurationMs), meta: (t.resolvedGames || 0) > 0 ? 'Finished games only' : '' }
                ];
                document.getElementById('histTotals').innerHTML = items.map(item =>
                    '<div class="rounded-[1.6rem] border border-white/10 bg-slate-950/70 px-5 py-4">' +
                    '<div class="text-[9px] font-black uppercase tracking-[0.35em] text-slate-600">' + item.label + '</div>' +
                    '<div class="mt-2 display-face text-4xl font-black text-white tabular-nums">' + item.value + '</div>' +
                    '<div class="mt-2 text-[9px] font-bold uppercase tracking-[0.2em] text-slate-500">' + (item.meta || '&nbsp;') + '</div></div>'
                ).join('');
            }

            function renderPlayDraw(pd) {
                if (!pd) return;
                const buckets = [
                    ['On Play', pd.onPlay],
                    ['On Draw', pd.onDraw],
                    ['Unknown', pd.unknown]
                ];
                document.getElementById('histPlayDraw').innerHTML = buckets.map(([label, b]) =>
                    '<div class="rounded-[1.4rem] border border-white/8 bg-slate-950/70 px-4 py-4">' +
                    '<div class="text-[9px] font-black uppercase tracking-[0.3em] text-slate-500">' + label + '</div>' +
                    '<div class="mt-2 text-2xl font-black text-white">' + (b.games || 0) + ' games</div>' +
                    '<div class="mt-1 text-sm font-bold text-slate-400">' + (b.wins || 0) + 'W / ' + (b.losses || 0) + 'L</div>' +
                    '<div class="mt-1 text-lg font-black text-orange-200">' + fmtPct(b.winRate) + '</div></div>'
                ).join('');
            }

            function renderMulligans(m) {
                if (!m) return;
                let html = '<div class="grid grid-cols-3 gap-3">' +
                    '<div class="rounded-[1.4rem] border border-white/8 bg-slate-950/70 px-4 py-4"><div class="text-[9px] font-black uppercase tracking-[0.3em] text-slate-500">Avg Mulligans</div><div class="mt-2 text-2xl font-black text-white">' + (m.average || 0) + '</div></div>' +
                    '<div class="rounded-[1.4rem] border border-white/8 bg-slate-950/70 px-4 py-4"><div class="text-[9px] font-black uppercase tracking-[0.3em] text-slate-500">Keep Rate</div><div class="mt-2 text-2xl font-black text-emerald-200">' + fmtPct(m.zeroMulliganRate) + '</div></div>' +
                    '<div class="rounded-[1.4rem] border border-white/8 bg-slate-950/70 px-4 py-4"><div class="text-[9px] font-black uppercase tracking-[0.3em] text-slate-500">Avg Hand Size</div><div class="mt-2 text-2xl font-black text-white">' + (m.openingHandAverage || '-') + '</div></div></div>';
                if (m.byCount && m.byCount.length) {
                    html += '<div class="mt-3 space-y-2">' + m.byCount.map(b =>
                        '<div class="flex items-center justify-between rounded-[1rem] border border-white/6 bg-slate-950/60 px-4 py-3">' +
                        '<div class="text-sm font-black text-white">' + (b.mulliganCount === 0 ? 'Kept (0 mulls)' : b.mulliganCount + ' mulligan' + (b.mulliganCount > 1 ? 's' : '')) + '</div>' +
                        '<div class="flex gap-4 text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">' +
                        '<span>' + b.games + ' games</span><span>' + b.wins + 'W / ' + b.losses + 'L</span>' +
                        '<span class="text-orange-200">' + fmtPct(b.winRate) + '</span></div></div>'
                    ).join('') + '</div>';
                }
                document.getElementById('histMulligans').innerHTML = html;
            }

            function renderDecks(decks) {
                if (!decks || !decks.length) {
                    document.getElementById('histDecks').innerHTML = '<div class="text-center text-sm text-slate-500 py-8">No deck data yet</div>';
                    return;
                }
                document.getElementById('histDecks').innerHTML = decks.map(d =>
                    '<div class="rounded-[1.6rem] border border-white/8 bg-slate-950/70 px-5 py-5">' +
                    '<div class="text-[10px] font-black uppercase tracking-[0.35em] text-slate-500">' + escapeHtml(d.format || 'Unknown') + '</div>' +
                    '<div class="mt-2 text-lg font-black text-white">' + escapeHtml(d.deckName || 'Unknown Deck') + '</div>' +
                    '<div class="mt-3 grid grid-cols-3 gap-2">' +
                    '<div class="text-center"><div class="text-[9px] font-black uppercase tracking-[0.2em] text-slate-600">Games</div><div class="text-xl font-black text-white">' + d.games + '</div></div>' +
                    '<div class="text-center"><div class="text-[9px] font-black uppercase tracking-[0.2em] text-slate-600">Record</div><div class="text-xl font-black text-white">' + d.wins + '-' + d.losses + '</div></div>' +
                    '<div class="text-center"><div class="text-[9px] font-black uppercase tracking-[0.2em] text-slate-600">Win Rate</div><div class="text-xl font-black text-orange-200">' + fmtPct(d.winRate) + '</div></div>' +
                    '</div>' +
                    '<div class="mt-3 text-[9px] font-bold uppercase tracking-[0.2em] text-slate-500">' + ((d.unresolvedGames || 0) > 0 ? d.unresolvedGames + ' unresolved game' + (d.unresolvedGames > 1 ? 's' : '') : (d.resolvedGames || 0) + ' resolved') + '</div>' +
                    '<div class="mt-3 text-[9px] font-bold uppercase tracking-[0.2em] text-slate-600">' + (d.lastPlayedAt ? fmtDate(d.lastPlayedAt) : '') + '</div></div>'
                ).join('');
            }

            function syncDeckFilterOptions(decks, selectedDeck) {
                const sel = document.getElementById('histDeckFilter');
                const uniqueDecks = [...new Set((decks || []).map(d => d.deckName).filter(Boolean))];
                sel.innerHTML = '<option value="">All Decks</option>' + uniqueDecks.map(deck =>
                    '<option value="' + escapeHtml(deck) + '">' + escapeHtml(deck) + '</option>'
                ).join('');
                sel.value = uniqueDecks.includes(selectedDeck || '') ? selectedDeck : '';
            }

            function renderCardList(containerId, cards) {
                const el = document.getElementById(containerId);
                if (!cards || !cards.length) {
                    el.innerHTML = '<div class="text-center text-sm text-slate-500 py-6">No data yet</div>';
                    return;
                }
                el.innerHTML = cards.slice(0, 20).map(c =>
                    '<div class="flex items-center justify-between rounded-[1rem] border border-white/6 bg-slate-950/60 px-4 py-3">' +
                    '<div class="min-w-0 flex-1"><div class="truncate text-sm font-black text-white">' + escapeHtml(c.name) + '</div>' +
                    '<div class="mt-1 text-[9px] font-bold uppercase tracking-[0.2em] text-slate-500">' + (c.typeLine || '') + '</div></div>' +
                    '<div class="flex gap-4 text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 text-right">' +
                    '<span>' + c.games + ' games</span>' +
                    '<span>' + fmtPct(c.openingRate || c.rate || 0) + '</span>' +
                    '<span class="text-orange-200">' + fmtPct(c.winRateWhenOpened || c.winRateWhenSeen || 0) + ' WR</span></div></div>'
                ).join('');
            }

            function renderRecentGames(games) {
                const el = document.getElementById('histRecentGames');
                if (!games || !games.length) {
                    el.innerHTML = '<div class="col-span-full text-center text-sm text-slate-500 py-8">No games recorded yet. Play a match and finish it to see history here.</div>';
                    return;
                }
                el.innerHTML = games.slice(0, 18).map(g =>
                    '<div class="rounded-[1.4rem] border border-white/6 bg-slate-950/65 px-5 py-4">' +
                    '<div class="flex items-center justify-between gap-3">' +
                    '<span class="rounded-full border px-3 py-1 text-[8px] font-black uppercase tracking-[0.28em] ' + resultTone(g.resultCode) + '">' + escapeHtml(g.resultCode || 'unknown') + '</span>' +
                    '<span class="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">Game ' + (g.gameNumber || '-') + '</span></div>' +
                    '<div class="mt-2 text-sm font-black text-white">' + escapeHtml(g.deckName || 'Unknown') + '</div>' +
                    '<div class="mt-1 text-[9px] font-bold uppercase tracking-[0.2em] text-slate-500">' + escapeHtml(g.format || '') + ' · ' + (g.turnCount || '-') + ' turns · ' + fmtDur(g.durationMs) + '</div>' +
                    '<div class="mt-2 flex gap-3 text-[9px] font-black uppercase tracking-[0.2em] text-slate-400">' +
                    '<span>' + (g.onPlay === true ? 'Play' : g.onPlay === false ? 'Draw' : '?') + '</span>' +
                    '<span>Mulls: ' + (g.mulliganCount ?? '-') + '</span>' +
                    '<span>' + (g.finalBoard ? g.finalBoard.life.me + ' - ' + g.finalBoard.life.opp + ' life' : '') + '</span></div>' +
                    '<div class="mt-2 text-[9px] font-bold text-slate-600">' + fmtDate(g.endAt || g.startAt) + '</div></div>'
                ).join('');
            }

            function renderRuns(runs) {
                const el = document.getElementById('histRuns');
                if (!runs || !runs.length) {
                    el.innerHTML = '<div class="col-span-full text-center text-sm text-slate-500 py-8">No tracker runs recorded yet</div>';
                    return;
                }

                el.innerHTML = runs.map(run => {
                    const durationMs = run.ended_at && run.started_at ? Math.max(run.ended_at - run.started_at, 0) : null;
                    const offsetDelta = Math.max((run.final_log_offset || 0) - (run.initial_log_offset || 0), 0);
                    return '<div class="rounded-[1.4rem] border border-white/6 bg-slate-950/65 px-5 py-4">' +
                        '<div class="flex items-center justify-between gap-3">' +
                        '<span class="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[8px] font-black uppercase tracking-[0.28em] text-slate-300">' + escapeHtml(run.boot_source || 'unknown') + '</span>' +
                        '<span class="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">' + fmtDate(run.started_at) + '</span></div>' +
                        '<div class="mt-3 grid grid-cols-2 gap-3 text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">' +
                        '<div><div class="text-slate-600">Duration</div><div class="mt-1 text-sm text-white">' + (durationMs ? fmtDur(durationMs) : 'Running') + '</div></div>' +
                        '<div><div class="text-slate-600">Processed</div><div class="mt-1 text-sm text-white">' + fmtBytes(run.processed_bytes || offsetDelta) + '</div></div>' +
                        '<div><div class="text-slate-600">Start Offset</div><div class="mt-1 text-sm text-white">' + Number(run.initial_log_offset || 0).toLocaleString() + '</div></div>' +
                        '<div><div class="text-slate-600">Final Offset</div><div class="mt-1 text-sm text-white">' + Number(run.final_log_offset || 0).toLocaleString() + '</div></div>' +
                        '</div></div>';
                }).join('');
            }

            function loadRuns() {
                fetch('/api/history/runs?limit=9')
                    .then(r => r.json())
                    .then(data => renderRuns(data || []))
                    .catch(err => {
                        console.error('Run history load failed:', err);
                        document.getElementById('histRuns').innerHTML = '<div class="col-span-full text-center text-sm text-red-400 py-6">Failed to load tracker runs</div>';
                    });
            }

            function loadHistory(deckName) {
                const qs = deckName ? '?deck=' + encodeURIComponent(deckName) : '';
                fetch('/api/history/summary' + qs)
                    .then(r => r.json())
                    .then(data => {
                        if (deckName && !(data.decks || []).some(d => d.deckName === deckName) && !(data.recentGames || []).length) {
                            syncDeckFilterOptions(data.decks || [], null);
                            loadHistory(null);
                            return;
                        }

                        renderTotals(data.totals || {});
                        renderPlayDraw(data.playDraw);
                        renderMulligans(data.mulligans);
                        renderDecks(data.decks || []);
                        renderCardList('histOpeningHands', data.openingHands || []);
                        renderCardList('histCardsSeen', data.cardsSeen || []);
                        renderRecentGames(data.recentGames || []);
                        syncDeckFilterOptions(data.decks || [], deckName);
                    })
                    .catch(err => {
                        console.error('History load failed:', err);
                        document.getElementById('histTotals').innerHTML = '<div class="col-span-full text-center text-red-400 py-6">Failed to load history</div>';
                    });
            }

            document.getElementById('histDeckFilter').addEventListener('change', e => loadHistory(e.target.value || null));
            document.getElementById('histRefresh').addEventListener('click', () => {
                loadHistory(document.getElementById('histDeckFilter').value || null);
                loadRuns();
            });
            loadHistory(null);
            loadRuns();
        } else {
            const collectionEl = document.getElementById('collection');
            const summaryEl = document.getElementById('collectionSummary');
            const countEl = document.getElementById('collectionCount');
            const hintEl = document.getElementById('collectionHint');
            const emptyEl = document.getElementById('collectionEmpty');
            const searchEl = document.getElementById('collectionSearch');
            const sortEl = document.getElementById('collectionSort');
            const formatEl = document.getElementById('collectionFormat');
            const exportCsvEl = document.getElementById('exportCsv');
            const exportJsonEl = document.getElementById('exportJson');
            const exportLlmEl = document.getElementById('exportLlm');
            const importCsvEl = document.getElementById('importCsv');
            const highlightFormats = ['standard', 'alchemy', 'historic', 'timeless', 'brawl', 'commander'];
            const rarityRank = { mythic: 4, rare: 3, uncommon: 2, common: 1 };
            const rarityTone = {
                common: 'border-slate-700 bg-slate-900/80 text-slate-300',
                uncommon: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200',
                rare: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
                mythic: 'border-orange-500/35 bg-orange-500/10 text-orange-100'
            };
            let allCards = [];
            let visibleCards = [];
            const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, char => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            }[char]));
            const formatLabel = format => format[0].toUpperCase() + format.slice(1);
            const isBasicLand = card => /\\bBasic Land\\b/i.test(String(card.type || ''));

            function csvEscape(value) {
                const text = String(value ?? '');
                return /[",\\r\\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
            }

            function updateExportButtons() {
                const disabled = !visibleCards.length;
                exportCsvEl.disabled = disabled;
                exportJsonEl.disabled = disabled;
                exportLlmEl.disabled = disabled;
                exportCsvEl.classList.toggle('opacity-40', disabled);
                exportJsonEl.classList.toggle('opacity-40', disabled);
                exportLlmEl.classList.toggle('opacity-40', disabled);
            }

            function downloadFile(filename, content, mimeType) {
                const blob = new Blob([content], { type: mimeType });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                link.remove();
                URL.revokeObjectURL(url);
            }

            function exportVisibleAsJson() {
                downloadFile('mtga-collection-filtered.json', JSON.stringify(visibleCards, null, 2), 'application/json');
            }

            function exportVisibleAsCsv() {
                const headers = ['grpId', 'name', 'quantity', 'set', 'rarity', 'type', 'legalFormats'];
                const rows = visibleCards.map(card => [
                    card.grpId,
                    card.name,
                    card.quantity,
                    card.set,
                    card.rarity,
                    card.type,
                    highlightFormats.filter(format => card.legalities && card.legalities[format] === 'legal').join('|')
                ]);
                const csv = [headers.join(','), ...rows.map(row => row.map(csvEscape).join(','))].join('\\r\\n');
                downloadFile('mtga-collection-filtered.csv', csv, 'text/csv;charset=utf-8');
            }

            function updateSummary(cards) {
                const totalCopies = cards.reduce((sum, card) => sum + (card.quantity || 0), 0);
                const standardLegal = cards.filter(card => card.legalities && card.legalities.standard === 'legal').length;
                const setCount = new Set(cards.map(card => card.set).filter(Boolean)).size;
                const items = [
                    ['Unique', cards.length],
                    ['Copies', totalCopies],
                    ['Sets', setCount],
                    ['Standard', standardLegal]
                ];

                const statAccents = ['text-orange-300', 'text-sky-300', 'text-purple-300', 'text-emerald-300'];
                summaryEl.innerHTML = items.map(([label, value], i) => \`
                    <div class="rounded-[1.8rem] border border-white/8 px-5 py-5 text-center" style="background: rgba(8,12,24,0.75); backdrop-filter: blur(12px);">
                        <div class="text-[8px] font-black uppercase tracking-[0.5em] text-slate-600 mb-2">\${label}</div>
                        <div class="display-face text-4xl font-black tabular-nums \${statAccents[i] || 'text-white'}">\${value.toLocaleString()}</div>
                    </div>
                \`).join('');
            }

            const rarityStyles = {
                mythic:   { shadow: '0 0 0 1px rgba(249,115,22,0.75), 0 0 22px rgba(249,115,22,0.38), 0 0 48px rgba(249,115,22,0.14)', ring: 'rgba(249,115,22,0.75)', qty: 'border-orange-500/50 bg-orange-950/80 text-orange-300' },
                rare:     { shadow: '0 0 0 1px rgba(251,191,36,0.65), 0 0 18px rgba(251,191,36,0.32), 0 0 40px rgba(251,191,36,0.11)', ring: 'rgba(251,191,36,0.65)', qty: 'border-amber-500/50 bg-amber-950/80 text-amber-300' },
                uncommon: { shadow: '0 0 0 1px rgba(56,189,248,0.55), 0 0 14px rgba(56,189,248,0.24), 0 0 32px rgba(56,189,248,0.08)', ring: 'rgba(56,189,248,0.55)', qty: 'border-sky-500/50 bg-sky-950/80 text-sky-300' },
                common:   { shadow: '0 0 0 1px rgba(100,116,139,0.45)', ring: 'rgba(100,116,139,0.45)', qty: 'border-slate-600/50 bg-slate-900/80 text-slate-300' }
            };

            function renderCards(cards, sourceCount) {
                const query = searchEl.value.trim();
                const format = formatEl.value;
                visibleCards = cards;
                updateExportButtons();

                countEl.textContent = \`\${cards.length} of \${sourceCount} cards visible\`;
                hintEl.textContent = query
                    ? \`Search: "\${query}"\`
                    : format === 'all'
                        ? 'Showing all cards · basic lands excluded'
                        : \`Filtered to \${formatLabel(format)} legal cards\`;

                if (!cards.length) {
                    collectionEl.innerHTML = '';
                    emptyEl.classList.remove('hidden');
                    return;
                }

                emptyEl.classList.add('hidden');
                collectionEl.innerHTML = cards.map(card => {
                    const finalImageUrl = card.localImage || card.imageUrl;
                    const rs = rarityStyles[card.rarity] || rarityStyles.common;

                    const artContent = finalImageUrl
                        ? \`<img src="\${escapeHtml(finalImageUrl)}" alt="\${escapeHtml(card.name)}" class="absolute inset-0 w-full h-full object-cover" loading="lazy" style="border-radius: 4.5%;" />\`
                        : \`<div class="absolute inset-0 flex flex-col items-center justify-center p-3 text-center" style="border-radius:4.5%; background: linear-gradient(160deg, #0a0f1e 0%, #120920 100%);">
                               <div class="text-[8px] font-black uppercase tracking-[0.4em] text-slate-500 mb-2">\${escapeHtml(card.set || '')}</div>
                               <div class="text-[11px] font-black text-white leading-tight">\${escapeHtml(card.name)}</div>
                               <div class="mt-2 text-[8px] text-slate-500 uppercase tracking-wider leading-tight">\${escapeHtml((card.type || '').split('—')[0].trim())}</div>
                           </div>\`;

                    return \`
                        <article class="group relative cursor-pointer select-none" style="perspective: 900px;">
                            <div class="relative w-full" style="aspect-ratio: 63/88; transition: transform 0.28s cubic-bezier(0.16,1,0.3,1);"
                                 onmouseenter="this.style.transform='translateY(-10px) scale(1.06)'; this.style.zIndex='20';"
                                 onmouseleave="this.style.transform=''; this.style.zIndex='';">
                                <div class="absolute inset-0 overflow-hidden" style="border-radius: 4.5%; box-shadow: \${rs.shadow}; transition: box-shadow 0.28s ease;">
                                    \${artContent}
                                    <!-- rarity top shimmer -->
                                    <div class="absolute inset-x-0 top-0 h-10 pointer-events-none" style="background: linear-gradient(to bottom, \${rs.ring.replace(')', ', 0.18)').replace('rgba', 'rgba')} 0%, transparent 100%);"></div>
                                    <!-- set badge -->
                                    <div class="absolute top-2 right-2 z-10">
                                        <span class="text-[7px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded" style="background: rgba(0,0,0,0.72); border: 1px solid rgba(255,255,255,0.1); color: rgba(148,163,184,0.9); backdrop-filter: blur(4px);">\${escapeHtml(card.set || '')}</span>
                                    </div>
                                    <!-- quantity badge -->
                                    <div class="absolute bottom-2 left-2 z-10">
                                        <span class="border \${rs.qty} text-[10px] font-black px-2 py-0.5 rounded-full tabular-nums" style="backdrop-filter: blur(6px); box-shadow: 0 2px 8px rgba(0,0,0,0.6);">×\${card.quantity || 0}</span>
                                    </div>
                                </div>
                            </div>
                        </article>
                    \`;
                }).join('');
            }

            function applyFilters(cards) {
                const query = searchEl.value.trim().toLowerCase();
                const format = formatEl.value;
                const sort = sortEl.value;

                const filtered = cards
                    .filter(card => {
                        if (isBasicLand(card)) return false;
                        const haystack = [card.name, card.set, card.type, card.rarity].filter(Boolean).join(' ').toLowerCase();
                        const matchesQuery = !query || haystack.includes(query);
                        const matchesFormat = format === 'all' || (card.legalities && card.legalities[format] === 'legal');
                        return matchesQuery && matchesFormat;
                    })
                    .sort((left, right) => {
                        if (sort === 'llm') {
                            const getBroadType = (type) => {
                                const t = String(type).toLowerCase();
                                if (t.includes('planeswalker')) return 1;
                                if (t.includes('creature')) return 2;
                                if (t.includes('instant') || t.includes('sorcery') || t.includes('enchantment') || t.includes('artifact')) return 3;
                                if (t.includes('land')) return 4;
                                return 5;
                            };
                            return (getBroadType(left.type) - getBroadType(right.type)) || 
                                   ((rarityRank[right.rarity] || 0) - (rarityRank[left.rarity] || 0)) || 
                                   ((left.name || '').localeCompare(right.name || ''));
                        }
                        if (sort === 'name') return (left.name || '').localeCompare(right.name || '') || (right.quantity || 0) - (left.quantity || 0);
                        if (sort === 'set') return (left.set || '').localeCompare(right.set || '') || (left.name || '').localeCompare(right.name || '');
                        if (sort === 'rarity') return (rarityRank[right.rarity] || 0) - (rarityRank[left.rarity] || 0) || (right.quantity || 0) - (left.quantity || 0) || (left.name || '').localeCompare(right.name || '');
                        return (right.quantity || 0) - (left.quantity || 0) || (left.name || '').localeCompare(right.name || '');
                    });

                renderCards(filtered, cards.length);
            }

            function exportVisibleForAI() {
                const params = new URLSearchParams();
                const query = searchEl.value.trim();
                const format = formatEl.value;
                if (query) params.set('q', query);
                if (format && format !== 'all') params.set('format', format);
                params.set('maxCards', '96');

                fetch('/api/collection/llm-context?' + params.toString())
                    .then(response => response.json())
                    .then(({ text }) => {
                        return fetch('/api/sync-llm', { method: 'POST', body: text }).then(() => text);
                    })
                    .then((text) => {
                        const oldText = exportLlmEl.innerText;
                        exportLlmEl.innerText = "Synced to Workspace!";
                        setTimeout(() => exportLlmEl.innerText = oldText, 2000);
                        downloadFile('mtg-ai-deck-context.txt', text, 'text/plain;charset=utf-8');
                    })
                    .catch(console.error);
            }

            importCsvEl.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (event) => {
                    const text = event.target.result;
                    const lines = text.split(/\\r?\\n/).filter(l => l.trim());
                    if (lines.length < 2) return;
                    const headers = lines[0].split(',').map(h => h.trim());
                    const parsedCards = [];
                    for (let i = 1; i < lines.length; i++) {
                        const line = lines[i];
                        const values = [];
                        let cur = '';
                        let inQuotes = false;
                        for (let j = 0; j < line.length; j++) {
                            const char = line[j];
                            if (char === '"') {
                                if (inQuotes && line[j+1] === '"') {
                                    cur += '"';
                                    j++;
                                } else {
                                    inQuotes = !inQuotes;
                                }
                            } else if (char === ',' && !inQuotes) {
                                values.push(cur);
                                cur = '';
                            } else {
                                cur += char;
                            }
                        }
                        values.push(cur);
                        
                        const obj = {};
                        headers.forEach((h, idx) => {
                            let val = values[idx] !== undefined ? values[idx] : '';
                            if (h === 'quantity') obj[h] = parseInt(val, 10) || 0;
                            else if (h === 'legalFormats') {
                                obj.legalities = {};
                                if (val) val.split('|').forEach(f => obj.legalities[f] = 'legal');
                            } else {
                                obj[h] = val;
                            }
                        });
                        parsedCards.push(obj);
                    }
                    allCards = parsedCards.filter(card => !isBasicLand(card));
                    updateSummary(allCards);
                    updateExportButtons();
                    applyFilters(allCards);
                };
                reader.readAsText(file);
            });

            exportCsvEl.addEventListener('click', exportVisibleAsCsv);
            exportJsonEl.addEventListener('click', exportVisibleAsJson);
            exportLlmEl.addEventListener('click', exportVisibleForAI);

            let imageRefreshTimer = null;

            function loadCollection() {
                return fetch('/api/collection')
                    .then(response => response.json())
                    .then(cards => {
                        allCards = cards.filter(card => !isBasicLand(card));
                        updateSummary(allCards);
                        updateExportButtons();
                        applyFilters(allCards);

                        // If some cards are still missing images, poll until they arrive
                        const missingImages = allCards.filter(c => !c.localImage && !c.imageUrl).length;
                        if (missingImages > 0) {
                            clearTimeout(imageRefreshTimer);
                            imageRefreshTimer = setTimeout(() => {
                                fetch('/api/collection')
                                    .then(r => r.json())
                                    .then(fresh => {
                                        const updated = fresh.filter(card => !isBasicLand(card));
                                        const gained = updated.filter(c => c.localImage || c.imageUrl).length -
                                                        allCards.filter(c => c.localImage || c.imageUrl).length;
                                        if (gained > 0) {
                                            allCards = updated;
                                            applyFilters(allCards);
                                        }
                                        // Keep polling if still missing
                                        const stillMissing = updated.filter(c => !c.localImage && !c.imageUrl).length;
                                        if (stillMissing > 0) {
                                            imageRefreshTimer = setTimeout(() => loadCollection(), 6000);
                                        }
                                    })
                                    .catch(() => {});
                            }, 4000);
                        }
                    })
                    .catch(error => {
                        console.error(error);
                        countEl.textContent = 'Collection failed to load';
                        hintEl.textContent = 'Collection data is missing or unreadable';
                        emptyEl.classList.remove('hidden');
                        emptyEl.innerHTML = '<div class="text-[10px] font-black uppercase tracking-[0.45em] text-red-400">Load Error</div><div class="mt-4 text-2xl font-black uppercase tracking-tight text-white">Could not read collection data</div><p class="mt-3 text-sm text-slate-400">Import a collection export or rebuild the local tracker data, then reload the page.</p>';
                    });
            }

            loadCollection();
            searchEl.addEventListener('input', () => applyFilters(allCards));
            sortEl.addEventListener('change', () => applyFilters(allCards));
            formatEl.addEventListener('change', () => applyFilters(allCards));
        }
    </script>
</body>
</html>
    `, { headers: { "Content-Type": "text/html" } });
    }
});

console.log(`Tracker Pro Active: http://localhost:${SERVER_PORT}`);
