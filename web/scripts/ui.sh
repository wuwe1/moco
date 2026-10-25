#!/bin/sh
# 加 shadcn 组件：pnpm ui button dialog …
# shadcn 4.21 解析不了这里的 @/lib/utils 别名，会写成 from "cn" 还装一个叫 cn 的 npm 包，加完改回来
set -e
npx -y shadcn@4.21.4 add "$@" --yes </dev/null
sed -i '' 's#from "cn"#from "@/lib/utils"#' src/components/ui/*.tsx
if grep -q '"cn":' package.json; then pnpm remove cn; fi
