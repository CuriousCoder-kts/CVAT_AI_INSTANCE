# CVAT 全面权限审计报告

**审计日期**: 2026-08-18
**审计范围**: 33 个 rego 规则文件 + 11 个 permissions.py 文件
**审计方法**: 代码级逐条比对 rego 实际 allow 分支 + base_filter 与角色分层期望

---

## 一、角色体系定义（代码现状正确）

| 层级 | 系统级角色 `privilege` | 组织级角色 `organization.user.role` | 优先级数字 (越小越高) |
|---|---|---|---|
| 1 (最高) | `admin` (Super Admin) | - | 0 |
| 2 | `user` | `owner` (组织 Owner) | 0 (组织内) |
| 3 | `user` | `maintainer` | 50 |
| 4 | `user` | `supervisor` | 75 |
| 5 | `worker` | `worker` | 100 |
| 6 (最低) | 非成员 / 未登录 | `role == null` | ∞ |

**关键函数说明**（见 [organizations.rego#L57-L59](file:///d:/cvat-develop/cvat/apps/organizations/rules/organizations.rego#L57-L59)）：
- `organizations.has_perm(X)` = "当前用户角色优先级 ≤ X 的优先级" = "当前用户权限 ≥ X"
- 例：`has_perm(MAINTAINER)` = Owner + Maintainer 两个角色
- 例：`has_perm(SUPERVISOR)` = Owner + Maintainer + Supervisor 三个角色

**辅助函数说明**:
- `organizations.is_staff` = Owner + Maintainer（**不含 Supervisor** — invitations/memberships 很多问题的根源）
- `organizations.is_member` = role != null（所有组织成员，含 Supervisor + Worker）
- `utils.has_perm(utils.USER)` = 全局 privilege == admin 或 user（不含 worker 组）

---

## 二、各模块权限矩阵与不合理点标注

✅ 符合预期  |  🔴 高优先级不合理  |  🟡 中优先级  |  🟢 低优先级

---

### 模块 1：Projects（项目） — [projects.rego](file:///d:/cvat-develop/cvat/apps/engine/rules/projects.rego)

| 操作 | Owner | Maintainer | Supervisor | Worker | 非成员 | 状态 |
|---|---|---|---|---|---|---|
| CREATE / IMPORT_BACKUP | ✅ | ✅ | ✅ (L73-77) | ❌ 仅 project_staff | ❌ | ✅ |
| LIST (base_filter) | ✅ 全组织 | ✅ 全组织 | ✅ 全组织 (L99-101 已修) | 仅 owner/assignee | ❌ | ✅ |
| VIEW / 导出 | ✅ 全组织 | ✅ 全组织 | ✅ 全组织 (L123-128 已修) | 仅 project_staff | ❌ | ✅ |
| UPDATE_DESC / IMPORT_DATASET | ✅ 全组织 | ✅ 全组织 | ✅ 作为 staff 可 | 仅 project_staff | ❌ | ✅ |
| UPDATE_ASSIGNEE / OWNER | ✅ 全组织 | ✅ 全组织 | ✅ 作为 staff 可 | 仅 resource_owner | ❌ | ✅ |
| DELETE | ✅ 全组织 + 资源 Owner | ✅ 全组织 + 资源 Owner | ✅ 作为 staff 可 | 仅 resource_owner | ❌ | ✅ |

**结论：Projects 模块 ✅ 合理，之前修的 Supervisor 分支完整存在。作为修复 Snippet 参考样板。**

---

### 模块 2：Tasks（任务） — [tasks.rego](file:///d:/cvat-develop/cvat/apps/engine/rules/tasks.rego)

| 操作 | Owner | Maintainer | Supervisor | Worker | 非成员 | 状态 |
|---|---|---|---|---|---|---|
| CREATE / IMPORT | ✅ | ✅ | ✅ (L124-129) | ❌ 仅 project_staff | ❌ | ✅ |
| LIST base_filter | ✅ 全 | ✅ 全 | ✅ 全 (L177-179 已修) | owner/assignee/project_staff | ❌ | ✅ |
| VIEW / VIEW_ANNOTATIONS / EXPORT | ✅ 全 | ✅ 全 | ✅ 全 (L214-223 已修) | 仅 task_staff | ❌ | ✅ |
| UPDATE_DESC / ANNOTATIONS 等 | ✅ 全 | ✅ 全 (L260-269) | ❌ 只能走 task_staff Worker 路径 | 仅 task_staff (L271-281) | ❌ | 🟡 ISSUE-T1 |
| UPDATE_OWNER/ASSIGNEE/PROJECT/DELETE | ✅ 全 | ✅ 全 (L310-318) | ❌ 只能走 task_staff Worker 路径 | 仅 task_owner/project_staff | ❌ | 🟡 ISSUE-T1 |

---

### 模块 3：Jobs（作业） — [jobs.rego](file:///d:/cvat-develop/cvat/apps/engine/rules/jobs.rego)

| 操作 | Owner | Maintainer | Supervisor | Worker | 非成员 | 状态 |
|---|---|---|---|---|---|---|
| LIST base_filter | ✅ 全 | ✅ 全 (L148-151) | **🔴 ISSUE-J1 缺失！跳到 Worker** | job_staff (L152-162) | ❌ | 🔴 严重 |
| CREATE / DELETE | ✅ 全 + task_staff | ✅ 全 (L191-200) | ✅ L173-179 但限制 task_staff | 仅 task_staff | ❌ | 🟡 ISSUE-J2 |
| VIEW / VIEW_ANNOTATIONS / EXPORT | ✅ 全 | ✅ 全 (L191-200) | **🔴 ISSUE-J3 缺失独立分支** | 仅 job_staff (L202-209) | ❌ | 🔴 严重 |
| UPDATE_STATE / ANNOTATIONS 等 | ✅ 全 | ✅ 全 (L235-243) | **🔴 ISSUE-J4 缺失独立分支** | 仅 job_staff (L245-254) | ❌ | 🔴 严重 |
| UPDATE_STAGE / ASSIGNEE | ✅ 全 | ✅ 全 (L275-280) | **🔴 ISSUE-J5 缺失独立分支** | 仅 task_staff (L282-288) | ❌ | 🔴 严重 |

---

### 模块 4：Issues（工单） — [issues.rego](file:///d:/cvat-develop/cvat/apps/engine/rules/issues.rego)

| 操作 | Owner | Maintainer | Supervisor | Worker | 非成员 | 状态 |
|---|---|---|---|---|---|---|
| LIST base_filter | ✅ 全 | ✅ 全 (L174-177) | **🔴 ISSUE-I1 缺失** | 仅 issue_staff 关联 (L178-190) | ❌ | 🔴 |
| CREATE_IN_JOB | ✅ 全 | ✅ 全 (L133-139) | **🔴 ISSUE-I2 缺失独立分支** | 仅 job_staff (L141-148) | ❌ | 🔴 |
| VIEW | ✅ 全 | ✅ 全 (L200-205) | **🔴 ISSUE-I3 缺失独立分支** | 仅 issue_staff (L207-212) | ❌ | 🔴 |
| UPDATE | ✅ 全 + issue_staff | ✅ 全 (L244-249) | **🔴 ISSUE-I4 缺失独立分支** | 仅 issue_staff (L221-227) | ❌ | 🔴 |
| DELETE | ✅ 全 + issue_admin | ✅ 全 (L244-249) | **🔴 ISSUE-I5 缺失独立分支** | 仅 issue_admin (L236-242) | ❌ | 🔴 |

---

### 模块 5：Comments（评论） — [comments.rego](file:///d:/cvat-develop/cvat/apps/engine/rules/comments.rego)

与 Issues **完全相同的 5 处 Supervisor 缺失模式**：

| 操作 | Owner | Maintainer | Supervisor | Worker | 状态 |
|---|---|---|---|---|---|
| LIST base_filter | ✅ | ✅ (L182-185) | **🔴 ISSUE-C1 缺失** | issue_staff 关联 (L186-199) | 🔴 |
| CREATE_IN_ISSUE | ✅ | ✅ 全 (L140-146) | **🔴 ISSUE-C2 缺失** | 仅 issue_staff (L148-155) | 🔴 |
| VIEW | ✅ | ✅ 全 (L209-214) | **🔴 ISSUE-C3 缺失** | comment_staff (L216-221) | 🔴 |
| UPDATE | ✅ | ✅ 全 (L230-235) | **🔴 ISSUE-C4 缺失** | comment_staff (L237-243) | 🔴 |
| DELETE | ✅ | ✅ 全 (L230-235) | **🔴 ISSUE-C5 缺失** | comment_staff (L237-243) | 🔴 |

---

### 模块 6：Labels（标签） — [labels.rego](file:///d:/cvat-develop/cvat/apps/engine/rules/labels.rego)

> Labels 的 UPDATE/DELETE/VIEW 不在 rego 里处理（permissions.py 透传到 project/task 的 UPDATE_DESC/VIEW），只有 LIST scope 走 rego。

| 操作 | Owner/Maintainer | Supervisor | Worker | 状态 |
|---|---|---|---|---|
| LIST base_filter | ✅ 全组织 (L71-74) | **🔴 ISSUE-L1 缺失** | 仅 task/project_staff (L75-83) | 🔴 |

---

### 模块 7：Quality 质控相关

#### 7.1 quality_settings.rego — [quality_settings.rego](file:///d:/cvat-develop/cvat/apps/quality_control/rules/quality_settings.rego)

| 操作 | Maintainer | Supervisor | Worker | 状态 |
|---|---|---|---|---|
| LIST base_filter | ✅ (L73-77) | **🔴 ISSUE-QS1 缺失** | task_staff 关联 (L78-88) | 🔴 |

#### 7.2 quality_reports.rego — [quality_reports.rego](file:///d:/cvat-develop/cvat/apps/quality_control/rules/quality_reports.rego)

| 操作 | Maintainer | Supervisor | Worker | 状态 |
|---|---|---|---|---|
| LIST base_filter | ✅ (L110-113) | **🔴 ISSUE-QR1 缺失** | task_staff 关联 (L114-118) | 🔴 |
| CREATE / VIEW | ✅ 全 (L75-80) | **🔴 ISSUE-QR2 缺失独立分支** | task_staff (L82-88) | 🔴 |

---

### 模块 8：Consensus 一致性相关

#### 8.1 consensus_settings.rego — [consensus_settings.rego](file:///d:/cvat-develop/cvat/apps/consensus/rules/consensus_settings.rego)

| 操作 | Maintainer | Supervisor | Worker | 状态 |
|---|---|---|---|---|
| LIST base_filter | ✅ (L71-74) | **🔴 ISSUE-CS1 缺失** | task_staff 关联 (L75-84) | 🔴 |

#### 8.2 consensus_merges.rego — [consensus_merges.rego](file:///d:/cvat-develop/cvat/apps/consensus/rules/consensus_merges.rego)

| 操作 | Maintainer | Supervisor | Worker | 状态 |
|---|---|---|---|---|
| CREATE | ✅ 全 (L57-62) | **🟡 ISSUE-CM1 缺失独立分支** | task_staff (L64-70) | 🟡 |

---

### 模块 9：Lambda / Models / 自动标注 — [lambda.rego](file:///d:/cvat-develop/cvat/apps/lambda_manager/rules/lambda.rego)

| 操作 | Owner/Maintainer | Supervisor | Worker | 非成员 | 状态 |
|---|---|---|---|---|---|
| LIST allow | ✅ 全局开放（无限制） | ✅ 全局开放 | ✅ 全局开放 | ✅ 也能 LIST | 🟢 ISSUE-L1 |
| VIEW allow | ✅ 全局开放 | ✅ 全局开放 | ✅ 全局开放 | ✅ 也能 VIEW | 🟢 ISSUE-L1 |
| LIST base_filter | ✅ 全组织 (L57-60) | **🔴 ISSUE-L2 缺失** (L61-69 跳 Worker) | 仅 staff 关联 | ❌ | 🔴 严重 |
| CALL_ONLINE / OFFLINE | ✅ 全局 Worker 即可 | ✅ 全局 Worker 即可 | ✅ 全局 Worker 即可 | **🟡 ISSUE-L3 非成员只要全局 Worker 也能 CALL！** | 🟡 |

> **ISSUE-L1（低）**: LIST/VIEW 全局开放是非成员也能看模型。模型 metadata 不敏感，问题不大，但如果有私有模型就有风险。
> **ISSUE-L3（中）**: CALL_ONLINE/OFFLINE L41-44 只检查 `utils.has_perm(utils.WORKER)`，没有 `organizations.is_member`。非组织成员但全局是 Worker 组也能调组织的自动标注。

---

### 模块 10：Analytics 分析报表 — [analytics.rego](file:///d:/cvat-develop/cvat/apps/log_viewer/rules/analytics.rego)

```rego
allow if {
    input.auth.user.has_analytics_access   # 只看这个 flag，完全忽略组织角色！
}
```

**🟡 ISSUE-A1（中高，设计缺陷）：完全绕过组织角色分层**
- Owner / Maintainer / Supervisor 如果 DB 里 `has_analytics_access = False` → 看不到分析数据（不合理，管理层默认应该有权）
- 非组织成员如果 `has_analytics_access = True` → 可以看任何组织的分析（严重越权风险）
- Worker 也可能因为有 flag 看所有分析数据

---

### 模块 11：Webhooks — [webhooks.rego](file:///d:/cvat-develop/cvat/apps/webhooks/rules/webhooks.rego)

| 操作 | Maintainer | Supervisor | Worker Project Owner | 状态 |
|---|---|---|---|---|
| CREATE_IN_PROJECT (组织) | ✅ L152-156 | ✅（能走 L166-172 Worker 路径，因为 Supervisor has_perm(WORKER)=true）| ✅ L166-172 | ✅ 需验证 |
| base_filter | ✅ 全组织 (L77-80) | **🔴 ISSUE-W1 缺失** | 仅 owner/project_owner (L81-89) | 🔴 |

---

### 模块 12：Invitations 邀请 — [invitations.rego](file:///d:/cvat-develop/cvat/apps/organizations/rules/invitations.rego)

> 所有问题总根源：`organizations.is_staff` = Owner + Maintainer（不含 Supervisor）

| 操作 | Owner | Maintainer | Supervisor | Worker 邀请人自己 | 受邀人 | 状态 |
|---|---|---|---|---|---|---|
| CREATE 邀请 | ✅ 邀除 Owner 外 | ✅ 邀 ≤Supervisor | **🟡 ISSUE-INV1 完全不能邀** | ❌ | ❌ | 🟡 产品决策 |
| base_filter | ✅ 全组织 (L58-61) | ✅ 属于 is_staff | **🔴 ISSUE-INV2 不属于 is_staff → 只能看自己的** | ❌ 自己发的/受邀的 | ❌ | 🟢 |
| RESEND / DELETE | ✅ 全组织 (L131-157) | ✅ 全组织 (is_staff) | **🟡 ISSUE-INV3 不能，走 Worker 分支只能自己发的** | ✅ 自己发的 (L138-143, L159-164) | ❌ | 🟢 |
| VIEW | ✅ 全组织 Staff (L105-110) | ✅ 全组织 Staff | ✅ 属于 is_staff ✅ | ✅ 自己发的 | ✅ 受邀的 | ✅ |

---

### 模块 13：Memberships 成员 — [memberships.rego](file:///d:/cvat-develop/cvat/apps/organizations/rules/memberships.rego)

> 同源：is_staff 不含 Supervisor

| 操作 | Owner | Maintainer | Supervisor | Worker 自己 | 状态 |
|---|---|---|---|---|---|
| LIST / VIEW | ✅ 全 | ✅ 全 | ✅ 全 (is_member 就行 L44-47) | ✅ 只能看 active | ✅ 合理 |
| base_filter | ✅ 全组织 (L57-58 is_staff) | ✅ 同上 | **🟡 ISSUE-M1 只能看 is_active=true（和 Worker 一样）** | ✅ is_active (L59-61) | 🟢 |
| CHANGE_ROLE / DELETE 成员 | ✅ 除 Owner 和自己 | ✅ 只能 ≤Supervisor 非自己 | ✅ Supervisor 不能改别人角色（设计合理） | ❌ | ✅ 合理 |
| 退出 (DELETE 自己) | ❌ Owner 不能退 | ✅ | ✅ | ✅ | ✅ |

---

### 模块 14：CloudStorages 云存储 — [cloudstorages.rego](file:///d:/cvat-develop/cvat/apps/engine/rules/cloudstorages.rego)

✅ **本模块修得最完整！样板参考**

| 操作 | Maintainer | Supervisor | Worker Owner | 状态 |
|---|---|---|---|---|
| CREATE | ✅ (L45-50) | ❌ 不能创建（合理，涉及密钥） | ❌ | ✅ |
| base_filter | ✅ | ✅ (L64-66) 已修 | 仅自己 (L67-73) | ✅ |
| VIEW / LIST_CONTENT | ✅ | ✅ (L90-95) 已修 | 仅自己 (L83-88) | ✅ |
| UPDATE / DELETE | ✅ (L113-118) | ❌ Supervisor 不能改密钥类配置（合理）| 仅自己 | ✅ |

---

### 模块 15：AnnotationGuides 标注指南 — [annotationguides.rego](file:///d:/cvat-develop/cvat/apps/engine/rules/annotationguides.rego)

| 操作 | Maintainer | Supervisor | Worker target_staff/job_staff | 状态 |
|---|---|---|---|---|
| VIEW | ✅ 全组织 (L79-84) | **🟡 ISSUE-AG1 缺失** | ✅ L94-106 双路径 | 🟡 |
| CREATE / UPDATE / DELETE | ✅ 全组织 (L79-84) | **🟡 ISSUE-AG2 缺失** | 仅 target_staff (L86-92) | 🟡 |

---

### 模块 16：Events 事件 — [events.rego](file:///d:/cvat-develop/cvat/apps/events/rules/events.rego)

| 操作 | Maintainer | Supervisor | Worker | 状态 |
|---|---|---|---|---|
| SEND_EVENTS | ✅ 全员开放（合理，埋点）| ✅ 全员开放 | ✅ 全员开放 | ✅ |
| DUMP_EVENTS allow | ✅ WORKER+is_member (L46-50) | ✅ 同左 | ✅ 同左 | ✅ |
| DUMP_EVENTS filter | ✅ 整 org dump (L70-72) | **🟡 ISSUE-E1 缺失！走 Worker 分支只能 dump 自己** (L73-77) | 仅自己 user_id | 🟡 |

---

### 模块 17：Users 用户 — [users.rego](file:///d:/cvat-develop/cvat/apps/engine/rules/users.rego)

✅ **本模块完全合理**：组织环境下 base_filter 是空对象（L54-56），任何组织成员都能看到其他组织成员。个人资料只能自己改，正确。

---

### 模块 18：organizations/permissions.py SAFE_METHODS 审计（之前修的那块）

✅ **完全正确**，见 [permissions.py](file:///d:/cvat-develop/cvat/apps/organizations/permissions.py):
- L9: 正确 import `SAFE_METHODS`
- L40-42: `bailian_settings` GET→VIEW / 其他→UPDATE
- L43-46: `ai_function_instances` + `ai_function_instance_detail` GET→VIEW / 其他→UPDATE
- L47-53: enable/disable/set_default/create_members 一律 UPDATE

> **产品待确认**: Supervisor 是否应该能改 bailian_settings / ai_function_instances ?
> - 目前 organizations.rego L99-109 UPDATE scope 只给了 Worker+resource_owner（Owner）和 MAINTAINER 角色
> - 所以 Supervisor 目前只能看（VIEW 已修）不能改（UPDATE 不在 allow 里）
> - 如果产品期望 Supervisor 也能改 → 需额外在 organizations.rego 补 Supervisor UPDATE 分支

---

## 三、标准修复 Snippet（参照 projects.rego + tasks.rego + cloudstorages.rego 已修样板）

### 修复 Snippet A: base_filter 补 Supervisor 分支
适用文件：jobs / issues / comments / labels / lambda / quality_settings / quality_reports / consensus_settings / webhooks

```rego
# 在 is_organization MAINTAINER 的 else := {} 之后
# 直接跳 organizations.has_perm(WORKER) qobject 之前，插入 Supervisor 块
base_filter := {} if {
    utils.is_admin
} else := qobject if {
    # ... sandbox 分支保持原样 ...
} else := {} if {
    utils.is_organization
    utils.has_perm(utils.USER)
    organizations.has_perm(organizations.MAINTAINER)
# ---------- 新增开始 ----------
} else := {} if {
    organizations.has_perm(organizations.SUPERVISOR)
    utils.has_perm(utils.USER)
# ---------- 新增结束 ----------
} else := qobject if {
    organizations.has_perm(organizations.WORKER)
    # ... Worker qobject 保持原样 ...
}
```

**注意 base_filter 条件顺序**: 必须先判断高优先级角色（MAINTAINER）→ 再 SUPERVISOR → 最后 WORKER，否则 rego 算不到正确分支（因为 Supervisor has_perm(WORKER)=true，会先匹配到 Worker 的 qobject 分支）。

---

### 修复 Snippet B: scope allow 补 Supervisor 独立分支
适用场景：所有 VIEW / UPDATE / CREATE scope 有 Maintainer 全组织 allow，缺 Supervisor。

```rego
# ---- Maintainer 已有的 allow ----
allow if {
    input.scope in {utils.VIEW, utils.UPDATE_DESC, ...}
    input.auth.organization.id == input.resource.organization.id
    utils.has_perm(utils.USER)
    organizations.has_perm(organizations.MAINTAINER)
}
# ---- 新增 Supervisor allow（插在 Maintainer 之后 Worker 之前）----
allow if {
    input.scope in {utils.VIEW, utils.UPDATE_DESC, ...}
    input.auth.organization.id == input.resource.organization.id
    utils.has_perm(utils.USER)
    organizations.has_perm(organizations.SUPERVISOR)
}
# ---- Worker 已有的 task_staff / project_staff 限制 allow ----
allow if {
    input.scope in {utils.VIEW, ...}
    input.auth.organization.id == input.resource.organization.id
    organizations.has_perm(organizations.WORKER)
    is_xxx_staff
}
```

---

## 四、问题清单按优先级汇总

### 🔴 高优先级（立即修复，确认后落地）— 共 20 处改动 × 8 个文件

| ID | 文件 | 问题类型 | 具体位置说明 |
|---|---|---|---|
| ISSUE-J1 | jobs.rego | base_filter | L148 之后缺 Supervisor 分支 |
| ISSUE-J3 | jobs.rego | scope allow | VIEW / EXPORT / VIEW_ANNOTATIONS / VIEW_DATA / VIEW_METADATA 缺 Supervisor (对比 L191-200 + L202-209) |
| ISSUE-J4 | jobs.rego | scope allow | UPDATE_STATE / UPDATE_ANNOTATIONS / DELETE_ANNOTATIONS / IMPORT_ANNOTATIONS / UPDATE_METADATA 缺 Supervisor (L235-243 + L245-254) |
| ISSUE-J5 | jobs.rego | scope allow | UPDATE_STAGE / UPDATE_ASSIGNEE 缺 Supervisor (L275-280 + L282-288) |
| ISSUE-J2 | jobs.rego | scope allow | CREATE / DELETE 现有 Supervisor 分支 (L173-179) 应放宽到和 Maintainer 一样全组织，不限制 is_task_staff |
| ISSUE-I1 | issues.rego | base_filter | L174 之后缺 Supervisor |
| ISSUE-I2 | issues.rego | scope allow | CREATE_IN_JOB 缺 Supervisor 独立 allow |
| ISSUE-I3 | issues.rego | scope allow | VIEW 缺 Supervisor |
| ISSUE-I4 | issues.rego | scope allow | UPDATE 缺 Supervisor |
| ISSUE-I5 | issues.rego | scope allow | DELETE 缺 Supervisor |
| ISSUE-C1 | comments.rego | base_filter | L182 之后缺 Supervisor |
| ISSUE-C2 | comments.rego | scope allow | CREATE_IN_ISSUE 缺 Supervisor |
| ISSUE-C3 | comments.rego | scope allow | VIEW 缺 Supervisor |
| ISSUE-C4 | comments.rego | scope allow | UPDATE 缺 Supervisor |
| ISSUE-C5 | comments.rego | scope allow | DELETE 缺 Supervisor |
| ISSUE-L1 | labels.rego | base_filter | L71 之后缺 Supervisor |
| ISSUE-L2 | lambda.rego | base_filter | L57 之后缺 Supervisor |
| ISSUE-QS1 | quality_settings.rego | base_filter | L73 之后缺 Supervisor |
| ISSUE-QR1 | quality_reports.rego | base_filter | L110 之后缺 Supervisor |
| ISSUE-QR2 | quality_reports.rego | scope allow | CREATE / VIEW 缺 Supervisor |
| ISSUE-CS1 | consensus_settings.rego | base_filter | L71 之后缺 Supervisor |
| ISSUE-W1 | webhooks.rego | base_filter | L77 之后缺 Supervisor |

---

### 🟡 中优先级（下一版本修复）— 共 9 处

| ID | 文件 | 问题 | 修复建议 |
|---|---|---|---|
| ISSUE-T1 | tasks.rego UPDATE* + DELETE | Supervisor 只能走 task_staff Worker 路径 | 按 Snippet B 补 Supervisor 独立 allow 全组织（DELETE/UPDATE_OWNER/ASSIGNEE 等敏感操作可选仅给 Maintainer）|
| ISSUE-CM1 | consensus_merges.rego CREATE | Supervisor 缺独立 allow | 按 Snippet B 补（Maintainer 已有，插 Supervisor，再保留 Worker task_staff）|
| ISSUE-L3 | lambda.rego CALL_ONLINE/OFFLINE | 缺少 `organizations.is_member` 校验 | 在 L41-44 `utils.has_perm(utils.WORKER)` 后加 `organizations.is_member` 限制非成员调用 |
| ISSUE-A1 | analytics.rego | 完全绕过组织角色分层 | 加分层规则：Owner/Maintainer → 无条件 allow；Supervisor → 需 has_analytics_access；Worker → 一律拒绝；另外加组织过滤 org_id 匹配 |
| ISSUE-AG1 | annotationguides.rego VIEW | Supervisor 缺独立分支 | 按 Snippet B 补 VIEW scope Supervisor |
| ISSUE-AG2 | annotationguides.rego CREATE/UPDATE/DELETE | Supervisor 缺独立分支 | 按 Snippet B 补；DELETE 敏感操作可只给 Maintainer+ |
| ISSUE-E1 | events.rego DUMP filter | Supervisor 不能整 org dump | 在 filter L70-72 Maintainer 整 org 分支后补 Supervisor 同样整 org filter |
| (待确认) | organizations.rego UPDATE scope | Supervisor 能否改 bailian_settings/ai_instances ? | 产品确认后：如需 → 补 Supervisor has_perm(SUPERVISOR) + has_perm(USER) allow |
| (待确认) | invitations.rego is_staff 不含 Supervisor | Supervisor 邀请/重发能力 | 产品决策后，要么把 Supervisor 加入 organizations.rego L38-44 is_staff 定义（影响 invitations+memberships），要么各分支单独补 Supervisor 判断 |

---

### 🟢 低优先级（产品决策）— 共 4 处

| ID | 问题 | 说明 |
|---|---|---|
| ISSUE-L1 | lambda.rego LIST/VIEW 全局开放非成员也能看 | 元数据不敏感可不修；如果有私有 detector 需要加 is_member 校验 |
| ISSUE-INV1 | invitations.rego CREATE Supervisor 不能邀人 | 产品决定 Supervisor 是否需要邀请权限 |
| ISSUE-INV2/INV3 | invitations.rego base_filter/RESEND Supervisor 能力受限 | 同上，和 is_staff 定义联动调整 |
| ISSUE-M1 | memberships.rego base_filter Supervisor 同 Worker 待遇 | 实际成员都是 is_active 所以无实质影响，只是语义不严谨 |

---

## 五、修改落地执行步骤建议

### 推荐顺序（避免 rego 语法错误导致 OPA 全挂）

1. **先改 base_filter**（8~9 个文件统一模式，最不容易写错）
   - labels.rego → lambda.rego → quality_settings.rego → consensus_settings.rego → quality_reports.rego (base_filter 部分)
   - issues.rego → comments.rego → jobs.rego → webhooks.rego (base_filter 部分)
   - 每改完一个单独 OPA reload 验证语法正确

2. **再改 scope allow 分支**（容易漏 scope 名）
   - jobs.rego 最复杂：先改 VIEW 类 → 再 UPDATE 类 → 最后 CREATE/DELETE
   - issues.rego 5 个 scope：CREATE_IN_JOB / VIEW / UPDATE / DELETE
   - comments.rego 5 个 scope：CREATE_IN_ISSUE / VIEW / UPDATE / DELETE
   - quality_reports.rego：CREATE + VIEW
   - consensus_merges.rego：CREATE

3. **最后做回归验证矩阵**（必须做）
   - 用 Admin 账号验证：所有列表/操作仍然正常（确认没把 Admin allow 覆盖写坏）
   - 用 Owner 账号验证：同上
   - 用 Maintainer 账号验证：同上（所有原 Maintainer 能力不能坏）
   - **用 Supervisor 账号验证（新增验证点）**：
     - Jobs 列表：能看到组织内所有 Job（不是只有自己 assignee 的）
     - Issues / Comments 列表：同上
     - Labels 列表：能看到组织内所有标签
     - Lambda 列表：能看到组织内所有 models
     - Quality 列表：能看到组织内所有质控设置和报告
     - Consensus Settings 列表：同上
     - Jobs：能对任意组织 Job 做 UPDATE_STAGE / UPDATE_ASSIGNEE
   - 用 Worker 账号验证：**最重要，防止权限放宽过度**
     - Jobs 列表：应该还是只能看到自己 assignee / task_staff 的那些（没有因为我们加 Supervisor 分支导致 Worker 也能看全组织）
     - 所有 UPDATE/DELETE 操作：仍然只能改自己 staff 关联的资源

4. **修复命令**
   - OPA 容器运行时热加载：`docker compose restart opa`
   - 如果 OPA 是 sidecar 模式可能需要连带重启 cvat_server / cvat_worker

---

## 六、修改记录跟踪表（用户逐条确认时打勾）

| # | 改动项 ID | 涉及文件 | 改动类型 | 是否已确认 | 是否已落地 | 回归验证通过 |
|---|---|---|---|---|---|---|
| 1 | ISSUE-L1 | labels.rego | base_filter Supervisor | ☐ | ☐ | ☐ |
| 2 | ISSUE-L2 | lambda.rego | base_filter Supervisor | ☐ | ☐ | ☐ |
| 3 | ISSUE-QS1 | quality_settings.rego | base_filter Supervisor | ☐ | ☐ | ☐ |
| 4 | ISSUE-CS1 | consensus_settings.rego | base_filter Supervisor | ☐ | ☐ | ☐ |
| 5 | ISSUE-QR1 | quality_reports.rego | base_filter Supervisor | ☐ | ☐ | ☐ |
| 6 | ISSUE-I1 | issues.rego | base_filter Supervisor | ☐ | ☐ | ☐ |
| 7 | ISSUE-C1 | comments.rego | base_filter Supervisor | ☐ | ☐ | ☐ |
| 8 | ISSUE-J1 | jobs.rego | base_filter Supervisor | ☐ | ☐ | ☐ |
| 9 | ISSUE-W1 | webhooks.rego | base_filter Supervisor | ☐ | ☐ | ☐ |
| 10 | ISSUE-J3 | jobs.rego | VIEW scope Supervisor 补全 | ☐ | ☐ | ☐ |
| 11 | ISSUE-J4 | jobs.rego | UPDATE_* scope Supervisor 补全 | ☐ | ☐ | ☐ |
| 12 | ISSUE-J5 | jobs.rego | UPDATE_STAGE/ASSIGNEE Supervisor 补全 | ☐ | ☐ | ☐ |
| 13 | ISSUE-J2 | jobs.rego | CREATE/DELETE Supervisor 放宽 is_task_staff | ☐ | ☐ | ☐ |
| 14 | ISSUE-I2 | issues.rego | CREATE_IN_JOB Supervisor 补独立 allow | ☐ | ☐ | ☐ |
| 15 | ISSUE-I3 | issues.rego | VIEW Supervisor 补独立 allow | ☐ | ☐ | ☐ |
| 16 | ISSUE-I4 | issues.rego | UPDATE Supervisor 补独立 allow | ☐ | ☐ | ☐ |
| 17 | ISSUE-I5 | issues.rego | DELETE Supervisor 补独立 allow | ☐ | ☐ | ☐ |
| 18 | ISSUE-C2 | comments.rego | CREATE_IN_ISSUE Supervisor 补独立 allow | ☐ | ☐ | ☐ |
| 19 | ISSUE-C3 | comments.rego | VIEW Supervisor 补独立 allow | ☐ | ☐ | ☐ |
| 20 | ISSUE-C4 | comments.rego | UPDATE Supervisor 补独立 allow | ☐ | ☐ | ☐ |
| 21 | ISSUE-C5 | comments.rego | DELETE Supervisor 补独立 allow | ☐ | ☐ | ☐ |
| 22 | ISSUE-QR2 | quality_reports.rego | CREATE/VIEW Supervisor 补独立 allow | ☐ | ☐ | ☐ |
| 23 | ISSUE-CM1 | consensus_merges.rego | CREATE Supervisor 补独立 allow | ☐ | ☐ | ☐ |
| 24 | ISSUE-L3 | lambda.rego | CALL_ONLINE/OFFLINE 加 is_member 校验 | ☐ | ☐ | ☐ |
| 25 | ISSUE-A1 | analytics.rego | 分层权限重写（Maintainer/Supervisor/Worker）| ☐ | ☐ | ☐ |
| 26 | ISSUE-T1 | tasks.rego | UPDATE* + DELETE Supervisor 补全 | ☐ | ☐ | ☐ |
| 27 | ISSUE-AG1 | annotationguides.rego | VIEW Supervisor 补全 | ☐ | ☐ | ☐ |
| 28 | ISSUE-AG2 | annotationguides.rego | CREATE/UPDATE/DELETE Supervisor 补全 | ☐ | ☐ | ☐ |
| 29 | ISSUE-E1 | events.rego | DUMP filter Supervisor 补全 org 级 | ☐ | ☐ | ☐ |
| 30 | (产品确认) | organizations.rego | Supervisor UPDATE bailian/ai_instance 权限 ? | ☐ | ☐ | ☐ |
| 31 | (产品确认) | invitations.rego + orgs.rego | Supervisor 邀请权限 / is_staff 定义调整 ? | ☐ | ☐ | ☐ |
