// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useCallback, useRef, useEffect } from 'react';

import { Attribute, Label, LabelType } from 'cvat-core-wrapper';
import ObjectMatcher from './object-mapper';

export type Md2JobAttributesMapping = [AttributeInterface | null, AttributeInterface | null][];
export type Md2JobLabelsMapping = [LabelInterface, LabelInterface | null][];

// The latest tuple element is child mapping (e.g. for skeleton points)
export type FullMapping = [LabelInterface, LabelInterface | null, Md2JobAttributesMapping, FullMapping][];

export interface AttributeInterface {
    name: Attribute['name'];
    values: Attribute['values'];
    input_type: Attribute['inputType'];
}

export interface LabelInterface {
    name: Label['name'];
    type: Label['type'];
    color?: Label['color'];
    attributes?: AttributeInterface[];
    sublabels?: Omit<LabelInterface, 'sublabels'>[];
}

interface Props {
    modelLabels: LabelInterface[];
    taskLabels: LabelInterface[];
    onUpdateMapping(mapping: FullMapping): void;
}

function labelsCompatible(modelLabel: LabelInterface, jobLabel: LabelInterface): boolean {
    const { type: modelLabelType } = modelLabel;
    const { type: jobLabelType } = jobLabel;
    const compatibleTypes = [[LabelType.MASK, LabelType.POLYGON]];
    return modelLabelType === jobLabelType ||
        (jobLabelType === LabelType.ANY && modelLabelType !== LabelType.SKELETON) ||
        (modelLabelType === LabelType.ANY && jobLabelType !== LabelType.SKELETON) ||
        compatibleTypes.some((compatible) => compatible.includes(jobLabelType) && compatible.includes(modelLabelType));
}

// 【Bug 1 FIX】
// ObjectMapper component (object-mapper.tsx L72-L103) 只渲染 mapping.map() 里「已有的行」，
// 如果 defaultMapping 只匹配到 6/9 个 task 对应的标签，剩下 3 个 modelLabel(pedestrian/cyclist/motor_vehicle)
// 根本不会在 UI 显示为行（只会在最下方作为一个 Select 选项，用户很难发现）。
//
// 修复：把所有 modelLabel（即使在 taskLabels 里找不到同名兼容项）全部初始化写入 mapping
//       命中 taskLabel → [modelLabel, taskLabel]
//       未命中 taskLabel → [modelLabel, null]
// 这样 ObjectMapper 会渲染出 9 行，右侧的 null 会被 Row 渲染为空位置，
// 再配合 row 上 Select → 可以让用户手动把 3 个未命中标签映射到任意 taskLabel。
function computeLabelsAutoMapping(
    modelLabels: LabelInterface[],
    taskLabels: LabelInterface[],
): Md2JobLabelsMapping {
    const autoMapping: Md2JobLabelsMapping = [];
    const matchedTask = new WeakSet<LabelInterface>();
    // 用 name 字符串去重兜底，避免引用不相等导致 WeakSet 判重失效
    const usedTaskNames = new Set<string>();

    // ================================================================
    // 【Bug Fix MAPPER-5（终极根因修复）】First Pass: 只按 label NAME 同名匹配
    //
    // 为什么用户任务里明明有 9 个 labels（含 pedestrian/cyclist/motor_vehicle），
    // 但自动匹配只命中了 6 个（non_motor/traffic_* 6 项），剩余 3 个被显示为半映射行，
    // 而且右侧 Select 下拉里也看不到这 3 个同名 taskLabel？
    //
    // 根因：First Pass 以前要求「modelLabel.name === taskLabel.name **AND labelsCompatible**」
    //       如果两边 label 的 type 值不一致（比如 task.pedestrian.type='polygon' 或
    //       'any'，但模型给的是 'rectangle'），labelsCompatible 返回 false → 同名也不匹配！
    //       然后 3 行变成半映射，object-mapper 右侧 Select 又调用一次 labelsCompatible 过滤，
    //       再次把 task 里的 pedestrian/cyclist/motor_vehicle 过滤掉 → **下拉里只剩 6 个**！
    //
    // 修复策略：同名是强约束！只要两边 label name 完全一致（大小写不敏感忽略下划线空格，
    // 或全等于），就直接自动映射。类型兼容性放到 Second Pass 模糊匹配阶段才检查。
    // 这样任务里 9 个 labels 只要 name 对得上，就算 type 不同，也一定会被自动匹配。
    // ================================================================
    const nameNorm = (s: string): string =>
        String(s || '').toLowerCase().replace(/[\s_-]+/g, '').trim();

    // First pass A: exact CASE-SENSITIVE name match (strict equality 最高优先级)
    for (let i = 0; i < modelLabels.length; i++) {
        const modelLabel = modelLabels[i];
        let found: LabelInterface | null = null;
        for (let j = 0; j < taskLabels.length && !found; j++) {
            const taskLabel = taskLabels[j];
            if (matchedTask.has(taskLabel)) continue;
            if (usedTaskNames.has(String(taskLabel.name || ''))) continue;
            if (String(modelLabel.name || '') === String(taskLabel.name || '')) {
                found = taskLabel;
                matchedTask.add(taskLabel);
                usedTaskNames.add(String(taskLabel.name));
            }
        }
        autoMapping.push([modelLabel, found as LabelInterface]);
    }

    // First pass B: 对于仍未命中的 modelLabel，再试 name 归一化匹配(去空格/下划线/大小写不敏感)
    //                (仍然不检查 labelsCompatible，名称相同就是强信号)
    for (let i = 0; i < autoMapping.length; i++) {
        if (autoMapping[i][1]) continue;
        const ml = autoMapping[i][0];
        const mlNorm = nameNorm(ml.name);
        if (!mlNorm) continue;
        let found: LabelInterface | null = null;
        for (let j = 0; j < taskLabels.length && !found; j++) {
            const tl = taskLabels[j];
            if (matchedTask.has(tl)) continue;
            if (usedTaskNames.has(String(tl.name || ''))) continue;
            const tlNorm = nameNorm(tl.name);
            if (!tlNorm) continue;
            if (mlNorm === tlNorm) {
                found = tl;
                matchedTask.add(tl);
                usedTaskNames.add(String(tl.name));
            }
        }
        if (found) {
            autoMapping[i][1] = found as LabelInterface;
        }
    }

    // Second pass: fuzzy name 匹配 + labelsCompatible（兜底，处理 Motor Vehicle vs motor_vehicle 这种）
    // 只有 FIRST PASS AB 都没命中时才走这里，这时才检查类型兼容性，
    // 保证不会出现"类型完全不搭的两个 label 被自动瞎映射"。
    for (let i = 0; i < autoMapping.length; i++) {
        if (autoMapping[i][1]) continue;
        const ml = autoMapping[i][0];
        const mlNorm = nameNorm(ml.name);
        for (let j = 0; j < taskLabels.length; j++) {
            const tl = taskLabels[j];
            if (matchedTask.has(tl)) continue;
            if (usedTaskNames.has(String(tl.name || ''))) continue;
            const tlNorm = nameNorm(tl.name);
            if (mlNorm && tlNorm && labelsCompatible(ml, tl) &&
                (mlNorm.includes(tlNorm) || tlNorm.includes(mlNorm))) {
                autoMapping[i][1] = tl as LabelInterface;
                matchedTask.add(tl);
                usedTaskNames.add(String(tl.name));
                break;
            }
        }
    }

    return autoMapping;
}

function computeAttributesAutoMapping(
    modelAttributes: AttributeInterface[],
    taskAttributes: AttributeInterface[],
): Md2JobAttributesMapping {
    const autoMapping: Md2JobAttributesMapping = [];
    for (let i = 0; i < modelAttributes.length; i++) {
        for (let j = 0; j < taskAttributes.length; j++) {
            const modelAttribute = modelAttributes[i];
            const taskAttribute = taskAttributes[j];
            if (modelAttribute.name === taskAttribute.name) {
                autoMapping.push([modelAttribute, taskAttribute]);
            }
        }
    }
    return autoMapping;
}

function LabelsMapperComponent(props: Props): JSX.Element {
    const { modelLabels, taskLabels, onUpdateMapping } = props;
    const mappingRef = useRef<FullMapping>([]);
    const setMapping = useCallback((_mapping: FullMapping) => {
        mappingRef.current = _mapping;
        onUpdateMapping(_mapping);
    }, [onUpdateMapping]);

    function getMappingItem(
        modelLabel: LabelInterface, taskLabel: LabelInterface, source: FullMapping,
    ): [number, FullMapping[0] | undefined] {
        const index = source.findIndex((el) => el[0] === modelLabel && el[1] === taskLabel);
        if (index !== -1) {
            return [index, source[index]];
        }

        return [-1, undefined];
    }

    const updateSublabelAttributesMapping = (
        modelLabel: LabelInterface, taskLabel: LabelInterface,
    ) => (
        modelSublabel: LabelInterface, taskSublabel: LabelInterface,
    ) => (
        _attrMapping: [AttributeInterface, AttributeInterface][],
    ) => {
        const mapping = mappingRef.current;
        const [parentIndex, parentItem] = getMappingItem(modelLabel, taskLabel, mapping);
        const copy = mapping.filter((_, index) => index !== parentIndex);
        if (parentItem) {
            const [childIndex] = getMappingItem(modelSublabel, taskSublabel, parentItem[3]);
            copy.push([
                modelLabel, taskLabel, parentItem[2],
                [
                    ...parentItem[3].filter((_, index) => index !== childIndex),
                    [modelSublabel, taskSublabel, _attrMapping, []],
                ],
            ]);

            setMapping(copy);
        }
    };

    const updateSublabelsMapping = (
        modelLabel: LabelInterface, taskLabel: LabelInterface,
    ) => (sublabelsMapping: [LabelInterface, LabelInterface][]) => {
        const mapping = mappingRef.current;
        const [index, parentItem] = getMappingItem(modelLabel, taskLabel, mapping);
        if (parentItem) {
            const updated = sublabelsMapping.reduce<FullMapping>((acc, [modelSublabel, taskSublabel]) => {
                const [, item] = getMappingItem(modelSublabel, taskSublabel, parentItem[3]);
                // the code to avoid reset mapping for attributes
                if (item) {
                    return [...acc, item];
                }

                return [...acc, [modelSublabel, taskSublabel, [], []]];
            }, []);

            const copy = mapping.filter((_, _index: number) => index !== _index);
            copy.push([
                modelLabel, taskLabel, parentItem[2], updated,
            ] as FullMapping[0]);
            setMapping(copy);
        }
    };

    return (
        <ObjectMatcher
            leftData={modelLabels}
            rightData={taskLabels}
            allowManyToOne
            defaultMapping={computeLabelsAutoMapping(modelLabels, taskLabels)}
            deleteMappingLabel='Remove mapped label'
            infoMappingLabel='Specify mapping between labels'
            containerClassName='cvat-runner-label-mapper'
            rowClassName='cvat-runner-label-mapping-row'
            getObjectName={(object: LabelInterface) => object.name}
            getObjectColor={(object: LabelInterface) => object.color}
            filterObjects={(
                left: LabelInterface | null | LabelInterface[],
                right: LabelInterface | null | LabelInterface[],
            ): LabelInterface[] => {
                if (Array.isArray(left) && !Array.isArray(right)) {
                    if (right) {
                        return left.filter((leftLabel) => labelsCompatible(leftLabel, right));
                    }

                    return left;
                }

                if (!Array.isArray(left) && Array.isArray(right)) {
                    if (left) {
                        return right.filter((rightLabel) => labelsCompatible(left, rightLabel));
                    }

                    return right;
                }

                return [];
            }}
            rowExtras={(modelLabel: LabelInterface, taskLabel: LabelInterface): JSX.Element[] => {
                if (!modelLabel || !taskLabel) {
                    return [];
                }
                const extras = [];

                if (modelLabel.attributes?.length && taskLabel.attributes?.length) {
                    extras.push(
                        <React.Fragment key='attributes'>
                            <ObjectMatcher
                                leftData={modelLabel.attributes}
                                rightData={taskLabel.attributes}
                                allowManyToOne={false}
                                defaultMapping={computeAttributesAutoMapping(
                                    modelLabel.attributes || [],
                                    taskLabel.attributes || [],
                                ) as [AttributeInterface, AttributeInterface][]}
                                rowClassName='cvat-runner-attribute-mapping-row'
                                containerClassName='cvat-runner-attribute-mapper'
                                deleteMappingLabel='Remove mapped attribute'
                                infoMappingLabel='Specify mapping between label attributes'
                                getObjectName={(object: AttributeInterface) => object.name}
                                getObjectColor={() => taskLabel.color}
                                filterObjects={(
                                    left: AttributeInterface | null | AttributeInterface[],
                                    right: AttributeInterface | null | AttributeInterface[],
                                ): AttributeInterface[] => {
                                    if (Array.isArray(left)) return left;
                                    if (Array.isArray(right)) return right;
                                    return [];
                                }}
                                onUpdateMapping={(_attrMapping: [AttributeInterface, AttributeInterface][]) => {
                                    const mapping = mappingRef.current;
                                    const [index, item] = getMappingItem(modelLabel, taskLabel, mapping);
                                    if (index !== -1 && item) {
                                        const copy = mapping.filter((_, _index: number) => index !== _index);
                                        copy.push([modelLabel, taskLabel, _attrMapping, item[3]] as FullMapping[0]);
                                        setMapping(copy);
                                    }
                                }}
                            />
                        </React.Fragment>,
                    );
                }

                if (modelLabel.type === LabelType.SKELETON && taskLabel.type === LabelType.SKELETON) {
                    extras.push(
                        <React.Fragment key='skeleton'>
                            <ObjectMatcher
                                leftData={modelLabel.sublabels || []}
                                rightData={taskLabel.sublabels || []}
                                allowManyToOne={false}
                                defaultMapping={computeLabelsAutoMapping(
                                    modelLabel.sublabels || [],
                                    taskLabel.sublabels || [],
                                )}
                                rowClassName='cvat-runner-label-mapping-row'
                                containerClassName='cvat-runner-label-mapper'
                                deleteMappingLabel='Remove mapped label'
                                infoMappingLabel='Specify mapping between skeleton sublabels'
                                getObjectName={(object: LabelInterface) => object.name}
                                getObjectColor={(object: LabelInterface) => object.color}
                                filterObjects={(
                                    left: LabelInterface | null | LabelInterface[],
                                    right: LabelInterface | null | LabelInterface[],
                                ): LabelInterface[] => {
                                    if (Array.isArray(left)) return left;
                                    if (Array.isArray(right)) return right;
                                    return [];
                                }}
                                rowExtras={(modelSublabel: LabelInterface, taskSublabel: LabelInterface) => {
                                    if (!modelSublabel || !taskSublabel) {
                                        return [];
                                    }
                                    const sublabelRowExtras = [];

                                    if (modelSublabel.attributes?.length && taskSublabel.attributes?.length) {
                                        sublabelRowExtras.push(
                                            <React.Fragment key='attributes'>
                                                <ObjectMatcher
                                                    leftData={modelSublabel.attributes}
                                                    rightData={taskSublabel.attributes}
                                                    allowManyToOne={false}
                                                    defaultMapping={computeAttributesAutoMapping(
                                                        modelSublabel.attributes || [],
                                                        taskSublabel.attributes || [],
                                                    ) as [AttributeInterface, AttributeInterface][]}
                                                    rowClassName='cvat-runner-attribute-mapping-row'
                                                    containerClassName='cvat-runner-attribute-mapper'
                                                    deleteMappingLabel='Remove mapped attribute'
                                                    infoMappingLabel='Specify mapping between sublabel attributes'
                                                    getObjectName={(object: AttributeInterface) => object.name}
                                                    getObjectColor={() => taskSublabel.color}
                                                    filterObjects={(
                                                        left: AttributeInterface | null | AttributeInterface[],
                                                        right: AttributeInterface | null | AttributeInterface[],
                                                    ): AttributeInterface[] => {
                                                        if (Array.isArray(left)) return left;
                                                        if (Array.isArray(right)) return right;
                                                        return [];
                                                    }}
                                                    onUpdateMapping={
                                                        updateSublabelAttributesMapping(
                                                            modelLabel, taskLabel,
                                                        )(modelSublabel, taskSublabel)
                                                    }
                                                />
                                            </React.Fragment>,
                                        );
                                    }

                                    return sublabelRowExtras;
                                }}
                                onUpdateMapping={updateSublabelsMapping(modelLabel, taskLabel)}
                            />
                        </React.Fragment>,
                    );
                }

                return extras;
            }}
            onUpdateMapping={(_mapping: [LabelInterface, LabelInterface][]) => {
                const updated = _mapping.reduce<FullMapping>((acc, [modelLabel, taskLabel]) => {
                    const [index, item] = getMappingItem(modelLabel, taskLabel, mappingRef.current);
                    // the code to avoid reset mapping for sublabels/attributes
                    // when one of top level mappings was updated
                    if (index !== -1 && item) {
                        return [...acc, item];
                    }

                    return [...acc, [modelLabel, taskLabel, [], []]];
                }, []);

                setMapping(updated);
            }}
        />
    );
}

export default React.memo(LabelsMapperComponent);
