import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { useHistory } from 'react-router';
import { Col, Row } from 'antd/lib/grid';
import Card from 'antd/lib/card';
import Statistic from 'antd/lib/statistic';
import Input from 'antd/lib/input';
import Button from 'antd/lib/button';
import Select from 'antd/lib/select';
import Radio from 'antd/lib/radio';
import Divider from 'antd/lib/divider';
import Space from 'antd/lib/space';
import Tag from 'antd/lib/tag';
import Tooltip from 'antd/lib/tooltip';
import Typography from 'antd/lib/typography';
import { ArrowLeftOutlined, PlusOutlined, ThunderboltFilled, DatabaseFilled, ControlFilled, StarFilled } from '@ant-design/icons';
import { CombinedState } from 'reducers';
import { Organization, AIFunctionInstance } from 'cvat-core-wrapper';
import type { AIFeatureKind, AIProviderKind } from 'cvat-core-wrapper';
import { FEATURE_KIND_META, PROVIDER_META, bcResolveLabelSpec } from './instance-card';
import AIFunctionInstanceCard from './instance-card';

const { Title, Text } = Typography;

export default function AIFeaturesListPage(): JSX.Element {
    const organization = useSelector((state: CombinedState) => state.organizations.current) as Organization | null;
    const history = useHistory();
    const [loading, setLoading] = useState(true);
    const [instances, setInstances] = useState<AIFunctionInstance[]>([]);
    const [outputFilter, setOutputFilter] = useState<AIFeatureKind | 'all'>('all');
    const [providerFilter, setProviderFilter] = useState<AIProviderKind | 'all'>('all');
    const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
    const [defaultsFilter, setDefaultsFilter] = useState<'all' | 'only'>('all');
    const [search, setSearch] = useState('');
    const [mutateCounter, setMutateCounter] = useState(0);

    const reload = useCallback(async () => {
        if (!organization) return;
        try {
            setLoading(true);
            const list = await organization.listAIFunctionInstances({ limit: 100 });
            const arr: any = list;
            const results: AIFunctionInstance[] = Array.isArray(arr)
                ? (arr as AIFunctionInstance[])
                : (arr && Array.isArray(arr.results) ? arr.results : []);
            setInstances(results);
        } finally {
            setLoading(false);
        }
    }, [organization]);

    useEffect(() => { reload(); }, [reload, mutateCounter]);

    const stats = useMemo(() => {
        const total = instances.length;
        const enabled = instances.filter((x) => x.isEnabled).length;
        const disabled = total - enabled;
        const defaults = instances.filter((x) => x.isDefault).length;
        return { total, enabled, disabled, defaults };
    }, [instances]);

    const filtered = useMemo(() => {
        const s = search.trim().toLowerCase();
        return instances.filter((i) => {
            if (outputFilter !== 'all' && i.featureKind !== outputFilter) return false;
            if (providerFilter !== 'all' && i.provider !== providerFilter) return false;
            if (statusFilter === 'enabled' && !i.isEnabled) return false;
            if (statusFilter === 'disabled' && i.isEnabled) return false;
            if (defaultsFilter === 'only' && !i.isDefault) return false;
            if (s && !(
                String(i.slug || '').toLowerCase().includes(s) ||
                String(i.name || '').toLowerCase().includes(s) ||
                String(i.provider || '').toLowerCase().includes(s) ||
                String((i.config as any)?.model || '').toLowerCase().includes(s)
            )) return false;
            return true;
        });
    }, [instances, outputFilter, providerFilter, statusFilter, defaultsFilter, search]);

    const grouped = useMemo(() => {
        const g: Record<string, AIFunctionInstance[]> = {};
        for (const i of filtered) {
            if (!g[i.featureKind]) g[i.featureKind] = [];
            g[i.featureKind].push(i);
        }
        return g;
    }, [filtered]);

    const providers = useMemo(() => {
        const s = new Set<string>();
        for (const i of instances) if (i.provider) s.add(i.provider);
        return Array.from(s) as AIProviderKind[];
    }, [instances]);

    const onMutate = useCallback(() => setMutateCounter((v) => v + 1), []);

    return (
        <div className='cvat-ai-features-page'>
            <Card size='small' bordered className='cvat-page-header-card'>
                <Row align='middle' gutter={[12, 8]}>
                    <Col flex='none'>
                        <Button icon={<ArrowLeftOutlined />} onClick={() => history.push('/organization')}>Back</Button>
                    </Col>
                    <Col flex='auto'>
                        <Title level={4} style={{ margin: 0 }}>AI Function Instances (Prompt-Driven)</Title>
                        <Text type='secondary'>
                            Organization: {organization?.name || organization?.slug || ''}
                            {'  ·  Prompt-driven VLM integration — configure once, use everywhere in annotation flows.'}
                        </Text>
                    </Col>
                    <Col flex='none'>
                        <Space size={[8, 8]} wrap>
                            <Tooltip title='Open preset library (read-only reference for object_detector and image_caption prompt bundles)'>
                                <Button disabled>Preset library</Button>
                            </Tooltip>
                            <Button type='primary' icon={<PlusOutlined />} onClick={() => history.push('/organization/ai-features/new')}>
                                New instance
                            </Button>
                        </Space>
                    </Col>
                </Row>
            </Card>

            <Row gutter={[12, 12]} className='cvat-ai-features-stats'>
                <Col xs={12} sm={6}>
                    <Card bordered size='small'>
                        <Statistic title='Total instances' value={stats.total} prefix={<ThunderboltFilled />} />
                    </Card>
                </Col>
                <Col xs={12} sm={6}>
                    <Card bordered size='small'>
                        <Statistic title='Enabled' value={stats.enabled} valueStyle={{ color: '#3f8600' }} prefix={<StarFilled />} />
                    </Card>
                </Col>
                <Col xs={12} sm={6}>
                    <Card bordered size='small'>
                        <Statistic title='Disabled' value={stats.disabled} valueStyle={{ color: '#cf1322' }} prefix={<ControlFilled />} />
                    </Card>
                </Col>
                <Col xs={12} sm={6}>
                    <Card bordered size='small'>
                        <Statistic title='Defaults' value={stats.defaults} valueStyle={{ color: '#1890ff' }} prefix={<DatabaseFilled />} />
                    </Card>
                </Col>
            </Row>

            <Card bordered size='small' className='cvat-ai-features-filter-card'>
                <Row align='middle' gutter={[12, 8]}>
                    <Col xs={24} md={14}>
                        <Space wrap size={[12, 8]} split={<Divider type='vertical' />}>
                            <span className='filter-label'>Output type:</span>
                            <Radio.Group
                                size='small'
                                value={outputFilter}
                                onChange={(e) => setOutputFilter(e.target.value as any)}
                            >
                                <Radio.Button value='all'>All</Radio.Button>
                                {Object.entries(FEATURE_KIND_META).map(([k, meta]) => (
                                    <Radio.Button key={k} value={k}>{meta.label}</Radio.Button>
                                ))}
                            </Radio.Group>

                            <span className='filter-label'>Provider:</span>
                            <Select
                                size='small'
                                style={{ minWidth: 140 }}
                                value={providerFilter}
                                onChange={(v) => setProviderFilter(v as any)}
                                options={[
                                    { value: 'all', label: 'All' },
                                    ...providers.map((p) => ({ value: p, label: PROVIDER_META[p]?.label || p })),
                                ]}
                            />
                        </Space>
                    </Col>
                    <Col xs={24} md={10}>
                        <Space wrap size={[12, 8]}>
                            <span className='filter-label'>Status:</span>
                            <Radio.Group size='small' value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}>
                                <Radio.Button value='all'>All</Radio.Button>
                                <Radio.Button value='enabled'>Enabled</Radio.Button>
                                <Radio.Button value='disabled'>Disabled</Radio.Button>
                            </Radio.Group>

                            <span className='filter-label'>Defaults:</span>
                            <Select
                                size='small'
                                style={{ width: 100 }}
                                value={defaultsFilter}
                                onChange={(v) => setDefaultsFilter(v as any)}
                                options={[
                                    { value: 'all', label: 'All' },
                                    { value: 'only', label: 'Only defaults' },
                                ]}
                            />

                            <Input.Search
                                size='small'
                                allowClear
                                placeholder='name / slug / model / co…'
                                style={{ width: 220 }}
                                onSearch={(v) => setSearch(v)}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                        </Space>
                    </Col>
                </Row>
            </Card>

            {Object.keys(grouped).length === 0 ? (
                <Card bordered style={{ textAlign: 'center', padding: '48px 16px' }}>
                    <Text type='secondary'>No AI function instances match your filters.</Text>
                    <br /><br />
                    <Button type='primary' icon={<PlusOutlined />} onClick={() => history.push('/organization/ai-features/new')}>
                        Create your first instance
                    </Button>
                </Card>
            ) : (
                Object.entries(grouped).map(([kind, list]) => {
                    const meta = FEATURE_KIND_META[kind] || { label: kind, color: 'default', desc: '' };
                    return (
                        <React.Fragment key={kind}>
                            <div className='section-header'>
                                <Title level={5} className='section-title'>
                                    <Tag color={meta.color}>{meta.label}</Tag>
                                </Title>
                                <div className='section-desc'>{meta.desc}</div>
                                <Tag className='section-count'>{list.length} instance{list.length === 1 ? '' : 's'}</Tag>
                            </div>
                            <Row gutter={[16, 16]}>
                                {list.map((inst) => (
                                    <Col key={inst.id || inst.slug} xs={24} md={12} xl={8} xxl={6}>
                                        <AIFunctionInstanceCard
                                            organization={organization!}
                                            instance={inst}
                                            onMutate={onMutate}
                                        />
                                    </Col>
                                ))}
                            </Row>
                        </React.Fragment>
                    );
                })
            )}
        </div>
    );
}
