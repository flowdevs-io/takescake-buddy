import { Database } from "bun:sqlite";

const HISTORY_SCHEMA_VERSION = 3;

export type CardSnapshot = {
    instanceId?: number | null;
    grpId: string | null;
    name: string;
    typeLine?: string;
    statLine?: string;
    tapped?: boolean;
};

export type CardCountRecord = {
    grpId: string;
    name: string;
    count: number;
    typeLine?: string;
    set?: string;
    rarity?: string;
};

export type TurnRecord = {
    turnNumber: number;
    activeSeatId: number | null;
    activeLabel: string;
    phase: string;
    step: string;
    yourLife: number;
    oppLife: number;
    yourHandCount: number;
    oppHandCount: number;
    yourBattlefieldCount: number;
    oppBattlefieldCount: number;
    yourGraveyardCount: number;
    oppGraveyardCount: number;
    yourExileCount: number;
    oppExileCount: number;
    libraryCount: number;
    oppLibraryCount: number;
    recordedAt: number;
};

export type GameRecord = {
    gameKey: string;
    matchId: string;
    gameNumber: number;
    deckName: string;
    format: string;
    startAt: number | null;
    endAt: number | null;
    durationMs: number | null;
    resultCode: "win" | "loss" | "unknown";
    result: string;
    resultReason: string | null;
    turnCount: number;
    onPlay: boolean | null;
    openingHandSize: number | null;
    openingHand: CardSnapshot[];
    mulliganCount: number | null;
    cardsDrawn: CardCountRecord[];
    cardsSeen: CardCountRecord[];
    finalBoard: {
        life: { me: number; opp: number };
        counts: Record<string, number>;
        zones: Record<string, CardSnapshot[]>;
    };
    eventSummary: {
        total: number;
        draws: number;
        plays: number;
        casts: number;
        zoneTransfers: number;
        timelineCount: number;
    };
    timeline: Array<Record<string, unknown>>;
    turnRecords: TurnRecord[];
    /** Human-readable plain-text game summary, generated at game end. Useful for LLM context. */
    narrative?: string;
    createdAt: number;
    updatedAt: number;
};

export type MatchRecord = {
    matchId: string;
    deckName: string;
    format: string;
    startAt: number | null;
    endAt: number | null;
    status: "complete" | "in_progress";
    gameCount: number;
    wins: number;
    losses: number;
    resultCode: "win" | "loss" | "mixed" | "unknown";
    createdAt: number;
    updatedAt: number;
    games?: GameRecord[];
};

type RawGameRow = {
    game_key: string;
    match_id: string;
    game_number: number;
    deck_name: string;
    format: string;
    start_at: number | null;
    end_at: number | null;
    duration_ms: number | null;
    result_code: "win" | "loss" | "unknown";
    result_text: string;
    result_reason: string | null;
    turn_count: number;
    on_play: number | null;
    opening_hand_size: number | null;
    mulligan_count: number | null;
    opening_hand_json: string;
    cards_drawn_json: string;
    cards_seen_json: string;
    final_board_json: string;
    event_summary_json: string;
    timeline_json: string;
    narrative_text: string | null;
    created_at: number;
    updated_at: number;
};

type RawMatchRow = {
    match_id: string;
    deck_name: string;
    format: string;
    start_at: number | null;
    end_at: number | null;
    status: "complete" | "in_progress";
    game_count: number;
    wins: number;
    losses: number;
    result_code: "win" | "loss" | "mixed" | "unknown";
    created_at: number;
    updated_at: number;
};

function parseJsonValue<T>(value: string | null | undefined, fallback: T): T {
    if (!value) return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

function toPercent(value: number, total: number) {
    if (!total) return 0;
    return Number(((value / total) * 100).toFixed(1));
}

function toAverage(values: number[]) {
    if (!values.length) return 0;
    return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
}

function hydrateGameRow(row: RawGameRow, turnRecords: TurnRecord[] = []): GameRecord {
    return {
        gameKey: row.game_key,
        matchId: row.match_id,
        gameNumber: Number(row.game_number || 0),
        deckName: row.deck_name || "Unknown Deck",
        format: row.format || "Unknown",
        startAt: row.start_at ?? null,
        endAt: row.end_at ?? null,
        durationMs: row.duration_ms ?? null,
        resultCode: row.result_code || "unknown",
        result: row.result_text || "Unknown",
        resultReason: row.result_reason || null,
        turnCount: Number(row.turn_count || 0),
        onPlay: row.on_play == null ? null : Boolean(row.on_play),
        openingHandSize: row.opening_hand_size ?? null,
        openingHand: parseJsonValue<CardSnapshot[]>(row.opening_hand_json, []),
        mulliganCount: row.mulligan_count ?? null,
        cardsDrawn: parseJsonValue<CardCountRecord[]>(row.cards_drawn_json, []),
        cardsSeen: parseJsonValue<CardCountRecord[]>(row.cards_seen_json, []),
        finalBoard: parseJsonValue<GameRecord["finalBoard"]>(row.final_board_json, {
            life: { me: 20, opp: 20 },
            counts: {},
            zones: {}
        }),
        eventSummary: parseJsonValue<GameRecord["eventSummary"]>(row.event_summary_json, {
            total: 0,
            draws: 0,
            plays: 0,
            casts: 0,
            zoneTransfers: 0,
            timelineCount: 0
        }),
        timeline: parseJsonValue<Array<Record<string, unknown>>>(row.timeline_json, []),
        turnRecords,
        narrative: row.narrative_text || undefined,
        createdAt: row.created_at || Date.now(),
        updatedAt: row.updated_at || Date.now()
    };
}

function hydrateMatchRow(row: RawMatchRow): MatchRecord {
    return {
        matchId: row.match_id,
        deckName: row.deck_name || "Unknown Deck",
        format: row.format || "Unknown",
        startAt: row.start_at ?? null,
        endAt: row.end_at ?? null,
        status: row.status || "complete",
        gameCount: Number(row.game_count || 0),
        wins: Number(row.wins || 0),
        losses: Number(row.losses || 0),
        resultCode: row.result_code || "unknown",
        createdAt: row.created_at || Date.now(),
        updatedAt: row.updated_at || Date.now()
    };
}

function buildTrackedPreview(game: GameRecord) {
    return {
        key: game.gameKey,
        matchId: game.matchId,
        gameNumber: game.gameNumber,
        label: game.gameNumber ? `Game ${game.gameNumber}` : "Game",
        deckName: game.deckName,
        format: game.format,
        status: "complete",
        result: game.result,
        startedAt: game.startAt,
        endedAt: game.endAt,
        turnNumber: game.turnCount,
        timelineCount: game.eventSummary?.timelineCount || game.timeline.length || 0,
        life: { ...(game.finalBoard?.life || { me: 20, opp: 20 }) },
        counts: { ...(game.finalBoard?.counts || {}) }
    };
}

function buildDeckAggregate(games: GameRecord[]) {
    const byDeck = new Map<string, {
        deckName: string;
        format: string;
        games: number;
        resolvedGames: number;
        unresolvedGames: number;
        wins: number;
        losses: number;
        durations: number[];
        turns: number[];
        lastPlayedAt: number | null;
    }>();

    for (const game of games) {
        const key = game.deckName || "Unknown Deck";
        if (!byDeck.has(key)) {
            byDeck.set(key, {
                deckName: key,
                format: game.format || "Unknown",
                games: 0,
                resolvedGames: 0,
                unresolvedGames: 0,
                wins: 0,
                losses: 0,
                durations: [],
                turns: [],
                lastPlayedAt: null
            });
        }

        const aggregate = byDeck.get(key)!;
        aggregate.games += 1;
        if (game.resultCode === "win" || game.resultCode === "loss") {
            aggregate.resolvedGames += 1;
        } else {
            aggregate.unresolvedGames += 1;
        }
        if (game.resultCode === "win") aggregate.wins += 1;
        if (game.resultCode === "loss") aggregate.losses += 1;
        if (game.durationMs != null) aggregate.durations.push(game.durationMs);
        if (game.turnCount) aggregate.turns.push(game.turnCount);
        const candidateLastPlayed = game.endAt ?? game.startAt ?? null;
        if (candidateLastPlayed != null && (aggregate.lastPlayedAt == null || candidateLastPlayed > aggregate.lastPlayedAt)) {
            aggregate.lastPlayedAt = candidateLastPlayed;
        }
    }

    return [...byDeck.values()]
        .map((aggregate) => ({
            deckName: aggregate.deckName,
            format: aggregate.format,
            games: aggregate.games,
            resolvedGames: aggregate.resolvedGames,
            unresolvedGames: aggregate.unresolvedGames,
            wins: aggregate.wins,
            losses: aggregate.losses,
            winRate: toPercent(aggregate.wins, aggregate.wins + aggregate.losses),
            avgDurationMs: toAverage(aggregate.durations),
            avgTurnCount: toAverage(aggregate.turns),
            lastPlayedAt: aggregate.lastPlayedAt
        }))
        .sort((left, right) => (right.lastPlayedAt || 0) - (left.lastPlayedAt || 0) || right.games - left.games);
}

function buildCardAggregate(
    games: GameRecord[],
    selectEntries: (game: GameRecord) => CardCountRecord[]
) {
    const entries = new Map<string, {
        grpId: string;
        name: string;
        typeLine?: string;
        set?: string;
        rarity?: string;
        games: number;
        wins: number;
        losses: number;
        totalCopies: number;
    }>();

    for (const game of games) {
        const perGame = new Map<string, CardCountRecord>();
        for (const entry of selectEntries(game)) {
            if (!entry?.grpId || !entry.count) continue;
            perGame.set(entry.grpId, entry);
        }

        for (const entry of perGame.values()) {
            if (!entries.has(entry.grpId)) {
                entries.set(entry.grpId, {
                    grpId: entry.grpId,
                    name: entry.name || `Card #${entry.grpId}`,
                    typeLine: entry.typeLine,
                    set: entry.set,
                    rarity: entry.rarity,
                    games: 0,
                    wins: 0,
                    losses: 0,
                    totalCopies: 0
                });
            }

            const aggregate = entries.get(entry.grpId)!;
            aggregate.games += 1;
            aggregate.totalCopies += Number(entry.count || 0);
            if (game.resultCode === "win") aggregate.wins += 1;
            if (game.resultCode === "loss") aggregate.losses += 1;
        }
    }

    return [...entries.values()]
        .map((aggregate) => ({
            ...aggregate,
            rate: toPercent(aggregate.games, games.length),
            winRateWhenSeen: toPercent(aggregate.wins, aggregate.wins + aggregate.losses),
            avgCopies: Number((aggregate.totalCopies / Math.max(aggregate.games, 1)).toFixed(2))
        }))
        .sort((left, right) => right.games - left.games || right.wins - left.wins || left.name.localeCompare(right.name));
}

function buildOpeningHandAggregate(games: GameRecord[]) {
    const entries = new Map<string, {
        grpId: string;
        name: string;
        games: number;
        wins: number;
        losses: number;
        totalCopies: number;
    }>();

    for (const game of games) {
        const counts = new Map<string, number>();
        for (const card of game.openingHand || []) {
            if (!card?.grpId) continue;
            counts.set(card.grpId, (counts.get(card.grpId) || 0) + 1);
        }

        for (const [grpId, count] of counts.entries()) {
            const name = game.openingHand.find((card) => card.grpId === grpId)?.name || `Card #${grpId}`;
            if (!entries.has(grpId)) {
                entries.set(grpId, {
                    grpId,
                    name,
                    games: 0,
                    wins: 0,
                    losses: 0,
                    totalCopies: 0
                });
            }

            const aggregate = entries.get(grpId)!;
            aggregate.games += 1;
            aggregate.totalCopies += count;
            if (game.resultCode === "win") aggregate.wins += 1;
            if (game.resultCode === "loss") aggregate.losses += 1;
        }
    }

    return [...entries.values()]
        .map((aggregate) => ({
            ...aggregate,
            openingRate: toPercent(aggregate.games, games.length),
            winRateWhenOpened: toPercent(aggregate.wins, aggregate.wins + aggregate.losses),
            avgCopies: Number((aggregate.totalCopies / Math.max(aggregate.games, 1)).toFixed(2))
        }))
        .sort((left, right) => right.games - left.games || right.wins - left.wins || left.name.localeCompare(right.name));
}

function buildPlayDrawAggregate(games: GameRecord[]) {
    const buckets = {
        onPlay: { games: 0, wins: 0, losses: 0 },
        onDraw: { games: 0, wins: 0, losses: 0 },
        unknown: { games: 0, wins: 0, losses: 0 }
    };

    for (const game of games) {
        const bucket = game.onPlay == null ? buckets.unknown : game.onPlay ? buckets.onPlay : buckets.onDraw;
        bucket.games += 1;
        if (game.resultCode === "win") bucket.wins += 1;
        if (game.resultCode === "loss") bucket.losses += 1;
    }

    return {
        onPlay: { ...buckets.onPlay, winRate: toPercent(buckets.onPlay.wins, buckets.onPlay.wins + buckets.onPlay.losses) },
        onDraw: { ...buckets.onDraw, winRate: toPercent(buckets.onDraw.wins, buckets.onDraw.wins + buckets.onDraw.losses) },
        unknown: { ...buckets.unknown, winRate: toPercent(buckets.unknown.wins, buckets.unknown.wins + buckets.unknown.losses) }
    };
}

function ensureHistorySchema(db: Database) {
    db.exec(`
        create table if not exists history_meta (
            key text primary key,
            value text not null
        );

        create table if not exists match_records (
            match_id text primary key,
            deck_name text not null,
            format text not null,
            start_at integer,
            end_at integer,
            status text not null,
            game_count integer not null default 0,
            wins integer not null default 0,
            losses integer not null default 0,
            result_code text not null default 'unknown',
            created_at integer not null,
            updated_at integer not null
        );

        create table if not exists game_records (
            game_key text primary key,
            match_id text not null,
            game_number integer not null,
            deck_name text not null,
            format text not null,
            start_at integer,
            end_at integer,
            duration_ms integer,
            result_code text not null,
            result_text text not null,
            result_reason text,
            turn_count integer not null default 0,
            on_play integer,
            opening_hand_size integer,
            mulligan_count integer,
            opening_hand_json text not null,
            cards_drawn_json text not null,
            cards_seen_json text not null,
            final_board_json text not null,
            event_summary_json text not null,
            timeline_json text not null,
            created_at integer not null,
            updated_at integer not null,
            unique (match_id, game_number)
        );

        create table if not exists turn_records (
            game_key text not null,
            turn_number integer not null,
            active_seat_id integer,
            active_label text not null,
            phase text not null,
            step text not null,
            your_life integer not null,
            opp_life integer not null,
            your_hand_count integer not null,
            opp_hand_count integer not null,
            your_battlefield_count integer not null,
            opp_battlefield_count integer not null,
            your_graveyard_count integer not null,
            opp_graveyard_count integer not null,
            your_exile_count integer not null,
            opp_exile_count integer not null,
            library_count integer not null,
            opp_library_count integer not null,
            recorded_at integer not null,
            primary key (game_key, turn_number),
            foreign key (game_key) references game_records (game_key) on delete cascade
        );

        create table if not exists app_runs (
            run_id text primary key,
            started_at integer not null,
            ended_at integer,
            boot_source text not null,
            log_path text not null,
            initial_log_offset integer not null default 0,
            final_log_offset integer not null default 0,
            processed_bytes integer not null default 0,
            created_at integer not null,
            updated_at integer not null
        );
    `);

    // --- migrations ---
    const currentVersion = Number(
        (db.query("select value from history_meta where key = 'schema_version'").get() as { value?: string } | null)?.value ?? "1"
    );

    if (currentVersion < 3) {
        // v3: add narrative_text column to game_records for LLM-readable game summaries
        try {
            db.exec("alter table game_records add column narrative_text text");
        } catch {
            // column already exists — safe to ignore
        }
    }

    db.query(`
        insert into history_meta (key, value)
        values ('schema_version', $value)
        on conflict(key) do update set value = excluded.value
    `).run({ $value: String(HISTORY_SCHEMA_VERSION) });
}

export function createHistoryStore(dbPath: string) {
    const db = new Database(dbPath);
    db.exec("pragma journal_mode = WAL;");
    db.exec("pragma foreign_keys = ON;");
    ensureHistorySchema(db);

    const persistedGameKeys = new Set<string>(
        (db.query("select game_key from game_records").all() as Array<{ game_key: string }>)
            .map((row) => row.game_key)
    );
    const selectExistingGameStatement = db.query(`
        select game_key
        from game_records
        where game_key = $gameKey
        limit 1
    `);

    const insertGameStatement = db.query(`
        insert into game_records (
            game_key, match_id, game_number, deck_name, format, start_at, end_at, duration_ms,
            result_code, result_text, result_reason, turn_count, on_play, opening_hand_size,
            mulligan_count, opening_hand_json, cards_drawn_json, cards_seen_json, final_board_json,
            event_summary_json, timeline_json, narrative_text, created_at, updated_at
        ) values (
            $gameKey, $matchId, $gameNumber, $deckName, $format, $startAt, $endAt, $durationMs,
            $resultCode, $resultText, $resultReason, $turnCount, $onPlay, $openingHandSize,
            $mulliganCount, $openingHandJson, $cardsDrawnJson, $cardsSeenJson, $finalBoardJson,
            $eventSummaryJson, $timelineJson, $narrativeText, $createdAt, $updatedAt
        )
    `);

    const deleteTurnRecordsStatement = db.query("delete from turn_records where game_key = $gameKey");
    const insertTurnRecordStatement = db.query(`
        insert into turn_records (
            game_key, turn_number, active_seat_id, active_label, phase, step,
            your_life, opp_life, your_hand_count, opp_hand_count, your_battlefield_count,
            opp_battlefield_count, your_graveyard_count, opp_graveyard_count, your_exile_count,
            opp_exile_count, library_count, opp_library_count, recorded_at
        ) values (
            $gameKey, $turnNumber, $activeSeatId, $activeLabel, $phase, $step,
            $yourLife, $oppLife, $yourHandCount, $oppHandCount, $yourBattlefieldCount,
            $oppBattlefieldCount, $yourGraveyardCount, $oppGraveyardCount, $yourExileCount,
            $oppExileCount, $libraryCount, $oppLibraryCount, $recordedAt
        )
    `);

    const upsertMatchStatement = db.query(`
        insert into match_records (
            match_id, deck_name, format, start_at, end_at, status,
            game_count, wins, losses, result_code, created_at, updated_at
        ) values (
            $matchId, $deckName, $format, $startAt, $endAt, $status,
            $gameCount, $wins, $losses, $resultCode, $createdAt, $updatedAt
        )
        on conflict(match_id) do update set
            deck_name = excluded.deck_name,
            format = excluded.format,
            start_at = excluded.start_at,
            end_at = excluded.end_at,
            status = excluded.status,
            game_count = excluded.game_count,
            wins = excluded.wins,
            losses = excluded.losses,
            result_code = excluded.result_code,
            updated_at = excluded.updated_at
    `);

    const getMetaStatement = db.query(`
        select value
        from history_meta
        where key = $key
    `);

    const upsertMetaStatement = db.query(`
        insert into history_meta (key, value)
        values ($key, $value)
        on conflict(key) do update set value = excluded.value
    `);

    const insertAppRunStatement = db.query(`
        insert into app_runs (
            run_id, started_at, ended_at, boot_source, log_path,
            initial_log_offset, final_log_offset, processed_bytes,
            created_at, updated_at
        ) values (
            $runId, $startedAt, $endedAt, $bootSource, $logPath,
            $initialLogOffset, $finalLogOffset, $processedBytes,
            $createdAt, $updatedAt
        )
    `);

    const updateAppRunStatement = db.query(`
        update app_runs
        set ended_at = coalesce($endedAt, ended_at),
            boot_source = coalesce($bootSource, boot_source),
            log_path = coalesce($logPath, log_path),
            initial_log_offset = coalesce($initialLogOffset, initial_log_offset),
            final_log_offset = coalesce($finalLogOffset, final_log_offset),
            processed_bytes = coalesce($processedBytes, processed_bytes),
            updated_at = $updatedAt
        where run_id = $runId
    `);

    const loadRecentRunsStatement = db.query(`
        select
            run_id,
            started_at,
            ended_at,
            boot_source,
            log_path,
            initial_log_offset,
            final_log_offset,
            processed_bytes,
            created_at,
            updated_at
        from app_runs
        order by started_at desc
        limit $limit
    `);

    function gameExists(gameKey: string) {
        if (!gameKey) return false;
        const row = selectExistingGameStatement.get({ $gameKey: gameKey }) as { game_key?: string } | null;
        if (row?.game_key) {
            persistedGameKeys.add(gameKey);
            return true;
        }
        persistedGameKeys.delete(gameKey);
        return false;
    }

    const persistGameTransaction = db.transaction((game: GameRecord) => {
        insertGameStatement.run({
            $gameKey: game.gameKey,
            $matchId: game.matchId,
            $gameNumber: game.gameNumber,
            $deckName: game.deckName || "Unknown Deck",
            $format: game.format || "Unknown",
            $startAt: game.startAt,
            $endAt: game.endAt,
            $durationMs: game.durationMs,
            $resultCode: game.resultCode || "unknown",
            $resultText: game.result || "Unknown",
            $resultReason: game.resultReason || null,
            $turnCount: game.turnCount || 0,
            $onPlay: game.onPlay == null ? null : Number(game.onPlay),
            $openingHandSize: game.openingHandSize,
            $mulliganCount: game.mulliganCount,
            $openingHandJson: JSON.stringify(game.openingHand || []),
            $cardsDrawnJson: JSON.stringify(game.cardsDrawn || []),
            $cardsSeenJson: JSON.stringify(game.cardsSeen || []),
            $finalBoardJson: JSON.stringify(game.finalBoard || { life: { me: 20, opp: 20 }, counts: {}, zones: {} }),
            $eventSummaryJson: JSON.stringify(game.eventSummary || { total: 0, draws: 0, plays: 0, casts: 0, zoneTransfers: 0, timelineCount: 0 }),
            $timelineJson: JSON.stringify(game.timeline || []),
            $narrativeText: game.narrative || null,
            $createdAt: game.createdAt || Date.now(),
            $updatedAt: game.updatedAt || Date.now()
        });

        deleteTurnRecordsStatement.run({ $gameKey: game.gameKey });
        for (const turn of game.turnRecords || []) {
            insertTurnRecordStatement.run({
                $gameKey: game.gameKey,
                $turnNumber: turn.turnNumber,
                $activeSeatId: turn.activeSeatId,
                $activeLabel: turn.activeLabel || "Game",
                $phase: turn.phase || "",
                $step: turn.step || "",
                $yourLife: turn.yourLife || 0,
                $oppLife: turn.oppLife || 0,
                $yourHandCount: turn.yourHandCount || 0,
                $oppHandCount: turn.oppHandCount || 0,
                $yourBattlefieldCount: turn.yourBattlefieldCount || 0,
                $oppBattlefieldCount: turn.oppBattlefieldCount || 0,
                $yourGraveyardCount: turn.yourGraveyardCount || 0,
                $oppGraveyardCount: turn.oppGraveyardCount || 0,
                $yourExileCount: turn.yourExileCount || 0,
                $oppExileCount: turn.oppExileCount || 0,
                $libraryCount: turn.libraryCount || 0,
                $oppLibraryCount: turn.oppLibraryCount || 0,
                $recordedAt: turn.recordedAt || Date.now()
            });
        }

        const rows = (db.query(`
            select deck_name, format, start_at, end_at, result_code, created_at, updated_at
            from game_records
            where match_id = $matchId
            order by game_number asc
        `).all({ $matchId: game.matchId }) as Array<{
            deck_name: string;
            format: string;
            start_at: number | null;
            end_at: number | null;
            result_code: "win" | "loss" | "unknown";
            created_at: number;
            updated_at: number;
        }>);

        const wins = rows.filter((row) => row.result_code === "win").length;
        const losses = rows.filter((row) => row.result_code === "loss").length;
        const startCandidates = rows.map((row) => row.start_at).filter((value): value is number => value != null);
        const endCandidates = rows.map((row) => row.end_at).filter((value): value is number => value != null);
        const createdCandidates = rows.map((row) => row.created_at).filter((value): value is number => value != null);
        const updatedCandidates = rows.map((row) => row.updated_at).filter((value): value is number => value != null);
        const latest = rows[rows.length - 1];
        const resultCode =
            wins && !losses
                ? "win"
                : losses && !wins
                    ? "loss"
                    : wins || losses
                        ? "mixed"
                        : "unknown";

        upsertMatchStatement.run({
            $matchId: game.matchId,
            $deckName: latest?.deck_name || game.deckName || "Unknown Deck",
            $format: latest?.format || game.format || "Unknown",
            $startAt: startCandidates.length ? Math.min(...startCandidates) : game.startAt,
            $endAt: endCandidates.length ? Math.max(...endCandidates) : game.endAt,
            $status: rows.every((row) => row.end_at != null) ? "complete" : "in_progress",
            $gameCount: rows.length,
            $wins: wins,
            $losses: losses,
            $resultCode: resultCode,
            $createdAt: createdCandidates.length ? Math.min(...createdCandidates) : (game.createdAt || Date.now()),
            $updatedAt: updatedCandidates.length ? Math.max(...updatedCandidates) : (game.updatedAt || Date.now())
        });
    });

    function loadTurnRecords(gameKeys: string[]) {
        if (!gameKeys.length) return new Map<string, TurnRecord[]>();
        const placeholders = gameKeys.map((_, index) => `?${index + 1}`).join(", ");
        const rows = db.query(`
            select
                game_key,
                turn_number,
                active_seat_id,
                active_label,
                phase,
                step,
                your_life,
                opp_life,
                your_hand_count,
                opp_hand_count,
                your_battlefield_count,
                opp_battlefield_count,
                your_graveyard_count,
                opp_graveyard_count,
                your_exile_count,
                opp_exile_count,
                library_count,
                opp_library_count,
                recorded_at
            from turn_records
            where game_key in (${placeholders})
            order by game_key asc, turn_number asc
        `).all(...gameKeys) as Array<Record<string, unknown>>;
        const recordsByGame = new Map<string, TurnRecord[]>();

        for (const row of rows) {
            const gameKey = String(row.game_key);
            if (!recordsByGame.has(gameKey)) recordsByGame.set(gameKey, []);
            recordsByGame.get(gameKey)!.push({
                turnNumber: Number(row.turn_number || 0),
                activeSeatId: row.active_seat_id == null ? null : Number(row.active_seat_id),
                activeLabel: String(row.active_label || "Game"),
                phase: String(row.phase || ""),
                step: String(row.step || ""),
                yourLife: Number(row.your_life || 0),
                oppLife: Number(row.opp_life || 0),
                yourHandCount: Number(row.your_hand_count || 0),
                oppHandCount: Number(row.opp_hand_count || 0),
                yourBattlefieldCount: Number(row.your_battlefield_count || 0),
                oppBattlefieldCount: Number(row.opp_battlefield_count || 0),
                yourGraveyardCount: Number(row.your_graveyard_count || 0),
                oppGraveyardCount: Number(row.opp_graveyard_count || 0),
                yourExileCount: Number(row.your_exile_count || 0),
                oppExileCount: Number(row.opp_exile_count || 0),
                libraryCount: Number(row.library_count || 0),
                oppLibraryCount: Number(row.opp_library_count || 0),
                recordedAt: Number(row.recorded_at || 0)
            });
        }

        return recordsByGame;
    }

    function getMetaValue(key: string) {
        const row = getMetaStatement.get({ $key: key }) as { value?: string } | null;
        return row?.value ?? null;
    }

    function setMetaValue(key: string, value: string) {
        upsertMetaStatement.run({ $key: key, $value: value });
    }

    function parseMetaJson<T>(key: string, fallback: T): T {
        return parseJsonValue<T>(getMetaValue(key), fallback);
    }

    function loadGameRecords(deckName?: string | null, limit?: number, includeTurns = false) {
        const rows = (deckName
            ? db.query(`
                select *
                from game_records
                where deck_name = $deckName
                order by coalesce(end_at, start_at, updated_at) desc
                ${limit ? "limit $limit" : ""}
            `).all(limit ? { $deckName: deckName, $limit: limit } : { $deckName: deckName })
            : db.query(`
                select *
                from game_records
                order by coalesce(end_at, start_at, updated_at) desc
                ${limit ? "limit $limit" : ""}
            `).all(limit ? { $limit: limit } : undefined)
        ) as RawGameRow[];

        const turnRecordsByGame = includeTurns ? loadTurnRecords(rows.map((row) => row.game_key)) : new Map<string, TurnRecord[]>();
        return rows.map((row) => hydrateGameRow(row, turnRecordsByGame.get(row.game_key) || []));
    }

    function loadMatchRecords(deckName?: string | null, limit?: number) {
        const rows = (deckName
            ? db.query(`
                select *
                from match_records
                where deck_name = $deckName
                order by coalesce(end_at, start_at, updated_at) desc
                ${limit ? "limit $limit" : ""}
            `).all(limit ? { $deckName: deckName, $limit: limit } : { $deckName: deckName })
            : db.query(`
                select *
                from match_records
                order by coalesce(end_at, start_at, updated_at) desc
                ${limit ? "limit $limit" : ""}
            `).all(limit ? { $limit: limit } : undefined)
        ) as RawMatchRow[];
        return rows.map(hydrateMatchRow);
    }

    const updateGameResultStatement = db.query(`
        update game_records
        set result_code = $resultCode,
            result_text = $resultText,
            result_reason = $resultReason,
            end_at = (
                case
                    when $endAt is not null and (end_at is null or end_at <> $endAt)
                    then $endAt
                    else end_at
                end
            ),
            updated_at = $updatedAt
        where game_key = $gameKey
          and (
                result_code = 'unknown'
                or ($endAt is not null and (end_at is null or end_at <> $endAt))
                or (
                    ($resultCode = 'win' or $resultCode = 'loss')
                    and (
                        result_code <> $resultCode
                        or coalesce(result_text, '') <> coalesce($resultText, '')
                        or coalesce(result_reason, '') <> coalesce($resultReason, '')
                    )
                )
            )
    `);

    const updateMatchResultStatement = db.query(`
        update match_records
        set result_code = (
            case
                when (select count(*) from game_records where match_id = $matchId and result_code = 'win') > 0
                 and (select count(*) from game_records where match_id = $matchId and result_code = 'loss') = 0
                then 'win'
                when (select count(*) from game_records where match_id = $matchId and result_code = 'loss') > 0
                 and (select count(*) from game_records where match_id = $matchId and result_code = 'win') = 0
                then 'loss'
                when (select count(*) from game_records where match_id = $matchId and result_code in ('win','loss')) > 0
                then 'mixed'
                else 'unknown'
            end
        ),
        end_at = (select max(coalesce(end_at, start_at, updated_at)) from game_records where match_id = $matchId),
        wins = (select count(*) from game_records where match_id = $matchId and result_code = 'win'),
        losses = (select count(*) from game_records where match_id = $matchId and result_code = 'loss'),
        updated_at = $updatedAt
        where match_id = $matchId
    `);

    const updateGameDeckInfoStatement = db.query(`
        update game_records
        set deck_name = $deckName,
            format = $format,
            updated_at = $updatedAt
        where game_key = $gameKey
          and (deck_name = 'Unknown Deck' or deck_name = 'Untitled Deck' or deck_name = '' or deck_name is null
               or format = 'Unknown' or format = '' or format is null)
    `);

    const updateMatchDeckInfoStatement = db.query(`
        update match_records
        set deck_name = $deckName,
            format = $format,
            updated_at = $updatedAt
        where match_id = $matchId
          and (deck_name = 'Unknown Deck' or deck_name = 'Untitled Deck' or deck_name = '' or deck_name is null
               or format = 'Unknown' or format = '' or format is null)
    `);

    return {
        getCheckpoint(logPath: string) {
            const checkpoint = parseMetaJson<{
                logPath: string;
                offset: number;
                size: number;
                updatedAt: number;
            } | null>("log_checkpoint", null);
            if (!checkpoint || checkpoint.logPath !== logPath) return null;
            return checkpoint;
        },
        saveCheckpoint(checkpoint: { logPath: string; offset: number; size: number; updatedAt?: number }) {
            setMetaValue("log_checkpoint", JSON.stringify({
                ...checkpoint,
                updatedAt: checkpoint.updatedAt || Date.now()
            }));
        },
        loadRuntimeState<T>(fallback: T): T {
            return parseMetaJson<T>("runtime_state", fallback);
        },
        saveRuntimeState(snapshot: unknown) {
            setMetaValue("runtime_state", JSON.stringify(snapshot));
        },
        clearRuntimeState() {
            setMetaValue("runtime_state", JSON.stringify(null));
        },
        startRun(details: { logPath: string; bootSource: string; initialLogOffset?: number }) {
            const now = Date.now();
            const runId = globalThis.crypto?.randomUUID?.() || `${now}-${Math.random().toString(36).slice(2)}`;
            insertAppRunStatement.run({
                $runId: runId,
                $startedAt: now,
                $endedAt: null,
                $bootSource: details.bootSource || "unknown",
                $logPath: details.logPath || "",
                $initialLogOffset: details.initialLogOffset || 0,
                $finalLogOffset: details.initialLogOffset || 0,
                $processedBytes: 0,
                $createdAt: now,
                $updatedAt: now
            });
            return runId;
        },
        updateRun(runId: string, details: {
            endedAt?: number | null;
            bootSource?: string | null;
            logPath?: string | null;
            initialLogOffset?: number | null;
            finalLogOffset?: number | null;
            processedBytes?: number | null;
        }) {
            if (!runId) return false;
            const changes = (updateAppRunStatement.run({
                $runId: runId,
                $endedAt: details.endedAt ?? null,
                $bootSource: details.bootSource ?? null,
                $logPath: details.logPath ?? null,
                $initialLogOffset: details.initialLogOffset ?? null,
                $finalLogOffset: details.finalLogOffset ?? null,
                $processedBytes: details.processedBytes ?? null,
                $updatedAt: Date.now()
            }) as { changes: number }).changes;
            return changes > 0;
        },
        loadRecentRuns(limit = 20) {
            return loadRecentRunsStatement.all({ $limit: limit }) as Array<{
                run_id: string;
                started_at: number;
                ended_at: number | null;
                boot_source: string;
                log_path: string;
                initial_log_offset: number;
                final_log_offset: number;
                processed_bytes: number;
                created_at: number;
                updated_at: number;
            }>;
        },
        hasGame(gameKey: string) {
            return gameExists(gameKey);
        },
        persistCompletedGame(game: GameRecord) {
            if (!game?.gameKey) {
                return { stored: false, duplicate: false };
            }

            if (gameExists(game.gameKey)) {
                return { stored: false, duplicate: true };
            }

            persistGameTransaction(game);
            persistedGameKeys.add(game.gameKey);

            return { stored: true, duplicate: false };
            },
            updateGameDeckInfo(gameKey: string, matchId: string | null, deckName: string, format: string) {
            if (!gameExists(gameKey)) return false;

            const now = Date.now();
            const gameChanges = (updateGameDeckInfoStatement.run({
                $gameKey: gameKey,
                $deckName: deckName,
                $format: format,
                $updatedAt: now
            }) as { changes: number }).changes;

            if (gameChanges > 0 && matchId) {
                updateMatchDeckInfoStatement.run({
                    $matchId: matchId,
                    $deckName: deckName,
                    $format: format,
                    $updatedAt: now
                });
            }

            return gameChanges > 0;
            },
            updateGameResult(gameKey: string, matchId: string | null, resultCode: string, resultText: string, resultReason: string | null, endAt: number | null = null) {
            if (!gameExists(gameKey)) return false;

            const now = Date.now();
            const changes = (updateGameResultStatement.run({
                $gameKey: gameKey,
                $resultCode: resultCode,
                $resultText: resultText,
                $resultReason: resultReason,
                $endAt: endAt,
                $updatedAt: now
            }) as { changes: number }).changes;

            if (changes > 0 && matchId) {
                updateMatchResultStatement.run({
                    $matchId: matchId,
                    $updatedAt: now
                });
            }

            return changes > 0;
            },
            loadRecentMatchPreview(limit = 12) {
            const matches = loadMatchRecords(null, limit);
            const games = loadGameRecords(undefined, undefined, false);

            return matches.map(match => ({
                matchId: match.matchId,
                deckName: match.deckName,
                format: match.format,
                startedAt: match.startAt,
                updatedAt: match.updatedAt,
                completedAt: match.endAt,
                games: games
                    .filter(game => game.matchId === match.matchId)
                    .sort((left, right) => left.gameNumber - right.gameNumber)
                    .map(buildTrackedPreview)
            }));
            },
            getHistory(options?: { deckName?: string | null, limitGames?: number, limitMatches?: number, includeTurns?: boolean }) {
            const deckName = options?.deckName || null;
            const limitGames = options?.limitGames ?? 30;
            const limitMatches = options?.limitMatches ?? 15;
            const includeTurns = Boolean(options?.includeTurns);

            const games = loadGameRecords(deckName, limitGames, includeTurns);
            const matches = loadMatchRecords(deckName, limitMatches).map(match => ({
                ...match,
                games: games
                    .filter(game => game.matchId === match.matchId)
                    .sort((left, right) => left.gameNumber - right.gameNumber)
            }));

            return { games, matches };
            },
            getHistorySummary(options?: { deckName?: string | null }) {
            const deckName = options?.deckName || null;
            const games = loadGameRecords(deckName, undefined, false);
            const matches = loadMatchRecords(deckName, undefined);

            const recentGames = games.slice(0, 20);
            const recentMatches = matches.slice(0, 12);

            const resolvedGames = games.filter(game => game.resultCode === 'win' || game.resultCode === 'loss');
            const wins = resolvedGames.filter(game => game.resultCode === 'win').length;
            const losses = resolvedGames.filter(game => game.resultCode === 'loss').length;
            const unresolvedGames = games.length - resolvedGames.length;

            const mulligans = resolvedGames.map(game => Number(game.mulliganCount ?? 0)).filter(value => Number.isFinite(value));
            const openingHandSizes = resolvedGames.map(game => Number(game.openingHandSize ?? 0)).filter(value => Number.isFinite(value) && value > 0);
            const durations = resolvedGames.map(game => Number(game.durationMs ?? 0)).filter(value => Number.isFinite(value) && value > 0);
            const turns = resolvedGames.map(game => Number(game.turnCount ?? 0)).filter(value => Number.isFinite(value) && value > 0);

            const openingHandDistribution = new Map<number, number>();
            const mulliganDistribution = new Map<number, { games: number, wins: number, losses: number }>();

            for (const game of resolvedGames) {
                const openingHandSize = Number(game.openingHandSize ?? 0);
                if (openingHandSize > 0) {
                    openingHandDistribution.set(openingHandSize, (openingHandDistribution.get(openingHandSize) || 0) + 1);
                }

                const mulliganCount = Number(game.mulliganCount ?? 0);
                if (!mulliganDistribution.has(mulliganCount)) {
                    mulliganDistribution.set(mulliganCount, { games: 0, wins: 0, losses: 0 });
                }

                const aggregate = mulliganDistribution.get(mulliganCount)!;
                aggregate.games += 1;
                if (game.resultCode === 'win') aggregate.wins += 1;
                if (game.resultCode === 'loss') aggregate.losses += 1;
            }

            return {
                filter: { deckName },
                totals: {
                    matches: matches.length,
                    completeMatches: matches.filter(match => match.status === 'complete').length,
                    inProgressMatches: matches.filter(match => match.status !== 'complete').length,
                    games: games.length,
                    resolvedGames: resolvedGames.length,
                    unresolvedGames,
                    wins,
                    losses,
                    winRate: toPercent(wins, wins + losses),
                    avgDurationMs: toAverage(durations),
                    avgTurnCount: toAverage(turns)
                },
                playDraw: buildPlayDrawAggregate(resolvedGames),
                mulligans: {
                    average: toAverage(mulligans),
                    zeroMulliganRate: toPercent(mulligans.filter(value => value === 0).length, mulligans.length),
                    openingHandAverage: toAverage(openingHandSizes),
                    openingHandDistribution: Array.from(openingHandDistribution.entries())
                        .map(([handSize, gamesCount]) => ({ handSize, games: gamesCount, rate: toPercent(gamesCount, resolvedGames.length) }))
                        .sort((left, right) => right.handSize - left.handSize),
                    byCount: Array.from(mulliganDistribution.entries())
                        .map(([mulliganCount, aggregate]) => ({
                            mulliganCount,
                            games: aggregate.games,
                            wins: aggregate.wins,
                            losses: aggregate.losses,
                            winRate: toPercent(aggregate.wins, aggregate.wins + aggregate.losses)
                        }))
                        .sort((left, right) => left.mulliganCount - right.mulliganCount)
                },
                openingHands: buildOpeningHandAggregate(resolvedGames).slice(0, 18),
                cardsDrawn: buildCardAggregate(resolvedGames, game => game.cardsDrawn).slice(0, 24),
                cardsSeen: buildCardAggregate(resolvedGames, game => game.cardsSeen).slice(0, 24),
                decks: buildDeckAggregate(games),
                recentGames,
                recentMatches
            };
            }
            };
            }

     