import dayjs from 'dayjs';

import {
    AcceptanceRecordData,
    AcceptanceRecordsQuery,
    getAcceptanceRecord,
    getAcceptanceRecords,
    listSessionFrames,
} from './acceptance-api';
import { buildAcceptanceDiff } from './acceptance-diff';

function csvCell(value: unknown): string {
    if (value == null) return '';
    const text = String(value);
    if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function downloadCsv(filename: string, header: string[], rows: Array<Array<unknown>>): void {
    const lines = [
        header.join(','),
        ...rows.map((row) => row.map(csvCell).join(',')),
    ];
    // BOM so Excel opens UTF-8 correctly (Chinese task names).
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

async function mapPool<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

export async function fetchAllAcceptanceRecords(
    query: AcceptanceRecordsQuery,
): Promise<AcceptanceRecordData[]> {
    const pageSize = 100;
    let page = 1;
    let total = Infinity;
    const all: AcceptanceRecordData[] = [];

    while (all.length < total) {
        const batch = await getAcceptanceRecords({
            ...query,
            page,
            pageSize,
            session: undefined,
        });
        total = batch.count;
        all.push(...batch.results);
        if (!batch.results.length || all.length >= total) break;
        page += 1;
        if (page > 500) break;
    }

    return all;
}

function snapshotPair(record: AcceptanceRecordData): { before: any; after: any } {
    const snaps = record.snapshots || [];
    const before = snaps.find((s) => s.snapshot_type === 'before')?.data ?? null;
    const after = snaps.find((s) => s.snapshot_type === 'after')?.data ?? null;
    return { before, after };
}

export interface CorrectionExportResult {
    sessions: number;
    objectChanges: number;
}

/**
 * Export matching correction sessions for work quantification.
 * Downloads two CSVs: session summary + object-level change rows.
 */
export async function exportCorrectionSessionsCsv(
    query: AcceptanceRecordsQuery,
    options?: {
        taskNameById?: Map<number, string>;
        onProgress?: (done: number, total: number) => void;
    },
): Promise<CorrectionExportResult> {
    const list = await fetchAllAcceptanceRecords(query);
    if (!list.length) {
        throw new Error('No correction sessions to export');
    }

    options?.onProgress?.(0, list.length);

    const details = await mapPool(list, 4, async (row, index) => {
        let full = row;
        if (row.has_before_snapshot || row.has_after_snapshot || !row.snapshots?.length) {
            try {
                full = await getAcceptanceRecord(row.id);
            } catch {
                full = row;
            }
        }
        options?.onProgress?.(index + 1, list.length);
        return full;
    });

    const stamp = dayjs().format('YYYYMMDD-HHmm');
    const sessionHeader = [
        'session_id',
        'task_id',
        'task_name',
        'job_id',
        'project_id',
        'reviewer',
        'created_date',
        'updated_date',
        'frame_count',
        'frames',
        'action_type',
        'status',
        'summary',
        'objects_added',
        'objects_removed',
        'objects_modified',
        'shapes_before',
        'shapes_after',
        'shapes_delta',
        'tags_before',
        'tags_after',
        'tags_delta',
        'tracks_before',
        'tracks_after',
        'tracks_delta',
    ];

    const objectHeader = [
        'session_id',
        'task_id',
        'task_name',
        'job_id',
        'frame',
        'change_kind',
        'object_type',
        'label',
        'summary',
        'reviewer',
        'created_date',
    ];

    const sessionRows: Array<Array<unknown>> = [];
    const objectRows: Array<Array<unknown>> = [];

    for (const record of details) {
        const taskName = (
            (record.task_name || '').trim()
            || options?.taskNameById?.get(record.task_id)
            || `Task #${record.task_id}`
        );
        const { before, after } = snapshotPair(record);
        const diff = buildAcceptanceDiff(before, after);
        const frames = listSessionFrames(before).length
            ? listSessionFrames(before)
            : (record.frames?.length ? record.frames : [record.frame]);
        const frameCount = record.frame_count || frames.length || 1;
        const shapesDelta = record.shape_count_after - record.shape_count_before;
        const tagsDelta = record.tag_count_after - record.tag_count_before;
        const tracksDelta = record.track_count_after - record.track_count_before;

        sessionRows.push([
            record.id,
            record.task_id,
            taskName,
            record.job,
            record.project_id ?? '',
            record.reviewer?.username || '',
            dayjs(record.created_date).format('YYYY-MM-DD HH:mm:ss'),
            dayjs(record.updated_date).format('YYYY-MM-DD HH:mm:ss'),
            frameCount,
            frames.map((f) => `#${f}`).join(' '),
            record.action_type,
            record.status,
            (record.description || diff.headline || '').trim(),
            diff.added,
            diff.removed,
            diff.modified,
            record.shape_count_before,
            record.shape_count_after,
            shapesDelta,
            record.tag_count_before,
            record.tag_count_after,
            tagsDelta,
            record.track_count_before,
            record.track_count_after,
            tracksDelta,
        ]);

        for (const item of diff.items) {
            if (item.kind === 'unchanged') continue;
            objectRows.push([
                record.id,
                record.task_id,
                taskName,
                record.job,
                item.frame ?? '',
                item.kind,
                item.objectType,
                item.label,
                item.summary,
                record.reviewer?.username || '',
                dayjs(record.created_date).format('YYYY-MM-DD HH:mm:ss'),
            ]);
        }
    }

    downloadCsv(`correction-sessions-${stamp}.csv`, sessionHeader, sessionRows);
    if (objectRows.length) {
        downloadCsv(`correction-object-changes-${stamp}.csv`, objectHeader, objectRows);
    }

    return {
        sessions: sessionRows.length,
        objectChanges: objectRows.length,
    };
}
