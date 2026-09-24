// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import Title from 'antd/lib/typography/Title';
import Alert from 'antd/lib/alert';
import Button from 'antd/lib/button';
import Card from 'antd/lib/card';
import Statistic from 'antd/lib/statistic';
import Table from 'antd/lib/table';
import DatePicker from 'antd/lib/date-picker';
import Empty from 'antd/lib/empty';
import Spin from 'antd/lib/spin';
import Select from 'antd/lib/select';
import Radio, { RadioChangeEvent } from 'antd/lib/radio';
import Tooltip from 'antd/lib/tooltip';
import {
    DownloadOutlined,
    QuestionCircleOutlined,
    FieldTimeOutlined,
    EditOutlined,
    ThunderboltOutlined,
    ImportOutlined,
} from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    BarElement,
    LineElement,
    PointElement,
    ArcElement,
    Tooltip as ChartTooltip,
    Legend,
} from 'chart.js';
import { Bar, Doughnut, Line } from 'react-chartjs-2';

import {
    AnalyticsEventsFilter, getCore, SerializedAnnotationStatistics, Task,
} from 'cvat-core-wrapper';
import { CombinedState } from 'reducers';

ChartJS.register(
    CategoryScale,
    LinearScale,
    BarElement,
    LineElement,
    PointElement,
    ArcElement,
    ChartTooltip,
    Legend,
);

const core = getCore();
const CHART_BLUE = '#1890ff';
const CHART_GOLD = '#faad14';
const CHART_PURPLE = '#722ed1';
const CHART_GRAY = '#8c8c8c';

const compactAxis = {
    ticks: { font: { size: 11 }, maxTicksLimit: 6 },
    grid: { color: 'rgba(0, 0, 0, 0.06)' },
};

type GroupBy = 'account' | 'task';
type StatisticsRow = {
    id: number;
    name: string;
    shapes: number;
    tags: number;
    tracks: number;
    annotations: number;
    manual?: number;
    ai?: number;
    imported?: number;
    other?: number;
    working_ms: number;
};

function kindValue(row: { manual?: number; ai?: number; imported?: number; other?: number }, key: 'manual' | 'ai' | 'imported' | 'other'): number {
    return row[key] || 0;
}

function formatWorkingTime(ms: number): string {
    const totalMinutes = Math.max(0, Math.round(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours <= 0) {
        return `${minutes}m`;
    }
    return `${hours}h ${minutes}m`;
}

function csvCell(value: string | number): string {
    const text = String(value);
    if (/[",\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function downloadCsv(stats: SerializedAnnotationStatistics): void {
    const header = ['type,id,name,manual,ai,imported,other,annotations,working_time'];
    const toRow = (type: string, row: StatisticsRow): string => (
        [
            type,
            row.id,
            csvCell(row.name),
            kindValue(row, 'manual'),
            kindValue(row, 'ai'),
            kindValue(row, 'imported'),
            kindValue(row, 'other'),
            row.annotations,
            formatWorkingTime(row.working_ms),
        ].join(',')
    );
    const userRows = stats.users.map((user) => toRow('user', user));
    const taskRows = (stats.tasks || []).map((task) => toRow('task', task));
    const blob = new Blob([[header, ...userRows, ...taskRows].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'annotation-statistics.csv';
    link.click();
    URL.revokeObjectURL(url);
}

function Panel(props: { title: React.ReactNode; children: React.ReactNode }): JSX.Element {
    const { title, children } = props;
    return (
        <div className='cvat-statistics-panel'>
            <div className='cvat-statistics-panel-title'>{title}</div>
            {children}
        </div>
    );
}

function truncateLabel(name: string, max = 24): string {
    if (name.length <= max) {
        return name;
    }
    return `${name.slice(0, max - 1)}…`;
}

export default function StatisticsPage(): JSX.Element {
    const [range, setRange] = useState<[Dayjs, Dayjs]>([
        dayjs().subtract(30, 'day').startOf('day'),
        dayjs().endOf('day'),
    ]);
    const [projectId, setProjectId] = useState<number | null>(null);
    const [taskId, setTaskId] = useState<number | null>(null);
    const [projects, setProjects] = useState<{ id: number; name: string }[]>([]);
    const [tasks, setTasks] = useState<{ id: number; name: string }[]>([]);
    const [groupBy, setGroupBy] = useState<GroupBy>('account');
    const [fetching, setFetching] = useState(true);
    const [stats, setStats] = useState<SerializedAnnotationStatistics | null>(null);
    const [error, setError] = useState<string>('');
    const organizationSlug = useSelector((state: CombinedState) => state.organizations.current?.slug ?? null);

    const load = useCallback(async (): Promise<void> => {
        setFetching(true);
        setError('');
        try {
            const filter: AnalyticsEventsFilter = {
                from: range[0].toISOString(),
                to: range[1].toISOString(),
            };
            if (projectId) {
                filter.projectId = projectId;
            }
            if (taskId) {
                filter.taskId = taskId;
            }
            const result = await core.analytics.events.statistics(filter);
            setStats(result);
        } catch (err: any) {
            setStats(null);
            setError(err?.message || 'Failed to load annotation statistics');
        } finally {
            setFetching(false);
        }
    }, [range, projectId, taskId, organizationSlug]);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        core.projects.searchNames('', 100).then((result: { id: number; name: string }[]) => {
            if (result) {
                setProjects(result);
            }
        }).catch(() => {
            setProjects([]);
        });
    }, [organizationSlug]);

    const loadTasks = useCallback((): void => {
        const filter: { page: number; pageSize: number; projectId?: number; ordering: string } = {
            page: 1,
            pageSize: 200,
            ordering: '-updated_date',
        };
        if (projectId) {
            filter.projectId = projectId;
        }
        core.tasks.get(filter).then((result: Task[]) => {
            const next = (result || []).map((task) => ({
                id: task.id as number,
                name: task.name || `Task #${task.id}`,
            }));
            setTasks(next);
        }).catch(() => {
            setTasks([]);
        });
    }, [projectId]);

    useEffect(() => {
        loadTasks();
    }, [loadTasks, organizationSlug]);

    const taskOptions = useMemo(() => {
        const byId = new Map<number, string>();
        tasks.forEach((task) => byId.set(task.id, task.name));
        (stats?.tasks || []).forEach((task) => {
            if (!byId.has(task.id)) {
                byId.set(task.id, task.name);
            }
        });
        return Array.from(byId, ([id, name]) => ({ id, name }));
    }, [tasks, stats]);

    const groupedRows = useMemo<StatisticsRow[]>(() => {
        if (!stats) {
            return [];
        }
        return groupBy === 'task' ? (stats.tasks || []) : stats.users;
    }, [stats, groupBy]);

    const barData = useMemo(() => {
        const rows = groupedRows.slice(0, 20);
        const stacked = {
            borderRadius: 3,
            maxBarThickness: 18,
            stack: 'source',
        };
        return {
            labels: rows.map((row) => truncateLabel(row.name)),
            datasets: [
                {
                    label: 'Manual',
                    data: rows.map((row) => kindValue(row, 'manual')),
                    backgroundColor: CHART_BLUE,
                    ...stacked,
                },
                {
                    label: 'AI',
                    data: rows.map((row) => kindValue(row, 'ai')),
                    backgroundColor: CHART_GOLD,
                    ...stacked,
                },
                {
                    label: 'Imported',
                    data: rows.map((row) => kindValue(row, 'imported')),
                    backgroundColor: CHART_PURPLE,
                    ...stacked,
                },
            ],
        };
    }, [groupedRows]);

    const lineData = useMemo(() => ({
        labels: (stats?.daily || []).map((item) => item.date.slice(5)),
        datasets: [
            {
                label: 'Manual',
                data: (stats?.daily || []).map((item) => item.manual || 0),
                borderColor: CHART_BLUE,
                backgroundColor: 'rgba(24, 144, 255, 0.12)',
                pointRadius: 2,
                pointHoverRadius: 4,
                borderWidth: 2,
                tension: 0.25,
            },
            {
                label: 'AI / import',
                data: (stats?.daily || []).map((item) => (
                    (item.ai || 0) + (item.imported || 0) + (item.other || 0)
                )),
                borderColor: CHART_GOLD,
                backgroundColor: 'rgba(250, 173, 20, 0.12)',
                pointRadius: 2,
                pointHoverRadius: 4,
                borderWidth: 2,
                tension: 0.25,
            },
        ],
    }), [stats]);

    const pieData = useMemo(() => {
        const totals = stats?.totals;
        const slices = [
            { label: 'Manual', value: totals?.manual || 0, color: CHART_BLUE },
            { label: 'AI', value: totals?.ai || 0, color: CHART_GOLD },
            { label: 'Imported', value: totals?.imported || 0, color: CHART_PURPLE },
            { label: 'Other', value: totals?.other || 0, color: CHART_GRAY },
        ].filter((slice) => slice.value > 0);
        return {
            labels: slices.map((slice) => slice.label),
            datasets: [{
                data: slices.map((slice) => slice.value),
                backgroundColor: slices.map((slice) => slice.color),
                borderWidth: 0,
            }],
        };
    }, [stats]);

    const empty = !fetching && (!stats || (!stats.users.length && !(stats.tasks || []).length));
    const canExport = Boolean(stats?.users.length || stats?.tasks?.length);

    return (
        <div className='cvat-statistics-page'>
            <div className='cvat-statistics-header'>
                <Title level={4} className='cvat-statistics-title'>
                    Annotation statistics
                    <Tooltip title='Manual is drawn or SAM-assisted. AI is automatic annotation (source=auto). Imported is dataset upload (source=file). Working time is time spent in the editor. Counts create events, not the current object inventory.'>
                        <QuestionCircleOutlined />
                    </Tooltip>
                </Title>
                <div className='cvat-statistics-filters'>
                    <DatePicker.RangePicker
                        size='small'
                        value={range}
                        allowClear={false}
                        className='cvat-statistics-date-picker'
                        onChange={(value) => {
                            if (value?.[0] && value?.[1]) {
                                setRange([value[0].startOf('day'), value[1].endOf('day')]);
                            }
                        }}
                    />
                    <Select
                        allowClear
                        showSearch
                        size='small'
                        placeholder='All projects'
                        className='cvat-statistics-project-filter'
                        optionFilterProp='label'
                        value={projectId ?? undefined}
                        onChange={(value: number | undefined) => {
                            setProjectId(value ?? null);
                            setTaskId(null);
                        }}
                        options={projects.map((project) => ({
                            value: project.id,
                            label: project.name,
                        }))}
                    />
                    <Select
                        allowClear
                        showSearch
                        size='small'
                        placeholder='All tasks'
                        className='cvat-statistics-task-filter'
                        optionFilterProp='label'
                        value={taskId ?? undefined}
                        onDropdownVisibleChange={(open: boolean) => {
                            if (open) {
                                loadTasks();
                            }
                        }}
                        onChange={(value: number | undefined) => setTaskId(value ?? null)}
                        options={taskOptions.map((task) => ({
                            value: task.id,
                            label: task.name,
                        }))}
                    />
                    <Radio.Group
                        size='small'
                        className='cvat-statistics-group-by'
                        value={groupBy}
                        onChange={(event: RadioChangeEvent) => setGroupBy(event.target.value)}
                    >
                        <Radio.Button value='account'>Account</Radio.Button>
                        <Radio.Button value='task'>Task</Radio.Button>
                    </Radio.Group>
                    <Button
                        size='small'
                        icon={<DownloadOutlined />}
                        disabled={!canExport}
                        onClick={(): void => {
                            if (stats) {
                                downloadCsv(stats);
                            }
                        }}
                    >
                        Export CSV
                    </Button>
                </div>
            </div>

            {error ? (
                <Alert type='error' showIcon message={error} className='cvat-statistics-alert' />
            ) : null}
            {stats && !stats.available ? (
                <Alert
                    type='warning'
                    showIcon
                    className='cvat-statistics-alert'
                    message={stats.message || 'Events database is unavailable.'}
                />
            ) : null}

            {fetching ? (
                <div className='cvat-statistics-spinner'>
                    <Spin size='large' className='cvat-spinner' />
                </div>
            ) : null}

            {!fetching && stats ? (
                <>
                    <div className='cvat-statistics-kpis'>
                        <Card size='small' bordered>
                            <Statistic
                                title='Manual annotations'
                                value={stats.totals.manual || 0}
                                prefix={<EditOutlined />}
                            />
                        </Card>
                        <Card size='small' bordered>
                            <Statistic
                                title='AI annotations'
                                value={stats.totals.ai || 0}
                                prefix={<ThunderboltOutlined />}
                            />
                        </Card>
                        <Card size='small' bordered>
                            <Statistic
                                title='Imported'
                                value={stats.totals.imported || 0}
                                prefix={<ImportOutlined />}
                            />
                        </Card>
                        <Card size='small' bordered>
                            <Statistic
                                title='Working time'
                                value={formatWorkingTime(stats.totals.working_ms)}
                                prefix={<FieldTimeOutlined />}
                            />
                        </Card>
                    </div>

                    {empty ? (
                        <div className='cvat-statistics-empty'>
                            <Empty description='No annotation events in this period' />
                        </div>
                    ) : (
                        <div className='cvat-statistics-grid'>
                            <Panel title={groupBy === 'task' ? 'By task (manual / AI / import)' : 'By account (manual / AI / import)'}>
                                <div className='cvat-statistics-chart-wrap'>
                                    <Bar
                                        data={barData}
                                        options={{
                                            indexAxis: 'y',
                                            responsive: true,
                                            maintainAspectRatio: false,
                                            plugins: {
                                                legend: {
                                                    display: true,
                                                    position: 'bottom',
                                                    labels: { boxWidth: 10, font: { size: 11 } },
                                                },
                                            },
                                            scales: {
                                                x: { beginAtZero: true, stacked: true, ...compactAxis },
                                                y: {
                                                    stacked: true,
                                                    ticks: { font: { size: 11 } },
                                                    grid: { display: false },
                                                },
                                            },
                                        }}
                                    />
                                </div>
                            </Panel>
                            <Panel title='Manual / AI / imported'>
                                <div className='cvat-statistics-chart-wrap'>
                                    <Doughnut
                                        data={pieData}
                                        options={{
                                            responsive: true,
                                            maintainAspectRatio: false,
                                            cutout: '62%',
                                            plugins: {
                                                legend: {
                                                    position: 'right',
                                                    labels: { boxWidth: 10, font: { size: 11 } },
                                                },
                                            },
                                        }}
                                    />
                                </div>
                            </Panel>
                            <Panel title='Annotations by day'>
                                <div className='cvat-statistics-chart-wrap'>
                                    <Line
                                        data={lineData}
                                        options={{
                                            responsive: true,
                                            maintainAspectRatio: false,
                                            plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } },
                                            scales: {
                                                x: compactAxis,
                                                y: { beginAtZero: true, ...compactAxis },
                                            },
                                        }}
                                    />
                                </div>
                            </Panel>
                            <Panel title={groupBy === 'task' ? 'Tasks' : 'Accounts'}>
                                <div className='cvat-statistics-table-wrap'>
                                    <Table
                                        size='small'
                                        rowKey='id'
                                        pagination={false}
                                        dataSource={groupedRows}
                                        locale={{
                                            emptyText: groupBy === 'task' ?
                                                'No task events in this period' : undefined,
                                        }}
                                        columns={[
                                            {
                                                title: groupBy === 'task' ? 'Task' : 'Account',
                                                dataIndex: 'name',
                                                ellipsis: true,
                                                width: 110,
                                            },
                                            {
                                                title: 'Manual',
                                                dataIndex: 'manual',
                                                align: 'right',
                                                width: 80,
                                                render: (value: number) => (value || 0).toLocaleString(),
                                            },
                                            {
                                                title: 'AI',
                                                dataIndex: 'ai',
                                                align: 'right',
                                                width: 64,
                                                render: (value: number) => (value || 0).toLocaleString(),
                                            },
                                            {
                                                title: 'Import',
                                                dataIndex: 'imported',
                                                align: 'right',
                                                width: 72,
                                                render: (value: number) => (value || 0).toLocaleString(),
                                            },
                                            {
                                                title: 'Other',
                                                dataIndex: 'other',
                                                align: 'right',
                                                width: 64,
                                                render: (value: number) => (value || 0).toLocaleString(),
                                            },
                                            {
                                                title: 'Time',
                                                dataIndex: 'working_ms',
                                                align: 'right',
                                                width: 72,
                                                render: (value: number) => formatWorkingTime(value),
                                            },
                                        ]}
                                    />
                                </div>
                            </Panel>
                        </div>
                    )}
                </>
            ) : null}
        </div>
    );
}
