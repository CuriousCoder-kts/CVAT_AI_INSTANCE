import base64
import io
import json
import os
import re
import time

import requests
import yaml
from PIL import Image


_ALLOWED_LABELS = [
    "pedestrian",
    "cyclist",
    "motor_vehicle",
    "non_motor_vehicle",
    "traffic_cone",
    "traffic_bucket",
    "traffic_column",
    "plastic_barrier",
    "guard_rail",
]

_ALLOWED_SET = set(_ALLOWED_LABELS)

_CLASS_SPEC = [
    {
        "name": "pedestrian",
        "description": (
            "行人：走路/站立/蹲坐的人本体，没有骑或坐在任何车辆上。\n"
            "\n"
            "判定规则：**存在级至少命中 1 条 + 分类级至少命中 1 条**才标；把握不足 45% → 直接跳过，不要勉强标。\n"
            "\n"
            "===== 存在级 cue（至少命中 1 条 → 进入分类级判断；把握 < 45% 仍跳过） =====\n"
            "  E1) 远处看起来像一个直立的小人人形：尺寸 16×30 像素以上，有头/躯干/腿中至少 2 段垂直堆叠结构可确认（不需要 3 段都全，剪影轮廓看得出来是人行就进）。\n"
            "  E2) 深色/浅色直立竖条：高宽比 ≥ 1.2，顶部有头部圆/隆起 + 中段有躯干感，底部触地（不需要看到鞋脚）→ 进入分类。\n"
            "  E3) 被树/柱/车/站牌挡住部分，露出的头/肩/躯干/腿中任意 2 段结构明确 → 进入分类。\n"
            "  E4) 画面边缘/角落有人形轮廓：尺寸 ≥ 5/1000 画面高，且垂直堆叠结构不是一根直杆（路灯杆/柱子是单条直没有躯干头分层）→ 进入分类。\n"
            "\n"
            "===== 分类级 cue（存在级命中 1 条 + 这里至少命中 1 条 → 可以标 pedestrian） =====\n"
            "  C1) 直立人形：头/肩/躯干/腿任意 2 段结构垂直堆叠可辨，高宽比 ≥ 1.2（不需要每段都完整）。\n"
            "  C2) 顶部有头 + 底部着地（或中段躯干有衣物折叠纹理），或身上有背包/衣物/雨披轮廓。\n"
            "  C3) 下方没有两轮/车架等车辆结构明显重叠（如果下方明确叠了两轮/车架 → 改判 cyclist）。\n"
            "  C4) 整体尺寸介于交通柱和 motor_vehicle 之间（不需要精确，明显不是巨型物/颗粒像素就行）。\n"
            "\n"
            "❌ 骑车/坐电动车/坐摩托车的人：不算 pedestrian，算 cyclist（人车并包一个框）。\n"
            "❌ 绝对跳过清单：路灯杆/电线杆/交通柱/路牌杆/监控杆 = 单条直没有头躯干分层的绝对不算 pedestrian。\n"
            "拿不准 pedestrian vs cyclist vs 跳过：直立竖条有头/躯干 2 段分层 + 下方没看到两轮/车架 + 把握 ≥ 45% → 才标 pedestrian；否则 → cyclist（如果有车叠加）或 直接跳过。宁缺毋滥！"
        ),
    },
    {
        "name": "cyclist",
        "description": (
            "骑行者：一个框整体打包包住人+车（自行车/电动车/摩托车/三轮车），人和车千万不要拆成两个框！\n"
            "\n"
            "判定规则：**存在级至少命中 1 条 + 分类级至少命中 1 条**才标；把握不足 45% → 直接跳过，不要勉强标。\n"
            "⚠️ **优先级提示**：只要画面里两轮/三轮车（自行车/电动车/摩托车/三轮车）+ 有人形叠在上方/坐在车上（哪怕只能看到头盔顶+车身轮廓），优先判 cyclist（人车并包一个大框）；只有「明确空着、车上完全看不到任何人形/头盔/手臂重叠」的情况才走 non_motor_vehicle 流程。\n"
            "\n"
            "===== 存在级 cue（至少命中 1 条 → 进入分类级判断；把握 < 45% 仍跳过） =====\n"
            "  E1) 路面上上下堆叠结构：上层有人轮廓（头/肩/身/头盔顶 ≥ 1 个结构），下层有两轮/车架/踏板轮廓 ≥ 1 个结构 → 进入分类。\n"
            "  E2) 罩布/雨披盖着的物体：下方有两轮/车架轮廓 + 上方有坐姿人形隆起/头盔突起/雨衣帽檐 ≥ 1 个可见 → 进入分类。\n"
            "  E3) 远处模糊团状：上部分颜色/纹理和下部分明显不同（上=衣物头盔颜色，下=车架车轮暗色），整体高宽比 0.5~2.0 + 尺寸比 pedestrian 大一圈或相近 → 进入分类。\n"
            "  E4) 画面边缘/遮挡区：有两轮/车轮廓 + 人轮廓部分叠合 → 进入分类。\n"
            "  E5) 排队骑行大队：画面有多辆连排，每辆有两轮+人坐姿堆叠结构的，每辆独立进入分类（不要合并成一个大框）。\n"
            "\n"
            "===== 分类级 cue（存在级命中 1 条 + 这里至少命中 1 条 → 可以标 cyclist） =====\n"
            "  C1) 近处：上方有人形结构（头/肩/手臂/头盔任意1个）+ 下方有车结构（两轮/车架/踏板/脚蹬任意1个），两者位置关系是人在车的上方/前方叠放。\n"
            "  C2) 车把附近有手臂/手轮廓或头顶有头盔/帽子/雨衣帽檐 ≥ 1 个特征。\n"
            "  C3) 远处模糊仍可判：上下两部分颜色纹理分界明显，整体尺寸在 pedestrian 和 motor_vehicle 之间。\n"
            "  C4) 雨披/罩布盖：下方两轮/车架轮廓有 1 个可见 + 上方坐姿人形有隆起/头盔突起 → 人车并包一个框（不要拆成人+车两个框！）。\n"
            "\n"
            "❌ 明确空着停在路边、车上完全没有人形/头盔/手臂/坐姿重叠的车辆：算 non_motor_vehicle（只有「空车」才判这个）。\n"
            "拿不准两轮车有人 vs 空车 vs 跳过：只要人+车有重叠结构（哪怕只看到头盔顶+一个车轮）+ 把握 ≥ 45% → cyclist；只有完全空（车上绝对没有人形任何痕迹）+ 把握 ≥ 45% → non_motor_vehicle；否则 → cyclist（宁误 cyclist 不丢骑行大队）。"
        ),
    },
    {
        "name": "motor_vehicle",
        "description": (
            "机动车辆：汽车/轿车/SUV/巴士/双层巴士/货车/大卡车/面包车/带篷驾驶室机动三轮车/有四轮或明显机动车轮廓的都算。\n"
            "\n"
            "判定规则：**存在级至少命中 1 条 + 分类级至少命中 1 条**才标；把握不足 45% → 直接跳过，不要为了凑数把背景硬判 motor_vehicle。\n"
            "\n"
            "===== 存在级 cue（至少命中 1 条 → 进入分类级判断；把握 < 45% 仍跳过） =====\n"
            "  E1) 被遮挡物体：被挡 ≤ 85%（露出来 15% 以上）且 露出部分 ≥ 1 条机动车线索（完整车尾/完整车头/一个轮拱/一个车轮阴影/一个车窗/对称车灯/一排车门线）→ 进入分类；只露一个像素角/完全看不清结构的跳过。\n"
            "  E2) 道路排队车辆群：相邻车之间有缝隙/色差/结构差，每辆独立露出 ≥ 1 条机动车线索（车尾/前灯/一个车轮/车顶线）→ 每辆进入分类（不要合并成一个大框）。\n"
            "  E3) 边缘/遮挡区轮廓：看起来像汽车/卡车/巴士的一部分，露出结构明确（车尾轮廓/车顶/车门/车窗 ≥ 1 个）→ 进入分类。\n"
            "  E4) 远处模糊地面矩形横条：长高比 1.0~4.0 + 尺寸 ≥ 行人 1.8 倍 + 位置在道路/车道上（不需要两个明确车轮黑影，远距离轮影看不见很正常，只要尺寸对+在路上+横条就进）→ 进入分类。\n"
            "  E5) 双层结构：上下两排窗户可见（哪怕被灌木/遮挡盖掉 70%，只要有一排半窗就够）→ 进入分类（双层巴士/大巴）。\n"
            "\n"
            "===== 分类级 cue（存在级命中 1 条 + 这里至少命中 1 条 → 可以标 motor_vehicle） =====\n"
            "  C1) 能看到 ≥ 1 个车轮/轮拱轮廓 + 车身颜色/结构（不需要两个，被车挡住只露一个轮也可以）。\n"
            "  C2) 封闭车厢：车顶横线 + 车窗 ≥ 1 个矩形玻璃；或对称车灯/格栅/保险杠/后视镜 ≥ 1 组。\n"
            "  C3) 侧视长条：长高比 ≥ 1.0 + 底部有轮拱凹陷/阴影/车身下沿黑线 ≥ 1 个。\n"
            "  C4) 远处：地面矩形横条（长高比 1.0~4.0）+ 位置确实在道路上（不是在人行道正中央的楼/花台）。\n"
            "  C5) 双层巴士：上下两排窗（一排半也行）+ 车身整体明显比轿车高。\n"
            "\n"
            "❌ 两轮无舱自行车/电动车/摩托车：不算 motor_vehicle，判 cyclist 或 non_motor_vehicle。\n"
            "❌ 绝对跳过清单：路边围墙/大门/广告牌/公交站亭/大型垃圾桶/建筑脚手架/花坛/花台 = 绝对不算 motor_vehicle。\n"
            "拿不准横条物体是 motor_vehicle vs 背景物体：至少有机动车核心线索 ≥ 1 条（车轮/车窗/车灯/车尾）+ 位置在路上 + 把握 ≥ 45% → 才标；否则 → 直接跳过。"
        ),
    },
    {
        "name": "non_motor_vehicle",
        "description": (
            "非机动车辆（明确空车）：停着没人的自行车/电动车/摩托车/三轮车（交通工具），车上绝对没人骑。\n"
            "\n"
            "判定规则：**存在级至少命中 1 条 + 分类级至少命中 1 条 + 空车确认至少 1 条**才标；把握不足 45% → 直接跳过，不要误标手拉小车/花坛/花盆等。\n"
            "⚠️ **优先级提示**：只要有两轮/三轮车 + 有人形/头盔/手臂任何一个「坐在车上/叠在车上」的线索 → 直接判 cyclist，不要来 non_motor_vehicle；只有完全空（车上绝对没有人形任何痕迹）的停着车才来这里。\n"
            "\n"
            "===== 存在级 cue（至少命中 1 条 → 进入分类级判断；把握 < 45% 仍跳过） =====\n"
            "  E1) 人行道/停车区/居民楼门口/路边单独停着的两轮/三轮物体：车轮圆+车架结构明确可见，车座/车把附近没有任何头/手臂/躯干轮廓叠 → 进入分类。\n"
            "  E2) 画面边缘/路肩长条带内：有停着的两轮车轮廓，没有任何人形轮廓叠在车的上半部分 → 进入分类。\n"
            "\n"
            "===== 分类级 cue（存在级命中 1 条 + 这里至少命中 1 条 → 继续空车确认） =====\n"
            "  C1) 两/三个车轮：有圆形/辐条/轮毂/侧撑/车架三角架 1 个可见。\n"
            "  C2) 车把抬高于车座，车把/车座附近确实没有头/手/人体轮廓（不是「看不见就没有」，而是真的有车座但空着）。\n"
            "  空车确认（至少满足 1 条，缺一条都不能标！）：\n"
            "  C3) 车座上空：车座区域确实没有衣物/头盔/头部任何痕迹覆盖。\n"
            "  C4) 车的 1 倍车宽附近确实没有直立人形靠在车上/手扶车把。\n"
            "  C5) 停在人行道/小区门口/停车区的静止姿态（侧撑着地/锁停/整齐停放）。\n"
            "\n"
            "❌ **绝对跳过清单（这些绝对不能标 non_motor_vehicle，也不能标其他类！）**：手拉购物小车/拖车/拉杆箱/婴儿车/购物篮/自行车配件/单独头盔/**花坛/花盆/木花坛/石墩/垃圾桶/建筑脚手架** → 直接跳过！\n"
            "❌ 车上叠了人形/头盔/手臂任意1个 → 改判 cyclist！\n"
            "拿不准两轮车有人 vs 空车 vs 跳过：空车确认 C3~C5 至少 1 条真的满足 + 把握 ≥ 45% → 才标 non_motor；但凡有一丝丝「车上好像坐了人」的感觉 → cyclist。"
        ),
    },
    {
        "name": "traffic_cone",
        "description": (
            "交通锥/锥桶/雪糕筒。\n"
            "\n"
            "判定规则：**存在级至少命中 1 条 + 分类级至少命中 1 条**才标；把握不足 45% → 直接跳过。\n"
            "\n"
            "===== 存在级 cue（至少命中 1 条 → 进入分类级判断；把握 < 45% 仍跳过） =====\n"
            "  E1) 路面/车道上单独或成排放置的上窄下宽锥形/梯形物体：底座+锥身+顶部尖 ≥ 2 段结构明确 → 进入分类。\n"
            "  E2) 路肩/边缘有鲜艳色（橙/红/黄）锥状物：底座宽上身窄锥形可见 → 进入分类。\n"
            "\n"
            "===== 分类级 cue（存在级命中 1 条 + 这里至少命中 1 条 → 可以标 traffic_cone） =====\n"
            "  C1) 上窄下宽三角形/梯形侧面轮廓（不需要尖顶完整，只要明显收窄）。\n"
            "  C2) 橙/红/黄色鲜艳主体 + 白/黑水平条纹 ≥ 1 条。\n"
            "  C3) 底部有宽底座（比锥身宽），落地在路面。\n"
            "  C4) 放置位置在路面/车道/路肩（不是人行道花坛里/大门边）。\n"
            "\n"
            "❌ 绝对跳过：路边花坛造型/地砖锥形图案/锥形灯罩/消防栓/消火栓/石墩/木花坛/水泥块 → 直接跳过！\n"
            "拿不准锥 vs 柱：高宽比 < 2.5 判锥；> 3.5 判柱。中间 2.5~3.5 看顶部：顶部有细柱/反光条穹顶 = column；顶部尖 = cone；把握不足 45% → 直接跳过。"
        ),
    },
    {
        "name": "traffic_bucket",
        "description": (
            "交通桶/防撞桶/水马：圆柱形/方形塑料/玻璃钢防撞桶/塑料注水围挡鼓。\n"
            "⚠️ 归属说明：「黄色方形电子倒计时立柱/带数字屏的路口信号桩/黄色行人倒计时器」虽然外形是柱，但归到 traffic_bucket 类（9 类中最接近）——但前提是**所有硬约束全部满足**，否则跳过。\n"
            "\n"
            "判定规则：**存在级至少命中 1 条 + 分类级至少命中 1 条 + 全部硬约束满足**才标；把握不足 45% → 直接跳过，不要误标路灯杆/路牌柱/大门柱。\n"
            "\n"
            "===== 存在级 cue（至少命中 1 条 → 进入分类级 + 硬约束检查；把握 < 45% 仍跳过） =====\n"
            "  E1) 斑马线/路口/路缘地面上（画面中下部及以下）：黄色方形立柱/电子倒计时桩/带数字显示屏（9/8/倒计时数字/小人图形）的信号桩 → 进入检查。\n"
            "  E2) 路面/路肩/路口（画面中下部）：粗壮圆柱/方柱（高宽比 0.6~3.0，矮胖或中等粗壮）→ 进入检查。\n"
            "  E3) 路面/路肩：水平红白/黄黑反光条绕身的塑料/玻璃钢立柱/桶状物 → 进入检查。\n"
            "  E4) 地面笨重底座着地：顶部有注水孔/提手/盖子/电子屏，常并排连放（连续 3 根及以上等间距 → 改判 plastic_barrier，不要逐根标！）→ 进入检查。\n"
            "\n"
            "===== 分类级 cue（存在级命中 1 条 + 这里至少命中 1 条 → 继续检查硬约束） =====\n"
            "  C1) 粗壮圆柱/方柱：高宽比 0.6~3.0，矮胖粗壮或中等粗壮（不是细高杆，细高杆走 traffic_column）。\n"
            "  C2) 水平红白/黄黑反光条绕身；或黄色方形带数字倒计时屏/小人灯图形明确可见。\n"
            "  C3) 传统桶顶部注水孔/提手/盖子；或电子桩顶部电子屏/数字/图形显示（哪怕屏在柱顶也算，不要误杀！）。\n"
            "  C4) 笨重底座着地，位置在路口/斑马线/路肩/车道地面（确实着地）。\n"
            "\n"
            "===== 硬约束（**全部必须满足，不满足直接跳过，哪怕存在级+分类级都命中**） =====\n"
            "  H1) 物体顶部 y_min（框的上沿）≥ 350/1000 规范空间坐标：必须在画面中下部（约画面中线 500 及以下都 OK，高到 350 也行的真实防撞桶/电子倒计时桩）；顶部在 350 以上（画面上半部分空中）= 路灯杆/路牌→跳过！\n"
            "  H2) 框的垂直跨度（y_max - y_min）≤ 220/1000 规范空间：高度 ≤ 画面高 22%；超过 22% 的是路灯杆/大门柱→跳过！\n"
            "  H3) 上方绝对没有**灯具/路牌/监控摄像头** 3 种明确附着物（电子倒计时桩自己的显示屏/数字屏/灯图形屏 不算附着物，允许！）；有上述 3 种明确附着物 = 路灯杆/路牌杆→跳过！\n"
            "  H4) **连续放置规则**：连续 3 根及以上等间距（相邻间距 ≤ 平均宽度 3 倍）排列的柱/桶列 = 整体判 plastic_barrier（横向包一个大框），绝对不要逐根单独标 traffic_bucket！逐根标 = 严重误标！\n"
            "\n"
            "❌ 绝对跳过清单：路灯杆（上方有灯头）/路牌杆（上方有路牌）/监控杆（上方有摄像头）/大门柱/围墙柱头/花坛石墩/旗杆/消防栓 → 直接跳过！\n"
            "拿不准桶/柱/锥/跳过：硬约束 H1~H4 全部满足 + 把握 ≥ 45% → 才标 traffic_bucket；否则 → plastic_barrier（连续 3 根时）或 直接跳过。**绝对禁止把电子倒计时桩顶的显示屏误判为「灯头/路牌/附着物」而砍了黄电子桩！**"
        ),
    },
    {
        "name": "traffic_column",
        "description": (
            "交通柱/弹立柱/分道柱：柔性弹力柱/分道标/升降柱。\n"
            "\n"
            "判定规则：**存在级至少命中 1 条 + 分类级至少命中 1 条 + 全部硬约束满足**才标；把握不足 45% → 直接跳过，绝对禁止把路灯杆/路牌杆标成 traffic_column！\n"
            "\n"
            "===== 存在级 cue（至少命中 1 条 → 进入分类级 + 硬约束检查；把握 < 45% 仍跳过） =====\n"
            "  E1) 路面/车道分隔线地面上（画面中下部）：细高竖立柱状物 → 进入检查（画面上半部空中的不算！）。\n"
            "  E2) 地面上细高柱：顶部圆形穹顶/反光顶盖、柱身有红白/黄白环 → 进入检查。\n"
            "\n"
            "===== 分类级 cue（存在级命中 1 条 + 这里至少命中 1 条 → 继续检查硬约束） =====\n"
            "  C1) 细高竖柱/方柱：高/底宽 ≥ 4，整体高细窄。\n"
            "  C2) 顶部圆形穹顶/反光顶盖（白/银/红白环/黄白环）明确可见。\n"
            "  C3) 柱身水平红白/黄白环/反光片环绕有 ≥ 1 条可见。\n"
            "  C4) 底部法兰盘/黑色底盘贴地固定明确。\n"
            "\n"
            "===== 硬约束（**全部必须满足，不满足直接跳过！**） =====\n"
            "  H1) 柱顶 y_min ≥ 350/1000 规范空间：必须在画面中下部（中线 500 上下 ± 150 都 OK）；顶部在 350 以上（画面上半部空中）= 路灯杆/路牌→跳过！\n"
            "  H2) 垂直跨度 ≤ 220/1000 规范空间：高度 ≤ 画面高 22%，超过=路灯杆/电线杆→跳过！\n"
            "  H3) 上方绝对没有**灯具/路牌/监控摄像头** 3 种明确附着物（柱本身的反光顶盖不算附着物）；有上述 3 种明确附着物 = 路灯杆/路牌杆→跳过！\n"
            "  H4) **连续放置规则**：连续 3 根及以上等间距（相邻间距 ≤ 平均宽度 3 倍）排列的柱列 = 整体判 plastic_barrier（横向包一个大框），**绝对不要逐根单独标 traffic_column！** 逐根标 = 张 5 Items 爆炸级严重误标！\n"
            "\n"
            "❌ 绝对跳过清单：路灯杆/电线杆/路牌杆/监控杆/旗杆/大门柱/建筑立柱/阳台栏杆立柱/消防栓 → 直接跳过！绝对禁止标这些！\n"
            "拿不准锥/柱/跳过：硬约束 H1~H4 全部满足 + 把握 ≥ 45% → 才标 column；否则 → plastic_barrier（连续3根时）或 直接跳过。**张 5 Items 爆炸的根因就是逐根标连续柱列，绝对禁止逐根！**"
        ),
    },
    {
        "name": "plastic_barrier",
        "description": (
            "塑料隔离栏/注水围挡：可拼接塑料临时路障/临时围挡/人群控制栏。\n"
            "⚠️ **连续交通柱/桶列的合并规则**：当画面中有 3 根及以上等间距排列的 traffic_column / traffic_bucket 时，不要逐根单标！必须把这一整段连续列整体合并为 1 个大框，判 plastic_barrier。（张 5 Items 爆炸的根因就是逐根标连续柱列，必须遵守此规则！）\n"
            "\n"
            "判定规则：**存在级至少命中 1 条 + 分类级至少命中 1 条**才标；把握不足 45% → 直接跳过，不要把小区大门/绿化围栏误判 plastic_barrier。\n"
            "\n"
            "===== 存在级 cue（至少命中 1 条 → 进入分类级判断；把握 < 45% 仍跳过） =====\n"
            "  E1) 路面上横向连续长条状鲜艳色拼接物：长度 ≥ 画面 10% 宽度 + 有拼接缝/竖缝可见 → 进入分类。\n"
            "  E2) 长条临时围挡：有多段拼接单元、顶/底加强梁、中间空格/注水孔 ≥ 1 个可见 → 进入分类。\n"
            "  E3) 交通柱/桶连续列：3 根及以上等间距（相邻间距 ≤ 均宽 3 倍）排列的柱/桶列整体 = 进入分类（按 plastic_barrier 合并判，不逐根）。\n"
            "\n"
            "===== 分类级 cue（存在级命中 1 条 + 这里至少命中 1 条 → 可以标 plastic_barrier） =====\n"
            "  C1) 长条矩形面板并排：竖缝/拼接头/卡扣 ≥ 1 个可见。\n"
            "  C2) 顶/底横向加强梁 + 中间空格/注水孔/网格 ≥ 1 个可见。\n"
            "  C3) 鲜艳色：红白/黄白/蓝白/纯黄/橙白拼接（钢质感的灰/绿/蓝喷塑/黑色金属 = guard_rail，不是这个）。\n"
            "  C4) 放置在路面/人行道临时隔离，不是永久钢制护栏。\n"
            "  C5) 连续 3 根及以上柱/桶列合并为整体大框。\n"
            "\n"
            "❌ **绝对跳过清单（这些绝对不能标 plastic_barrier，也不能标其他类！）**：小区入口铁栅大门/绿化带围栏（带门锁/门铰）/广场装饰围栏/校园围墙栅栏/工地临时铁丝网/桥边玻璃栏杆/阳台栏杆 → 直接跳过，不属于任何 9 类！\n"
            "拿不准塑料栏 vs 钢护栏 vs 跳过：鲜艳色+拼接缝 = plastic_barrier；灰/绿/蓝/黑金属+立柱 = guard_rail；NOT 命中 = 跳过。把握 < 45% → 跳过。"
        ),
    },
    {
        "name": "guard_rail",
        "description": (
            "波形护栏/钢制道路护栏/金属栏杆：马路/公路/高速/城市道路上，用于**道路防撞/车道分隔**的横向长条金属护栏（波形钢板/横梁+立柱结构，或金属栅栏杆）。\n"
            "⚠️ 非典型形态（只要位于道路防撞/分隔位置且 NOT 清单不命中，这些也算）：白色油漆弧形金属栏杆（人行道旁）、黑色金属连续栅栏、绿色喷塑、蓝色喷塑钢制护栏、人行道旁金属弧形栏杆。\n"
            "\n"
            "判定规则：**NOT 清单先排除 → 存在级至少命中 1 条 → 分类级 B 组至少命中 1 条** 才标；把握不足 45% → 直接跳过，不要误判小区大门/绿化围栏。\n"
            "\n"
            "===== NOT 清单（**先看这个，命中任意 1 条直接跳过，绝对不能判 guard_rail，也绝对不要改判其他 9 类！**） =====\n"
            "  ❌ 小区入口铁栅大门/带门锁的栅栏门/人行道绿化带围栏（围栏内有绿化植物）/广场装饰围栏/校园围墙栅栏/工地临时铁丝网/桥边玻璃+不锈钢立柱扶手/阳台栏杆/庭院铸铁栅栏 → 这些属于「景观/围合功能」，不是道路防撞/分隔 → 直接跳过，不属于任何 9 类！\n"
            "  ❌ 大面积主色为**全白塑料色**（不是白油漆金属+立柱）、或鲜艳黄/红纯塑料色、或木质色。\n"
            "  ❌ 竖向杆件密集：每米 ≥ 5 根竖杆（人行横道白色塑料密集竖杆隔离栏 = 功能是人群分隔，跳过）。\n"
            "  ❌ 位置：人行道步行区正内部/斑马线正上方/广场/绿化带内部（不在路缘石/车道防撞分隔位置）。\n"
            "  ❌ 只有单根立柱/路灯杆/电线杆/路牌杆/监控杆。\n"
            "\n"
            "===== 存在级 cue（NOT 清单没命中 + 这里至少命中 1 条 → 进入分类级 B 组检查） =====\n"
            "  E1) 画面左右两侧靠近路缘石/路肩的位置：有连续栅栏+立柱结构（横向长条 + 竖立柱/竖栅杆支撑 + 下沿紧邻路缘石）→ 进入 B 组。\n"
            "  E2) 路肩/人行道交接长条带内沿路面横向延伸的长条金属物体：连续跨越画面 ≥ 15% 宽度 + 下沿靠路缘石 → 进入 B 组。\n"
            "  E3) 路肩/车道分隔位置的白弧形栏杆/黑铁栅/绿/蓝喷塑/灰镀锌钢：横向长条 + 立柱支撑 + 非 NOT 清单 → 进入 B 组。\n"
            "\n"
            "===== 分类级 B 组（NOT 清单不命中 + E 命中 1 条 + B 至少命中 1 条 → 可以判 guard_rail） =====\n"
            "  B1) 横梁板有波形/W 型断面/连续波纹钢板轮廓。\n"
            "  B2) 有等间距稀疏竖向立柱（金属圆柱/方柱）从地面支撑横梁/栅栏杆（每米 ≤ 2 根）。\n"
            "  B3) 整体长高比 ≥ 5（连续长横条，不是短段）。\n"
            "  B4) 颜色：深灰/银灰镀锌、绿色喷塑、蓝色喷塑、黑色、局部白油漆金属（带金属立柱/底座，不是全白塑料）。\n"
            "  B5) 位置紧邻路缘石/路肩/中央分隔带车道线，功能明显是防撞或车道分隔。\n"
            "\n"
            "【框紧贴要求（垂直方向必须严格遵守）】：\n"
            "  y_min = 横梁/栏杆上沿（不要多包天空/路牌/树冠）；\n"
            "  y_max = 横梁/栏杆下沿 或 钢立柱与路肩/地面接触最底部（只留 0.6% 余量），严禁多包下方混凝土路肩/土坡/地面大块背景超过横梁高度 1/3。\n"
            "  x_min/x_max = 护栏两端或画面截断处左右端点，不要太宽。\n"
            "\n"
            "拿不准时：NOT 清单不命中 + 位于路肩/车道分隔位置 + B 组至少 1 条命中 + 把握 ≥ 45% → 才标 guard_rail；否则 → 直接跳过（但真的靠边的白色弧形栏杆/黑色金属护栏一定要标，不要漏掉边缘段护栏）。"
        ),
    },
]

_GLOBAL_RATIO_MIN = 0.02
_GLOBAL_RATIO_MAX = 50.0
_GLOBAL_AREA_MIN_PX = 100
_CANONICAL_BOX_MIN_SPAN = 6

_PER_LABEL_MIN_AREA_PX_SOFT = {
    "pedestrian": 280,
    "cyclist": 560,
    "motor_vehicle": 1050,
    "non_motor_vehicle": 560,
    "traffic_cone": 140,
    "traffic_bucket": 210,
    "traffic_column": 154,
    "plastic_barrier": 840,
    "guard_rail": 1400,
}


def _normalize_label(label: str) -> str:
    label = str(label).strip().lower()
    label = label.replace("-", "_").replace(" ", "_")
    label = re.sub(r"_+", "_", label)
    return label


def init_context(context):
    with open("/opt/nuclio/function.yaml", "rb") as function_file:
        functionconfig = yaml.safe_load(function_file)

    labels_spec = functionconfig["metadata"]["annotations"]["spec"]
    labels = json.loads(labels_spec)
    canonical_labels = [item["name"] for item in labels]

    norm_to_canon = {}
    for name in canonical_labels:
        norm_to_canon[_normalize_label(name)] = name

    context.user_data.norm_to_canon = norm_to_canon
    context.user_data.allowed_labels = sorted(set(canonical_labels))

    try:
        context.logger.info(
            "[CVAT-LAMBDA-SANITIZED] init_context OK. "
            "allowed_labels=%s",
            context.user_data.allowed_labels,
        )
    except Exception:
        pass


def _strip_markdown(text: str) -> str:
    if not text:
        return ""
    text = str(text).strip()
    text = re.sub(r"^\s*```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```\s*$", "", text)
    return text.strip()


def _repair_json_grammar(text: str) -> str:
    """
    Repair ONLY bracket errors at the array-literal level (tuple-style coordinate arrays).
    We deliberately avoid touching parentheses that might appear inside JSON string values
    (e.g. label descriptions like "truck (heavy)") by anchoring substitutions with
    adjacent structural tokens (digits, [ ], { }, commas, or line/string boundaries).
    """
    text = str(text)

    text = re.sub(r"(?<=[\d\[\],])\)\s*,\s*\((?=[\d\[\{])", "],[", text)
    text = re.sub(r"(?<=[\d\[\],])\)\s*,\s*\[(?=[\d\[\{])", "],[", text)
    text = re.sub(r"(?<=[\d\[\],])\]\s*,\s*\((?=[\d\[\{])", "],[", text)

    text = re.sub(r"(?<=\d)\s*\(\s*(?=[\d-])", "[ ", text)
    text = re.sub(r"(?<=[\d-])\s*\)\s*(?=\s*[,\]\}]|$)", " ]", text)

    text = re.sub(r"(?<=\d)\s*,\s*\((?=[\d-])", ", [", text)
    text = re.sub(r"(?<=[\[\{,])\(\s*(?=[\d-])", "[", text)
    text = re.sub(r"(?<=[\d-])\)\s*,\s*(?=[\d\[\{])", "],", text)
    text = re.sub(r"(?<=[\d-])\)\s*(?=\s*[\[\{])", "]", text)

    text = re.sub(r"(\]|\})\s+(\[|\{)", r"\1,\2", text)
    return text


def _extract_json(text: str):
    """
    Best-effort JSON extraction aligned with vision-label-skill extract_json_array:
    1) strip markdown fences
    2) direct parse if starts with [ or {
    3) fallback: find outer [..]
    4) fallback: find {..} with list-valued keys: objects/annotations/labels/shapes/instances/results/detections
    5) fallback: same pipeline on _repair_json_grammar(text)  (only if previous all failed)
    """
    if not text:
        raise ValueError("Empty model output")
    text_clean = _strip_markdown(text)

    list_keys = (
        "objects", "annotations", "labels", "shapes", "instances",
        "results", "detections", "items", "detections_", "boxes",
    )

    def _attempt(candidate: str):
        if not candidate:
            return None, False
        if candidate.startswith("["):
            arr = json.loads(candidate)
            if isinstance(arr, list):
                return arr, True
        if candidate.startswith("{"):
            obj = json.loads(candidate)
            if isinstance(obj, dict):
                for k in list_keys:
                    v = obj.get(k)
                    if isinstance(v, list):
                        return v, True
                return [obj], True
        start = candidate.find("[")
        end = candidate.rfind("]")
        if start != -1 and end != -1 and end > start:
            arr = json.loads(candidate[start : end + 1])
            if isinstance(arr, list):
                return arr, True
        m = re.search(r"(\{.*\})", candidate, flags=re.S)
        if m:
            obj = json.loads(m.group(1))
            if isinstance(obj, dict):
                for k in list_keys:
                    v = obj.get(k)
                    if isinstance(v, list):
                        return v, True
                return [obj], True
        return None, False

    last_err = None
    for candidate in (text_clean, _repair_json_grammar(text_clean)):
        try:
            result, ok = _attempt(candidate)
            if ok:
                return result
        except (json.JSONDecodeError, ValueError) as e:
            last_err = e
            continue
    raise ValueError(f"No JSON found in model output even after repair: {last_err}")


def _content_to_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        return "".join(parts).strip()
    return str(content)


def _iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    x1 = max(ax1, bx1)
    y1 = max(ay1, by1)
    x2 = min(ax2, bx2)
    y2 = min(ay2, by2)
    w = max(0.0, x2 - x1)
    h = max(0.0, y2 - y1)
    inter = w * h
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    if union <= 0:
        return 0.0
    return inter / union


def _nms(boxes, iou_threshold=0.5):
    if not boxes:
        return []
    sorted_boxes = sorted(boxes, key=lambda b: float(b["confidence"]), reverse=True)
    keep = []
    while sorted_boxes:
        current = sorted_boxes.pop(0)
        keep.append(current)
        c_box = current["_box"]
        c_label = current["label"]
        filtered = []
        for b in sorted_boxes:
            if b["label"] == c_label and _iou(c_box, b["_box"]) >= iou_threshold:
                continue
            filtered.append(b)
        sorted_boxes = filtered
    return keep


def _box_center(b):
    x1, y1, x2, y2 = b
    return ((x1 + x2) * 0.5, (y1 + y2) * 0.5)


def _box_area(b):
    x1, y1, x2, y2 = b
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def _box_union(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    return (min(ax1, bx1), min(ay1, by1), max(ax2, bx2), max(ay2, by2))


def _merge_ped_cycle_to_cyclist(boxes, logger=None):
    """
    模型层固有行为：远处/模糊骑行者经常被拆成 pedestrian + non_motor_vehicle 两个相邻框。
    此函数把满足空间关系的 (ped, non_motor) 对合并成一个 cyclist 并集框。
    空间判定：
      - ped 中心点 <= non_motor 垂直方向 65% 线上（人叠在车的上半部分）
      - ped 底边 <= non_motor 垂直方向 90% 线上（人没有完全落于车下方/车后面地面上独立行走）
      - 水平投影有交集 >= 20% min(ped_w, nm_w)，或中心距 <= 0.5·max(ped_w, nm_w)
      - 匹配评分 = 0.6·IoU + 0.4·(min_area/union_area)，取每个 ped 的最高匹配
    """
    if not boxes:
        return boxes
    peds = [b for b in boxes if b["label"] == "pedestrian"]
    non_motors = [b for b in boxes if b["label"] == "non_motor_vehicle"]
    if not peds or not non_motors:
        return boxes

    merged_ids = set()
    new_cyclists = []

    for ped in peds:
        pb = ped["_box"]
        p_cx, p_cy = _box_center(pb)
        pw = pb[2] - pb[0]
        ph = pb[3] - pb[1]
        best_match = None
        best_score = -1.0
        for nm in non_motors:
            if id(nm) in merged_ids or id(ped) in merged_ids:
                continue
            nb = nm["_box"]
            nw = nb[2] - nb[0]
            nh = nb[3] - nb[1]
            n_cx, _ = _box_center(nb)
            if not (p_cy <= nb[1] + 0.65 * nh):
                continue
            if not (pb[3] <= nb[1] + 0.9 * nh):
                continue
            horiz_overlap = max(0.0, min(pb[2], nb[2]) - max(pb[0], nb[0]))
            horiz_min_span = min(pw, nw) if min(pw, nw) > 0 else 1.0
            horiz_ok = (horiz_overlap >= 0.2 * horiz_min_span) or (abs(p_cx - n_cx) <= max(pw, nw) * 0.5)
            if not horiz_ok:
                continue
            iou_score = _iou(pb, nb)
            union_box = _box_union(pb, nb)
            union_a = _box_area(union_box)
            smaller_a = min(_box_area(pb), _box_area(nb))
            containment = smaller_a / union_a if union_a > 0 else 0.0
            score = iou_score * 0.6 + containment * 0.4
            if score > best_score:
                best_score = score
                best_match = (ped, nm, union_box)
        if best_match is not None and best_score > 0.015:
            ped_, nm_, ubox = best_match
            conf = max(ped_["confidence"], nm_["confidence"])
            x1u, y1u, x2u, y2u = ubox
            merged_cyclist = {
                "confidence": float(conf),
                "label": "cyclist",
                "_box": [float(x1u), float(y1u), float(x2u), float(y2u)],
                "_points": [int(round(x1u)), int(round(y1u)), int(round(x2u)), int(round(y2u))],
                "_merged": True,
            }
            new_cyclists.append(merged_cyclist)
            merged_ids.add(id(ped_))
            merged_ids.add(id(nm_))

    if not new_cyclists:
        return boxes
    survivors = [b for b in boxes if id(b) not in merged_ids]
    out = survivors + new_cyclists
    try:
        if logger is not None:
            logger.info(
                "[CVAT-LAMBDA-SANITIZED] merge_ped_nm_to_cyclist produced=%d "
                "before=%d after=%d",
                len(new_cyclists), len(boxes), len(out),
            )
    except Exception:
        pass
    return out


def handler(context, event):
    try:
        data = event.body
        threshold = float(data.get("threshold", 0.50))
        image_b64 = data["image"]

        buf = io.BytesIO(base64.b64decode(image_b64))
        image = Image.open(buf).convert("RGB")
        w, h = image.size
        total_pixels = float(w * h)

        bailian = data.get("bailian") or {}
        if not isinstance(bailian, dict):
            bailian = {}

        api_key = bailian.get("api_key") or os.environ.get("BAILIAN_API_KEY", "")
        api_url = bailian.get("api_url") or os.environ.get("BAILIAN_API_URL", "")
        model = bailian.get("model") or os.environ.get("BAILIAN_MODEL", "qwen3-vl-plus")

        if not api_key or not api_url:
            try:
                context.logger.warning(
                    "[CVAT-LAMBDA-SANITIZED] bailian config missing, returning []"
                )
            except Exception:
                pass
            return context.Response(
                body=json.dumps([]),
                headers={},
                content_type="application/json",
                status_code=200,
            )

        allowed_list = "\n".join(f"- {s['name']}" for s in _CLASS_SPEC)
        allowed_block = "Allowed labels (use EXACTLY these strings):\n" + allowed_list

        class_def_lines = ["CLASS DEFINITIONS (use EXACT name strings as labels):"]
        for i, spec in enumerate(_CLASS_SPEC):
            class_def_lines.append(f"\n[{i}] name: {spec['name']}")
            class_def_lines.append(f"    meaning: {spec['description']}")
        class_def_lines.append(
            "\nMatch targets to these definitions. Prefer the listed names only. "
            "If uncertain between two classes, pick the closer definition by spatial/structural match."
        )
        class_def_block = "\n".join(class_def_lines)

        shared_block = (
            "【只返回 JSON 数组，禁止任何 Markdown/文字解释/代码围栏】\n"
            "坐标系统 / 格式要求：\n"
            "- 所有坐标必须是整数，范围 0–1000（对应图像宽高归一化后的整数，和原图像素尺寸无关）。\n"
            "- 坐标顺序：先写 X（水平方向），再写 Y（垂直方向），绝对不能先写 Y 再写 X。\n"
            "- 一个物体实例一个条目：框必须紧贴物体的真实轮廓，不要留多余的空白背景。\n"
            "  - 特别强调：对于横向长条类物体（护栏、隔离栏、路肩横梁等），垂直方向只包物体本身，"
            "不要多包下方的路肩、土坡、地面大块背景，y_max 只比物体下沿多留 0.6% 左右的余量即可。\n"
            "- 同一个物体只写一条，不要对同一东西写重复/嵌套/高度重叠的多个框。\n"
            "- 跳过的情况：只有以下这些才跳过——水印、纯阴影、纯背景纹理、两边任意一边小于约 " + str(_CANONICAL_BOX_MIN_SPAN) + "/1000（图像单边 0.6% 以下）的极小无法辨认的像素块。"
        )

        schema_block = (
            "【必须遵守的 JSON 输出 Schema（严格按这个格式写）】\n"
            "每条元素的 Schema：\n"
            "{\"label\":\"<从允许类别列表中选一个精确字符串>\",\"box\":[x_min,y_min,x_max,y_max]}\n"
            "- x_min<x_max, y_min<y_max。\n"
            "- 数组全部使用方括号 []，坐标数组内绝对不能出现圆括号 ()。\n"
            "- 每条只能有 label 和 box 这 2 个字段，不要写 score/confidence/description 等任何额外字段。"
        )

        attention_block = (
            "【检测注意事项（单阶段直接出结果，不要分候选/分类两阶段）】\n"
            "⚠️ 核心原则：**宁缺毋滥**。只标你确信属于 9 类之一、特征足够清晰的物体；拿不准、只有模糊印象、看起来像但又不像的物体——**直接跳过不标**，不要为了凑数勉强标。\n"
            "\n"
            "注意力分配建议（顺带检查，不要为了通过自检硬凑框）：\n"
            "1) 先扫画面中心 60% 区域的大/中目标（近处汽车、卡车、骑行大队、行人队），把确信的先标出来；\n"
            "2) 顺带扫一下四边 15% 边缘带和路肩/人行道长条带：如果边缘/路肩位置确实有清晰的交通柱/护栏/只露一部分的车辆行人，就补上；**如果边缘/路肩只有路灯杆、围墙、大门、绿化带围栏、地砖纹理等，绝对不要硬标成 9 类**；\n"
            "3) 顺带扫遮挡重叠区：大车/大树/罩布边缘确实露出了车轮/车头/人形隆起等明确线索的才标；**没有明确线索的不要臆测里面藏了物体**；\n"
            "4) 远处目标：只有你确信结构特征（直立人形、两轮+人叠、汽车轮廓+车轮阴影）清晰可辨才标；**只剩几个像素、无法确认是什么的小点——跳过不标，不要勉强**。"
        )

        density_block = (
            "密度/范围要求：\n"
            "- 把每一个「确信属于 9 类、特征清晰可辨」的实例全部标出来——包括远处但特征仍然清晰的小型物体。\n"
            "- 不要仅仅因为像素小就跳过——但前提是「你能确认它属于 9 类中的哪一类」，如果只剩几个像素无法辨认 → 直接跳过。\n"
            "- 不能编造任何不在允许类别列表里的类别。\n"
            "- 整张图确实没有任何符合条件的物体时才返回空数组 []。\n"
            "- ⚠️ **绝对禁止凑数**：不要为了让结果看起来多就把背景物体（路灯杆、大门、围墙、地砖、手拉车、路牌头等）硬判成 9 类。结果数少（甚至 0）是正常的，只要确信没漏就行。"
        )

        self_check_block = (
            "【输出前必须逐条自检（确认全 Yes 后再输出）】\n"
            "1) 先过「绝对跳过清单」：你标的每一条都不在下面绝对跳过列表里吗？（路灯杆/电线杆/路牌杆/监控杆/小区绿化围栏/带门锁的栅栏门/手拉购物车/拖车/拉杆箱/婴儿车/公交站亭/建筑脚手架/广告牌支架 → 这些绝对不能标）\n"
            "2) 每一条的 label 精确等于以下 9 个类名之一（字符串必须完全匹配、不能改字）：\n"
            "   " + ", ".join(_ALLOWED_LABELS) + "\n"
            "3) 每一条的 box 是 [x_min,y_min,x_max,y_max] 格式，4 个坐标全是 0–1000 的整数，全部用方括号 []。\n"
            "4) 坐标顺序必须 X 先 Y 后；且 x_min<x_max, y_min<y_max。\n"
            "5) 除非图像真的一个允许类别的物体都没有，否则不能返回空数组。\n"
            "6) 每条只含 label 和 box 字段，没有 score/confidence/description 等其他字段。\n"
            "7) ⚠️ 最后一问：你标的每一条，自己对分类结果有 45% 以上把握吗？**如果某条把握 < 45%（完全不像，纯瞎猜）→ 删除这条不要标**；把握 ≥ 45% 且符合规则的就留，不要真目标也砍掉（比如被挡大巴/缝隙骑手/远处真车/黄电子桩）。"
        )

        prompt = "\n\n".join([
            "任务：在图中做目标检测并打标签，用于计算机视觉数据集标注。\n"
            "⚠️ ⚠️ ⚠️ 【**全局绝对跳过清单（先读这个！读到的东西绝对不能标任何9类！直接跳过！）**】：\n"
            "以下物体 100% 不属于 9 类，直接跳过，绝对不要标（包括不能改判其他 9 类！）：\n"
            "  ・路灯杆（上方有灯头的杆）/电线杆/路牌杆（上方有路牌的杆）/监控杆（上方有摄像头）/旗杆\n"
            "  ・小区入口黑色/银色铁栅大门 / 绿化带围栏（带门锁/门铰）/ 广场装饰围栏 / 校园围墙 / 工地临时铁丝网\n"
            "  ・手拉购物小车 / 拖车 / 拉杆箱 / 婴儿车 / 购物篮（这些不是车！）\n"
            "  ・消防栓 / 消火栓 / 花坛 / 花盆 / 木花坛 / 石墩 / 垃圾桶 / 水泥块\n"
            "  ・公交站亭 / 建筑脚手架 / 广告牌支架 / 围墙柱头 / 锥形灯罩 / 地砖图案\n"
            "  ・桥边玻璃栏杆 / 阳台栏杆 / 庭院铸铁栅栏（属于景观围合，不属于道路防撞护栏）\n"
            "**特别提醒：别把消防栓当 traffic_cone！别把花坛/花盆当 non_motor_vehicle！别把路灯杆当 traffic_column/bucket！别把小区大门当 guard_rail/plastic_barrier！**\n"
            "\n"
            "核心原则：宁缺毋滥，但真目标（被挡的大巴/骑行大队缝隙骑手/远处真车/黄电子桩）有 45% 把握就标，不要漏掉。\n"
            "⚠️ **召回补偿：张5 Items爆炸的根因是逐根标连续柱列——所以连续 3 根及以上 traffic_column/bucket，必须整体合并为 1 个 plastic_barrier 大框！绝对不能逐根！**",
            attention_block,
            schema_block,
            allowed_block,
            shared_block,
            class_def_block,
            density_block,
            self_check_block,
        ])

        try:
            context.logger.info(
                "[CVAT-LAMBDA-SANITIZED] handler start model=%s image(w=%s,h=%s) "
                "threshold=%.2f mode=0-1000_canonical",
                model, w, h, threshold,
            )
        except Exception:
            pass

        def _call_api(messages, timeout_s=55, max_retries=3):
            """
            Single-shot VLM request with 3 retries and capped exponential backoff.
            Retries are triggered ONLY by transient failures:
              - requests.exceptions (ConnectTimeout, ReadTimeout, ConnectionError, ChunkedEncodingError, etc.)
              - HTTP 5xx (server-side overloaded / temporarily unavailable)
              - HTTP 408 / 425 / 429 (timeout / too early / rate limited)
            Non-transient HTTP 4xx and any JSON/key access errors raise immediately (no retry).
            """
            payload = {"model": model, "messages": messages}
            last_exc = None
            for attempt in range(1, max_retries + 1):
                try:
                    r = requests.post(
                        api_url,
                        headers={
                            "Authorization": f"Bearer {api_key}",
                            "Content-Type": "application/json",
                        },
                        json=payload,
                        timeout=timeout_s,
                    )
                    if r.status_code >= 500 or r.status_code in (408, 425, 429):
                        r.raise_for_status()
                    r.raise_for_status()
                    resp_body = r.json()
                    c = resp_body["choices"][0]["message"]["content"]
                    if attempt >= 2:
                        try:
                            context.logger.info(
                                "[CVAT-LAMBDA-SANITIZED] api_call_succeeded_on_attempt=%d/%d",
                                attempt, max_retries,
                            )
                        except Exception:
                            pass
                    return _content_to_text(c)
                except (requests.exceptions.RequestException,) as e:
                    last_exc = e
                    status = None
                    try:
                        status = getattr(e, "response", None)
                        status = getattr(status, "status_code", None) if status is not None else None
                    except Exception:
                        status = None
                    if attempt >= max_retries:
                        break
                    backoff = min(1.0 * (2 ** (attempt - 1)), 5.0)
                    try:
                        context.logger.info(
                            "[CVAT-LAMBDA-SANITIZED] api_call_transient_failed attempt=%d/%d "
                            "status=%s err=%s retrying_in_%.1fs",
                            attempt, max_retries, status, str(e)[:120], backoff,
                        )
                    except Exception:
                        pass
                    time.sleep(backoff)
                    continue
            raise last_exc  # after all retries exhausted

        first_messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                    },
                ],
            }
        ]

        llm_output = _call_api(first_messages, timeout_s=55)
        try:
            context.logger.info(
                "[CVAT-LAMBDA-SANITIZED] llm_output_raw_len=%s snippet=%s",
                len(llm_output),
                llm_output[:200].replace("\n", " \\n "),
            )
        except Exception:
            pass

        try:
            parsed = _extract_json(llm_output)
        except Exception as first_err:
            try:
                context.logger.info(
                    "[CVAT-LAMBDA-SANITIZED] first_parse_failed=%s running_text_only_repair_prompt",
                    str(first_err)[:140],
                )
            except Exception:
                pass
            repair_msg = (
                "Your previous response failed strict JSON validation. "
                "Reply ONLY a valid JSON array (no prose, no code fences).\n"
                "Fix rules:\n"
                "- Every entry: {\"label\":\"<allowed_class_name>\",\"box\":[x_min,y_min,x_max,y_max]}\n"
                "- Use SQUARE brackets [] ONLY; never () for arrays.\n"
                "- All four box values are integers between 0 and 1000; x_min<x_max, y_min<y_max.\n"
                "- If nothing matches, reply exactly: []"
            )
            try:
                repair_messages = [
                    {"role": "user", "content": [{"type": "text", "text": prompt}]},
                    {"role": "assistant", "content": [{"type": "text", "text": llm_output}]},
                    {"role": "user", "content": [{"type": "text", "text": repair_msg}]},
                ]
                llm_output2 = _call_api(repair_messages, timeout_s=40)
                try:
                    context.logger.info(
                        "[CVAT-LAMBDA-SANITIZED] repair_output_len=%s snippet=%s",
                        len(llm_output2),
                        llm_output2[:200].replace("\n", " \\n "),
                    )
                except Exception:
                    pass
                parsed = _extract_json(llm_output2)
            except Exception as second_err:
                try:
                    context.logger.warning(
                        "[CVAT-LAMBDA-SANITIZED] repair_prompt_also_failed=%s returning_empty",
                        str(second_err)[:140],
                    )
                except Exception:
                    pass
                parsed = []

        if not isinstance(parsed, list):
            raise ValueError(f"Parsed result is not a list: {type(parsed).__name__}")

        try:
            context.logger.info(
                "[CVAT-LAMBDA-SANITIZED] parsed_boxes_before_filter=%d",
                len(parsed),
            )
        except Exception:
            pass

        candidates = []
        for idx, item in enumerate(parsed):
            if not isinstance(item, dict):
                continue

            raw_label = item.get("label", "")
            norm_label = _normalize_label(raw_label)
            if norm_label not in context.user_data.norm_to_canon:
                continue
            label = context.user_data.norm_to_canon[norm_label]
            if label not in _ALLOWED_SET:
                continue

            box = item.get("box")
            bbox = item.get("bbox")
            points = item.get("points")
            conf_raw = item.get("confidence")

            raw_4 = None
            raw_conf = None

            if isinstance(box, list) and len(box) == 4:
                raw_4 = [box[0], box[1], box[2], box[3]]
                raw_conf = conf_raw
            elif isinstance(bbox, list) and len(bbox) == 5:
                raw_4 = [bbox[0], bbox[1], bbox[2], bbox[3]]
                raw_conf = bbox[4]
            elif isinstance(bbox, list) and len(bbox) == 4:
                raw_4 = [bbox[0], bbox[1], bbox[2], bbox[3]]
                raw_conf = conf_raw
            elif isinstance(points, list) and len(points) == 4:
                raw_4 = [points[0], points[1], points[2], points[3]]
                raw_conf = conf_raw
            else:
                continue

            try:
                cx1 = float(raw_4[0])
                cy1 = float(raw_4[1])
                cx2 = float(raw_4[2])
                cy2 = float(raw_4[3])
            except (TypeError, ValueError):
                continue

            if not (0.0 <= cx1 <= 1000.0 and 0.0 <= cy1 <= 1000.0
                    and 0.0 <= cx2 <= 1000.0 and 0.0 <= cy2 <= 1000.0):
                continue

            cspan_x = abs(cx2 - cx1)
            cspan_y = abs(cy2 - cy1)
            if cspan_x < _CANONICAL_BOX_MIN_SPAN or cspan_y < _CANONICAL_BOX_MIN_SPAN:
                try:
                    context.logger.info(
                        "[CVAT-LAMBDA-SANITIZED] drop box idx=%d label=%s "
                        "canonical_span=[%.1f,%.1f] side_smaller_than_%d/1000",
                        idx, label, cspan_x, cspan_y, _CANONICAL_BOX_MIN_SPAN,
                    )
                except Exception:
                    pass
                continue

            px1 = int(round(cx1 / 1000.0 * float(w)))
            py1 = int(round(cy1 / 1000.0 * float(h)))
            px2 = int(round(cx2 / 1000.0 * float(w)))
            py2 = int(round(cy2 / 1000.0 * float(h)))

            xtl = max(0, min(px1, px2))
            ytl = max(0, min(py1, py2))
            xbr = min(w, max(px1, px2))
            ybr = min(h, max(py1, py2))
            if xbr <= xtl or ybr <= ytl:
                continue

            try:
                conf = float(raw_conf) if raw_conf is not None else 0.6
            except (TypeError, ValueError):
                conf = 0.6
            conf = max(0.0, min(1.0, conf))
            if conf < threshold:
                try:
                    context.logger.info(
                        "[CVAT-LAMBDA-SANITIZED] drop box idx=%d label=%s "
                        "conf=%.3f below_global_threshold=%.3f",
                        idx, label, conf, threshold,
                    )
                except Exception:
                    pass
                continue

            area_px = int((xbr - xtl) * (ybr - ytl))
            area_ratio = float(area_px) / total_pixels if total_pixels > 0 else 0.0
            if area_ratio > 0.95:
                try:
                    context.logger.info(
                        "[CVAT-LAMBDA-SANITIZED] drop box idx=%d label=%s "
                        "area_ratio=%.5f (too large, >95%% of image)",
                        idx, label, area_ratio,
                    )
                except Exception:
                    pass
                continue

            bw = float(xbr - xtl)
            bh = float(ybr - ytl)
            ratio = bw / bh if bh > 0 else float("inf")
            if area_px < _GLOBAL_AREA_MIN_PX or ratio < _GLOBAL_RATIO_MIN or ratio > _GLOBAL_RATIO_MAX:
                try:
                    context.logger.info(
                        "[CVAT-LAMBDA-SANITIZED] drop box idx=%d label=%s "
                        "area_px=%d ratio=%.3f (globally malformed shape, "
                        "area<=%d or ratio outside [%.3f, %.3f])",
                        idx, label, area_px, ratio,
                        _GLOBAL_AREA_MIN_PX, _GLOBAL_RATIO_MIN, _GLOBAL_RATIO_MAX,
                    )
                except Exception:
                    pass
                continue

            per_label_min = _PER_LABEL_MIN_AREA_PX_SOFT.get(label)
            if per_label_min is not None and area_px < per_label_min:
                try:
                    context.logger.info(
                        "[CVAT-LAMBDA-SANITIZED] drop box idx=%d label=%s "
                        "area_px=%d below_per_label_soft_min=%d",
                        idx, label, area_px, per_label_min,
                    )
                except Exception:
                    pass
                continue

            candidates.append(
                {
                    "confidence": conf,
                    "label": label,
                    "_box": [float(xtl), float(ytl), float(xbr), float(ybr)],
                    "_points": [xtl, ytl, xbr, ybr],
                }
            )

        try:
            context.logger.info(
                "[CVAT-LAMBDA-SANITIZED] after_coord_conf_filter=%d",
                len(candidates),
            )
        except Exception:
            pass

        kept = _nms(candidates, iou_threshold=0.5)

        try:
            context.logger.info(
                "[CVAT-LAMBDA-SANITIZED] after_nms=%d",
                len(kept),
            )
        except Exception:
            pass

        merged = _merge_ped_cycle_to_cyclist(kept, logger=context.logger)

        per_label_after_merge = {}
        for item in merged:
            per_label_after_merge[item["label"]] = per_label_after_merge.get(item["label"], 0) + 1

        # ====== 后处理召回补刀：minimal prompt 二次调用（仅对明显漏标的帧，正常帧无开销） ======
        def _parse_to_candidates(parsed_list, logger_ctx):
            cands = []
            for i_idx, item in enumerate(parsed_list):
                if not isinstance(item, dict):
                    continue
                rl = _normalize_label(item.get("label", ""))
                if rl not in context.user_data.norm_to_canon:
                    continue
                lab = context.user_data.norm_to_canon[rl]
                if lab not in _ALLOWED_SET:
                    continue
                b4 = None
                for key in ("box", "bbox", "points"):
                    v = item.get(key)
                    if isinstance(v, list) and len(v) >= 4:
                        b4 = [v[0], v[1], v[2], v[3]]
                        break
                if b4 is None:
                    continue
                try:
                    cx1, cy1, cx2, cy2 = float(b4[0]), float(b4[1]), float(b4[2]), float(b4[3])
                except (TypeError, ValueError):
                    continue
                if not (0 <= cx1 <= 1000 and 0 <= cy1 <= 1000 and 0 <= cx2 <= 1000 and 0 <= cy2 <= 1000):
                    continue
                if abs(cx2 - cx1) < _CANONICAL_BOX_MIN_SPAN or abs(cy2 - cy1) < _CANONICAL_BOX_MIN_SPAN:
                    continue
                _px1 = int(round(cx1 / 1000.0 * float(w)))
                _py1 = int(round(cy1 / 1000.0 * float(h)))
                _px2 = int(round(cx2 / 1000.0 * float(w)))
                _py2 = int(round(cy2 / 1000.0 * float(h)))
                _xtl = max(0, min(_px1, _px2))
                _ytl = max(0, min(_py1, _py2))
                _xbr = min(w, max(_px1, _px2))
                _ybr = min(h, max(_py1, _py2))
                if _xbr <= _xtl or _ybr <= _ytl:
                    continue
                _area = int((_xbr - _xtl) * (_ybr - _ytl))
                _plm = _PER_LABEL_MIN_AREA_PX_SOFT.get(lab)
                if _plm is not None and _area < _plm:
                    try:
                        logger_ctx.logger.info(
                            "[CVAT-LAMBDA-SANITIZED] recall_drop idx=%d label=%s area=%d < per_label_soft=%d",
                            i_idx, lab, _area, _plm,
                        )
                    except Exception:
                        pass
                    continue
                cands.append({
                    "confidence": 0.55,
                    "label": lab,
                    "_box": [float(_xtl), float(_ytl), float(_xbr), float(_ybr)],
                    "_points": [_xtl, _ytl, _xbr, _ybr],
                })
            return cands

        recall_candidates = []
        need_generic_recall = (len(parsed) == 0) and (total_pixels >= 800000)
        if need_generic_recall:
            try:
                context.logger.info(
                    "[CVAT-LAMBDA-SANITIZED] recall_trigger first_parse=0 pixels=%d running_general_recall_prompt (strict宁缺毋滥 mode)",
                    total_pixels,
                )
                general_recall_prompt = (
                    "任务：你上一次返回了空数组 []，但这是一张 ≥ 80 万像素的真实街景图，请再仔细看一遍有没有漏掉的目标。\n"
                    "⚠️ **核心规则（严格遵守，把握 45% 门槛，不要凑数也不要漏真目标！）**：\n"
                    "  1) 只标 9 类：pedestrian / cyclist / motor_vehicle / non_motor_vehicle / traffic_cone / traffic_bucket / traffic_column / plastic_barrier / guard_rail。\n"
                    "  2) 把握 ≥ 45% 且符合存在级+分类级/硬约束规则的就标（包括被挡大巴/缝隙骑手/远处真车/黄电子桩）；把握 < 45% 的才跳过。\n"
                    "  3) **绝对跳过清单（标了就算严重错误！）**：路灯杆/电线杆/路牌杆/监控杆/小区大门/绿化围栏/带门锁的栅栏门/广场装饰围栏/手拉购物车/拖车/拉杆箱/婴儿车/公交站亭/建筑脚手架/广告牌支架/花坛/花盆/木花坛/石墩/消防栓/围墙柱头 → 这些绝对不能标任何 9 类！\n"
                    "  4) 连续 3 根及以上等间距排列的 traffic_column/bucket：整体合并为一个 plastic_barrier 大框，**绝对禁止逐根单标**！\n"
                    "  5) 9 类判定规则和之前的定义完全一致。\n"
                    "只返回 JSON 数组，每条 Schema：{\"label\":\"<9 类之一>\",\"box\":[x_min,y_min,x_max,y_max]}。坐标 0–1000 整数。如果确实没有任何把握≥45%的目标，返回 []。"
                )
                recall_msgs = [
                    {"role": "user", "content": [
                        {"type": "text", "text": general_recall_prompt},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                    ]}
                ]
                try:
                    recall_out = _call_api(recall_msgs, timeout_s=45)
                    try:
                        recall_parsed = _extract_json(recall_out)
                        if isinstance(recall_parsed, list) and recall_parsed:
                            got = _parse_to_candidates(recall_parsed, context)
                            recall_candidates.extend(got)
                            context.logger.info(
                                "[CVAT-LAMBDA-SANITIZED] recall_general_produced=%d candidates (strict mode)",
                                len(got),
                            )
                    except Exception as _rerr:
                        context.logger.info(
                            "[CVAT-LAMBDA-SANITIZED] recall_general_parse_failed=%s", str(_rerr)[:120]
                        )
                except Exception as _apierr:
                    context.logger.info(
                        "[CVAT-LAMBDA-SANITIZED] recall_general_api_failed=%s", str(_apierr)[:120]
                    )
            except Exception:
                pass

        if recall_candidates:
            combined = list(merged) + recall_candidates
            combined = _nms(combined, iou_threshold=0.45)
            merged = _merge_ped_cycle_to_cyclist(combined, logger=context.logger)
            per_label_after_merge = {}
            for item in merged:
                per_label_after_merge[item["label"]] = per_label_after_merge.get(item["label"], 0) + 1
            try:
                context.logger.info(
                    "[CVAT-LAMBDA-SANITIZED] recall_combined_after_nms_merge total=%d per_label=%s",
                    len(merged), json.dumps(per_label_after_merge, ensure_ascii=False),
                )
            except Exception:
                pass

        results = []
        for item in merged:
            results.append(
                {
                    "confidence": str(item["confidence"]),
                    "label": item["label"],
                    "points": item["_points"],
                    "type": "rectangle",
                }
            )

        try:
            context.logger.info(
                "[CVAT-LAMBDA-SANITIZED] per_label_after_merge=%s final_results=%s",
                json.dumps(per_label_after_merge, ensure_ascii=False),
                json.dumps(results, ensure_ascii=False),
            )
        except Exception:
            pass

        return context.Response(
            body=json.dumps(results),
            headers={},
            content_type="application/json",
            status_code=200,
        )
    except Exception as e:
        try:
            context.logger.error(
                "[CVAT-LAMBDA-SANITIZED] handler_exception: %s", str(e), exc_info=True
            )
        except Exception:
            pass
        return context.Response(
            body=json.dumps([]),
            headers={},
            content_type="application/json",
            status_code=200,
        )
