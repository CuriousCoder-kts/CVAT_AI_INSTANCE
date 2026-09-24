// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';
import { useHistory, useLocation } from 'react-router';
import Button from 'antd/lib/button';
import message from 'antd/lib/message';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { Job, ObjectState } from 'cvat-core-wrapper';

import { CombinedState } from 'reducers';
import { changeFrameAsync } from 'actions/annotation-actions';
import { shallowEqual } from 'utils/redux';
import CVATTooltip from 'components/common/cvat-tooltip';
import AcceptanceSessionBar from 'components/acceptance-page/acceptance-session-bar';
import 'components/acceptance-page/styles.scss';
import {
    getAcceptanceRecord,
    AcceptanceRecordData,
    FrameAnnotationsSnapshot,
    buildFrameAnnotationsSnapshot,
    countSnapshotObjects,
} from 'components/acceptance-page/acceptance-api';
import { CORRECTION_COPY } from 'components/acceptance-page/copy';
import { useCanUseAcceptance } from 'components/acceptance-page/use-can-use-acceptance';

function AcceptanceToolbarButtonImpl(): JSX.Element | null {
    const history = useHistory();
    const location = useLocation();
    const dispatch = useDispatch();
    const canUseAcceptance = useCanUseAcceptance({ includeTaskStaffGate: true });

    const { jobInstance, frameNumber } = useSelector((state: CombinedState) => ({
        jobInstance: state.annotation.job.instance as Job | null,
        frameNumber: state.annotation.player.frame.number ?? 0,
    }), shallowEqual);

    const [beforeByFrame, setBeforeByFrame] = useState<Record<number, FrameAnnotationsSnapshot>>({});
    const [sessionPrimaryFrame, setSessionPrimaryFrame] = useState<number | null>(null);
    const [reviewRecord, setReviewRecord] = useState<AcceptanceRecordData | null>(null);
    const [capturing, setCapturing] = useState(false);
    const [portalRoot, setPortalRoot] = useState<Element | null>(null);

    const sessionActive = Object.keys(beforeByFrame).length > 0;

    useEffect(() => {
        setPortalRoot(document.querySelector('.cvat-annotation-page'));
    }, []);

    const startReview = useCallback(async () => {
        if (!jobInstance) {
            message.warning('Wait for the job to load');
            return;
        }
        if (sessionActive) {
            message.info(CORRECTION_COPY.startBusy);
            return;
        }
        setCapturing(true);
        try {
            const states = await jobInstance.annotations.get(frameNumber) as ObjectState[];
            const snap = await buildFrameAnnotationsSnapshot(states || [], frameNumber);
            setBeforeByFrame({ [frameNumber]: snap });
            setSessionPrimaryFrame(frameNumber);
            const c = countSnapshotObjects(snap);
            message.success({
                key: 'acceptance-before',
                content: CORRECTION_COPY.startLocked(frameNumber, c.shapes),
                duration: 5,
            });
        } catch (e: any) {
            message.error(`Failed to start correction: ${e?.message || e}`);
        } finally {
            setCapturing(false);
        }
    }, [jobInstance, frameNumber, sessionActive]);

    useEffect(() => {
        if (!sessionActive || !jobInstance || reviewRecord) return;
        if (beforeByFrame[frameNumber]) return;
        let cancelled = false;
        (async () => {
            try {
                const states = await jobInstance.annotations.get(frameNumber) as ObjectState[];
                if (cancelled) return;
                const snap = await buildFrameAnnotationsSnapshot(states || [], frameNumber);
                setBeforeByFrame((prev) => {
                    if (prev[frameNumber]) return prev;
                    message.info({
                        key: `acceptance-lock-${frameNumber}`,
                        content: CORRECTION_COPY.frameLocked(frameNumber),
                        duration: 2,
                    });
                    return { ...prev, [frameNumber]: snap };
                });
            } catch {
                // ignore
            }
        })();
        return () => { cancelled = true; };
    }, [frameNumber, sessionActive, jobInstance, reviewRecord]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const params = new URLSearchParams(location.search);
        const recordId = params.get('acceptance_record');
        if (!recordId) {
            if (reviewRecord) setReviewRecord(null);
            return undefined;
        }
        const id = parseInt(recordId, 10);
        if (reviewRecord?.id === id) return undefined;
        let cancelled = false;
        (async () => {
            try {
                const rec = await getAcceptanceRecord(id);
                if (cancelled) return;
                setReviewRecord(rec);
                setBeforeByFrame({});
                setSessionPrimaryFrame(null);
                if (typeof rec.frame === 'number' && rec.frame !== frameNumber) {
                    dispatch(changeFrameAsync(rec.frame));
                }
                message.success({
                    key: 'acceptance-review-loaded',
                    content: CORRECTION_COPY.reviewLoaded(rec.id),
                    duration: 4,
                });
            } catch (e: any) {
                if (!cancelled) message.error(CORRECTION_COPY.reviewLoadFail(recordId));
            }
        })();
        return () => { cancelled = true; };
    }, [location.search]); // eslint-disable-line react-hooks/exhaustive-deps

    const clearSession = useCallback(() => {
        setBeforeByFrame({});
        setSessionPrimaryFrame(null);
    }, []);

    const onSessionCompleted = useCallback((record: AcceptanceRecordData) => {
        clearSession();
        setReviewRecord(record);
        const params = new URLSearchParams(location.search);
        params.set('acceptance_record', String(record.id));
        history.replace({ pathname: location.pathname, search: params.toString() });
    }, [clearSession, history, location.pathname, location.search]);

    const clearReviewRecord = useCallback(() => {
        setReviewRecord(null);
        const params = new URLSearchParams(location.search);
        params.delete('acceptance_record');
        history.replace({ pathname: location.pathname, search: params.toString() });
    }, [history, location.pathname, location.search]);

    const active = Boolean(sessionActive || reviewRecord);
    const tip = sessionActive
        ? CORRECTION_COPY.toolbarTipActive
        : (reviewRecord
            ? CORRECTION_COPY.toolbarTipReview(reviewRecord.id)
            : CORRECTION_COPY.toolbarTipIdle);

    const sessionBar = (sessionActive || reviewRecord) ? (
        <AcceptanceSessionBar
            beforeByFrame={beforeByFrame}
            sessionPrimaryFrame={sessionPrimaryFrame}
            onClearSession={clearSession}
            onSessionCompleted={onSessionCompleted}
            reviewRecord={reviewRecord}
            onClearReviewRecord={clearReviewRecord}
        />
    ) : null;

    if (!canUseAcceptance) {
        return null;
    }

    return (
        <>
            <CVATTooltip overlay={tip}>
                <Button
                    type='link'
                    className={`cvat-acceptance-header-button cvat-annotation-header-button${active ? ' cvat-button-active' : ''}`}
                    onClick={startReview}
                    loading={capturing}
                    disabled={sessionActive}
                >
                    <SafetyCertificateOutlined />
                    <span>{CORRECTION_COPY.toolbarLabel}</span>
                </Button>
            </CVATTooltip>
            {sessionBar && portalRoot
                ? ReactDOM.createPortal(sessionBar, portalRoot)
                : null}
        </>
    );
}

export default React.memo(AcceptanceToolbarButtonImpl);
