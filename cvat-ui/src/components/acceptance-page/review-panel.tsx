import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useHistory } from 'react-router';
import Button from 'antd/lib/button';
import Space from 'antd/lib/space';
import Tag from 'antd/lib/tag';
import Typography from 'antd/lib/typography';
import Collapse from 'antd/lib/collapse';
import Spin from 'antd/lib/spin';
import message from 'antd/lib/message';
import {
    DeleteOutlined, EyeOutlined, CopyOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';

import {
    AcceptanceRecordData,
    buildJobFrameURL,
    getAcceptanceRecord,
    listSessionFrames,
} from './acceptance-api';
import { buildAcceptanceDiff, DiffItem } from './acceptance-diff';
import { CORRECTION_COPY } from './copy';

const { Text, Title } = Typography;
const { Panel } = Collapse;

interface Props {
    recordId: number | null;
    listHint?: AcceptanceRecordData | null;
    onDelete: (record: AcceptanceRecordData) => void;
}

const KIND_COLOR: Record<string, string> = {
    added: 'green',
    removed: 'red',
    modified: 'orange',
    unchanged: 'default',
};

function formatJSON(data: unknown): string {
    return JSON.stringify(data, null, 2);
}

function DiffItems({ items }: { items: DiffItem[] }): JSX.Element {
    const meaningful = items.filter((i) => i.kind !== 'unchanged');
    if (!meaningful.length) {
        return (
            <Text type='secondary' className='cvat-acceptance-review-empty-diff'>
                {CORRECTION_COPY.reviewNoObjectDiff}
            </Text>
        );
    }
    return (
        <div className='cvat-acceptance-diff-list'>
            {meaningful.map((item) => (
                <div className='cvat-acceptance-diff-item' key={item.key}>
                    <Tag color={KIND_COLOR[item.kind]}>{item.kind}</Tag>
                    <div className='cvat-acceptance-diff-item__body'>
                        <span className='cvat-acceptance-diff-item__label'>
                            {item.label}
                            <Text type='secondary'>
                                {' '}
                                ·
                                {item.objectType}
                            </Text>
                        </span>
                        <span className='cvat-acceptance-diff-item__summary'>{item.summary}</span>
                    </div>
                    {item.frame != null && (
                        <span className='cvat-acceptance-diff-item__frame'>
                            #
                            {item.frame}
                        </span>
                    )}
                </div>
            ))}
        </div>
    );
}

function AcceptanceReviewPanel(props: Props): JSX.Element {
    const { recordId, listHint, onDelete } = props;
    const history = useHistory();
    const [loading, setLoading] = useState(false);
    const [record, setRecord] = useState<AcceptanceRecordData | null>(null);
    const [focusFrame, setFocusFrame] = useState<number | null>(null);

    useEffect(() => {
        if (recordId == null) {
            setRecord(null);
            setFocusFrame(null);
            return undefined;
        }
        let cancelled = false;
        setLoading(true);
        if (listHint?.id === recordId && listHint.snapshots?.length) {
            setRecord(listHint);
            setFocusFrame(listHint.frame);
            setLoading(false);
        }
        (async () => {
            try {
                const full = await getAcceptanceRecord(recordId);
                if (cancelled) return;
                setRecord(full);
                setFocusFrame(full.frame);
            } catch (e: any) {
                if (!cancelled) {
                    message.error(`Failed to load session: ${e?.message || 'Unknown error'}`);
                    setRecord(listHint?.id === recordId ? listHint : null);
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [recordId, listHint]);

    const beforeSnapshot = useMemo(
        () => record?.snapshots?.find((s) => s.snapshot_type === 'before'),
        [record],
    );
    const afterSnapshot = useMemo(
        () => record?.snapshots?.find((s) => s.snapshot_type === 'after'),
        [record],
    );
    const diff = useMemo(
        () => buildAcceptanceDiff(beforeSnapshot?.data as any, afterSnapshot?.data as any),
        [beforeSnapshot, afterSnapshot],
    );

    const frames = useMemo(() => {
        if (!record) return [] as number[];
        const fromSnap = [
            ...listSessionFrames(beforeSnapshot?.data),
            ...listSessionFrames(afterSnapshot?.data),
        ];
        if (fromSnap.length) return Array.from(new Set(fromSnap)).sort((a, b) => a - b);
        if (record.frames?.length) return record.frames;
        return [record.frame];
    }, [record, beforeSnapshot, afterSnapshot]);

    const openFrame = focusFrame ?? record?.frame ?? 0;

    const handleReviewOnCanvas = useCallback(() => {
        if (!record) return;
        history.push(buildJobFrameURL(record.task_id, record.job, openFrame, record.id));
    }, [history, record, openFrame]);

    const copySnapshot = useCallback((data: unknown, label: string) => {
        navigator.clipboard.writeText(formatJSON(data))
            .then(() => message.success(`${label} copied`))
            .catch(() => message.error('Copy failed'));
    }, []);

    if (recordId == null) {
        return (
            <div className='cvat-acceptance-review-panel cvat-acceptance-review-panel--empty'>
                <Title level={5}>{CORRECTION_COPY.reviewPanelEmptyTitle}</Title>
                <Text type='secondary'>{CORRECTION_COPY.reviewPanelEmptyHint}</Text>
            </div>
        );
    }

    if (loading && !record) {
        return (
            <div className='cvat-acceptance-review-panel cvat-acceptance-review-panel--empty'>
                <Spin />
            </div>
        );
    }

    if (!record) {
        return (
            <div className='cvat-acceptance-review-panel cvat-acceptance-review-panel--empty'>
                <Text type='secondary'>{CORRECTION_COPY.reviewPanelMissing}</Text>
            </div>
        );
    }

    return (
        <div className='cvat-acceptance-review-panel'>
            <div className='cvat-acceptance-review-panel__header'>
                <div>
                    <Title level={5} className='cvat-acceptance-review-panel__title'>
                        {CORRECTION_COPY.sessionRowTitle(record.id)}
                    </Title>
                    <Text type='secondary' className='cvat-acceptance-review-panel__headline'>
                        {diff.headline || record.description || CORRECTION_COPY.sessionNoSummary}
                    </Text>
                </div>
                {loading && <Spin size='small' />}
            </div>

            <div className='cvat-acceptance-review-panel__meta'>
                <span>
                    Job #
                    {record.job}
                </span>
                <span>{record.reviewer?.username || '—'}</span>
                <span>{dayjs(record.created_date).format('YYYY-MM-DD HH:mm')}</span>
            </div>

            <div className='cvat-acceptance-review-panel__stats'>
                <Tag color='green'>
                    +
                    {diff.added}
                    {' '}
                    added
                </Tag>
                <Tag color='red'>
                    -
                    {diff.removed}
                    {' '}
                    removed
                </Tag>
                <Tag color='orange'>
                    {diff.modified}
                    {' '}
                    modified
                </Tag>
            </div>

            {frames.length > 0 && (
                <div className='cvat-acceptance-review-panel__frames'>
                    <Text type='secondary' className='cvat-acceptance-review-panel__section-label'>
                        {CORRECTION_COPY.reviewFramesLabel}
                    </Text>
                    <div className='cvat-acceptance-frame-chips'>
                        {frames.map((f) => (
                            <button
                                type='button'
                                key={f}
                                className={`cvat-acceptance-frame-chip${openFrame === f ? ' is-active' : ''}`}
                                onClick={() => setFocusFrame(f)}
                            >
                                #
                                {f}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <div className='cvat-acceptance-review-panel__section'>
                <Text type='secondary' className='cvat-acceptance-review-panel__section-label'>
                    {CORRECTION_COPY.reviewChangesLabel}
                </Text>
                <DiffItems items={diff.items} />
            </div>

            <div className='cvat-acceptance-review-panel__actions'>
                <Button
                    type='primary'
                    icon={<EyeOutlined />}
                    onClick={handleReviewOnCanvas}
                    block
                >
                    {CORRECTION_COPY.reviewOnCanvas}
                </Button>
                <Button
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => onDelete(record)}
                    block
                >
                    {CORRECTION_COPY.deleteRecord}
                </Button>
            </div>

            <Text type='secondary' className='cvat-acceptance-review-panel__tip'>
                {CORRECTION_COPY.compareTip}
            </Text>

            <Collapse ghost className='cvat-acceptance-review-panel__raw'>
                <Panel header={CORRECTION_COPY.originalJson} key='before'>
                    <Space style={{ marginBottom: 8 }}>
                        <Button
                            size='small'
                            icon={<CopyOutlined />}
                            onClick={() => copySnapshot(beforeSnapshot?.data, 'Original')}
                        />
                    </Space>
                    <pre className='cvat-acceptance-json-block'>
                        {beforeSnapshot?.data ? formatJSON(beforeSnapshot.data) : '—'}
                    </pre>
                </Panel>
                <Panel header={CORRECTION_COPY.correctedJson} key='after'>
                    <Space style={{ marginBottom: 8 }}>
                        <Button
                            size='small'
                            icon={<CopyOutlined />}
                            onClick={() => copySnapshot(afterSnapshot?.data, 'Corrected')}
                        />
                    </Space>
                    <pre className='cvat-acceptance-json-block'>
                        {afterSnapshot?.data ? formatJSON(afterSnapshot.data) : '—'}
                    </pre>
                </Panel>
            </Collapse>
        </div>
    );
}

export default React.memo(AcceptanceReviewPanel);
