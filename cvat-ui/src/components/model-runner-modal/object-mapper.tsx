// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useEffect, useState } from 'react';
import { Row, Col } from 'antd/lib/grid';
import Select from 'antd/lib/select';
import Tag from 'antd/lib/tag';

import { DeleteOutlined, QuestionCircleOutlined, CheckCircleFilled, CheckOutlined } from '@ant-design/icons';

import CVATTooltip from 'components/common/cvat-tooltip';
import { computeTextColor } from 'utils/compute-text-color';

interface Props {
    leftData: object[];
    rightData: object[];
    defaultMapping: [object, object | null][];
    allowManyToOne: boolean;
    rowClassName: string;
    containerClassName: string;
    deleteMappingLabel: string;
    infoMappingLabel: string;
    getObjectName(object: object): string;
    getObjectColor(object: object): string | undefined;
    filterObjects(left: object | null | object[], right: object | null | object[]): object[];
    onUpdateMapping(mapping: [object, object | null][]): void;
    rowExtras?(left: object, right: object | null): JSX.Element[];
}

function ObjectMapperComponent(props: Props): JSX.Element {
    const {
        leftData, rightData, defaultMapping, allowManyToOne,
        rowClassName, containerClassName, deleteMappingLabel, infoMappingLabel,
        getObjectName, getObjectColor, onUpdateMapping, filterObjects, rowExtras,
    } = props;

    const [mapping, setMapping] = useState<Props['defaultMapping']>(defaultMapping as Props['defaultMapping']);
    const [leftValue, setLeftValue] = useState<object | null>(null);
    const [rightValue, setRightValue] = useState<object | null>(null);

    const setMappingWrapper = (updated: Props['defaultMapping']): void => {
        onUpdateMapping(updated);
        setMapping(updated);
    };

    const usedLeftNames = new Set(
        mapping
            .map(([l]) => (l ? getObjectName(l) : null))
            .filter((n): n is string => typeof n === 'string' && n.length > 0),
    );
    const usedRightNames = new Set(
        mapping
            .map(([, r]) => (r ? getObjectName(r) : null))
            .filter((n): n is string => typeof n === 'string' && n.length > 0),
    );
    const notMappedLeft = leftData.filter((left) => {
        const name = getObjectName(left);
        return !usedLeftNames.has(name);
    });
    const notMappedRight = (): object[] => {
        if (allowManyToOne) {
            return rightData;
        }
        // 同左列，按 name 去重（避免引用不相等误判）
        return rightData.filter((right) => !usedRightNames.has(getObjectName(right)));
    };

    useEffect(() => {
        setMappingWrapper(defaultMapping as Props['defaultMapping']);
    }, [leftData, rightData]);

    useEffect(() => {
        if (leftValue && rightValue) {
            setMappingWrapper([...mapping, [leftValue, rightValue]]);
            setLeftValue(null);
            setRightValue(null);
        }
    }, [leftValue, rightValue]);

    return (
        <div className={containerClassName}>
            { mapping.map((mappingItem, idx) => {
                const [left, right] = mappingItem;
                const leftName = left ? getObjectName(left) : '';
                const rightName = right ? getObjectName(right) : '';
                const rightPlaceholder = !right ? '← Click Select to choose a task label' : '';
                // Bug Fix MAPPER-1: color 兜底。
                // AI Instance 的 modelLabels 只有 name/type（config.labels 里用户没填 color），
                // getObjectColor(left) 返回 undefined → Antd Tag 背景白/透明 + 文字几乎和页面融合，
                // 就像截图里的前 3 行"左侧空白"（实际上用户根本看不见 Tag）。
                // 修复策略：① 左 color → 右 color → 兜底灰色 #bfbfbf，最后保底永远有颜色；
                //          ② 同时保证 computeTextColor() 的输入非空。
                const rawColor = (left ? getObjectColor(left) : undefined) ||
                                 (right ? getObjectColor(right) : undefined);
                const color = (typeof rawColor === 'string' && rawColor.trim().length >= 3) ? rawColor : '#bfbfbf';
                const textColor = computeTextColor(color);
                // Bug Fix MAPPER-2 辅助：半映射行（!right）左侧 Tag 加一个轻描边 + 轻微文字加深，
                // 避免用户视觉上认为它是占位。
                const semiMapStyle = !right ? {
                    border: '1px dashed #8c8c8c',
                    fontWeight: 500 as const,
                } : undefined;
                const rowKey = `${leftName || 'NO-LEFT'}:${rightName || 'NO-RIGHT'}:${idx}`;

                return (
                    <React.Fragment key={rowKey}>
                        <Row className={rowClassName} key={rowKey}>
                            <Col span={9}>
                                { left ? (
                                    <Tag
                                        style={{
                                            color: textColor,
                                            ...(semiMapStyle || {}),
                                        }}
                                        color={color}
                                        key={`L-${leftName}-${rowKey}`}
                                    >
                                        {leftName}
                                    </Tag>
                                ) : (
                                    <Select
                                        virtual
                                        showSearch
                                        size='small'
                                        placeholder='Select a model label'
                                        value={leftValue ? getObjectName(leftValue) : null}
                                        onChange={(value) => {
                                            const chosen = notMappedLeft.find(
                                                (o) => getObjectName(o) === value,
                                            ) || null;
                                            setLeftValue(chosen);
                                        }}
                                    >
                                        {filterObjects(notMappedLeft, rightValue).map((obj) => (
                                            <Select.Option
                                                key={getObjectName(obj)}
                                                value={getObjectName(obj)}
                                            >
                                                {getObjectName(obj)}
                                            </Select.Option>
                                        ))}
                                    </Select>
                                )}
                            </Col>
                            <Col span={9} offset={1}>
                                { right ? (
                                    <Tag
                                        style={{ color: textColor }}
                                        color={color}
                                        key={`R-${rightName}-${rowKey}`}
                                    >
                                        {rightName}
                                    </Tag>
                                ) : left ? (
                                    <>
                                        <Select
                                            virtual
                                            showSearch
                                            size='small'
                                            style={{ width: '100%' }}
                                            placeholder='← Select task label'
                                            allowClear
                                            onChange={(value) => {
                                                if (!value) return;
                                                const chosen = notMappedRight().find(
                                                    (o) => getObjectName(o) === value,
                                                ) || null;
                                                if (chosen) {
                                                    const next = mapping.map((mItem) => (
                                                        mItem === mappingItem ? [left, chosen] : mItem
                                                    ));
                                                    setMappingWrapper(next as Props['defaultMapping']);
                                                }
                                            }}
                                        >
                                            {/* =================================================================
                                                 Bug Fix MAPPER-6 (右侧下拉过滤过度导致看不到 3 个同名 task label)

                                                 旧：{filterObjects(left, notMappedRight()).map(...)
                                                 问题：filterObjects 内部调用 labelsCompatible(left, rightLabel)，
                                                 如果 left=pedestrian 模型 label type=RECTANGLE，任务里 pedestrian
                                                 的 type=polygon / any / 或任何不一致，labelsCompatible 返回 false，
                                                 于是把任务里所有 pedestrian/cyclist/motor_vehicle **全部过滤掉**，
                                                 用户任务明明有 9 个 labels，但下拉只显示 6 个（non_motor + traffic 6）！
                                                 用户根本看不到同名 taskLabel，导致误以为任务没配。

                                                 修复：半映射行（用户明确要手动选 task label 的场景）→ 不再强制 labelsCompatible，
                                                 只保留一个非常宽松的「智能排序 + 明显不兼容剔除」：
                                                 · allowManyToOne=true 场景：rightData 全显示（因为用户可以多对一）
                                                 · 否则：只过滤已经被其它行占用的 task label（notMappedRight 本身已过滤）
                                                 · 智能排序：同名 label 排在最前面（命中高亮 ← 匹配优先推荐），
                                                   其次归一化同名，再次 labelsCompatible 兼容的，其余最后
                                                 这样用户能看到 9 个 task label，不会再被偷偷过滤成 6 个！
                                               ================================================================== */}
                                            {(() => {
                                                const rawRight = notMappedRight();
                                                const leftName = String(left ? getObjectName(left) : '').trim();
                                                const leftNorm = leftName
                                                    .toLowerCase()
                                                    .replace(/[\s_-]+/g, '');

                                                // 打分：0 最好 → 同名精确匹配；1 归一化同名；2 labelsCompatible；3 其余
                                                const scored = rawRight.map((obj) => {
                                                    const n = getObjectName(obj);
                                                    const nNorm = String(n || '')
                                                        .toLowerCase()
                                                        .replace(/[\s_-]+/g, '');
                                                    let score = 3;
                                                    if (leftName && String(n) === leftName) {
                                                        score = 0;
                                                    } else if (leftNorm && nNorm === leftNorm) {
                                                        score = 1;
                                                    } else if (
                                                        left && typeof (filterObjects as any) === 'function' &&
                                                        // 宽松探测：只看 labelsCompatible 是否把它过滤
                                                        (() => {
                                                            try {
                                                                const filtered = filterObjects(left, [obj]);
                                                                return Array.isArray(filtered) && filtered.length > 0;
                                                            } catch (_e) {
                                                                return false;
                                                            }
                                                        })()
                                                    ) {
                                                        score = 2;
                                                    }
                                                    return { obj, n, score };
                                                });
                                                scored.sort((a, b) => {
                                                    if (a.score !== b.score) return a.score - b.score;
                                                    return String(a.n).localeCompare(String(b.n));
                                                });
                                                return scored.map(({ obj, n, score }) => (
                                                    <Select.Option
                                                        key={String(n)}
                                                        value={String(n)}
                                                        title={
                                                            score === 0
                                                                ? `${n} (精确同名匹配，推荐)`
                                                                : score === 1
                                                                    ? `${n} (归一化同名，推荐)`
                                                                    : score === 2
                                                                        ? `${n} (类型兼容)`
                                                                        : `${n} (需要手动确认兼容性)`
                                                        }
                                                    >
                                                        {score === 0 ? (
                                                            <span style={{ fontWeight: 700 }}>
                                                                <CheckCircleFilled
                                                                    style={{
                                                                        color: '#52c41a',
                                                                        marginRight: 6,
                                                                        fontSize: 12,
                                                                    }}
                                                                />
                                                                {String(n)} ← 同名，建议选择
                                                            </span>
                                                        ) : score === 1 ? (
                                                            <span style={{ fontWeight: 600 }}>
                                                                <CheckCircleFilled
                                                                    style={{
                                                                        color: '#1890ff',
                                                                        marginRight: 6,
                                                                        fontSize: 12,
                                                                    }}
                                                                />
                                                                {String(n)} ← 归一化同名，建议选择
                                                            </span>
                                                        ) : (
                                                            <span>
                                                                {score === 2 ? (
                                                                    <CheckOutlined
                                                                        style={{
                                                                            color: '#8c8c8c',
                                                                            marginRight: 6,
                                                                            fontSize: 11,
                                                                        }}
                                                                    />
                                                                ) : null}
                                                                {String(n)}
                                                            </span>
                                                        )}
                                                    </Select.Option>
                                                ));
                                            })()}
                                        </Select>
                                        { rightPlaceholder ? (
                                            <div
                                                style={{
                                                    fontSize: 11,
                                                    color: '#999',
                                                    marginTop: 2,
                                                    lineHeight: 1.2,
                                                }}
                                            >
                                                {rightPlaceholder}
                                            </div>
                                        ) : null}
                                    </>
                                ) : (
                                    <Select
                                        virtual
                                        showSearch
                                        size='small'
                                        placeholder='Select a task label'
                                        allowClear
                                        value={rightValue ? getObjectName(rightValue) : null}
                                        onChange={(value) => {
                                            const chosen = notMappedRight().find(
                                                (o) => getObjectName(o) === value,
                                            ) || null;
                                            setRightValue(chosen);
                                        }}
                                    >
                                        {filterObjects(leftValue, notMappedRight()).map((obj) => (
                                            <Select.Option
                                                key={getObjectName(obj)}
                                                value={getObjectName(obj)}
                                            >
                                                {getObjectName(obj)}
                                            </Select.Option>
                                        ))}
                                    </Select>
                                )}
                            </Col>
                            <Col span={2} offset={1}>
                                <CVATTooltip title={deleteMappingLabel}>
                                    <DeleteOutlined
                                        className='cvat-danger-circle-icon'
                                        onClick={() => setMappingWrapper(
                                            mapping.filter((_mapping) => _mapping !== mappingItem),
                                        )}
                                    />
                                </CVATTooltip>
                            </Col>
                        </Row>

                        { rowExtras ? rowExtras(mappingItem[0], mappingItem[1]) : null }
                    </React.Fragment>
                );
            })}

            { (leftValue === null || rightValue === null) && !!notMappedLeft.length && (
                <Row className={rowClassName}>
                    <Col span={9}>
                        <Select
                            virtual
                            showSearch
                            value={leftValue ? getObjectName(leftValue) : null}
                            size='small'
                            placeholder='Add new model label…'
                            onChange={(value) => {
                                setLeftValue(notMappedLeft
                                    .find((obj) => getObjectName(obj) === value) || null);
                            }}
                        >
                            {filterObjects(notMappedLeft, rightValue).map((obj) => (
                                <Select.Option
                                    key={getObjectName(obj)}
                                    value={getObjectName(obj)}
                                >
                                    {getObjectName(obj)}
                                </Select.Option>
                            ))}
                        </Select>
                    </Col>
                    <Col span={9} offset={1}>
                        <Select
                            virtual
                            showSearch
                            value={rightValue ? getObjectName(rightValue) : null}
                            size='small'
                            placeholder='Add new task label…'
                            allowClear
                            onChange={(value) => {
                                setRightValue(notMappedRight()
                                    .find((obj) => getObjectName(obj) === value) || null);
                            }}
                        >
                            {filterObjects(leftValue, notMappedRight()).map((obj) => (
                                <Select.Option
                                    key={getObjectName(obj)}
                                    value={getObjectName(obj)}
                                >
                                    {getObjectName(obj)}
                                </Select.Option>
                            ))}
                        </Select>
                    </Col>
                    <Col span={2} offset={1}>
                        { (leftValue === null && rightValue === null) ? (
                            <CVATTooltip title={infoMappingLabel}>
                                <QuestionCircleOutlined className='cvat-info-circle-icon' />
                            </CVATTooltip>
                        ) : (
                            <CVATTooltip title={deleteMappingLabel}>
                                <DeleteOutlined
                                    className='cvat-danger-circle-icon'
                                    onClick={() => {
                                        setLeftValue(null);
                                        setRightValue(null);
                                    }}
                                />
                            </CVATTooltip>
                        )}
                    </Col>
                </Row>
            )}
        </div>
    );
}

export default React.memo(ObjectMapperComponent);
