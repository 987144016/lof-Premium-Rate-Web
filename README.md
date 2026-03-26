# 溢价率日常看板

这是一个面向 LOF / QDII / ETF 场内溢价率观察的静态网站项目，目标是替代直接拿滞后净值估溢价率的粗糙做法。

当前版本已支持 24 只基金的日常看板，并按 QDII 的 LOF、国内 LOF、ETF 类 三页展示，为每只基金维护独立误差记录与独立修正模型。

## 当前能力

- 启动时自动抓取最新基金净值、历史净值和场内价格
- 日度资料缓存到 .cache/fund-sync/daily，避免一天内重复抓取
- 日内场内价格、USD/CNY、QDII 代理篮子报价和 161128 前十大持仓报价缓存到 .cache/fund-sync/intraday
- 自动抓取基金最新前十大持仓公告，并把披露快照保存在本地缓存中，便于后续调参
- 公告持仓解析已拆成独立脚本注册表，便于按基金格式持续追加专用解析器
- 自动记录昨日估值与后续真实净值的差值，并累积误差历史
- 160723 额外生成离线静态研究图（本地脚本出图），用于对比“持仓期分段训练”与“双目标优化”
- 首页表格主看板支持排序，展示现价、估值、溢价率、净值日期、现价时间和申购状态
- 详情页展示每只基金自己的误差折线图和模型状态
- 161128 额外保留持仓级估值实验室，并自动带入 USD/CNY 与美股前十大持仓报价

## 已纳入的基金

160221、165520、161725、167301、501050、501011、161226、161128、160216、161116、164701、160719、501018、161129、162719、160723、162411、160416、501225、161125、501312、161130、159509、513310。

## 估值方法

首页自动模型当前分两类：

国内 LOF：

当日预估净值 = 最近官方净值 × (1 + alpha + betaLead × 场内当日涨跌幅 + betaGap × 昨收相对净值偏离)

QDII / 跨境 ETF：

当日预估净值 = 最近官方净值 × (1 + alpha + betaLead × 海外代理篮子涨跌幅 + betaGap × USD/CNY 变化)

其中：

- 最近官方净值就是最近一次已公布净值，QDII 常常会落后 1 到 2 个交易日，具体看净值日期列
- 首页估值列不是已公布净值本身，而是以它为锚推出来的“当日尚未公布真实净值”
- 国内 LOF 的主因子仍是场内日内涨跌幅
- QDII 和跨境 ETF 的主因子改为海外代理篮子涨跌幅，不再用场内价格去驱动净值
- QDII 和跨境 ETF 的辅助因子改为 USD/CNY 变化
- alpha、betaLead、betaGap 由各基金自己的误差历史单独更新
- 当真实净值发布后，系统会把当日预测误差回写到该基金自己的模型

161128 详情页额外提供持仓模式：

- 以最近官方净值为锚点
- 使用前十大持仓权重和代理篮子做净值贡献拆解
- 叠加汇率变化、费用拖累、人工修正和独立细模型修正

## 训练规则（必须遵守）

以下规则用于避免“只看当天净值”导致的冷启动和漂移。

1. 每次同步必须抓取一段历史净值，不允许只用当天净值。
1. 历史净值来源为 Eastmoney 历史净值接口（脚本中的 `fetchExtendedNavHistory`），并与基金基础净值序列合并后作为 `navHistory`。
1. 线上模型训练采用“结算后增量学习”：
	- 先记录每日估值快照（`journal.snapshots`）。
	- 等该交易日官方净值可用后，再用 `navHistory` 回填真实值并更新参数（`reconcileJournal`）。
	- 未结算日不能计入 `sampleCount`。
1. 对已做离线研究的基金，必须加载 `public/generated/<code>-offline-research.json` 作为预训练引导：
	- 自动注入离线 MAE 到 `meanAbsError`，并提供不少于 30 的 bootstrap 样本权重。
	- 再叠加线上增量样本，持续更新。
1. 新接入基金默认视为冷启动，必须补齐离线研究后再作为“已训练基金”看待：
	- 仅有 1-2 个线上样本时，误差统计不具备稳定性。
	- 需要先生成对应的 `*-offline-research.json`，再执行 `npm run sync:data` 合并到运行时状态。

简化判断标准：

- `sampleCount < 30`：冷启动阶段（以观察为主）。
- `sampleCount >= 30`：进入可比较阶段（再结合近30天误差看稳定性）。

## 本地开发

安装依赖后可直接运行：

```powershell
npm install
npm run dev
```

如果需要自动同步并打开本地页面：

```powershell
npm run app:start
```

如果要录入第三方溢价率（本地弹窗，不在网站中展示），可使用：

```powershell
start-premium-entry.cmd
```

或：

```powershell
npm run manual:premium-entry
```

弹窗关闭时会自动保存，并同时写入以下两个文件：

- `.cache/fund-sync/premium-compare-manual-local.json`（本地私有）
- `public/generated/premium-compare-manual.json`（仓库共享，可用于 GitHub 线上展示）

弹窗会记住你上次使用的日期和平台；下次打开时会直接回显该日期/平台已录入的溢价率，便于复核历史数据。

后续执行 `npm run sync:data` 时会自动读取这两份手工录入数据并并入第三方误差统计。

这个主入口会按交易时段调整频率：

- A 股和美股开市时按 60 秒刷新
- 其他时段按 15 分钟刷新

如果只需要刷新一次数据：

```powershell
npm run sync:data
```

该命令仅同步基金运行时数据（用于每日更新，速度更快）。

若需要在研究阶段更新离线训练图和摘要，请手动运行：

```bash
npm run sync:research
```

如需按同一方法逐个优化原油类未优化基金（160723/501018/161129），可运行：

```bash
npm run sync:research:oil
```

如需优化商品混合基金 160216，可运行：

```bash
npm run sync:research:commodities
```

如需优化半导体组（501225/513310/161130），可运行：

```bash
npm run sync:research:semiconductor
```

如需优化油气上游组（160416/162719/162411），可运行：

```bash
npm run sync:research:energy
```

如需优化美股科技组（161125/159509），可运行：

```bash
npm run sync:research:us-tech
```

如需优化海外科技持仓组（501312），可运行：

```bash
npm run sync:research:innovation
```

如需优化国内行业组（501011/501050），可运行：

```bash
npm run sync:research:domestic-industry
```

如需优化 A 股本土组（160221/165520/167301），可运行：

```bash
npm run sync:research:a-share
```

如需优化当前剩余组（161226/161128），可运行：

```bash
npm run sync:research:remaining
```

若希望一次性同时执行两者，可运行：

```bash
npm run sync:data:full
```

默认开发地址为 http://localhost:5173。

## SSH 配置（解决 HTTPS 连接问题）

如果遇到 `git push` 或 `git pull` 超时失败（如 "Failed to connect to github.com port 443"），可能是因为网络环境限制了 HTTPS 连接。此时可切换到 SSH 方式：

### 1. 生成 SSH 密钥

```powershell
# 创建 .ssh 目录（如果不存在）
New-Item -ItemType Directory -Force -Path $env:USERPROFILE\.ssh

# 生成 4096 位 RSA 密钥
ssh-keygen -t rsa -b 4096 -C "your_email@example.com" -f $env:USERPROFILE\.ssh\id_rsa -N '""'
```

### 2. 添加公钥到 GitHub

```powershell
# 查看公钥内容
Get-Content $env:USERPROFILE\.ssh\id_rsa.pub
```

复制输出的公钥内容，然后：
1. 打开 GitHub → Settings → SSH and GPG keys → New SSH key
2. Title 填：`溢价率网站`
3. Key 粘贴公钥内容
4. 点击 Add SSH key

### 3. 切换远程仓库为 SSH

```powershell
git remote set-url origin git@github.com:987144016/lof-Premium-Rate-Web.git
```

### 4. 验证配置

```powershell
# 查看远程配置
git remote -v

# 测试推送
git push origin main
```

首次连接时会提示确认 GitHub 主机指纹，输入 `yes` 即可。

## 数据来源与抓取约束

- 仅使用公开可访问的基金净值、场内行情、公告和公开报价接口
- 优先依赖本地缓存，避免对单一来源做不必要的高频重复请求
- 接入新来源前，先检查该站点的 robots.txt、公开说明和使用条款；如果明确限制自动抓取，则不纳入默认同步流程
- 不绕过登录、鉴权、验证码、签名校验或其他访问控制
- 本项目只保存结构化结果用于估值展示，不把大段原始公告正文作为公开仓库内容分发

## 公告解析维护

- 公告解析脚本放在 [scripts/notice-parsers/README.md](scripts/notice-parsers/README.md) 对应目录下
- 当前采用“注册表 + 专用解析脚本”方式，不再把所有异常格式都堆进一个函数
- 新基金如果公告格式不同，优先新增专用解析器，再在注册表里把基金代码挂过去

## 部署

推荐使用 GitHub Pages。

- 网站本体按静态站点发布，不需要访问时保持本地电脑在线
- 数据同步和构建由 GitHub Actions 定时执行，交易时段 5 分钟一次，其他工作时段 15 分钟一次
- 工作流会额外拉取 GitHub 仓库 traffic API，并生成最近 7 天访客/浏览统计供首页展示
- 访客统计会在北京时间固定时段（默认 12:00 窗口）写入每日快照，并在首页显示累计访客与趋势线，便于看长期变化
- Pages 构建前会在 CI 执行 runtime 数据同步（sync:data），再构建并部署
- 离线研究类 generated 文件仍以仓库已提交内容为准；如需展示本地私有训练结果，请先在本地生成并提交对应 generated 文件
- 访客统计依赖 GH_TRAFFIC_TOKEN 仓库密钥；若未配置或权限不足，页面会显示访客数据不可用，并在 generated/github-traffic.json 写入失败原因
- 若 token 暂时不可用，可先准备一个 `snapshots` JSON（例如 `public/generated/github-traffic-manual.json`），再执行 `npm run import:github-traffic -- public/generated/github-traffic-manual.json` 手工导入历史快照，恢复首页趋势展示
- 若第三方溢价率接口不可用（例如 Sina 无溢价字段），可优先使用本地弹窗录入（`start-premium-entry.cmd` 或 `npm run manual:premium-entry`）；同步时会自动读取 `.cache/fund-sync/premium-compare-manual-local.json` 与 `public/generated/premium-compare-manual.json`。
- 别人直接打开网址即可查看最近一次更新后的页面
- 本地修改和本地构建不会自动发布到 GitHub Pages，必须有新的提交并推送到远端，工作流才会重新部署
- 路由使用哈希模式，避免静态托管下的前端路由 404 问题

部署所需工作流文件已包含在 [deploy-pages.yml](.github/workflows/deploy-pages.yml)。

## 开源协议

本项目使用 Apache License 2.0，见 [LICENSE](LICENSE)。

使用、修改和再分发本项目代码时，请遵守 [LICENSE](LICENSE) 中的条款，并保留必要的协议与声明。

## 说明

- README 仅保留项目说明、运行方式和公开协议信息。
- 数据更新时间：2026-03-26 16:48
