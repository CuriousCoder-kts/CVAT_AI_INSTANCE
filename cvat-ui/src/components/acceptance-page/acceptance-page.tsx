import './styles.scss';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useHistory, useParams, useLocation } from 'react-router';
import Spin from 'antd/lib/spin';
import Pagination from 'antd/lib/pagination';
import Button from 'antd/lib/button';
import Select from 'antd/lib/select';
import Space from 'antd/lib/space';
import Typography from 'antd/lib/typography';
import Modal from 'antd/lib/modal';
import message from 'antd/lib/message';
import Tooltip from 'antd/lib/tooltip';
import {
    ArrowLeftOutlined, DownOutlined, RightOutlined, DownloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { getCore } from 'cvat-core-wrapper';

import {
    getAcceptanceRecords,
    deleteAcceptanceRecord,
    AcceptanceRecordData,
    AcceptanceRecordsQuery,
} from './acceptance-api';
import AcceptanceReviewPanel from './review-panel';
import { CORRECTION_COPY } from './copy';
import { useCanUseAcceptance } from './use-can-use-acceptance';
import { exportCorrectionSessionsCsv } from './export-csv';
function buildCorrectionSearch(query: AcceptanceRecordsQuery): string {
    const params = new URLSearchParams();
    if (query.page && query.page !== 1) params.set('page', String(query.page));
    if (query.pageSize && query.pageSize !== 20) params.set('pageSize', String(query.pageSize));
    if (query.sort) params.set('sort', query.sort);
    if (query.task != null && !Number.isNaN(Number(query.task))) params.set('task', String(query.task));
    if (query.session != null && !Number.isNaN(Number(query.session))) {
        params.set('session', String(query.session));
    }
    const text = params.toString();
    return text ? `?${text}` : '';
}

const { Title, Text } = Typography;

interface AcceptancePageProps {
    scope?: 'global' | 'job';
    jobId?: number;
    taskId?: number;
}

interface TaskOption {
    id: number;
    name: string;
}

function sessionFrames(record: AcceptanceRecordData): number[] {
    if (record.frames && record.frames.length) return record.frames;
    return [record.frame];
}

function framesMeta(record: AcceptanceRecordData): string {
    const frames = sessionFrames(record);
    if (frames.length <= 1) return `Frame #${frames[0]}`;
    if (frames.length <= 4) return `Frames ${frames.map((f) => `#${f}`).join(', ')}`;
    return `Frames #${frames[0]}–#${frames[frames.length - 1]} (${frames.length})`;
}

function displaySummary(record: AcceptanceRecordData): string {
    const raw = (record.description || '').trim();
    let cleaned = raw
        .replace(/\s*·\s*frames?\s+#\d+(?:\s*,\s*#\d+)*\s*$/i, '')
        .replace(/\s*\(\s*#\d+\s*[–-]\s*#\d+\s*\)\s*$/i, '')
        .trim();

    if (/^no object-level changes detected\.?$/i.test(cleaned)) {
        cleaned = CORRECTION_COPY.sessionNoSummary;
    }

    if (cleaned) return cleaned;

    const diff = record.shape_count_after - record.shape_count_before;
    if (diff > 0) return `+${diff} shapes`;
    if (diff < 0) return `${diff} shapes`;
    return CORRECTION_COPY.sessionNoSummary;
}

function AcceptancePageComponent(props: AcceptancePageProps): JSX.Element {
    const history = useHistory();
    const location = useLocation();
    const canUseAcceptance = useCanUseAcceptance();
    const core = useMemo(() => getCore(), []);
    const [isMounted, setIsMounted] = useState(false);
    const [fetching, setFetching] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [records, setRecords] = useState<AcceptanceRecordData[]>([]);
    const [count, setCount] = useState(0);
    const [taskOptions, setTaskOptions] = useState<TaskOption[]>([]);
    const [taskOptionsLoading, setTaskOptionsLoading] = useState(false);
    const [taskSearchText, setTaskSearchText] = useState('');
    const [collapsedTasks, setCollapsedTasks] = useState<Record<number, boolean>>({});

    const params = useParams<{ tid?: string; jid?: string }>();
    const resolvedTaskId = props.taskId ?? (params.tid ? parseInt(params.tid, 10) : undefined);
    const resolvedJobId = props.jobId ?? (params.jid ? parseInt(params.jid, 10) : undefined);
    const scope = props.scope ?? (resolvedJobId ? 'job' : 'global');

    const parseQuery = useCallback((): AcceptanceRecordsQuery => {
        const urlParams = new URLSearchParams(location.search);
        const taskRaw = urlParams.get('task');
        const sessionRaw = urlParams.get('session');
        return {
            page: parseInt(urlParams.get('page') || '1', 10),
            pageSize: parseInt(urlParams.get('pageSize') || '20', 10),
            sort: urlParams.get('sort') || null,
            task: taskRaw != null && taskRaw !== '' ? parseInt(taskRaw, 10) : undefined,
            session: sessionRaw != null && sessionRaw !== '' ? parseInt(sessionRaw, 10) : undefined,
        };
    }, [location.search]);

    const query = parseQuery();
    const selectedSessionId = query.session ?? null;

    const mergeTaskOptions = useCallback((incoming: TaskOption[]) => {
        setTaskOptions((prev) => {
            const map = new Map<number, TaskOption>();
            const prefer = (a: TaskOption | undefined, b: TaskOption): TaskOption => {
                if (!a) return b;
                const aReal = Boolean(a.name && !a.name.startsWith('Task #'));
                const bReal = Boolean(b.name && !b.name.startsWith('Task #'));
                if (bReal && !aReal) return b;
                if (aReal && !bReal) return a;
                if ((b.name || '').length > (a.name || '').length) return b;
                return a;
            };
            prev.forEach((item) => {
                if (item?.id) map.set(item.id, item);
            });
            incoming.forEach((item) => {
                if (!item?.id) return;
                map.set(item.id, prefer(map.get(item.id), item));
            });
            return Array.from(map.values()).sort((a, b) => b.id - a.id);
        });
    }, []);

    const loadTaskOptions = useCallback(async (search?: string) => {
        if (scope !== 'global') return;
        setTaskOptionsLoading(true);
        try {
            const q = (search || '').trim();
            const incoming: TaskOption[] = [];

            if (/^\d+$/.test(q)) {
                try {
                    const [task] = await core.tasks.get({ id: parseInt(q, 10) });
                    if (task) {
                        incoming.push({
                            id: task.id,
                            name: (task.name || '').trim() || `Task #${task.id}`,
                        });
                    }
                } catch {
                    // ignore
                }
            }

            if (q && !/^\d+$/.test(q)) {
                const result = await core.tasks.get({
                    page: 1,
                    pageSize: 50,
                    ordering: '-updated_date',
                    search: q,
                });
                incoming.push(...(result || []).map((task: { id: number; name?: string }) => ({
                    id: task.id,
                    name: (task.name || '').trim() || `Task #${task.id}`,
                })));
            } else if (!q) {
                const result = await core.tasks.get({
                    page: 1,
                    pageSize: 200,
                    ordering: '-updated_date',
                });
                incoming.push(...(result || []).map((task: { id: number; name?: string }) => ({
                    id: task.id,
                    name: (task.name || '').trim() || `Task #${task.id}`,
                })));
            }

            if (incoming.length) mergeTaskOptions(incoming);
        } catch {
            // keep existing
        } finally {
            setTaskOptionsLoading(false);
        }
    }, [core, mergeTaskOptions, scope]);

    const taskSelectOptions = useMemo(() => {
        const q = taskSearchText.trim();
        let list = [...taskOptions];
        if (/^\d+$/.test(q)) {
            const id = parseInt(q, 10);
            list.sort((a, b) => {
                const rank = (t: TaskOption): number => {
                    if (t.id === id) return 0;
                    if (String(t.id).startsWith(q)) return 1;
                    if ((t.name || '').toLowerCase().includes(q)) return 2;
                    return 3;
                };
                const d = rank(a) - rank(b);
                return d !== 0 ? d : b.id - a.id;
            });
        }
        return list.map((t) => ({
            value: t.id,
            label: `${t.name} (#${t.id})`,
        }));
    }, [taskOptions, taskSearchText]);

    const fetchData = useCallback(async () => {
        setFetching(true);
        try {
            const result = await getAcceptanceRecords({
                ...query,
                job: resolvedJobId,
                task: scope === 'job' ? resolvedTaskId : query.task,
                session: undefined,
            });
            setRecords(result.results);
            setCount(result.count);
        } catch (error: any) {
            const detail = error?.response?.data?.detail
                || error?.response?.statusText
                || error?.message
                || 'Unknown error';
            const status = error?.response?.status;
            message.error({
                key: 'acceptance-list-error',
                content: CORRECTION_COPY.loadFail(status ? ` (${status})` : '', String(detail)),
                duration: 6,
            });
            setRecords([]);
            setCount(0);
        } finally {
            setFetching(false);
        }
    }, [query, resolvedJobId, resolvedTaskId, scope]);

    useEffect(() => {
        setIsMounted(true);
        fetchData();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.search, resolvedJobId, resolvedTaskId, scope]);

    useEffect(() => {
        if (scope === 'global') loadTaskOptions();
    }, [scope, loadTaskOptions]);

    useEffect(() => {
        if (scope !== 'global' || !records.length) return;
        mergeTaskOptions(records.map((r) => ({
            id: r.task_id,
            name: (r.task_name || '').trim() || `Task #${r.task_id}`,
        })));
    }, [scope, records, mergeTaskOptions]);

    useEffect(() => {
        if (scope !== 'global') return;
        const needed = new Set<number>();
        if (query.task != null && !Number.isNaN(query.task)) needed.add(query.task);
        records.forEach((r) => {
            if (!(r.task_name || '').trim()) needed.add(r.task_id);
        });
        if (!needed.size) return;

        let cancelled = false;
        (async () => {
            const resolved: TaskOption[] = [];
            await Promise.all(Array.from(needed).map(async (id) => {
                try {
                    const [task] = await core.tasks.get({ id });
                    if (task) {
                        resolved.push({
                            id: task.id,
                            name: (task.name || '').trim() || `Task #${task.id}`,
                        });
                    }
                } catch {
                    // ignore
                }
            }));
            if (!cancelled && resolved.length) mergeTaskOptions(resolved);
        })();
        return () => { cancelled = true; };
    }, [scope, query.task, records, core, mergeTaskOptions]);

    const taskNameById = useMemo(() => {
        const map = new Map<number, string>();
        taskOptions.forEach((t) => map.set(t.id, t.name));
        return map;
    }, [taskOptions]);

    const setQuery = useCallback((nextQuery: AcceptanceRecordsQuery) => {
        if (!isMounted) return;
        const nextSearch = buildCorrectionSearch(nextQuery);
        if (nextSearch === (location.search || '')) return;
        history.push({ ...location, search: nextSearch });
    }, [history, isMounted, location]);

    const selectSession = useCallback((id: number | null) => {
        setQuery({
            ...query,
            session: id == null ? undefined : id,
        });
    }, [query, setQuery]);

    const handleDeleteRecord = useCallback((record: AcceptanceRecordData) => {
        Modal.confirm({
            title: CORRECTION_COPY.deleteTitle,
            content: CORRECTION_COPY.deleteContent(record.id),
            okText: CORRECTION_COPY.deleteOk,
            okButtonProps: { danger: true },
            onOk: async () => {
                try {
                    await deleteAcceptanceRecord(record.id);
                    message.success(CORRECTION_COPY.deleted);
                    if (selectedSessionId === record.id) {
                        setQuery({ ...query, session: undefined });
                    }
                    fetchData();
                } catch (error: any) {
                    message.error(`Failed to delete: ${error?.message || 'Unknown error'}`);
                }
            },
        });
    }, [fetchData, query, selectedSessionId, setQuery]);

    const handleExportCsv = useCallback(async () => {
        if (exporting) return;
        setExporting(true);
        message.loading({
            content: 'Exporting correction sessions…',
            key: 'acceptance-export-csv',
            duration: 0,
        });
        try {
            const result = await exportCorrectionSessionsCsv(
                {
                    ...query,
                    job: resolvedJobId,
                    task: scope === 'job' ? resolvedTaskId : query.task,
                    page: 1,
                    session: undefined,
                },
                { taskNameById },
            );
            message.success({
                key: 'acceptance-export-csv',
                content: CORRECTION_COPY.exportCsvDone(result.sessions, result.objectChanges),
            });
        } catch (error: any) {
            message.error({
                key: 'acceptance-export-csv',
                content: CORRECTION_COPY.exportCsvFail(
                    error?.message || CORRECTION_COPY.exportCsvEmpty,
                ),
            });
        } finally {
            setExporting(false);
        }
    }, [
        exporting,
        query,
        resolvedJobId,
        resolvedTaskId,
        scope,
        taskNameById,
    ]);

    const listHint = useMemo(
        () => records.find((r) => r.id === selectedSessionId) || null,
        [records, selectedSessionId],
    );

    const sessionsByTask = useMemo(() => {
        const map = new Map<number, AcceptanceRecordData[]>();
        for (const record of records) {
            const tid = record.task_id;
            const list = map.get(tid) || [];
            list.push(record);
            map.set(tid, list);
        }
        return Array.from(map.entries())
            .map(([taskId, sessions]) => ({
                taskId,
                sessions,
                latest: sessions[0]?.created_date,
            }))
            .sort((a, b) => String(b.latest || '').localeCompare(String(a.latest || '')));
    }, [records]);

    const toggleTaskGroup = useCallback((taskId: number) => {
        setCollapsedTasks((prev) => ({ ...prev, [taskId]: !prev[taskId] }));
    }, []);

    const renderSessionRow = useCallback((record: AcceptanceRecordData) => {
        const frames = sessionFrames(record);
        const summary = displaySummary(record);
        const operator = record.reviewer?.username || '—';
        const selected = selectedSessionId === record.id;

        return (
            <button
                type='button'
                className={`cvat-acceptance-session-row${selected ? ' is-selected' : ''}`}
                key={record.id}
                onClick={() => selectSession(record.id)}
            >
                <div className='cvat-acceptance-session-row__main'>
                    <div className='cvat-acceptance-session-row__title'>
                        <span className='cvat-acceptance-session-row__id'>
                            {CORRECTION_COPY.sessionRowTitle(record.id)}
                        </span>
                    </div>
                    <div className='cvat-acceptance-session-row__summary' title={summary}>
                        {summary}
                    </div>
                    <div className='cvat-acceptance-session-row__meta'>
                        <Tooltip title={frames.map((f) => `#${f}`).join(', ')}>
                            <span>{framesMeta(record)}</span>
                        </Tooltip>
                        <span>
                            Job #
                            {record.job}
                        </span>
                        <span>{operator}</span>
                        <span>{dayjs(record.created_date).format('YYYY-MM-DD HH:mm')}</span>
                    </div>
                </div>
            </button>
        );
    }, [selectedSessionId, selectSession]);

    const renderSessionList = (): JSX.Element => {
        if (scope === 'global') {
            return (
                <>
                    {sessionsByTask.map(({ taskId, sessions }) => {
                        const collapsed = Boolean(collapsedTasks[taskId]);
                        const taskName = taskNameById.get(taskId);
                        const hasRealName = Boolean(taskName && !taskName.startsWith('Task #'));
                        return (
                            <div className='cvat-acceptance-task-group' key={taskId}>
                                <div
                                    className='cvat-acceptance-task-group__header'
                                    onClick={() => toggleTaskGroup(taskId)}
                                >
                                    <span className='cvat-acceptance-task-group__title'>
                                        {collapsed
                                            ? <RightOutlined className='cvat-acceptance-task-group__chevron' />
                                            : <DownOutlined className='cvat-acceptance-task-group__chevron' />}
                                        {hasRealName ? taskName : `Task #${taskId}`}
                                        {hasRealName && (
                                            <span className='cvat-acceptance-task-group__id'>
                                                #
                                                {taskId}
                                            </span>
                                        )}
                                        <span className='cvat-acceptance-task-group__id'>
                                            ·
                                            {' '}
                                            {sessions.length}
                                            {' '}
                                            session
                                            {sessions.length === 1 ? '' : 's'}
                                        </span>
                                    </span>
                                    <span className='cvat-acceptance-task-group__meta'>
                                        <a
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                history.push(`/tasks/${taskId}`);
                                            }}
                                        >
                                            Open task
                                        </a>
                                    </span>
                                </div>
                                {!collapsed && (
                                    <div className='cvat-acceptance-session-list'>
                                        {sessions.map((record) => renderSessionRow(record))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </>
            );
        }
        return (
            <div className='cvat-acceptance-session-list'>
                {records.map((record) => renderSessionRow(record))}
            </div>
        );
    };

    if (!canUseAcceptance) {
        return (
            <div className='cvat-acceptance-page'>
                <div className='cvat-acceptance-empty' style={{ padding: 48 }}>
                    <Text type='secondary'>
                        You do not have permission to use Corrections. Contact a global admin.
                    </Text>
                </div>
            </div>
        );
    }

    return (
        <div className='cvat-acceptance-page'>
            <div className='cvat-acceptance-top-bar'>
                <Space>
                    {scope === 'job' && resolvedTaskId && resolvedJobId && (
                        <Button
                            icon={<ArrowLeftOutlined />}
                            onClick={() => history.push(`/tasks/${resolvedTaskId}/jobs/${resolvedJobId}`)}
                        >
                            Back to Job
                        </Button>
                    )}
                    <div>
                        <Title level={4} className='cvat-acceptance-page-title'>
                            {scope === 'global'
                                ? CORRECTION_COPY.pageTitleGlobal
                                : CORRECTION_COPY.pageTitleJob(resolvedJobId as number)}
                        </Title>
                        {!!count && (
                            <Text type='secondary' className='cvat-acceptance-page-count'>
                                {CORRECTION_COPY.sessionCount(count)}
                            </Text>
                        )}
                    </div>
                </Space>
                <div className='cvat-acceptance-top-bar-right'>
                    <Tooltip title={CORRECTION_COPY.exportCsvTip}>
                        <Button
                            icon={<DownloadOutlined />}
                            loading={exporting}
                            disabled={!count && !exporting}
                            onClick={handleExportCsv}
                        >
                            {CORRECTION_COPY.exportCsv}
                        </Button>
                    </Tooltip>
                    {scope === 'global' && (
                        <Select
                            showSearch
                            allowClear
                            placeholder={CORRECTION_COPY.taskFilterPlaceholder}
                            style={{ minWidth: 320, maxWidth: 480 }}
                            value={query.task}
                            loading={taskOptionsLoading}
                            filterOption={(input, option) => {
                                const q = input.trim().toLowerCase();
                                if (!q) return true;
                                const id = String(option?.value ?? '');
                                const label = String(option?.label ?? '').toLowerCase();
                                if (/^\d+$/.test(q)) {
                                    return id === q
                                        || id.startsWith(q)
                                        || label.includes(`#${q}`)
                                        || label.includes(`(#${q})`);
                                }
                                return label.includes(q) || id.includes(q);
                            }}
                            onSearch={(value) => {
                                setTaskSearchText(value);
                                if (value && value.trim().length >= 1) {
                                    loadTaskOptions(value);
                                }
                            }}
                            onChange={(val) => {
                                setTaskSearchText('');
                                setQuery({
                                    ...query,
                                    task: val == null ? undefined : Number(val),
                                    page: 1,
                                    session: undefined,
                                });
                            }}
                            onBlur={() => setTaskSearchText('')}
                            options={taskSelectOptions}
                            notFoundContent={taskOptionsLoading ? <Spin size='small' /> : CORRECTION_COPY.taskFilterEmpty}
                        />
                    )}
                </div>
            </div>

            <div className='cvat-acceptance-content-wrapper'>
                <div className='cvat-acceptance-layout'>
                    <div className='cvat-acceptance-layout__nav'>
                        {fetching ? (
                            <div style={{ textAlign: 'center', padding: '48px 0' }}>
                                <Spin size='large' />
                            </div>
                        ) : (
                            <>
                                {!records.length && (
                                    <div className='cvat-acceptance-empty'>
                                        <Title level={5} style={{ marginBottom: 8 }}>
                                            No correction sessions yet
                                        </Title>
                                        <Text type='secondary'>
                                            Open a Job →
                                            {' '}
                                            {CORRECTION_COPY.toolbarLabel}
                                            {' '}
                                            → edit frames →
                                            {' '}
                                            {CORRECTION_COPY.saveCorrection}
                                            .
                                        </Text>
                                    </div>
                                )}
                                {!!records.length && renderSessionList()}
                                {!!count && (
                                    <div className='cvat-acceptance-layout__pager'>
                                        <Pagination
                                            size='small'
                                            onChange={(page: number, pageSize: number) => {
                                                setQuery({
                                                    ...query,
                                                    page,
                                                    pageSize,
                                                    session: undefined,
                                                });
                                            }}
                                            total={count}
                                            pageSizeOptions={[10, 20, 50, 100]}
                                            current={query.page}
                                            pageSize={query.pageSize}
                                            showSizeChanger
                                            showTotal={(total) => CORRECTION_COPY.sessionCount(total)}
                                        />
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                    <div className='cvat-acceptance-layout__detail'>
                        <AcceptanceReviewPanel
                            recordId={selectedSessionId}
                            listHint={listHint}
                            onDelete={handleDeleteRecord}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

export default AcceptancePageComponent;
