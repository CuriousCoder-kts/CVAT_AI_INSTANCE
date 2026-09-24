import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Button from 'antd/lib/button';
import Space from 'antd/lib/space';
import Tooltip from 'antd/lib/tooltip';
import message from 'antd/lib/message';
import {
    CheckOutlined, CloseOutlined, EyeOutlined, EyeInvisibleOutlined,
    DragOutlined,
} from '@ant-design/icons';
import { Job, ObjectState } from 'cvat-core-wrapper';

import { CombinedState } from 'reducers';
import { saveAnnotationsAsync } from 'actions/annotation-actions';
import { shallowEqual } from 'utils/redux';
import {
    FrameAnnotationsSnapshot,
    AcceptanceRecordData,
    buildFrameAnnotationsSnapshot,
    buildSessionSnapshot,
    countSnapshotObjects,
    createAcceptanceRecord,
    getAcceptanceRecord,
} from './acceptance-api';
import { buildAcceptanceDiff, frameSnapshotAt, guessActionType } from './acceptance-diff';
import { clearBeforeOverlay, countOverlayDrawables, renderBeforeOverlay } from './acceptance-before-overlay';
import { CORRECTION_COPY } from './copy';

const POS_KEY = 'cvat-acceptance-session-bar-pos';

interface Props {
    beforeByFrame: Record<number, FrameAnnotationsSnapshot>;
    sessionPrimaryFrame: number | null;
    onClearSession: () => void;
    onSessionCompleted: (record: AcceptanceRecordData) => void;
    reviewRecord: AcceptanceRecordData | null;
    onClearReviewRecord: () => void;
}

interface BarPos {
    left: number;
    top: number;
}

function loadPos(): BarPos | null {
    try {
        const raw = sessionStorage.getItem(POS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed?.left === 'number' && typeof parsed?.top === 'number') {
            return { left: parsed.left, top: parsed.top };
        }
    } catch {
        // ignore
    }
    return null;
}

function savePos(pos: BarPos): void {
    try {
        sessionStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {
        // ignore
    }
}

function defaultPos(): BarPos {
    const left = Math.max(12, Math.round(window.innerWidth / 2 - 180));
    const top = Math.max(12, window.innerHeight - 72);
    return { left, top };
}

function clampPos(pos: BarPos, el: HTMLElement | null): BarPos {
    const w = el?.offsetWidth ?? 360;
    const h = el?.offsetHeight ?? 48;
    const maxLeft = Math.max(8, window.innerWidth - w - 8);
    const maxTop = Math.max(8, window.innerHeight - h - 8);
    return {
        left: Math.min(Math.max(8, pos.left), maxLeft),
        top: Math.min(Math.max(8, pos.top), maxTop),
    };
}

function AcceptanceSessionBar(props: Props): JSX.Element | null {
    const {
        beforeByFrame, sessionPrimaryFrame, onClearSession, onSessionCompleted,
        reviewRecord, onClearReviewRecord,
    } = props;
    const dispatch = useDispatch();
    const barRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{
        startX: number;
        startY: number;
        origLeft: number;
        origTop: number;
        moved: boolean;
    } | null>(null);

    const {
        jobInstance, frameNumber, saving, undoLength, canvasInstance,
    } = useSelector((state: CombinedState) => ({
        jobInstance: state.annotation.job.instance as Job | null,
        frameNumber: state.annotation.player.frame.number ?? 0,
        saving: state.annotation.annotations.saving.uploading,
        undoLength: state.annotation.annotations.history.undo.length,
        canvasInstance: state.annotation.canvas.instance as any,
    }), shallowEqual);

    const taskId = (jobInstance as any)?.taskId;
    const [busy, setBusy] = useState(false);
    const [showBefore, setShowBefore] = useState(false);
    const [pos, setPos] = useState<BarPos>(() => loadPos() || defaultPos());
    const [dragging, setDragging] = useState(false);

    const lockedFrames = useMemo(
        () => Object.keys(beforeByFrame).map((n) => parseInt(n, 10)).sort((a, b) => a - b),
        [beforeByFrame],
    );
    const inCreateSession = lockedFrames.length > 0;
    const inReviewSession = Boolean(reviewRecord);
    const primaryFrame = sessionPrimaryFrame ?? lockedFrames[0] ?? frameNumber;

    useEffect(() => {
        setPos((prev) => clampPos(prev, barRef.current));
    }, [inCreateSession, inReviewSession]);

    const captureFrame = useCallback(async (frame: number): Promise<FrameAnnotationsSnapshot | null> => {
        if (!jobInstance) return null;
        const states = await jobInstance.annotations.get(frame) as ObjectState[];
        return buildFrameAnnotationsSnapshot(states || [], frame);
    }, [jobInstance]);

    const beforeSessionPayload = useMemo(() => {
        if (!inCreateSession) return null;
        return buildSessionSnapshot(beforeByFrame, primaryFrame, {
            taskId: typeof taskId === 'number' ? taskId : undefined,
            jobId: jobInstance?.id,
        });
    }, [inCreateSession, beforeByFrame, primaryFrame, taskId, jobInstance]);

    const reviewBeforeRaw = reviewRecord?.snapshots?.find((s) => s.snapshot_type === 'before')?.data;

    const overlayBefore = useMemo(() => {
        if (inReviewSession) {
            return frameSnapshotAt(reviewBeforeRaw, frameNumber);
        }
        return beforeByFrame[frameNumber] || null;
    }, [inReviewSession, reviewBeforeRaw, frameNumber, beforeByFrame]);

    useEffect(() => {
        clearBeforeOverlay();
        if (!showBefore) return undefined;
        if (!overlayBefore || !canvasInstance || typeof canvasInstance.html !== 'function') {
            return undefined;
        }
        const handle = renderBeforeOverlay(overlayBefore, canvasInstance);
        const n = handle?.shapeCount ?? countOverlayDrawables(overlayBefore);
        if (!n) {
            message.info({
                key: 'acceptance-overlay-empty',
                content: CORRECTION_COPY.overlayEmpty(frameNumber),
                duration: 4,
            });
        } else {
            message.success({
                key: 'acceptance-overlay-on',
                content: CORRECTION_COPY.overlayOn(n, frameNumber),
                duration: 2,
            });
        }
        return () => {
            handle?.clear();
            clearBeforeOverlay();
        };
    }, [showBefore, overlayBefore, canvasInstance, frameNumber]);

    useEffect(() => {
        if (!inReviewSession || !reviewRecord) return;
        setShowBefore(true);
    }, [inReviewSession, reviewRecord?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleCancel = useCallback(() => {
        setShowBefore(false);
        clearBeforeOverlay();
        if (inCreateSession) onClearSession();
        if (inReviewSession) onClearReviewRecord();
    }, [inCreateSession, inReviewSession, onClearSession, onClearReviewRecord]);

    const handleConfirm = useCallback(async () => {
        if (!jobInstance || !inCreateSession || !beforeSessionPayload) return;
        setBusy(true);
        try {
            if (typeof (jobInstance.annotations as any).hasUnsavedChanges === 'function'
                && (jobInstance.annotations as any).hasUnsavedChanges()) {
                await (dispatch(saveAnnotationsAsync()) as any);
                message.success(CORRECTION_COPY.savedAnnotations);
            } else if (undoLength > 0 && !saving) {
                await (dispatch(saveAnnotationsAsync()) as any);
            }

            const afterFrames: Record<number, FrameAnnotationsSnapshot> = {};
            for (const f of lockedFrames) {
                const after = await captureFrame(f);
                if (!after) {
                    message.error(CORRECTION_COPY.afterCaptureFail);
                    return;
                }
                afterFrames[f] = after;
            }
            const afterPayload = buildSessionSnapshot(afterFrames, primaryFrame, {
                taskId: typeof taskId === 'number' ? taskId : undefined,
                jobId: jobInstance.id,
            });
            const diff = buildAcceptanceDiff(beforeSessionPayload as any, afterPayload as any);
            const beforeC = countSnapshotObjects(beforeSessionPayload);
            const afterC = countSnapshotObjects(afterPayload);
            const frameLabel = lockedFrames.length > 1
                ? `frames ${lockedFrames.map((f) => `#${f}`).join(', ')}`
                : `frame #${primaryFrame}`;
            const description = `${diff.headline} · ${frameLabel}`;

            const created = await createAcceptanceRecord({
                job: jobInstance.id,
                frame: primaryFrame,
                action_type: guessActionType(diff),
                description,
                status: 'finalized',
                shape_count_before: beforeC.shapes,
                shape_count_after: afterC.shapes,
                tag_count_before: beforeC.tags,
                tag_count_after: afterC.tags,
                track_count_before: beforeC.tracks,
                track_count_after: afterC.tracks,
                snapshots: [
                    { snapshot_type: 'before', data: beforeSessionPayload },
                    { snapshot_type: 'after', data: afterPayload },
                ],
            });
            const full = await getAcceptanceRecord(created.id);
            message.success(CORRECTION_COPY.saved(created.id, diff.headline));
            setShowBefore(false);
            onSessionCompleted(full);
        } catch (e: any) {
            const detail = e?.response?.data ? JSON.stringify(e.response.data) : (e?.message || e);
            message.error(CORRECTION_COPY.saveFail(String(detail)));
        } finally {
            setBusy(false);
        }
    }, [
        jobInstance, inCreateSession, beforeSessionPayload, lockedFrames, primaryFrame,
        taskId, undoLength, saving, dispatch, captureFrame, onSessionCompleted,
    ]);

    const onDragStart = useCallback((e: React.MouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const current = clampPos(pos, barRef.current);
        dragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            origLeft: current.left,
            origTop: current.top,
            moved: false,
        };
        setDragging(true);
    }, [pos]);

    useEffect(() => {
        if (!dragging) return undefined;

        const onMove = (e: MouseEvent): void => {
            const d = dragRef.current;
            if (!d) return;
            const next = clampPos({
                left: d.origLeft + (e.clientX - d.startX),
                top: d.origTop + (e.clientY - d.startY),
            }, barRef.current);
            if (Math.abs(e.clientX - d.startX) > 3 || Math.abs(e.clientY - d.startY) > 3) {
                d.moved = true;
            }
            setPos(next);
        };

        const onUp = (): void => {
            const d = dragRef.current;
            dragRef.current = null;
            setDragging(false);
            if (d?.moved) {
                setPos((prev) => {
                    const clamped = clampPos(prev, barRef.current);
                    savePos(clamped);
                    return clamped;
                });
            }
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [dragging]);

    if (!inCreateSession && !inReviewSession) {
        return null;
    }

    const modeClass = inCreateSession ? 'create' : 'review';

    return (
        <div
            ref={barRef}
            className={`cvat-acceptance-session-bar ${modeClass}${dragging ? ' is-dragging' : ''}`}
            style={{ left: pos.left, top: pos.top }}
        >
            <Tooltip title='Drag to move'>
                <button
                    type='button'
                    className='cvat-acceptance-session-bar__drag'
                    onMouseDown={onDragStart}
                    aria-label='Drag correction bar'
                >
                    <DragOutlined />
                </button>
            </Tooltip>
            <Space wrap size={4}>
                <Tooltip title={CORRECTION_COPY.originalOverlayTip}>
                    <Button
                        size='small'
                        icon={showBefore ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                        onClick={() => setShowBefore((v) => !v)}
                        disabled={!overlayBefore && !beforeByFrame[frameNumber]}
                    >
                        {showBefore ? CORRECTION_COPY.hideOriginal : CORRECTION_COPY.showOriginal}
                    </Button>
                </Tooltip>
                {inCreateSession ? (
                    <>
                        <Button size='small' icon={<CloseOutlined />} onClick={handleCancel}>
                            {CORRECTION_COPY.cancel}
                        </Button>
                        <Button
                            type='primary'
                            size='small'
                            icon={<CheckOutlined />}
                            loading={busy || saving}
                            onClick={handleConfirm}
                        >
                            {CORRECTION_COPY.saveCorrection}
                        </Button>
                    </>
                ) : (
                    <Button size='small' icon={<CloseOutlined />} onClick={handleCancel}>
                        {CORRECTION_COPY.done}
                    </Button>
                )}
            </Space>
        </div>
    );
}

export default React.memo(AcceptanceSessionBar);
