import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { useHistory, useParams } from 'react-router';
import { Col, Row } from 'antd/lib/grid';
import Card from 'antd/lib/card';
import Form from 'antd/lib/form';
import Input from 'antd/lib/input';
import Button from 'antd/lib/button';
import Select from 'antd/lib/select';
import Switch from 'antd/lib/switch';
import Spin from 'antd/lib/spin';
import Alert from 'antd/lib/alert';
import Divider from 'antd/lib/divider';
import Space from 'antd/lib/space';
import Tag from 'antd/lib/tag';
import Tooltip from 'antd/lib/tooltip';
import Popconfirm from 'antd/lib/popconfirm';
import Text from 'antd/lib/typography/Text';
import Title from 'antd/lib/typography/Title';
import Tabs from 'antd/lib/tabs';
import notification from 'antd/lib/notification';
import InputNumber from 'antd/lib/input-number';
import Mentions from 'antd/lib/mentions';
import { ArrowLeftOutlined, DeleteOutlined, SaveOutlined, InfoCircleOutlined, ThunderboltOutlined, PlusOutlined, MinusCircleOutlined, EditOutlined, BuildOutlined } from '@ant-design/icons';
import { CombinedState } from 'reducers';
import { Organization, AIFunctionInstance } from 'cvat-core-wrapper';
import type { AIFeatureKind, AIProviderKind } from 'cvat-core-wrapper';
import { FEATURE_KIND_META, PROVIDER_META, bcResolveLabelSpec } from './instance-card';
import { BUILTIN_PROMPT_VARIABLES, PRESET_BUNDLES, findPreset, sanitizePromptValue, resolvePresetIdCanonical, isPlaceholderLabel, parseLabelsRawJson, serializeLabelsRaw, LABEL_NAME_RE, type PresetBundle, type LabelSpec, type PromptVariableSpec } from './presets';

const { Option } = Select;

export const OUTPUT_FORMAT_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
    object_detector: [
        { value: 'rectangles', label: 'Rectangles / bounding boxes' },
        { value: 'polygons',   label: 'Polygons (shapes w/ multiple points)' },
        { value: 'polylines',  label: 'Polylines (lane lines / curves)' },
        { value: 'mixed',      label: 'Mixed (JSON may contain boxes + polygons)' },
    ],
    image_caption: [
        { value: 'captions', label: 'Captions — 1-sentence TAG attribute per image' },
    ],
    object_tracker: [
        { value: 'rectangles', label: 'Rectangles (HTTP /track keyframes)' },
    ],
};

export const BAILIAN_DEFAULT_API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
export const BAILIAN_DEFAULT_MODEL = 'qwen3-vl-plus';

type TabKey = 'basic' | 'api' | 'prompts' | 'labels' | 'parser' | 'variables' | 'debug';

function toFormPromptVars(list: any[]): Array<{ name: string; value: string; desc: string }> {
    const builtinKeys = new Set(BUILTIN_PROMPT_VARIABLES.map((v) => v.key));
    if (!Array.isArray(list)) return [];
    return list.map((v) => ({
        name: String(v?.name || v?.key || '').trim(),
        value: (v?.value !== undefined && v?.value !== null) ? String(v.value)
            : ((v?.default !== undefined && v?.default !== null) ? String(v.default) : ''),
        desc: String(v?.desc || v?.label || ''),
    })).filter((row) => row.name && !builtinKeys.has(row.name));
}

function toFormHttpFields(raw: any): Array<{ key: string; value: string }> {
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw.map((row) => ({
            key: String(row?.key || row?.name || '').trim(),
            value: row?.value === undefined || row?.value === null ? '' : String(row.value),
        })).filter((row) => row.key);
    }
    if (typeof raw === 'object') {
        return Object.entries(raw).map(([key, value]) => ({
            key: String(key).trim(),
            value: value === undefined || value === null ? '' : String(value),
        })).filter((row) => row.key);
    }
    if (typeof raw === 'string' && raw.includes('=')) {
        return raw.split(/[&;]/).map((pair) => {
            const i = pair.indexOf('=');
            return {
                key: (i >= 0 ? pair.slice(0, i) : pair).trim(),
                value: (i >= 0 ? pair.slice(i + 1) : '').trim(),
            };
        }).filter((row) => row.key);
    }
    return [];
}

const HTTP_CONFIG_KEYS = [
    'http_file_field', 'http_form_fields', 'http_query_fields',
    'http_timeout_seconds', 'local_backend', 'vision_backend',
];

function tabForFieldName(name: Array<string | number>): TabKey {
    const top = String(name[0] ?? '');
    const map: Record<string, TabKey> = {
        slug: 'basic', name: 'basic', featureKind: 'basic', outputFormat: 'basic',
        isEnabled: 'basic', isDefault: 'basic', presetId: 'basic',
        provider: 'api', apiUrl: 'api', apiKey: 'api', model: 'api', executionMode: 'api',
        httpFileField: 'api', httpTimeoutSeconds: 'api', httpFormFields: 'api',
        systemPromptTemplate: 'prompts', userPromptTemplate: 'prompts',
        captionAttributeName: 'labels', labels: 'labels',
        parserConfig: 'parser',
        promptVariables: 'variables',
        extraConfigRaw: 'debug',
    };
    return map[top] || 'basic';
}

export default function AIFeatureInstanceFormPage(): JSX.Element {
    const organization = useSelector((state: CombinedState) => state.organizations.current) as Organization | null;
    const history = useHistory();
    const { slug } = useParams<{ slug?: string }>();
    const isEdit = !!slug && slug !== 'new';

    const [form] = Form.useForm();
    const [saving, setSaving] = useState(false);
    const [loading, setLoading] = useState(true);
    const [forbidden, setForbidden] = useState(false);
    const [existInstance, setExistInstance] = useState<AIFunctionInstance | null>(null);
    const [activeTab, setActiveTab] = useState<TabKey>('basic');
    const [systemPromptKey, setSystemPromptKey] = useState(0);
    const [userPromptKey, setUserPromptKey] = useState(0);
    const [probing, setProbing] = useState(false);

    const featureKind = Form.useWatch('featureKind', form) as AIFeatureKind | undefined;
    const provider = Form.useWatch('provider', form) as AIProviderKind | undefined;
    const labelsWatch = Form.useWatch('labels', form) as LabelSpec[] | undefined;
    const systemPromptWatch = Form.useWatch('systemPromptTemplate', form) as string | undefined;
    const userPromptWatch = Form.useWatch('userPromptTemplate', form) as string | undefined;
    const parserWatch = Form.useWatch('parserConfig', form) as Record<string, any> | undefined;
    const executionModeWatch = Form.useWatch('executionMode', form) as string | undefined;

    const outputFormatOptions = useMemo(() => OUTPUT_FORMAT_OPTIONS[featureKind || 'object_detector'] || [], [featureKind]);

    const applicablePresets = useMemo(() => {
        const set: PresetBundle[] = [];
        for (const p of PRESET_BUNDLES) {
            if (!featureKind || (Array.isArray(p.appliesTo) && p.appliesTo.includes(featureKind as any))) set.push(p);
        }
        return set;
    }, [featureKind]);

    const hasCfg = useMemo(() => {
        const c = (existInstance?.config || {}) as Record<string, any>;
        const h = (existInstance?.sensitiveExposed || {}) as Record<string, any>;
        return {
            has_api_key: Boolean(h?.has_api_key || h?.api_key || c.api_key),
            preset_id: typeof c.preset_id === 'string' ? c.preset_id : undefined,
        };
    }, [existInstance]);

    const sensitiveBadges = useMemo(() => {
        const out: JSX.Element[] = [];
        if (hasCfg.has_api_key) out.push(<Tag key='api' color='green'>API key configured (preserved)</Tag>);
        if (isEdit && !forbidden) out.push(<Tag key='edit-info' color='blue'>Preset: {hasCfg.preset_id || '—'}</Tag>);
        return out;
    }, [hasCfg, isEdit, forbidden]);

    const loadExisting = useCallback(async () => {
        // Create page (/new or missing slug) has nothing to fetch. Must clear the
        // initial loading=true, otherwise Spin stays on "Loading…" forever.
        if (!slug || slug === 'new') {
            setLoading(false);
            return;
        }
        if (!organization) {
            if (!slug || slug === 'new') {
                setLoading(false);
            }
            return;
        }
        try {
            setLoading(true);
            const inst: any = await organization.getAIFunctionInstance(slug);
            setExistInstance(inst);
            const c = (inst?.config || {}) as Record<string, any>;
            const h = (inst?.sensitiveExposed || {}) as Record<string, any>;
            const opc = c.output_parser_config || {};
            const promptVars = toFormPromptVars(c.prompt_variables);
            const labelCfg: LabelSpec[] = bcResolveLabelSpec(c);
            const rawPresetId = typeof c.preset_id === 'string' ? c.preset_id : undefined;
            const presetId = resolvePresetIdCanonical(rawPresetId);
            let sysPrompt = sanitizePromptValue(c.system_prompt_template);
            let usrPrompt = sanitizePromptValue(c.user_prompt_template);
            if ((!sysPrompt || !usrPrompt) && presetId) {
                const preset = findPreset(presetId);
                if (preset && preset.defaults) {
                    if (!sysPrompt) sysPrompt = preset.defaults.system_prompt_template || '';
                    if (!usrPrompt) usrPrompt = preset.defaults.user_prompt_template || '';
                }
            }
            form.setFieldsValue({
                    featureKind: inst.featureKind,
                    provider: inst.provider,
                    slug: inst.slug,
                    name: inst.name,
                    apiUrl: String(c.api_url || ''),
                    model: String(c.model || ''),
                    apiKey: h?.has_api_key || h?.api_key ? '***PRESERVED***' : '',
                    apiKeyStatus: h?.has_api_key ? 'preserved' : 'empty',
                    isEnabled: !!inst.isEnabled,
                    isDefault: !!inst.isDefault,
                    executionMode: String(c.execution_mode || 'vlm_prompt'),
                    outputFormat: String(c.output_format || (labelCfg.length ? 'rectangles' : 'captions')),
                    httpFileField: String(c.http_file_field || 'image'),
                    httpTimeoutSeconds: Number(c.http_timeout_seconds || 120),
                    httpFormFields: toFormHttpFields(c.http_form_fields),
                    systemPromptTemplate: sysPrompt,
                    userPromptTemplate: usrPrompt,
                    labels: labelCfg,
                    parserConfig: opc,
                    captionAttributeName: String(opc.caption_attribute_name || c.caption_attribute_name || 'caption'),
                    promptVariables: promptVars,
                    presetId: presetId,
                    extraConfigRaw: JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k]) => !new Set([
                        'api_url','api_key','model','execution_mode','output_format','system_prompt_template','user_prompt_template','prompt_variables','output_parser_config','labels','caption_attribute_name','preset_labels','ascii_labels','attributes_per_label','preset_id',
                        ...HTTP_CONFIG_KEYS]).has(k))), null, 2),
                });
                if (sysPrompt.length > 0) setSystemPromptKey((v) => v + 1);
                if (usrPrompt.length > 0) setUserPromptKey((v) => v + 1);
        } catch (err: any) {
            if (err?.message?.includes('403') || err?.status === 403) {
                setForbidden(true);
            } else {
                notification.error({ message: 'Failed to load instance', description: err?.message || String(err) });
            }
        } finally {
            setLoading(false);
        }
    }, [slug, organization?.id]);

    useEffect(() => { loadExisting(); }, [loadExisting]);

    const applyPreset = useCallback((presetId: string) => {
        const preset = findPreset(presetId);
        if (!preset) return;
        const def = preset.defaults || {};
        const parser: Record<string, any> = { ...(def.output_parser_config || {}) };
        parser.caption_attribute_name = def.caption_attribute_name || 'caption';
        const guessedFeature: AIFeatureKind = (preset.defaultFor?.[0] as AIFeatureKind) || (preset.appliesTo?.[0] as AIFeatureKind) || 'object_detector';
        form.setFieldsValue({
            presetId: preset.id,
            featureKind: guessedFeature,
            outputFormat: def.output_format || (guessedFeature === 'image_caption' ? 'captions' : 'rectangles'),
            systemPromptTemplate: def.system_prompt_template || '',
            userPromptTemplate: def.user_prompt_template || '',
            labels: Array.isArray(def.labels) ? [...def.labels] : [],
            promptVariables: toFormPromptVars(def.prompt_variables),
            provider: def.provider || form.getFieldValue('provider') || 'bailian',
            model: def.model || form.getFieldValue('model'),
            apiUrl: Object.prototype.hasOwnProperty.call(def, 'api_url')
                ? (def.api_url || '')
                : form.getFieldValue('apiUrl'),
            executionMode: def.execution_mode || form.getFieldValue('executionMode') || 'vlm_prompt',
            httpFileField: def.http_file_field || 'image',
            httpTimeoutSeconds: def.http_timeout_seconds || 120,
            httpFormFields: toFormHttpFields(def.http_form_fields),
            parserConfig: parser,
            captionAttributeName: def.caption_attribute_name || 'caption',
            extraConfigRaw: JSON.stringify((() => {
                const extra: Record<string, unknown> = {};
                if (def.local_backend) extra.local_backend = def.local_backend;
                if (def.weights !== undefined) extra.weights = def.weights;
                if (def.gmc_method) extra.gmc_method = def.gmc_method;
                if (def.imgsz) extra.imgsz = def.imgsz;
                if (def.device) extra.device = def.device;
                return extra;
            })(), null, 2),
        });
        setSystemPromptKey((v) => v + 1);
        setUserPromptKey((v) => v + 1);
        notification.success({ message: `Loaded preset "${preset.name}"`, description: 'Prompt, labels, parser defaults applied. Adjust in the tabs below then Save.' });
    }, []);

    const HTTP_PRESET_LEFTOVER = useMemo(
        () => new Set(['object', 'box', 'image', 'text', 'title', 'table', 'figure', 'caption']),
        [],
    );

    const onProbeHttp = useCallback(async () => {
        if (!organization || forbidden) return;
        const apiUrl = String(form.getFieldValue('apiUrl') || '').trim();
        if (!apiUrl) {
            notification.warning({ message: 'Predict URL is required', description: 'Set API URL on this tab first (e.g. http://host:8080/predict).' });
            setActiveTab('api');
            return;
        }
        try {
            // eslint-disable-next-line no-new
            new URL(apiUrl);
        } catch {
            notification.warning({ message: 'Invalid Predict URL' });
            return;
        }
        try {
            setProbing(true);
            const apiKey = String(form.getFieldValue('apiKey') || '');
            const timeoutRaw = Number(form.getFieldValue('httpTimeoutSeconds'));
            const result = await organization.probeHttpMicroservice({
                apiUrl,
                httpTimeoutSeconds: Number.isFinite(timeoutRaw) ? timeoutRaw : 10,
                apiKey: apiKey && apiKey !== '***PRESERVED***' ? apiKey : undefined,
                instanceSlug: isEdit ? slug : undefined,
            });
            const items = Array.isArray(result?.labels?.items) ? result.labels.items : [];
            const usable = items.filter((it) => (
                it && typeof it.name === 'string' && it.name.trim() && !isPlaceholderLabel(it.name)
            ));
            if (usable.length) {
                const mapped: LabelSpec[] = usable.map((it) => ({
                    name: String(it.name).trim(),
                    type: (['rectangle', 'polygon', 'polyline', 'points', 'tag', 'any'].includes(String(it.type || ''))
                        ? (it.type as LabelSpec['type'])
                        : 'any'),
                    description: it.description || '',
                }));
                form.setFieldsValue({ labels: mapped });
                setActiveTab('labels');
                notification.success({
                    message: result.ok ? 'Connection OK — labels filled from GET /labels' : 'Labels filled from GET /labels',
                    description: result.message || `${mapped.length} label(s) replaced the previous list. Review the Labels tab, then Save.`,
                    duration: 8,
                });
                return;
            }
            if (result?.ok) {
                const current = (form.getFieldValue('labels') || []) as LabelSpec[];
                const leftover = current.filter((l) => HTTP_PRESET_LEFTOVER.has(String(l?.name || '').toLowerCase()));
                notification.info({
                    message: 'Service reachable',
                    description: `${result.message || 'GET /health ok.'} GET /labels is missing — keep the Labels tab, or replace leftover preset names (box/image/…) with the classes this API actually returns (e.g. lane).`,
                    duration: leftover.length ? 10 : 8,
                });
                return;
            }
            notification.error({
                message: 'Test connection failed',
                description: result?.message || 'Host is not reachable from the CVAT server.',
                duration: 10,
            });
        } catch (err: any) {
            notification.error({
                message: 'Test connection failed',
                description: err?.message || String(err),
                duration: 10,
            });
        } finally {
            setProbing(false);
        }
    }, [organization, forbidden, form, isEdit, slug, HTTP_PRESET_LEFTOVER]);

    const insertVariableAtCursor = useCallback((target: 'system' | 'user', variable: string) => {
        // best-effort DOM-based insertion using direct mutation if no textarea exists, we append safely:
        const marker = `{{${variable}}}`;
        const fk = target === 'system' ? 'systemPromptTemplate' : 'userPromptTemplate';
        const cur = (form.getFieldValue(fk) || '') as string;
        form.setFieldsValue({ [fk]: cur + marker });
        if (target === 'system') setSystemPromptKey((v) => v + 1);
        if (target === 'user') setUserPromptKey((v) => v + 1);
    }, [form]);

    const onFinish = useCallback(async (values: any) => {
        if (!organization || forbidden) return;
        try {
            setSaving(true);
            const featureKind = values.featureKind || 'object_detector';
            const labels: LabelSpec[] = Array.isArray(values.labels) ?
                values.labels.filter((l: any) => (
                    l && typeof l.name === 'string' && l.name.trim() && !isPlaceholderLabel(l.name)
                )) : [];
            const parser: Record<string, any> = Object.assign({}, values.parserConfig || {});
            if (featureKind === 'image_caption' && typeof values.captionAttributeName === 'string') {
                parser.caption_attribute_name = values.captionAttributeName;
            }
            const promptVars = Array.isArray(values.promptVariables) ? values.promptVariables.filter((v: any) => v && typeof v.name === 'string' && v.name.trim()) : [];
            let extra: Record<string, any> = {};
            try {
                if (typeof values.extraConfigRaw === 'string' && values.extraConfigRaw.trim().length > 2) {
                    const parsed = JSON.parse(values.extraConfigRaw);
                    if (parsed && typeof parsed === 'object') extra = parsed;
                }
            } catch (e: any) {
                notification.warning({ message: 'Extra config JSON parse failed', description: e?.message || String(e) });
            }
            const apiKey = (typeof values.apiKey === 'string' && values.apiKey && values.apiKey !== '***PRESERVED***') ? values.apiKey : undefined;
            const apiUrl = values.apiUrl && !['', undefined, null].includes(values.apiUrl) ? String(values.apiUrl).trim() : undefined;
            const cfg: Record<string, any> = {
                ...extra,
                model: String(values.model || '').trim() || extra.model || undefined,
                execution_mode: String(values.executionMode || extra.execution_mode || 'vlm_prompt'),
                output_format: String(values.outputFormat || (
                    featureKind === 'image_caption' ? 'captions' :
                        labels.length ? 'rectangles' :
                            featureKind === 'object_detector' ? 'rectangles' : 'rectangles'
                )),
                system_prompt_template: (() => {
                    let s = sanitizePromptValue(values.systemPromptTemplate);
                    if (!s && typeof values.presetId === 'string' && values.presetId) {
                        const p = findPreset(values.presetId);
                        if (p && p.defaults) s = p.defaults.system_prompt_template || '';
                    }
                    return s;
                })(),
                user_prompt_template: (() => {
                    let s = sanitizePromptValue(values.userPromptTemplate);
                    if (!s && typeof values.presetId === 'string' && values.presetId) {
                        const p = findPreset(values.presetId);
                        if (p && p.defaults) s = p.defaults.user_prompt_template || '';
                    }
                    return s;
                })(),
                prompt_variables: promptVars,
                output_parser_config: parser,
                labels: (() => {
                    if (labels && labels.length > 0) return labels;
                    if (Array.isArray(extra.labels) && extra.labels.length) return extra.labels;
                    if (typeof values.presetId === 'string' && values.presetId) {
                        const p = findPreset(values.presetId);
                        if (p && p.defaults && Array.isArray(p.defaults.labels) && p.defaults.labels.length) {
                            return p.defaults.labels.filter((l: any) => l && typeof l.name === 'string' && l.name.trim());
                        }
                    }
                    return labels;
                })(),
                caption_attribute_name: featureKind === 'image_caption' ? (parser.caption_attribute_name || 'caption') : undefined,
                preset_id: resolvePresetIdCanonical(values.presetId),
            };
            if (apiUrl) cfg.api_url = apiUrl;
            const httpFileField = typeof values.httpFileField === 'string' ? values.httpFileField.trim() : '';
            const modelLc = String(cfg.model || '').toLowerCase();
            const presetLc = String(values.presetId || '').toLowerCase();
            const isClrernet = modelLc.includes('clrernet') || presetLc.includes('clrernet');
            const isHttpVision = String(cfg.execution_mode) === 'vision_pipeline' && !isClrernet && !!apiUrl;
            if (isHttpVision) {
                if (httpFileField) cfg.http_file_field = httpFileField;
                const httpTimeout = Number(values.httpTimeoutSeconds);
                if (Number.isFinite(httpTimeout) && httpTimeout > 0) cfg.http_timeout_seconds = httpTimeout;
                const httpPairs = Array.isArray(values.httpFormFields)
                    ? values.httpFormFields.filter((row: any) => row && String(row.key || '').trim())
                    : [];
                if (httpPairs.length) {
                    cfg.http_form_fields = Object.fromEntries(
                        httpPairs.map((row: any) => [String(row.key).trim(), String(row.value ?? '')]),
                    );
                }
                cfg.local_backend = extra.local_backend || 'http_microservice';
            }
            if (!cfg.preset_id) delete cfg.preset_id;
            if (!cfg.model) delete cfg.model;

            if (apiKey !== undefined) cfg.api_key = apiKey;
            if (featureKind === 'image_caption') {
                cfg.caption_attribute_name = parser.caption_attribute_name || 'caption';
            }
            const writePayload = {
                slug: isEdit ? existInstance!.slug : values.slug,
                name: values.name,
                featureKind,
                provider: values.provider || 'bailian',
                isEnabled: !!values.isEnabled,
                isDefault: !!values.isDefault,
                config: cfg,
            };
            let saved: AIFunctionInstance;
            if (isEdit) saved = await organization.updateAIFunctionInstance(existInstance!.slug, writePayload);
            else saved = await organization.createAIFunctionInstance(writePayload);
            notification.success({ message: isEdit ? 'Instance updated' : 'Instance created', description: saved.slug });
            history.push('/organization/ai-features');
        } catch (err: any) {
            notification.error({ message: 'Save failed', description: err?.message || String(err) });
        } finally {
            setSaving(false);
        }
    }, [organization, forbidden, existInstance, isEdit, history]);

    const onFinishFailed = useCallback((info: { errorFields?: Array<{ name: Array<string | number>; errors: string[] }> }) => {
        const fields = Array.isArray(info?.errorFields) ? info.errorFields : [];
        const first = fields[0];
        if (first?.name) setActiveTab(tabForFieldName(first.name));
        const msgs = fields
            .slice(0, 5)
            .map((f) => (Array.isArray(f.errors) ? f.errors[0] : '') || String((f.name || []).join('.')))
            .filter(Boolean);
        notification.warning({
            message: 'Please complete required fields',
            description: msgs.length ? msgs.join(' · ') : 'Some fields on other tabs are invalid.',
            duration: 6,
        });
    }, []);

    const formDisabled = forbidden || saving || loading;

    const tabsItems = useMemo(() => ([
        {
            key: 'basic',
            label: '1. Basic',
            children: (
                <Card bordered size='small' style={{ marginTop: 12 }}>
                    <Row gutter={[14, 6]}>
                        <Col xs={24} md={8}>
                            <Form.Item label={<Space>Slug<Tooltip title='Unique ASCII identifier inside the organization; cannot be changed after creation'><InfoCircleOutlined /></Tooltip></Space>} name='slug' rules={[{ required: true, message: 'Slug is required' }, { pattern: /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, message: 'Start with a-z/0-9, then [a-zA-Z0-9_-] only' }, { max: 64 }]}>
                                <Input disabled={isEdit || formDisabled} placeholder='e.g. qwen37-traffic-detector' />
                            </Form.Item>
                        </Col>
                        <Col xs={24} md={10}>
                            <Form.Item label='Display Name' name='name' rules={[{ required: true, message: 'Display name is required' }, { max: 128 }]}>
                                <Input disabled={formDisabled} placeholder='e.g. Qwen3.7 VL · 9-Class Traffic Detector' />
                            </Form.Item>
                        </Col>
                        <Col xs={24} md={6}>
                            <Form.Item label='Output type' name='featureKind' rules={[{ required: true }]}>
                                <Select disabled={isEdit || formDisabled}>
                                    {Object.entries(FEATURE_KIND_META).map(([k, meta]) => (
                                        <Option key={k} value={k as AIFeatureKind} disabled={!!meta.reserved}>
                                            {meta.label}
                                        </Option>
                                    ))}
                                </Select>
                            </Form.Item>
                        </Col>
                        <Col xs={24} md={6}>
                            <Form.Item label='Output format' name='outputFormat'>
                                <Select disabled={formDisabled}>
                                    {outputFormatOptions.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
                                </Select>
                            </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                            <Form.Item label='Enabled' name='isEnabled' valuePropName='checked'><Switch disabled={formDisabled} /></Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                            <Form.Item label='Default instance' name='isDefault' valuePropName='checked'><Switch disabled={formDisabled} /></Form.Item>
                        </Col>
                        <Col xs={24} md={8}>
                            <Form.Item label={<Space>Preset<Tooltip title='Apply a bundled preset. System/User prompts, labels, and parser defaults will be applied immediately. This only edits the form local state; click Save afterwards to persist. Preset id is also stored on config.preset_id for future label resolution.'><InfoCircleOutlined /></Tooltip></Space>} name='presetId'>
                                <Select
                                    allowClear
                                    disabled={formDisabled}
                                    placeholder='(optional) — choose a preset to apply'
                                    onSelect={(v) => applyPreset(String(v))}
                                    options={applicablePresets.map((p) => ({ value: p.id, label: `${p.name} (${(p.appliesTo || []).join(', ')})` }))}
                                />
                            </Form.Item>
                        </Col>
                    </Row>
                </Card>
            ),
        },
        {
            key: 'api',
            label: '2. API & execution',
            children: (
                <Card bordered size='small' style={{ marginTop: 12 }}>
                    <Row gutter={[14, 6]}>
                        <Col xs={24} md={6}>
                            <Form.Item label='AI Provider' name='provider' rules={[{ required: true }]}>
                                <Select disabled={formDisabled}>
                                    {Object.entries(PROVIDER_META).map(([k, meta]) => <Option key={k} value={k as AIProviderKind}>{meta.label}</Option>)}
                                </Select>
                            </Form.Item>
                        </Col>
                        <Col xs={24} md={10}>
                            <Form.Item label={<Space>API URL{provider === 'bailian' ? <Tag>Bailian default: {BAILIAN_DEFAULT_API_URL}</Tag> : executionModeWatch === 'vision_pipeline' ? <Tag color='green'>Predict endpoint</Tag> : null}</Space>} name='apiUrl' rules={[{
                                validator: (_, v) => {
                                    const raw = v === undefined || v === null ? '' : String(v).trim();
                                    const mode = executionModeWatch || '';
                                    const modelLc = String(form.getFieldValue('model') || '').toLowerCase();
                                    const needsHttpUrl = mode === 'vision_pipeline'
                                        && !modelLc.includes('clrernet');
                                    if (!raw) {
                                        if (needsHttpUrl) return Promise.reject(new Error('Predict URL is required (e.g. http://host:8080/predict)'));
                                        return Promise.resolve();
                                    }
                                    try {
                                        // eslint-disable-next-line no-new
                                        new URL(raw);
                                        return Promise.resolve();
                                    } catch {
                                        return Promise.reject(new Error('Please enter a valid URL'));
                                    }
                                },
                            }]}>
                                <Input disabled={formDisabled} placeholder={executionModeWatch === 'vision_pipeline' ? 'http://192.168.50.42:8080/predict' : 'https://.../chat/completions'} />
                            </Form.Item>
                        </Col>
                        <Col xs={24} md={8}>
                            <Form.Item label={<Space>Model{provider === 'bailian' ? <Tag color='geekblue'>Recommended: {BAILIAN_DEFAULT_MODEL}</Tag> : null}</Space>} name='model'><Input disabled={formDisabled} placeholder='e.g. qwen3-vl-plus' /></Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                            <Form.Item label={<Space>API Key{isEdit && hasCfg.has_api_key ? <Tag color='success'>Configured (preserved)</Tag> : null}<Tooltip title={isEdit ? 'Leave empty to keep the current value; fill to overwrite; clear with the × button to remove' : 'Optional. Leave empty to reuse organization Bailian settings / existing fallback.'}><InfoCircleOutlined /></Tooltip></Space>} name='apiKey'>
                                <Input.Password disabled={formDisabled} allowClear placeholder={isEdit ? 'Empty = keep current value' : 'Optional · sk-...'} />
                            </Form.Item>
                        </Col>
                        <Col xs={24} md={6}>
                            <Form.Item label='Execution mode' name='executionMode' initialValue='vlm_prompt'>
                                <Select disabled={formDisabled}>
                                    <Option value='vlm_prompt'>vlm_prompt (LLM with image)</Option>
                                    <Option value='vision_pipeline'>vision_pipeline (HTTP microservice or local ONNX)</Option>
                                    <Option value='hybrid_agent'>hybrid_agent (reserved)</Option>
                                </Select>
                            </Form.Item>
                        </Col>
                    </Row>
                    {(executionModeWatch === 'vision_pipeline' || provider === 'local' || provider === 'custom') ? (
                        <Row gutter={[14, 6]} style={{ marginTop: 8 }}>
                            <Col xs={24}>
                                <Alert
                                    showIcon
                                    type='info'
                                    message='HTTP microservice contract (plug into Automatic annotation)'
                                    description={(
                                        <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                                            <div>CVAT POSTs the current frame as multipart to the Predict URL. Colleagues should expose:</div>
                                            <pre style={{
                                                margin: '8px 0', padding: 10, background: '#fafafa',
                                                border: '1px solid #f0f0f0', borderRadius: 6,
                                                whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12,
                                            }}>{`POST /predict   multipart  -F image=@frame.jpg   (+ optional form fields or ?query=)
GET  /health    optional   {"status":"ok"}
GET  /labels    optional   {"labels":[{"name":"lane","type":"polyline"}]}

# predict response
{"code":0,"width":W,"height":H,"message":"ok","shapes":[
  {"label":"box","type":"polygon","points":[[x,y],...]},
  {"label":"image","type":"rectangle","points":[x1,y1,x2,y2]},
  {"label":"lane","type":"polyline","points":[[x,y],...],"confidence":0.92}
]}

curl -sS -F image=@frame.jpg "http://HOST:8081/predict?conf_thres=0.43"`}</pre>
                                            <div>
                                                <code>type</code> ∈ rectangle / polygon / polyline.
                                                Points: xyxy flat or [[x,y],…]. Extra knobs: keep them on the URL query or add Extra form fields below.
                                                Click <b>Test connection</b> to GET /health and fill Labels from GET /labels (no image needed). If /labels is missing, edit the Labels tab (delete leftover box/image).
                                            </div>
                                        </div>
                                    )}
                                />
                            </Col>
                            <Col xs={24}>
                                <Button
                                    icon={<ThunderboltOutlined />}
                                    loading={probing}
                                    disabled={formDisabled || probing}
                                    onClick={() => { onProbeHttp(); }}
                                >
                                    Test connection
                                </Button>
                            </Col>
                            <Col xs={24} md={8}>
                                <Form.Item label='Multipart file field' name='httpFileField' initialValue='image'>
                                    <Input disabled={formDisabled} placeholder='image' />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={8}>
                                <Form.Item label='HTTP timeout (seconds)' name='httpTimeoutSeconds' initialValue={120}>
                                    <InputNumber min={5} max={600} style={{ width: '100%' }} disabled={formDisabled} />
                                </Form.Item>
                            </Col>
                            <Col xs={24}>
                                <Divider plain orientation='left' style={{ margin: '6px 0' }}>Extra form fields (sent with the image)</Divider>
                                <Form.List name='httpFormFields'>
                                    {(fields, { add, remove }) => (
                                        <>
                                            {fields.map(({ key, name, ...restField }) => (
                                                <Space key={key} align='baseline' wrap style={{ display: 'flex', marginBottom: 8 }}>
                                                    <Form.Item {...restField} name={[name, 'key']}>
                                                        <Input disabled={formDisabled} placeholder='layout_on_box' style={{ width: 220 }} />
                                                    </Form.Item>
                                                    <Form.Item {...restField} name={[name, 'value']}>
                                                        <Input disabled={formDisabled} placeholder='1' style={{ width: 220 }} />
                                                    </Form.Item>
                                                    <Button icon={<MinusCircleOutlined />} onClick={() => remove(name)} disabled={formDisabled} danger>Remove</Button>
                                                </Space>
                                            ))}
                                            <Button type='dashed' onClick={() => add({ key: '', value: '' })} block icon={<PlusOutlined />} disabled={formDisabled}>
                                                Add form field
                                            </Button>
                                        </>
                                    )}
                                </Form.List>
                            </Col>
                        </Row>
                    ) : null}
                </Card>
            ),
        },
        {
            key: 'prompts',
            label: '3. Prompt templates',
            children: (
                <Card bordered size='small' style={{ marginTop: 12 }}>
                    <div className='prompt-editor-wrapper'>
                        <div className='prompt-toolbar'>
                            <Space wrap>
                                <strong>System prompt template</strong>
                                <Tag>Variables (inject via curly braces)</Tag>
                                <Space size={[4, 4]} wrap>
                                    {BUILTIN_PROMPT_VARIABLES.map((v) => (
                                        <Button size='small' key={v.key} onClick={() => insertVariableAtCursor('system', v.key)}>{`{{${v.key}}}`} - {v.label || v.key}</Button>
                                    ))}
                                    {(labelsWatch && labelsWatch.length ? <Tag color='purple'>{labelsWatch.length} label(s) in schema</Tag> : null)}
                                </Space>
                            </Space>
                            <Space>
                                <Select
                                    size='small'
                                    placeholder='Apply prompt preset'
                                    allowClear
                                    onSelect={(v) => applyPreset(String(v))}
                                    options={applicablePresets.filter((p) => featureKind ? (Array.isArray(p.appliesTo) && p.appliesTo.includes(featureKind as any)) : true).map((p) => ({ value: p.id, label: p.name }))}
                                />
                                <Button size='small' onClick={() => { form.setFieldsValue({ systemPromptTemplate: '' }); setSystemPromptKey((v) => v + 1);}}>Clear</Button>
                            </Space>
                        </div>
                        <Form.Item name='systemPromptTemplate' noStyle><Input.TextArea key={systemPromptKey} rows={14} disabled={formDisabled} placeholder='System role instructions for the VLM...' style={{ fontFamily: 'Consolas, Menlo, monospace', fontSize: 12.5 }} /></Form.Item>
                        <Divider style={{ margin: '18px 0 8px' }} plain orientation='left'>User (per image, appended after the system prompt)</Divider>
                        <div className='prompt-toolbar'>
                            <Space wrap>
                                <strong>User prompt template</strong>
                                {BUILTIN_PROMPT_VARIABLES.map((v) => <Button size='small' key={v.key} onClick={() => insertVariableAtCursor('user', v.key)}>{`{{${v.key}}}`}</Button>)}
                            </Space>
                            <Button size='small' onClick={() => { form.setFieldsValue({ userPromptTemplate: '' }); setUserPromptKey((v) => v + 1); }}>Clear</Button>
                        </div>
                        <Form.Item name='userPromptTemplate' noStyle><Input.TextArea key={userPromptKey} rows={8} disabled={formDisabled} placeholder='Often empty for detection tasks. Try: "Please return boxes strictly for the allowed labels."' style={{ fontFamily: 'Consolas, Menlo, monospace', fontSize: 12.5 }} /></Form.Item>
                    </div>
                </Card>
            ),
        },
        {
            key: 'labels',
            label: featureKind === 'image_caption' ? '4. Captions & attributes' : '4. Labels & attributes',
            children: featureKind === 'image_caption' ? (
                <Card bordered size='small' style={{ marginTop: 12 }}>
                    <Row gutter={[14, 6]}>
                        <Col xs={24} md={10}>
                            <Form.Item
                                label={<Space>Caption attribute name<Tooltip title='Single image-level TAG attribute that stores the caption string inside CVAT label specs (ASCII only).'><InfoCircleOutlined /></Tooltip></Space>}
                                name='captionAttributeName'
                                rules={featureKind === 'image_caption' ? [
                                    { required: true, message: 'Caption attribute name is required' },
                                    { pattern: /^[A-Za-z_][A-Za-z0-9_-]*$/, message: 'ASCII identifier only' },
                                    { max: 64 },
                                ] : []}
                            ><Input disabled={formDisabled} placeholder='caption / miao_shu (ASCII)' /></Form.Item>
                        </Col>
                        <Col xs={24}>
                            <Divider orientation='left' plain style={{ margin: '8px 0' }}>Optional fallback TAG labels (define them for Tasks/Projects that don't have a caption attribute yet</Divider>
                            <LabelsEditor disabled={formDisabled} />
                        </Col>
                    </Row>
                </Card>
            ) : (
                <Card bordered size='small' style={{ marginTop: 12 }}>
                    <LabelsEditor disabled={formDisabled} />
                </Card>
            ),
        },
        {
            key: 'parser',
            label: '5. Parser configuration',
            children: (
                <Card bordered size='small' style={{ marginTop: 12 }}>
                    <Row gutter={[14, 6]}>
                        <Col xs={24} md={8}>
                            <Form.Item label='Confidence threshold (default)' name={['parserConfig', 'confidence_threshold_default']}>
                                <InputNumber step={0.05} min={0} max={1} style={{ width: '100%' }} disabled={formDisabled} />
                            </Form.Item>
                        </Col>
                        <Col xs={24} md={8}>
                            <Form.Item label='Min confidence (per-label, optional)' name={['parserConfig', 'confidence_threshold_min']}><InputNumber step={0.05} min={0} max={1} style={{ width: '100%' }} disabled={formDisabled} /></Form.Item>
                        </Col>
                        <Col xs={24} md={8}>
                            <Form.Item label='Coordinate system' name={['parserConfig', 'coordinate_system']}>
                                <Select disabled={formDisabled}>
                                    <Option value='canonical_1000'>canonical_1000 (0-1000)</Option>
                                    <Option value='relative_0_1'>relative_0_1 (0-1 ratio)</Option>
                                    <Option value='absolute_pixels'>absolute_pixels (REAL_PIXEL_INTEGERS)</Option>
                                </Select>
                            </Form.Item>
                        </Col>
                        <Col xs={24} md={8}>
                            <Form.Item label='VLM call timeout (seconds)' name={['parserConfig', 'vlm_call_timeout_seconds']}><InputNumber min={10} max={3600} style={{ width: '100%' }} disabled={formDisabled} /></Form.Item>
                        </Col>
                        <Col xs={24} md={8}>
                            <Form.Item label='Max detections per image' name={['parserConfig', 'max_detections_per_image']}><InputNumber min={1} max={2000} style={{ width: '100%' }} disabled={formDisabled} /></Form.Item>
                        </Col>
                        <Col xs={24} md={8}>
                            <Form.Item label='NMS IoU threshold' name={['parserConfig', 'nms_iou_threshold']}><InputNumber step={0.05} min={0} max={1} style={{ width: '100%' }} disabled={formDisabled} /></Form.Item>
                        </Col>
                        <Col xs={24} md={8}>
                            <Form.Item label='Polygon simplification (0 = off)' name={['parserConfig', 'polygon_simplification_epsilon']}><InputNumber step={0.1} min={0} max={50} style={{ width: '100%' }} disabled={formDisabled} /></Form.Item>
                        </Col>
                        <Col xs={24} md={8}>
                            <Form.Item label='Min polygon points' name={['parserConfig', 'min_polygon_points']}><InputNumber min={3} max={100} style={{ width: '100%' }} disabled={formDisabled} /></Form.Item>
                        </Col>
                        <Col xs={24} md={8}>
                            <Form.Item label='Max polygon points' name={['parserConfig', 'max_polygon_points']}><InputNumber min={3} max={1000} style={{ width: '100%' }} disabled={formDisabled} /></Form.Item>
                        </Col>
                        <Col xs={24}>
                            <Divider plain orientation='left' style={{ margin: '6px 0' }}>Optional 2-pass recall tuning</Divider>
                        </Col>
                        <Col xs={12} md={6}>
                            <Form.Item label='Recall pass enabled' name={['parserConfig', 'recall_pass_enabled']} valuePropName='checked'><Switch disabled={formDisabled} /></Form.Item>
                        </Col>
                        <Col xs={12} md={6}>
                            <Form.Item label='Recall threshold' name={['parserConfig', 'recall_confidence_threshold']}><InputNumber step={0.05} min={0} max={1} style={{ width: '100%' }} disabled={formDisabled} /></Form.Item>
                        </Col>
                        <Col xs={24} md={6}>
                            <Form.Item label='Recall prompt suffix' name={['parserConfig', 'recall_prompt_suffix']}><Input disabled={formDisabled} placeholder='e.g. Are there any more boxes you missed?' /></Form.Item>
                        </Col>
                        <Col xs={24} md={6}>
                            <Form.Item label='Max recall passes' name={['parserConfig', 'max_recall_passes']}><InputNumber min={0} max={10} style={{ width: '100%' }} disabled={formDisabled} /></Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                            <Form.Item label='Caption post-processing (for image_caption)' name={['parserConfig', 'caption_postprocessing']}>
                                <Select disabled={formDisabled} allowClear>
                                    <Option value='strip_non_chinese'>Strip non-Chinese output (保留中文, 去 冗余短语)</Option>
                                </Select>
                            </Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                            <Form.Item label='JSON schema hint (output_format)' name={['parserConfig', 'json_schema_hint']}><Input disabled={formDisabled} allowClear placeholder='e.g. Use strict JSON schema hint to use in system prompt (auto unless disabled)' /></Form.Item>
                        </Col>
                    </Row>
                </Card>
            ),
        },
        {
            key: 'variables',
            label: '6. Custom prompt variables',
            children: (
                <Card bordered size='small' style={{ marginTop: 12 }}>
                    <Alert showIcon type='info' style={{ marginBottom: 12 }} message='Variables available inside your prompt templates' description='Define reusable text snippets. Use {{variable_name}} in System / User prompt above (tab 3). Built-ins are always available: image_filename, label_categories_markdown, label_attributes_markdown, task_description_json, confidence_threshold.' />
                    <Form.List name='promptVariables'>
                        {(fields, { add, remove }) => (
                            <>
                                {fields.map(({ key, name, ...restField }) => (
                                    <Space key={key} align='baseline' wrap style={{ display: 'flex', marginBottom: 8 }}>
                                        <Form.Item {...restField} name={[name, 'name']} rules={[{ pattern: /^$|^[A-Za-z_][A-Za-z0-9_]*$/, message: 'ASCII identifier only' }]}><Input addonBefore='{{' addonAfter='}}' style={{ width: 220 }} placeholder='var_name' disabled={formDisabled} /></Form.Item>
                                        <Form.Item {...restField} name={[name, 'value']}><Input.TextArea rows={1} style={{ width: 420, minWidth: 280 }} placeholder='Default / fallback value' disabled={formDisabled} /></Form.Item>
                                        <Form.Item {...restField} name={[name, 'desc']}><Input placeholder='Short description' style={{ width: 260 }} disabled={formDisabled} /></Form.Item>
                                        <Button icon={<MinusCircleOutlined />} onClick={() => remove(name)} disabled={formDisabled} danger>Remove</Button>
                                    </Space>
                                ))}
                                <Button type='dashed' onClick={() => add({ name: '', value: '', desc: '' } as PromptVariableSpec)} block icon={<PlusOutlined />} disabled={formDisabled}>Add custom variable</Button>
                            </>
                        )}
                    </Form.List>
                </Card>
            ),
        },
        {
            key: 'debug',
            label: '7. Troubleshooting / raw JSON',
            children: (
                <Card bordered size='small' style={{ marginTop: 12 }}>
                    <Row gutter={[14, 6]}>
                        <Col xs={24}>
                            <Divider plain orientation='left'>Extra raw config JSON (optional · merge-overrides values above)
</Divider>
                            <Alert showIcon type='warning' style={{ marginBottom: 10 }} message='Advanced usage only' description='Any valid JSON will be merged into instance.config on save. Keys already set by tabs above take precedence on conflicts except raw; for labels/prompt templates use explicit tabs. Invalid JSON will block save with an inline warning.' />
                            <Form.Item name='extraConfigRaw' extra='e.g. {\"custom_parser_temperature\": 0.2}'><Input.TextArea rows={10} disabled={formDisabled} placeholder='{} (Valid JSON object)' style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }} /></Form.Item>
                        </Col>
                        <Col xs={24}>
                            <Divider plain orientation='left'>Live payload preview (read-only)</Divider>
                            <LivePreview form={form} />
                        </Col>
                    </Row>
                </Card>
            ),
        },
    ] as const), [form, applicablePresets, applyPreset, featureKind, provider, executionModeWatch, outputFormatOptions, labelsWatch, insertVariableAtCursor, isEdit, hasCfg, formDisabled, probing, onProbeHttp]);

    return (
        <div className='cvat-ai-feature-form-page'>
            <Card size='small' bordered className='cvat-page-header-card'>
                <Row align='middle' gutter={[12, 8]}>
                    <Col flex='none'>
                        <Button icon={<ArrowLeftOutlined />} onClick={() => history.push('/organization/ai-features')}>Back</Button>
                    </Col>
                    <Col flex='auto'>
                        <Title level={4} style={{ margin: 0 }}>
                            {isEdit ? (forbidden ? 'View AI function instance' : 'Edit AI function instance') : 'Create AI function instance'}
                        </Title>
                        <Text type='secondary'>
                            Organization: {organization?.name || organization?.slug || ''}
                            {slug && slug !== 'new' ? <>  ·  slug: {slug}</> : null}
                            {sensitiveBadges.length ? <Space size={4} style={{ marginLeft: 10 }}>{sensitiveBadges}</Space> : null}
                        </Text>
                    </Col>
                    <Col flex='none'>
                        <Space wrap size={[8, 8]}>
                            {forbidden ? (
                                <Tooltip title='Your current role does not have modification permission'>
                                    <Button type='primary' icon={<SaveOutlined />} disabled>{isEdit ? 'Save changes' : 'Create instance'}</Button>
                                </Tooltip>
                            ) : (
                                <Button type='primary' icon={<SaveOutlined />} loading={saving} onClick={() => {
                                    try {
                                        if (form.getFieldValue('_labelsRawDirty')) {
                                            const parsed = parseLabelsRawJson(form.getFieldValue('_labelsRawDraft') || '');
                                            form.setFieldsValue({ labels: parsed, _labelsRawDirty: false });
                                        }
                                    } catch (err: any) {
                                        notification.error({
                                            message: 'Invalid labels JSON',
                                            description: err?.message || String(err),
                                        });
                                        setActiveTab('labels');
                                        return;
                                    }
                                    form.validateFields()
                                        .then((values) => onFinish(values))
                                        .catch((err) => {
                                            if (err && Array.isArray(err.errorFields)) onFinishFailed(err);
                                            else notification.error({ message: 'Cannot create instance', description: err?.message || String(err) });
                                        });
                                }}>
                                    {isEdit ? 'Save changes' : 'Create instance'}
                                </Button>
                            )}
                            <Button onClick={() => history.push('/organization/ai-features')}>Cancel</Button>
                            {isEdit ? (
                                forbidden ? (
                                    <Tooltip title='Your current role does not have deletion permission'>
                                        <Button danger icon={<DeleteOutlined />} disabled>Delete instance</Button>
                                    </Tooltip>
                                ) : (
                                    <Popconfirm
                                        title={`Delete instance "${existInstance?.name || slug}"?`}
                                        description='This action cannot be undone. Existing annotation results will not be affected.'
                                        okText='Delete'
                                        okType='danger'
                                        cancelText='Cancel'
                                        onConfirm={async () => {
                                            try {
                                                setLoading(true);
                                                await organization?.deleteAIFunctionInstance(slug as string);
                                                notification.success({ message: 'Instance deleted' });
                                                history.push('/organization/ai-features');
                                            } catch (err: any) {
                                                notification.error({ message: 'Delete failed', description: err?.message || String(err) });
                                            } finally { setLoading(false); }
                                        }}
                                    >
                                        <Button danger icon={<DeleteOutlined />}>Delete instance</Button>
                                    </Popconfirm>
                                )
                            ) : null}
                        </Space>
                    </Col>
                </Row>
            </Card>

            <Spin spinning={loading || saving} tip={saving ? 'Saving…' : 'Loading…'} wrapperClassName='cvat-spinner-wrapper'>
                <div className='cvat-page-content' style={{ padding: 16 }}>
                    {forbidden ? (
                        <Alert type='info' showIcon message='View-only access' description='Your current role cannot create, edit, or delete AI function instances. Contact an organization owner/maintainer.' style={{ marginBottom: 16 }} />
                    ) : null}
                    <Form form={form} layout='vertical' onFinish={onFinish} onFinishFailed={onFinishFailed} scrollToFirstError requiredMark='optional' initialValues={{ isEnabled: true, isDefault: false, captionAttributeName: 'caption', provider: 'bailian', executionMode: 'vlm_prompt' }}>
                        <Tabs activeKey={activeTab} onChange={(k) => setActiveTab(k as TabKey)} items={tabsItems.map((t) => ({ ...t, forceRender: true }))} destroyInactiveTabPane={false} />
                    </Form>
                </div>
            </Spin>
        </div>
    );
}

function LabelsEditor(props: { disabled?: boolean }): JSX.Element {
    const { disabled } = props;
    const form = Form.useFormInstance();
    const labelsWatch = Form.useWatch('labels', form) as LabelSpec[] | undefined;
    const [rawMode, setRawMode] = useState<'raw' | 'constructor'>('raw');
    const [rawText, setRawText] = useState('[]\n');
    const [rawDirty, setRawDirty] = useState(false);

    useEffect(() => {
        if (rawMode !== 'raw' || rawDirty) {
            return;
        }
        setRawText(serializeLabelsRaw(labelsWatch));
    }, [rawMode, labelsWatch, rawDirty]);

    const applyRaw = (): void => {
        try {
            const parsed = parseLabelsRawJson(rawText);
            form.setFieldsValue({ labels: parsed, _labelsRawDraft: serializeLabelsRaw(parsed), _labelsRawDirty: false });
            setRawText(serializeLabelsRaw(parsed));
            setRawDirty(false);
            notification.success({
                message: `Loaded ${parsed.length} label(s) from JSON`,
                description: 'Review Constructor if you want, then Save changes on this instance.',
            });
            setRawMode('constructor');
        } catch (error: any) {
            notification.error({
                message: 'Invalid labels JSON',
                description: error?.message || String(error),
            });
        }
    };

    const resetRaw = (): void => {
        const snapshot = serializeLabelsRaw(form.getFieldValue('labels'));
        setRawDirty(false);
        setRawText(snapshot);
        form.setFieldsValue({ _labelsRawDraft: snapshot, _labelsRawDirty: false });
    };

    const constructor = (
        <Form.List name='labels'>
            {(fields, { add, remove }) => (
                <>
                    {fields.map(({ key, name, ...restField }) => (
                        <div className='label-list-item' key={key}>
                            <Row gutter={[10, 6]}>
                                <Col xs={24} md={6}>
                                    <Form.Item
                                        {...restField}
                                        name={[name, 'name']}
                                        label='Label name (ASCII)'
                                        rules={[
                                            { required: true, message: 'Required' },
                                            { pattern: LABEL_NAME_RE, message: 'ASCII identifier or path (e.g. Vehicle/VanCar)' },
                                            { max: 96 },
                                            {
                                                validator: async (_, value) => {
                                                    if (isPlaceholderLabel(value)) {
                                                        throw new Error('Placeholder names like None cannot be CVAT labels');
                                                    }
                                                },
                                            },
                                        ]}
                                    >
                                        <Input disabled={disabled} placeholder='e.g. pedestrian' />
                                    </Form.Item>
                                </Col>
                                <Col xs={24} md={4}>
                                    <Form.Item {...restField} name={[name, 'type']} label='Shape type' initialValue='rectangle'><Select disabled={disabled}><Option value='any'>Any (box or polygon)</Option><Option value='rectangle'>Rectangle</Option><Option value='polygon'>Polygon</Option><Option value='polyline'>Polyline (lane / curve)</Option><Option value='points'>Points / keypoints)</Option><Option value='tag'>Tag (no shape)</Option></Select></Form.Item>
                                </Col>
                                <Col xs={0}>
                                    <Form.Item {...restField} name={[name, 'color']} hidden><Input /></Form.Item>
                                </Col>
                                <Col xs={24} md={14}>
                                    <Form.Item {...restField} name={[name, 'description']} label='Description (optional, sent to LLM prompt)'><Input disabled={disabled} placeholder='e.g. Person walking or standing' /></Form.Item>
                                </Col>
                                <Col xs={24}>
                                    <Divider orientation='left' plain style={{ margin: '4px 0' }}>Attributes (optional · auto created if missing on save)</Divider>
                                    <Form.List name={[name, 'attributes']}>
                                        {(afields, aops) => (
                                            <>
                                                {afields.map((af) => (
                                                    <Space key={af.key} wrap size={[10, 6]} style={{ marginBottom: 6 }} align='baseline'>
                                                        <Form.Item {...af.restField} name={[af.name, 'name']} rules={[{ required: true }, { pattern: /^[A-Za-z_][A-Za-z0-9_-]*$/, message: 'ASCII identifier' }]}><Input addonBefore='attr' disabled={disabled} style={{ width: 180 }} placeholder='attribute_name' /></Form.Item>
                                                        <Form.Item {...af.restField} name={[af.name, 'type']} initialValue='text'><Select disabled={disabled} style={{ width: 160 }}><Option value='text'>TEXT (text / freeform</Option><Option value='select'>SELECT (dropdown)</Option><Option value='checkbox'>CHECKBOX</Option><Option value='number'>NUMBER</Option></Select></Form.Item>
                                                        <Form.Item {...af.restField} name={[af.name, 'description']}><Input disabled={disabled} style={{ width: 280 }} placeholder='Short description for LLM / users' /></Form.Item>
                                                        <Button icon={<MinusCircleOutlined />} onClick={() => aops.remove(af.name)} disabled={disabled} danger>Remove attr</Button>
                                                    </Space>
                                                ))}
                                                <Button type='dashed' size='small' onClick={() => aops.add({ name: '', type: 'text', description: '' })} disabled={disabled} icon={<PlusOutlined />}>Add attribute</Button>
                                            </>
                                        )}
                                    </Form.List>
                                </Col>
                            </Row>
                            <div style={{ textAlign: 'right', marginTop: 4 }}>
                                <Button icon={<MinusCircleOutlined />} onClick={() => remove(name)} disabled={disabled} danger size='small'>Remove label</Button>
                            </div>
                        </div>
                    ))}
                    <Button type='dashed' block icon={<PlusOutlined />} onClick={() => add({ name: '', type: 'any', description: '', attributes: [] } as LabelSpec)} disabled={disabled}>Add label</Button>
                </>
            )}
        </Form.List>
    );

    return (
        <div className='labels-editor-wrapper' data-cvat-ai-labels-raw='1'>
            <Alert showIcon type='info' style={{ marginBottom: 10 }} message='Paste the same JSON as Project Labels → Raw (name / color / type / attributes). Done loads every label at once. These names become the left column in Automatic annotation. Test connection can also fill from GET /labels.' />
            <Tabs
                activeKey={rawMode}
                onChange={(key) => setRawMode(key as 'raw' | 'constructor')}
                destroyInactiveTabPane={false}
                items={[
                    {
                        key: 'raw',
                        label: (
                            <span>
                                <EditOutlined />
                                {' '}
                                Raw
                            </span>
                        ),
                        forceRender: true,
                        children: (
                            <div className='cvat-ai-labels-raw'>
                                <Input.TextArea
                                    value={rawText}
                                    onChange={(event) => {
                                        const next = event.target.value;
                                        setRawDirty(true);
                                        setRawText(next);
                                        form.setFieldsValue({ _labelsRawDraft: next, _labelsRawDirty: true });
                                    }}
                                    disabled={disabled}
                                    rows={18}
                                    className='cvat-ai-labels-raw-textarea'
                                    placeholder='[ { "name": "box", "color": "#208080", "type": "any", "attributes": [] } ]'
                                />
                                <Space style={{ marginTop: 12 }}>
                                    <Button type='primary' disabled={disabled} onClick={applyRaw}>Done</Button>
                                    <Button danger disabled={disabled} onClick={resetRaw}>Reset</Button>
                                </Space>
                            </div>
                        ),
                    },
                    {
                        key: 'constructor',
                        label: (
                            <span>
                                <BuildOutlined />
                                {' '}
                                Constructor
                            </span>
                        ),
                        forceRender: true,
                        children: constructor,
                    },
                ]}
            />
        </div>
    );
}

function LivePreview({ form }: { form: any }): JSX.Element {
    const values = Form.useWatch([], form);
    const json = useMemo(() => JSON.stringify(values, null, 2), [values]);
    return <pre style={{ background: '#fafafa', padding: 12, borderRadius: 6, border: '1px solid #f0f0f0', fontSize: 12, lineHeight: 1.6, maxHeight: 420, overflow: 'auto' }}>{json}</pre>;
}
