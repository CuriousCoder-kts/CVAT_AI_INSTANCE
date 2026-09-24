// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useState } from 'react';
import { useForm } from 'antd/lib/form/Form';
import Form from 'antd/lib/form';
import { Row, Col } from 'antd/lib/grid';
import Modal from 'antd/lib/modal';
import Paragraph from 'antd/lib/typography/Paragraph';
import Text from 'antd/lib/typography/Text';
import Select from 'antd/lib/select';
import { Store } from 'antd/lib/form/interface';
import {
    DeleteOutlined, PlusCircleOutlined, ReloadOutlined, DownloadOutlined, CopyOutlined,
} from '@ant-design/icons';
import Button from 'antd/lib/button';
import Input from 'antd/lib/input';
import Tooltip from 'antd/lib/tooltip';
import Table from 'antd/lib/table';
import Alert from 'antd/lib/alert';
import Tag from 'antd/lib/tag';
import Space from 'antd/lib/space';
import notification from 'antd/lib/notification';
import { toClipboard } from 'utils/to-clipboard';

interface Props {
    onCreate: (values: Store, onFinish: (result: any) => void) => void;
    onCancel: () => void;
    currentUserRole: 'owner' | 'maintainer' | 'supervisor' | 'worker' | null;
}

const generatePassword = (length = 16): string => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
    let pwd = '';
    const arr = new Uint32Array(length);
    if (typeof window !== 'undefined' && window.crypto) {
        window.crypto.getRandomValues(arr);
        for (let i = 0; i < length; i++) {
            pwd += chars[arr[i] % chars.length];
        }
    } else {
        for (let i = 0; i < length; i++) {
            pwd += chars[Math.floor(Math.random() * chars.length)];
        }
    }
    if (!/[A-Z]/.test(pwd)) pwd = `A${pwd.slice(1)}`;
    if (!/[a-z]/.test(pwd)) pwd = `${pwd.slice(0, -1)}a`;
    if (!/[0-9]/.test(pwd)) pwd = `${pwd.slice(0, -2)}1`;
    return pwd;
};

const downloadAccountsCSV = (accounts: any[]): void => {
    const header = ['Username', 'Email', 'First Name', 'Last Name', 'Role', 'Password', 'User ID', 'Membership ID'];
    const rows = accounts.map((a) => [
        a.username,
        a.email,
        a.first_name,
        a.last_name,
        a.role,
        a.password,
        a.user_id,
        a.membership_id,
    ]);
    const csv = [header, ...rows]
        .map((r) => r.map((cell: any) => {
            const v = String(cell ?? '');
            return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(','))
        .join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cvat-accounts-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

function CreateMemberModal(props: Props): JSX.Element {
    const { onCreate, onCancel, currentUserRole } = props;
    const [form] = useForm();
    const [submitting, setSubmitting] = useState(false);
    const [result, setResult] = useState<{
        created_count: number;
        error_count: number;
        results: any[];
        errors: any[];
    } | null>(null);

    const roleOptions = currentUserRole === 'owner'
        ? [
            { value: 'worker', label: 'Worker' },
            { value: 'supervisor', label: 'Supervisor' },
            { value: 'maintainer', label: 'Maintainer' },
        ]
        : [
            { value: 'worker', label: 'Worker' },
            { value: 'supervisor', label: 'Supervisor' },
        ];

    const handleCopyAllPasswords = (accounts: any[]): void => {
        const text = accounts
            .map((a) => `${a.username}\t${a.password}\t${a.email}\t${a.role}`)
            .join('\n');
        toClipboard(text).then(() => {
            notification.success({ message: 'Account credentials copied to clipboard' });
        }).catch(() => {
            notification.error({ message: 'Failed to copy to clipboard' });
        });
    };

    return (
        <Modal
            className='cvat-organization-create-member-modal'
            open
            confirmLoading={submitting}
            okText={result ? 'Close' : 'Create accounts'}
            cancelText='Cancel'
            width={result ? 960 : 720}
            onCancel={() => {
                if (!submitting) {
                    form.resetFields(['members']);
                    setResult(null);
                    onCancel();
                }
            }}
            destroyOnClose
            onOk={() => {
                if (result) {
                    form.resetFields(['members']);
                    setResult(null);
                    onCancel();
                    return;
                }
                form.submit();
            }}
        >
            {!result ? (
                <Form
                    initialValues={{
                        members: [
                            {
                                username: '', email: '', first_name: '', last_name: '', password: '', role: 'worker', auto_pwd: true,
                            },
                        ],
                    }}
                    onFinish={(values: Store) => {
                        const members = (values.members as any[]).map((m) => ({
                            username: m.username,
                            email: m.email,
                            first_name: m.first_name ?? '',
                            last_name: m.last_name ?? '',
                            password: (m.auto_pwd || !m.password) ? '' : m.password,
                            role: m.role,
                        }));
                        setSubmitting(true);
                        onCreate({ members }, (r: any) => {
                            setSubmitting(false);
                            setResult(r);
                        });
                    }}
                    layout='vertical'
                    form={form}
                >
                    <Paragraph>
                        <Text strong>Create CVAT accounts directly</Text>
                        <Text type='secondary'> — no email invitation required. </Text>
                        <Text>Users are immediately active and can be assigned to tasks/jobs.</Text>
                    </Paragraph>
                    <Paragraph>
                        <Alert
                            type='warning'
                            showIcon
                            message='Passwords are shown only once'
                            description='Save or download the credentials after creation. Passwords are never stored in plaintext and cannot be recovered later.'
                        />
                    </Paragraph>
                    <Form.List name='members'>
                        {(fields, { add, remove }) => (
                            <>
                                {fields.map((field: any, index: number) => (
                                    <div className='cvat-organization-create-member-field' key={field.key} style={{ borderBottom: '1px dashed #e8e8e8', paddingBottom: 8, marginBottom: 8 }}>
                                        <Row gutter={[8, 4]} align='middle'>
                                            <Col span={7}>
                                                <Form.Item
                                                    label='Username'
                                                    hasFeedback
                                                    name={[field.name, 'username']}
                                                    fieldKey={[field.fieldKey, 'username']}
                                                    rules={[
                                                        { required: true, message: 'Required' },
                                                        { min: 3, max: 150, message: '3-150 characters' },
                                                        {
                                                            pattern: /^[a-zA-Z0-9_.@+-]+$/,
                                                            message: 'Letters, digits and @/./+/-/_ only',
                                                        },
                                                    ]}
                                                    style={{ marginBottom: 4 }}
                                                >
                                                    <Input placeholder='e.g. worker01' />
                                                </Form.Item>
                                            </Col>
                                            <Col span={9}>
                                                <Form.Item
                                                    label='Email'
                                                    hasFeedback
                                                    name={[field.name, 'email']}
                                                    fieldKey={[field.fieldKey, 'email']}
                                                    rules={[
                                                        { required: true, message: 'Required' },
                                                        { type: 'email', message: 'Invalid email' },
                                                    ]}
                                                    style={{ marginBottom: 4 }}
                                                >
                                                    <Input placeholder='worker@example.com' />
                                                </Form.Item>
                                            </Col>
                                            <Col span={7}>
                                                <Form.Item
                                                    label='Role'
                                                    name={[field.name, 'role']}
                                                    fieldKey={[field.fieldKey, 'role']}
                                                    initialValue='worker'
                                                    rules={[{ required: true, message: 'Required' }]}
                                                    style={{ marginBottom: 4 }}
                                                >
                                                    <Select
                                                        options={roleOptions}
                                                    />
                                                </Form.Item>
                                            </Col>
                                            <Col span={1}>
                                                {index > 0 ? (
                                                    <Tooltip title='Remove row'>
                                                        <DeleteOutlined style={{ color: '#ff4d4f' }} onClick={() => remove(field.name)} />
                                                    </Tooltip>
                                                ) : null}
                                            </Col>
                                        </Row>
                                        <Row gutter={[8, 4]} align='middle'>
                                            <Col span={6}>
                                                <Form.Item
                                                    label='First name'
                                                    name={[field.name, 'first_name']}
                                                    fieldKey={[field.fieldKey, 'first_name']}
                                                    style={{ marginBottom: 4 }}
                                                >
                                                    <Input placeholder='Optional' />
                                                </Form.Item>
                                            </Col>
                                            <Col span={6}>
                                                <Form.Item
                                                    label='Last name'
                                                    name={[field.name, 'last_name']}
                                                    fieldKey={[field.fieldKey, 'last_name']}
                                                    style={{ marginBottom: 4 }}
                                                >
                                                    <Input placeholder='Optional' />
                                                </Form.Item>
                                            </Col>
                                            <Col span={9}>
                                                <Form.Item
                                                    noStyle
                                                    shouldUpdate={(prev: any, curr: any) => (
                                                        prev?.members?.[field.name]?.auto_pwd !==
                                                        curr?.members?.[field.name]?.auto_pwd
                                                    )}
                                                >
                                                    {({ getFieldValue, setFieldValue }: any) => {
                                                        const autoPwd = getFieldValue(['members', field.name, 'auto_pwd']) !== false;
                                                        return (
                                                            <Form.Item
                                                                label={autoPwd ? 'Password (auto-generated)' : 'Password'}
                                                                name={[field.name, 'password']}
                                                                fieldKey={[field.fieldKey, 'password']}
                                                                rules={autoPwd ? [] : [
                                                                    { required: true, message: 'Required when not auto-generated' },
                                                                    { min: 8, message: 'At least 8 characters' },
                                                                ]}
                                                                style={{ marginBottom: 4 }}
                                                            >
                                                                <Input.Password
                                                                    disabled={autoPwd}
                                                                    placeholder={autoPwd ? 'Will be generated automatically' : 'Min. 8 chars'}
                                                                    addonAfter={(
                                                                        <Tooltip title={autoPwd ? 'Disable auto-generation to set manually' : 'Generate a strong password'}>
                                                                            <ReloadOutlined
                                                                                onClick={() => {
                                                                                    setFieldValue(['members', field.name, 'password'], autoPwd ? '' : generatePassword());
                                                                                    setFieldValue(['members', field.name, 'auto_pwd'], !autoPwd);
                                                                                }}
                                                                            />
                                                                        </Tooltip>
                                                                    )}
                                                                />
                                                            </Form.Item>
                                                        );
                                                    }}
                                                </Form.Item>
                                                <Form.Item
                                                    hidden
                                                    name={[field.name, 'auto_pwd']}
                                                    fieldKey={[field.fieldKey, 'auto_pwd']}
                                                    initialValue={true}
                                                    valuePropName='checked'
                                                >
                                                    <Input type='checkbox' />
                                                </Form.Item>
                                            </Col>
                                        </Row>
                                    </div>
                                ))}
                                <Form.Item>
                                    <Button type='dashed' icon={<PlusCircleOutlined />} onClick={() => add({
                                        username: '', email: '', first_name: '', last_name: '', password: '', role: 'worker', auto_pwd: true,
                                    })} block>
                                        Add another account
                                    </Button>
                                </Form.Item>
                            </>
                        )}
                    </Form.List>
                </Form>
            ) : (
                <>
                    <Row justify='space-between' align='middle' style={{ marginBottom: 12 }}>
                        <Col>
                            <Space>
                                <Tag color={result.created_count ? 'green' : 'default'}>
                                    Created: {result.created_count}
                                </Tag>
                                <Tag color={result.error_count ? 'red' : 'default'}>
                                    Failed: {result.error_count}
                                </Tag>
                            </Space>
                        </Col>
                        <Col>
                            <Space>
                                {result.created_count > 0 && (
                                    <>
                                        <Button
                                            icon={<CopyOutlined />}
                                            onClick={() => handleCopyAllPasswords(result.results)}
                                        >
                                            Copy all
                                        </Button>
                                        <Button
                                            type='primary'
                                            icon={<DownloadOutlined />}
                                            onClick={() => downloadAccountsCSV(result.results)}
                                        >
                                            Download CSV
                                        </Button>
                                    </>
                                )}
                            </Space>
                        </Col>
                    </Row>
                    {result.created_count > 0 && (
                        <>
                            <Paragraph>
                                <Text strong>Created accounts</Text>
                                <Text type='secondary'> — distribute credentials securely to users.</Text>
                            </Paragraph>
                            <Table
                                size='small'
                                rowKey='user_id'
                                dataSource={result.results}
                                pagination={false}
                                scroll={{ x: 800 }}
                                columns={[
                                    { title: 'Username', dataIndex: 'username', width: 140 },
                                    { title: 'Email', dataIndex: 'email', width: 200 },
                                    { title: 'Name', key: 'name', width: 160, render: (_: any, r: any) => `${r.first_name} ${r.last_name}`.trim() || '-' },
                                    { title: 'Role', dataIndex: 'role', width: 100, render: (v: string) => <Tag color='blue'>{v}</Tag> },
                                    {
                                        title: 'Password',
                                        dataIndex: 'password',
                                        width: 180,
                                        render: (v: string) => (
                                            <Space>
                                                <code style={{ background: '#f6f8fa', padding: '2px 6px', borderRadius: 4 }}>{v}</code>
                                                <Tooltip title='Copy password'>
                                                    <CopyOutlined
                                                        onClick={() => toClipboard(v).then(() => notification.success({ message: 'Password copied' }))}
                                                    />
                                                </Tooltip>
                                            </Space>
                                        ),
                                    },
                                    { title: 'User ID', dataIndex: 'user_id', width: 80 },
                                ]}
                            />
                        </>
                    )}
                    {result.error_count > 0 && (
                        <>
                            <Paragraph style={{ marginTop: 16 }}>
                                <Text strong type='danger'>Failures</Text>
                            </Paragraph>
                            <Alert
                                type='error'
                                showIcon
                                message={(
                                    <ul style={{ margin: 0, paddingLeft: 20 }}>
                                        {result.errors.map((e: any, i: number) => (
                                            <li key={i}>
                                                #{e.index + 1}
                                                {e.username ? ` (${e.username})` : ''}: {e.error}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            />
                        </>
                    )}
                </>
            )}
        </Modal>
    );
}

export default React.memo(CreateMemberModal);
