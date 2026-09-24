import { FrameAnnotationsSnapshot } from './acceptance-api';

export type DiffKind = 'added' | 'removed' | 'modified' | 'unchanged';

export interface DiffItem {
    kind: DiffKind;
    key: string;
    objectType: string;
    label: string;
    frame?: number;
    before?: any;
    after?: any;
    summary: string;
}

export interface AcceptanceDiffSummary {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
    framesTouched: number;
    items: DiffItem[];
    headline: string;
}

function labelOf(obj: any): string {
    return obj?.label_name
        || obj?.label?.name
        || (obj?.label_id != null ? `label#${obj.label_id}` : null)
        || (obj?.label != null && typeof obj.label !== 'object' ? String(obj.label) : null)
        || 'unknown';
}

function stableId(obj: any): string | null {
    if (obj?.serverID != null) return `server:${obj.serverID}`;
    if (obj?.id != null && typeof obj.id === 'number') return `id:${obj.id}`;
    if (obj?.id != null && /^\d+$/.test(String(obj.id))) return `id:${obj.id}`;
    return null;
}

function pointsFingerprint(obj: any): string {
    const pts = obj?.points;
    if (Array.isArray(pts)) return pts.map((n: number) => Math.round(Number(n) * 10) / 10).join(',');
    return '';
}

function softKey(obj: any, bucket: string): string {
    return `${bucket}:${labelOf(obj)}:${obj?.type || obj?.shapeType || ''}:${pointsFingerprint(obj)}`;
}

function objectKeys(obj: any, index: number, bucket: string): string[] {
    const keys: string[] = [];
    const sid = stableId(obj);
    if (sid) keys.push(sid);
    keys.push(softKey(obj, bucket));
    if (obj?.clientID != null) keys.push(`client:${obj.clientID}`);
    keys.push(`${bucket}:${labelOf(obj)}:${index}`);
    return keys;
}

function flattenBucket(
    snapshot: FrameAnnotationsSnapshot | null | undefined,
    bucket: 'shapes' | 'tags' | 'tracks' | 'intervals',
    frame?: number,
) {
    const list = (snapshot as any)?.[bucket];
    if (!Array.isArray(list)) {
        return [] as Array<{ keys: string[]; obj: any; objectType: string; frame?: number }>;
    }
    return list.map((obj: any, index: number) => ({
        keys: objectKeys(obj, index, bucket),
        obj,
        objectType: bucket.slice(0, -1),
        frame,
    }));
}

function sameGeometry(a: any, b: any): boolean {
    return pointsFingerprint(a) === pointsFingerprint(b)
        && (a?.rotation || 0) === (b?.rotation || 0)
        && Boolean(a?.occluded) === Boolean(b?.occluded)
        && Boolean(a?.outside) === Boolean(b?.outside);
}

function describeChange(before: any | undefined, after: any | undefined): string {
    if (!before && after) return `Added ${labelOf(after)}`;
    if (before && !after) return `Removed ${labelOf(before)}`;
    if (!before || !after) return 'Changed';
    const bits: string[] = [];
    if (labelOf(before) !== labelOf(after)) bits.push(`label ${labelOf(before)}→${labelOf(after)}`);
    if (!sameGeometry(before, after)) bits.push('geometry updated');
    if ((before?.attributes && JSON.stringify(before.attributes))
        !== (after?.attributes && JSON.stringify(after.attributes))) {
        bits.push('attributes updated');
    }
    return bits.length ? bits.join(', ') : 'Updated';
}

function indexSnapshot(
    snapshot: FrameAnnotationsSnapshot | null | undefined,
    frame?: number,
): Map<string, { obj: any; objectType: string; frame?: number; keys: string[] }> {
    const map = new Map<string, { obj: any; objectType: string; frame?: number; keys: string[] }>();
    const buckets = ['shapes', 'tags', 'tracks', 'intervals'] as const;
    for (const bucket of buckets) {
        for (const item of flattenBucket(snapshot, bucket, frame)) {
            const primary = item.keys[0];
            if (!map.has(primary)) {
                map.set(primary, item);
            }
        }
    }
    return map;
}

function matchKey(
    item: { keys: string[]; obj: any },
    other: Map<string, { obj: any; objectType: string; frame?: number; keys: string[] }>,
    used: Set<string>,
): string | null {
    for (const key of item.keys) {
        if (other.has(key) && !used.has(key)) return key;
    }
    const soft = softKey(item.obj, 'shape');
    for (const [k, v] of other.entries()) {
        if (used.has(k)) continue;
        if (v.keys.includes(soft) || softKey(v.obj, 'shape') === soft) {
            return k;
        }
    }
    return null;
}

function diffOneFrame(
    before: FrameAnnotationsSnapshot | null | undefined,
    after: FrameAnnotationsSnapshot | null | undefined,
    frame?: number,
): DiffItem[] {
    const beforeMap = indexSnapshot(before, frame);
    const afterMap = indexSnapshot(after, frame);
    const usedAfter = new Set<string>();
    const items: DiffItem[] = [];

    for (const [bKey, b] of beforeMap.entries()) {
        const aKey = matchKey(b, afterMap, usedAfter);
        if (aKey == null) {
            items.push({
                kind: 'removed',
                key: bKey,
                objectType: b.objectType,
                label: labelOf(b.obj),
                frame,
                before: b.obj,
                summary: describeChange(b.obj, undefined),
            });
            continue;
        }
        const a = afterMap.get(aKey)!;
        usedAfter.add(aKey);
        const changed = labelOf(b.obj) !== labelOf(a.obj)
            || !sameGeometry(b.obj, a.obj)
            || JSON.stringify(b.obj?.attributes || {}) !== JSON.stringify(a.obj?.attributes || {});
        if (changed) {
            items.push({
                kind: 'modified',
                key: aKey,
                objectType: a.objectType,
                label: labelOf(a.obj),
                frame,
                before: b.obj,
                after: a.obj,
                summary: describeChange(b.obj, a.obj),
            });
        }
    }

    for (const [aKey, a] of afterMap.entries()) {
        if (usedAfter.has(aKey)) continue;
        items.push({
            kind: 'added',
            key: aKey,
            objectType: a.objectType,
            label: labelOf(a.obj),
            frame,
            after: a.obj,
            summary: describeChange(undefined, a.obj),
        });
    }

    return items;
}

/** Normalize legacy single-frame or session-v1 snapshot into frame map. */
export function framesFromSnapshotData(data: any): Record<number, FrameAnnotationsSnapshot> {
    if (!data || typeof data !== 'object') return {};
    if (data.version === 'session-v1' && data.frames && typeof data.frames === 'object') {
        const out: Record<number, FrameAnnotationsSnapshot> = {};
        for (const [k, v] of Object.entries(data.frames)) {
            const frame = parseInt(k, 10);
            if (!Number.isNaN(frame) && v && typeof v === 'object') {
                out[frame] = v as FrameAnnotationsSnapshot;
            }
        }
        return out;
    }
    if (Array.isArray(data.shapes) || Array.isArray(data.tracks) || Array.isArray(data.tags)) {
        const frame = typeof data.frame === 'number' ? data.frame : 0;
        return { [frame]: data as FrameAnnotationsSnapshot };
    }
    return {};
}

export function frameSnapshotAt(data: any, frame: number): FrameAnnotationsSnapshot | null {
    const map = framesFromSnapshotData(data);
    if (map[frame]) return map[frame];
    const frames = Object.keys(map).map(Number).sort((a, b) => a - b);
    if (!frames.length) return null;
    return map[frames[0]] || null;
}

export function formatDiffHeadline(
    diff: Pick<AcceptanceDiffSummary, 'added' | 'removed' | 'modified' | 'framesTouched'>,
): string {
    const parts: string[] = [];
    if (diff.framesTouched > 1) parts.push(`${diff.framesTouched} frames`);
    if (diff.added) parts.push(`${diff.added} added`);
    if (diff.removed) parts.push(`${diff.removed} removed`);
    if (diff.modified) parts.push(`${diff.modified} edited`);
    if (!parts.length) return 'No object-level changes';
    return parts.join(', ');
}

export function buildAcceptanceDiff(
    before: FrameAnnotationsSnapshot | Record<string, unknown> | null | undefined,
    after: FrameAnnotationsSnapshot | Record<string, unknown> | null | undefined,
): AcceptanceDiffSummary {
    const beforeFrames = framesFromSnapshotData(before);
    const afterFrames = framesFromSnapshotData(after);
    const frameNums = Array.from(
        new Set([...Object.keys(beforeFrames), ...Object.keys(afterFrames)].map(Number)),
    ).sort((a, b) => a - b);

    const items: DiffItem[] = [];
    for (const f of frameNums) {
        items.push(...diffOneFrame(beforeFrames[f], afterFrames[f], f));
    }

    let added = 0;
    let removed = 0;
    let modified = 0;
    for (const it of items) {
        if (it.kind === 'added') added += 1;
        else if (it.kind === 'removed') removed += 1;
        else if (it.kind === 'modified') modified += 1;
    }

    const framesTouched = new Set(
        items.map((i) => i.frame).filter((x): x is number => x != null),
    ).size;

    const summary: AcceptanceDiffSummary = {
        added,
        removed,
        modified,
        unchanged: 0,
        framesTouched,
        items: items.sort(
            (x, y) => (x.frame || 0) - (y.frame || 0)
                || x.kind.localeCompare(y.kind)
                || x.label.localeCompare(y.label),
        ),
        headline: '',
    };
    summary.headline = formatDiffHeadline(summary);
    return summary;
}

export function guessActionType(diff: AcceptanceDiffSummary): string {
    if (diff.removed && !diff.added && !diff.modified) return 'delete';
    if (diff.added && !diff.removed && !diff.modified) return 'create';
    if (diff.modified && !diff.added && !diff.removed) return 'edit';
    return 'edit';
}
