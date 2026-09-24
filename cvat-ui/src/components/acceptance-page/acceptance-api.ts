import Axios from 'axios';
import { ObjectState, ObjectType } from 'cvat-core-wrapper';

const backendAPI = '/api';

export interface AcceptanceRecordData {
    id: number;
    job: number;
    task_id: number;
    task_name?: string;
    project_id: number | null;
    frame: number;
    frame_count?: number;
    frames?: number[];
    reviewer: { id: number; username: string } | null;
    action_type: string;
    description: string;
    status: string;
    shape_count_before: number;
    shape_count_after: number;
    tag_count_before: number;
    tag_count_after: number;
    track_count_before: number;
    track_count_after: number;
    snapshots?: AcceptanceSnapshotData[];
    has_before_snapshot?: boolean;
    has_after_snapshot?: boolean;
    created_date: string;
    updated_date: string;
}

export interface AcceptanceSnapshotData {
    id: number;
    snapshot_type: 'before' | 'after';
    data: SnapshotPayload | FrameAnnotationsSnapshot;
    created_date: string;
    updated_date: string;
}

export interface FrameAnnotationsSnapshot {
    version: string;
    frame: number;
    capturedAt: string;
    tags: any[];
    shapes: any[];
    tracks: any[];
    intervals: any[];
}

/** One correction session may cover multiple frames on a task/job. */
export interface SessionAnnotationsSnapshot {
    version: 'session-v1';
    primaryFrame: number;
    taskId?: number;
    jobId?: number;
    frames: Record<string, FrameAnnotationsSnapshot>;
}

export type SnapshotPayload = FrameAnnotationsSnapshot | SessionAnnotationsSnapshot;

export interface AcceptanceRecordCreateData {
    job: number;
    frame: number;
    action_type: string;
    description?: string;
    status?: string;
    shape_count_before?: number;
    shape_count_after?: number;
    tag_count_before?: number;
    tag_count_after?: number;
    track_count_before?: number;
    track_count_after?: number;
    snapshots?: Array<{
        snapshot_type: 'before' | 'after';
        data: SnapshotPayload | Record<string, unknown>;
    }>;
}

export interface AcceptanceRecordsQuery {
    page?: number;
    pageSize?: number;
    filter?: string | null;
    sort?: string | null;
    search?: string | null;
    job?: number;
    task?: number;
    project?: number;
    frame?: number;
    reviewer?: number;
    action_type?: string;
    /** Selected session id on the Corrections navigator (URL only). */
    session?: number;
}

export interface AcceptanceRecordsListResponse {
    count: number;
    results: AcceptanceRecordData[];
}

function toPlainAnnotation(state: ObjectState): any {
    const serialized = state.serialize();
    const label = serialized.label as any;
    return {
        ...serialized,
        label: undefined,
        label_id: label?.id ?? null,
        label_name: label?.name ?? null,
        objectType: state.objectType,
        elements: Array.isArray(serialized.elements)
            ? serialized.elements.map((el: any) => ({
                ...el,
                label: undefined,
                label_id: el.label?.id ?? null,
                label_name: el.label?.name ?? null,
            }))
            : undefined,
    };
}

/**
 * Build a durable BEFORE/AFTER frame snapshot from ObjectState[].
 * job.annotations.get(frame) returns ObjectState[], NOT {shapes,tags,tracks}.
 */
export async function buildFrameAnnotationsSnapshot(
    states: ObjectState[],
    frame: number,
): Promise<FrameAnnotationsSnapshot> {
    const tags: any[] = [];
    const shapes: any[] = [];
    const tracks: any[] = [];
    const intervals: any[] = [];

    for (const state of states || []) {
        let item: any;
        try {
            item = await state.export();
        } catch {
            item = toPlainAnnotation(state);
        }

        switch (state.objectType) {
            case ObjectType.TAG:
                tags.push(item);
                break;
            case ObjectType.TRACK:
                tracks.push(item);
                break;
            case ObjectType.INTERVAL:
                intervals.push(item);
                break;
            case ObjectType.SHAPE:
            default:
                shapes.push(item);
                break;
        }
    }

    return {
        version: '1.0',
        frame,
        capturedAt: new Date().toISOString(),
        tags,
        shapes,
        tracks,
        intervals,
    };
}

export function countSnapshotObjects(data: SnapshotPayload | Record<string, unknown> | null | undefined) {
    if (!data || typeof data !== 'object') {
        return { shapes: 0, tags: 0, tracks: 0 };
    }
    if ((data as SessionAnnotationsSnapshot).version === 'session-v1') {
        const frames = (data as SessionAnnotationsSnapshot).frames || {};
        return Object.values(frames).reduce(
            (acc, frame) => {
                acc.shapes += Array.isArray(frame?.shapes) ? frame.shapes.length : 0;
                acc.tags += Array.isArray(frame?.tags) ? frame.tags.length : 0;
                acc.tracks += Array.isArray(frame?.tracks) ? frame.tracks.length : 0;
                return acc;
            },
            { shapes: 0, tags: 0, tracks: 0 },
        );
    }
    const d = data as FrameAnnotationsSnapshot;
    return {
        shapes: Array.isArray(d.shapes) ? d.shapes.length : 0,
        tags: Array.isArray(d.tags) ? d.tags.length : 0,
        tracks: Array.isArray(d.tracks) ? d.tracks.length : 0,
    };
}

export function buildSessionSnapshot(
    frames: Record<number, FrameAnnotationsSnapshot>,
    primaryFrame: number,
    meta?: { taskId?: number; jobId?: number },
): SessionAnnotationsSnapshot {
    const packed: Record<string, FrameAnnotationsSnapshot> = {};
    for (const [frame, snap] of Object.entries(frames)) {
        packed[String(frame)] = snap;
    }
    return {
        version: 'session-v1',
        primaryFrame,
        taskId: meta?.taskId,
        jobId: meta?.jobId,
        frames: packed,
    };
}

export function listSessionFrames(data: any): number[] {
    if (data?.version === 'session-v1' && data.frames) {
        return Object.keys(data.frames).map((k) => parseInt(k, 10)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
    }
    if (typeof data?.frame === 'number') return [data.frame];
    return [];
}

export async function getAcceptanceRecords(
    query: AcceptanceRecordsQuery = {},
): Promise<AcceptanceRecordsListResponse> {
    const params: Record<string, unknown> = {};
    if (query.page) params.page = query.page;
    if (query.pageSize) params.page_size = query.pageSize;
    if (query.filter) params.filter = query.filter;
    if (query.sort) params.ordering = query.sort;
    if (query.search) params.search = query.search;
    if (query.job) params.job = query.job;
    if (query.task) params.job__segment__task = query.task;
    if (query.project) params.job__segment__task__project = query.project;
    if (query.frame !== undefined && query.frame !== null) params.frame = query.frame;
    if (query.reviewer) params.reviewer = query.reviewer;
    if (query.action_type) params.action_type = query.action_type;

    const response = await Axios.get(`${backendAPI}/acceptance/records`, { params });
    return {
        count: response.data.count,
        results: response.data.results,
    };
}

export async function getAcceptanceRecord(id: number): Promise<AcceptanceRecordData> {
    const response = await Axios.get(`${backendAPI}/acceptance/records/${id}`);
    return response.data;
}

export async function createAcceptanceRecord(
    data: AcceptanceRecordCreateData,
): Promise<AcceptanceRecordData> {
    const response = await Axios.post(`${backendAPI}/acceptance/records`, data);
    return response.data;
}

export async function updateAcceptanceRecord(
    id: number,
    data: Partial<AcceptanceRecordCreateData>,
): Promise<AcceptanceRecordData> {
    const response = await Axios.patch(`${backendAPI}/acceptance/records/${id}`, data);
    return response.data;
}

export async function deleteAcceptanceRecord(id: number): Promise<void> {
    await Axios.delete(`${backendAPI}/acceptance/records/${id}`);
}

export function buildJobFrameURL(
    taskId: number,
    jobId: number,
    frame: number,
    acceptanceRecordId?: number,
): string {
    let url = `/tasks/${taskId}/jobs/${jobId}?frame=${frame}`;
    if (acceptanceRecordId) {
        url += `&acceptance_record=${acceptanceRecordId}`;
    }
    return url;
}
