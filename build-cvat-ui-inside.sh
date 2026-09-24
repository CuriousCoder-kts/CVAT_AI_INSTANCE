#!/bin/bash
# ----------------------------------------------------------------
# CVAT-UI AI Mgr Build Script (YARN 版)
#   在本地已有的 node:lts-slim 镜像内执行：yarn install（package manager 是 yarn，因为
#   cvat Dockerfile.ui L17 用 yarn install --immutable ）+ yarn build
#   然后 cp 到共享 volume /output
# ----------------------------------------------------------------
set -euo pipefail

echo "===== [0/6] Node /src 文件检查 cvat-develop 挂载检查 ====="
cd /src
ls -la
test -f /src/package.json && echo "✅ /src/package.json 存在" || (echo "❌ /src/package.json 不存在" && exit 2)
test -d /src/cvat-ui && echo "✅ /src/cvat-ui 存在" || exit 2
test -d /src/cvat-core && echo "✅ /src/cvat-core 存在" || exit 2

echo "===== [1/6] 核心包管理器：启用 corepack (yarn 最新 stable) ====="
export DISABLE_HUSKY=1
corepack enable
corepack prepare yarn@stable --activate 2>/dev/null || true
cd /src
yarn --version
echo "  -> yarn 版本 OK"

echo "===== [2/6] 装系统依赖（yarn 原生模块编译用：python3/make/g++，同时配置 registry 加速（若离线模式也会有 node-gyp 失败 ====="
apt-get update -y > /dev/null 2>&1 || true
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 make g++ git ca-certificates > /dev/null 2>&1 || true
echo "  -> apt deps OK（失败忽略，因为大多数 CVAT UI 依赖一般不需要这个阶段很少遇到原生模块）"

echo "===== [3/6] 根目录 yarn install（cvat 是 monorepo，根目录 package.json 用 yarn workspaces ====="
cd /src
# 如果 webpack 已经存在（之前安装过），跳过重装（节省 569MB 下载时间）
if ls node_modules/.bin/webpack > /dev/null 2>&1 && yarn workspace cvat-ui exec true 2>/dev/null; then
  echo "  -> ⚡️ node_modules 已存在（webpack 可用），跳过 yarn install（用增量缓存）";
else
  # 只在确有旧 node_modules 时清理（第一次需要）
  find /src -maxdepth 4 -type d -name node_modules -exec rm -rf {} + 2>/dev/null || true
  echo "  -> 清理旧 node_modules 完成（或不需要），开始 yarn install"
  yarn install --no-immutable 2>&1 | tail -n 30 || yarn install 2>&1 | tail -n 50
  echo "  -> 根目录 yarn install OK"
fi

echo "===== [4/6] 验证 webpack 存在（它是 monorepo 根 devDeps，在根 node_modules/.bin 下）====="
cd /src
ls node_modules/.bin/webpack > /dev/null 2>&1 && (echo "✅ webpack 在 /src/node_modules/.bin/webpack OK") || (echo "❌ 没找到 webpack，重新在根目录 yarn install 强制" && cd /src && yarn install --no-immutable 2>&1 | tail -n 30 && ls node_modules/.bin/webpack || true)
ls node_modules/.bin/webpack || true

echo "===== [5/6] cvat-ui build（两种方式都行：yarn workspace cvat-ui run build，或 cd cvat-ui && yarn run build —— yarn 会向上解析根 node_modules/.bin/webpack）====="
cd /src/cvat-ui
# 必须用 yarn run build（= 它内部执行 scripts.build="webpack --config webpack.config.js"）
# 不能直接 webpack，因为子目录没有 .bin/webpack
yarn run build 2>&1 | tail -n 80

echo "===== [5.5/6] dist 存在性验证 ====="
test -d dist && echo "✅ 有 dist 目录"
ls dist | head -n 20

echo "===== [6/6] 拷贝 dist/. → /output 共享 volume ====="
rm -rf /output/* 2>/dev/null || true
mkdir -p /output
cp -R /src/cvat-ui/dist/. /output/
echo "  -> copy OK，/output 列表："
ls -la /output | head -n 10
du -sh /output 2>/dev/null || true
echo ""
echo "🎉🎉🎉 Node(Yarn) 容器 Build 完成，退出容器"
