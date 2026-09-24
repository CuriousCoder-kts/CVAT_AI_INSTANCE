import React, { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { Col, Row } from 'antd/lib/grid';
import Card from 'antd/lib/card';
import Empty from 'antd/lib/empty';
import Form from 'antd/lib/form';
import Input from 'antd/lib/input';
import Button from 'antd/lib/button';
import Spin from 'antd/lib/spin';
import Text from 'antd/lib/typography/Text';
import notification from 'antd/lib/notification';
import { CombinedState } from 'reducers';
import { Organization } from 'cvat-core-wrapper';

interface FormValues {
    apiUrl: string;
    model: string;
    apiKey?: string;
}

function OrganizationBailianPage(): JSX.Element {
    const organization = useSelector((state: CombinedState) => state.organizations.current);
    const [form] = Form.useForm<FormValues>();
    const [fetching, setFetching] = useState(true);
    const [saving, setSaving] = useState(false);
    const [hasApiKey, setHasApiKey] = useState(false);
    const [updatedDate, setUpdatedDate] = useState<string | null>(null);
    const [updatedBy, setUpdatedBy] = useState<string | null>(null);
    const [forbidden, setForbidden] = useState(false);

    function extractErrorText(error: unknown): string {
        if (error instanceof Error) {
            return error.message || error.name || 'Unknown error';
        }
        if (typeof error === 'object' && error !== null && 'message' in error) {
            const v = (error as any).message;
            if (typeof v === 'string' && v.length) return v;
        }
        const code = typeof error === 'object' && error !== null && 'code' in error ? (error as any).code : null;
        return code ? `HTTP ${code}` : 'Unknown error';
    }

    function sanitizeErrorDescription(raw: string): string {
        const htmlStripped = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return htmlStripped.length <= 160 ? htmlStripped : `${htmlStripped.slice(0, 157)}...`;
    }

    const fetchSettings = useCallback(async (org: Organization) => {
        setFetching(true);
        try {
            setForbidden(false);
            const settings = await org.bailianSettings();
            form.setFieldsValue({
                apiUrl: settings.apiUrl,
                model: settings.model,
                apiKey: undefined,
            });
            setHasApiKey(settings.hasApiKey);
            setUpdatedDate(settings.updatedDate);
            setUpdatedBy(settings.updatedBy ? settings.updatedBy.username : null);
        } catch (error: unknown) {
            const errorCode = typeof error === 'object' && error !== null && 'code' in error ? (error as any).code : null;
            if (errorCode === 403) {
                setForbidden(true);
                return;
            }
            notification.error({
                message: 'Could not load Bailian settings',
                description: sanitizeErrorDescription(extractErrorText(error)),
            });
        } finally {
            setFetching(false);
        }
    }, []);

    useEffect(() => {
        if (organization) {
            fetchSettings(organization);
        } else {
            setFetching(false);
        }
    }, [organization]);

    const onFinish = useCallback(async (values: FormValues) => {
        if (!organization || forbidden) return;
        setSaving(true);
        try {
            const payload: { apiUrl?: string; model?: string; apiKey?: string } = {
                apiUrl: values.apiUrl,
                model: values.model,
            };
            if (values.apiKey) {
                payload.apiKey = values.apiKey;
            }
            const settings = await organization.updateBailianSettings(payload);
            form.setFieldsValue({ apiKey: undefined });
            setHasApiKey(settings.hasApiKey);
            setUpdatedDate(settings.updatedDate);
            setUpdatedBy(settings.updatedBy ? settings.updatedBy.username : null);
            notification.success({ message: 'Bailian settings saved' });
        } catch (error: unknown) {
            const errorCode = typeof error === 'object' && error !== null && 'code' in error ? (error as any).code : null;
            if (errorCode === 403) {
                setForbidden(true);
                return;
            }
            notification.error({
                message: 'Could not save Bailian settings',
                description: error instanceof Error ? error.message : 'Unknown error',
            });
        } finally {
            setSaving(false);
        }
    }, [organization, forbidden]);

    const onClearApiKey = useCallback(async () => {
        if (!organization || forbidden) return;
        setSaving(true);
        try {
            const settings = await organization.updateBailianSettings({ apiKey: null });
            form.setFieldsValue({ apiKey: undefined });
            setHasApiKey(settings.hasApiKey);
            setUpdatedDate(settings.updatedDate);
            setUpdatedBy(settings.updatedBy ? settings.updatedBy.username : null);
            notification.success({ message: 'API key cleared' });
        } catch (error: unknown) {
            const errorCode = typeof error === 'object' && error !== null && 'code' in error ? (error as any).code : null;
            if (errorCode === 403) {
                setForbidden(true);
                return;
            }
            notification.error({
                message: 'Could not clear API key',
                description: error instanceof Error ? error.message : 'Unknown error',
            });
        } finally {
            setSaving(false);
        }
    }, [organization, forbidden]);

    if (!organization) {
        return <Empty description='You are not in an organization' />;
    }

    if (fetching) {
        return <Spin className='cvat-spinner' />;
    }

    if (forbidden) {
        return (
            <Row justify='center' style={{ padding: '24px' }}>
                <Col span={18}>
                    <Alert
                        type='info'
                        showIcon
                        message='View only'
                        description='Current role does not have permission to modify organization-level Bailian settings. Only owner or maintainer can update these fields. You can still view the configuration and use AI models in Automatic annotation dialogs.'
                    />
                    <Card title='Bailian settings' bordered style={{ marginTop: 16 }}>
                        <Row style={{ marginBottom: '12px' }}>
                            <Col span={24}>
                                <Text type='secondary'>
                                    {`API key configured: ${hasApiKey ? 'yes' : 'no'}`}
                                    {updatedDate ? `, updated: ${updatedDate}` : ''}
                                    {updatedBy ? `, by: ${updatedBy}` : ''}
                                </Text>
                            </Col>
                        </Row>
                        <Form form={form} layout='vertical'>
                            <Form.Item
                                name='apiUrl'
                                label='API URL'
                            >
                                <Input readOnly placeholder='https://...' />
                            </Form.Item>
                            <Form.Item
                                name='model'
                                label='Model'
                            >
                                <Input readOnly placeholder='qwen3-vl-plus' />
                            </Form.Item>
                            <Form.Item
                                name='apiKey'
                                label='API Key'
                            >
                                <Input.Password readOnly placeholder={hasApiKey ? '••••••••' : 'Not configured'} />
                            </Form.Item>
                        </Form>
                    </Card>
                </Col>
            </Row>
        );
    }

    return (
        <Row justify='center' style={{ padding: '24px' }}>
            <Col span={18}>
                <Card title='Bailian settings' bordered>
                    <Row style={{ marginBottom: '12px' }}>
                        <Col span={24}>
                            <Text type='secondary'>
                                {`API key configured: ${hasApiKey ? 'yes' : 'no'}`}
                                {updatedDate ? `, updated: ${updatedDate}` : ''}
                                {updatedBy ? `, by: ${updatedBy}` : ''}
                            </Text>
                        </Col>
                    </Row>
                    <Form form={form} layout='vertical' onFinish={onFinish}>
                        <Form.Item
                            name='apiUrl'
                            label='API URL'
                            rules={[{ required: false }]}
                        >
                            <Input placeholder='https://...' />
                        </Form.Item>
                        <Form.Item
                            name='model'
                            label='Model'
                            rules={[{ required: false }]}
                        >
                            <Input placeholder='qwen3-vl-plus' />
                        </Form.Item>
                        <Form.Item
                            name='apiKey'
                            label='API Key'
                            rules={[{ required: false }]}
                        >
                            <Input.Password placeholder={hasApiKey ? '•••••••• (leave empty to keep unchanged)' : ''} />
                        </Form.Item>
                        <Row justify='end' gutter={8}>
                            <Col>
                                <Button danger onClick={onClearApiKey} loading={saving} disabled={!hasApiKey}>
                                    Clear key
                                </Button>
                            </Col>
                            <Col>
                                <Button type='primary' htmlType='submit' loading={saving}>
                                    Save
                                </Button>
                            </Col>
                        </Row>
                    </Form>
                </Card>
            </Col>
        </Row>
    );
}

export default React.memo(OrganizationBailianPage);
