import React, { useMemo, useCallback } from 'react';
import Drawer from 'antd/lib/drawer';
import Tabs from 'antd/lib/tabs';
import Button from 'antd/lib/button';
import Space from 'antd/lib/space';
import Tag from 'antd/lib/tag';
import Typography from 'antd/lib/typography';
import Divider from 'antd/lib/divider';
import List from 'antd/lib/list';
import Collapse from 'antd/lib/collapse';
import { RollbackOutlined, CopyOutlined } from '@ant-design/icons';
import message from 'antd/lib/message';
import dayjs from 'dayjs';
import { useHistory } from 'react-router';

import { AcceptanceRecordData, buildJobFrameURL } from './acceptance-api';
import { buildAcceptanceDiff, DiffItem } from './acceptance-diff';
import { CORRECTION_COPY } from './copy';

const { TabPane } = Tabs;
const { Text, Title } = Typography;
const { Panel } = Collapse;

interface AcceptanceCompareDrawerProps {
    visible: boolean;
    onClose: () => void;
    record: AcceptanceRecordData | null;
    onJumpToFrame?: (record: AcceptanceRecordData) => void;
}

const KIND_COLOR: Record<string, string> = {
    added: 'green',
    removed: 'red',
    modified: 'orange',
    unchanged: 'default',
};

function formatJSON(data: any): string {
    return JSON.stringify(data, null, 2);
}

function DiffList({ items }: { items: DiffItem[] }): JSX.Element {
    if (!items.length) {
        return <Text type='secondary'>No object-level differences.</Text>;
    }
    return (
        <List
            size='small'
            dataSource={items}
            renderItem={(item) => (
                <List.Item>
                    <Space align='start'>
                        <Tag color={KIND_COLOR[item.kind]}>{item.kind}</Tag>
                        <div>
                            <div>
                                <Text strong>{item.label}</Text>
                                <Text type='secondary'>
                                    {' '}
                                    ·
                                    {item.objectType}
                                </Text>
                            </div>
                            <Text type='secondary'>{item.summary}</Text>
                            {item.frame != null && (
                                <div>
                                    <Text type='secondary'>
                                        Frame #
                                        {item.frame}
                                    </Text>
                                </div>
                            )}
                        </div>
                    </Space>
                </List.Item>
            )}
        />
    );
}

function AcceptanceCompareDrawer(props: AcceptanceCompareDrawerProps): JSX.Element {
    const { visible, onClose, record, onJumpToFrame } = props;
    const history = useHistory();

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

    const handleJump = useCallback(() => {
        if (!record) return;
        if (onJumpToFrame) onJumpToFrame(record);
        else history.push(buildJobFrameURL(record.task_id, record.job, record.frame, record.id));
    }, [record, onJumpToFrame, history]);

    const copySnapshot = useCallback((data: any, label: string) => {
        navigator.clipboard.writeText(formatJSON(data))
            .then(() => message.success(`${label} copied`))
            .catch(() => message.error('Copy failed'));
    }, []);

    return (
        <Drawer
            title={(
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingRight: 40 }}>
                    <span>
                        {CORRECTION_COPY.compareTitle(record?.id || '-')}
                    </span>
                    <Button type='primary' icon={<RollbackOutlined />} onClick={handleJump} disabled={!record}>
                        Open frame
                    </Button>
                </div>
            )}
            placement='right'
            width={720}
            open={visible}
            onClose={onClose}
            destroyOnClose
            className='cvat-acceptance-compare-drawer'
        >
            {record && (
                <div>
                    <Space wrap style={{ marginBottom: 12 }}>
                        <Tag>Job #{record.job}</Tag>
                        <Tag>Frame #{record.frame}</Tag>
                        <Tag color='blue'>{record.action_type}</Tag>
                        <Tag>{record.reviewer?.username || 'N/A'}</Tag>
                        <Text type='secondary'>{dayjs(record.created_date).format('YYYY-MM-DD HH:mm')}</Text>
                    </Space>

                    {record.description && (
                        <p style={{ marginBottom: 16 }}>
                            <Text strong>Note: </Text>
                            {record.description}
                        </p>
                    )}

                    <Title level={5} style={{ marginTop: 0 }}>{diff.headline}</Title>
                    <Space wrap style={{ marginBottom: 16 }}>
                        <Tag color='green'>+{diff.added} added</Tag>
                        <Tag color='red'>-{diff.removed} removed</Tag>
                        <Tag color='orange'>{diff.modified} modified</Tag>
                        <Tag>{diff.unchanged} unchanged</Tag>
                    </Space>

                    <Tabs defaultActiveKey='changes'>
                        <TabPane tab='Changes' key='changes'>
                            <DiffList items={diff.items} />
                        </TabPane>
                        <TabPane tab='Counts' key='counts'>
                            <Space direction='vertical'>
                                <Text>
                                    Shapes:
                                    {' '}
                                    {record.shape_count_before}
                                    {' → '}
                                    {record.shape_count_after}
                                </Text>
                                <Text>
                                    Tags:
                                    {' '}
                                    {record.tag_count_before}
                                    {' → '}
                                    {record.tag_count_after}
                                </Text>
                                <Text>
                                    Tracks:
                                    {' '}
                                    {record.track_count_before}
                                    {' → '}
                                    {record.track_count_after}
                                </Text>
                            </Space>
                        </TabPane>
                        <TabPane tab='Raw JSON' key='json'>
                            <Collapse ghost>
                                <Panel
                                    header={(
                                        <Space>
                                            {CORRECTION_COPY.originalJson}
                                            <Button
                                                size='small'
                                                icon={<CopyOutlined />}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    copySnapshot(beforeSnapshot?.data, 'Original');
                                                }}
                                            />
                                        </Space>
                                    )}
                                    key='before'
                                >
                                    <pre className='cvat-acceptance-json-block'>
                                        {beforeSnapshot?.data ? formatJSON(beforeSnapshot.data) : '—'}
                                    </pre>
                                </Panel>
                                <Panel
                                    header={(
                                        <Space>
                                            {CORRECTION_COPY.correctedJson}
                                            <Button
                                                size='small'
                                                icon={<CopyOutlined />}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    copySnapshot(afterSnapshot?.data, 'Corrected');
                                                }}
                                            />
                                        </Space>
                                    )}
                                    key='after'
                                >
                                    <pre className='cvat-acceptance-json-block'>
                                        {afterSnapshot?.data ? formatJSON(afterSnapshot.data) : '—'}
                                    </pre>
                                </Panel>
                            </Collapse>
                        </TabPane>
                    </Tabs>
                    <Divider />
                    <Text type='secondary'>
                        {CORRECTION_COPY.compareTip}
                    </Text>
                </div>
            )}
        </Drawer>
    );
}

export default AcceptanceCompareDrawer;
