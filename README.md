<div align="center">
  <h1 align="center">EasyTier CF Records</h1>
  <p align="center">自动维护 Cloudflare 上的 EasyTier 网络发现记录（SRV + TXT）</p>
</div>

[![Update EasyTier DNS records](https://github.com/muxinxy/easytier-cf-records/actions/workflows/update-dns.yml/badge.svg)](https://github.com/muxinxy/easytier-cf-records/actions/workflows/update-dns.yml)

> 徽章在 workflow 首次运行之前显示 `no status`，手动触发或等定时跑过一次后就会显示通过/失败。

合并手动节点与社区状态页节点，定期探测可用性和延迟，把延迟最低的前几名写入 DNS，供各 EasyTier 节点通过 `srv://` / `txt://` 自动发现公共中继。

## 运行方式

跑在 **GitHub Actions**（公共仓库免费），不依赖任何常驻设备（NAS / 电脑关机都照常运行）。工作流固定每 15 分钟检查一次是否到期，**实际执行间隔由仓库变量 `UPDATE_INTERVAL_MINUTES` 控制**（默认 30 分钟），因为 GitHub 的 schedule cron 不支持引用变量。定时触发可能延迟几分钟到几十分钟，对小时级的 DNS 更新没有影响。

其他方式的取舍：Cloudflare Worker 定时最精准但只能做 TCP 探测；Vercel/Netlify 免费版 cron 受限（Vercel Hobby 每天仅一次）且无原始 TCP/UDP 套接字；本机/服务器 cron 依赖常驻设备。本脚本零依赖（Node ≥ 18），将来若想在 VPS 上跑，直接 `cron` 调用即可。

## 流程

```
peers.txt（手动维护） ──┐
                        ├→ 合并去重 (host:port) → TCP 探测×3（可用性+延迟）
Uptime Kuma 状态页 ─────┘        ↓
                          过滤（探测失败 / 状态页离线 / 24h 在线率 < 0.8 的剔除）
                                 ↓
                          排序（状态页上海探测延迟优先，手动节点用自测延迟+120ms 跨洋补偿）
                                 ↓
                          取前 5 名 → diff 式更新 Cloudflare（SRV ×5 + TXT et-1..et-3）
                                 ↓
                          last_run.json 提交回仓库（审计 + 保持仓库活跃防定时任务被停用）
```

- **状态页来源**：[ruixuan.online/uptime/easytier](https://ruixuan.online/uptime/easytier)（Uptime Kuma），只抓取分组名含「公共节点」的监控项，从名称中提取 `tcp://` `udp://` `wss://` 等完整地址；**打码节点（地址带 `*`）自动跳过**。它的探测点是上海电信，比 Actions 的海外探测器更贴近国内实际使用视角。
- **探测**：对每个节点做 3 次 TCP 连接取最小延迟（超时 2 秒）。EasyTier 默认 tcp/udp 同端口监听，所以对 `udp://` 节点测 TCP 端口同样是有效的可达性依据。
- **写入 Cloudflare**：diff 式更新，只创建/修改/删除有变化的记录；筛选后没有节点时会直接终止，绝不清空现有记录。

## Cloudflare 记录布局

| 记录 | 名称 | 内容 | 说明 |
|---|---|---|---|
| SRV ×N | `_easytier._tcp.et.<domain>` | priority 按延迟名次降序（第 1 名最高） | EasyTier 把 priority 当**加权随机权重，越大越常被选中**。SRV 只收 tcp/udp 节点（EasyTier 会按查询协议拼 `tcp://` 地址，wss 节点连不上） |
| A（按需） | `et_<priority>.<domain>` | 节点裸 IP | SRV 的 target 不能直接写裸 IP，为它自动创建的 A 记录；名称后缀就是该节点的 priority（随延迟名次变化，掉出名单的会自动清理） |

> 换记录内容后，新值（TTL 60 秒）会很快生效；但如果**被替换掉的旧记录**是手工创建的长 TTL（如 1 小时），公网解析器最长会在此后一个 TTL 周期内仍看到旧值，属正常现象。
| TXT 主记录 | `et.<domain>` | 全部入选节点，空格分隔 | EasyTier 每次解析随机选一、分摊流量（内容限 240 字节内，因 TXT 单字符串段 ≤255 字节） |
| TXT 槽位 ×3 | `et-1` / `et-2` / `et-3` `.<domain>` | `tcp://host:port` 等 | 延迟前 3 名的确定性槽位，与 config.toml 的 `txt://et-N` 对应 |

对应的 EasyTier 配置（**无需修改**）：

```toml
[[peer]]
uri = "srv://et.<domain>"

[[peer]]
uri = "txt://et-1.<domain>"

[[peer]]
uri = "txt://et-2.<domain>"

[[peer]]
uri = "txt://et-3.<domain>"
```

> EasyTier 对同一域名下的多条 TXT 记录只读取第一条（内容按空格分隔、随机选一），所以用 `et-1..et-N` 分名发布多个节点。想扩大候选，把 workflow 里加上 `args: --max 7 --txt-count 5` 之类的参数，并在 config.toml 里补 `txt://et-4` / `txt://et-5`。

## 首次部署

1. 在 Cloudflare 面板创建 API Token：权限 **Zone → DNS → Edit**，Zone 限定为 `<domain>`。
2. GitHub 仓库 **Settings → Secrets and variables → Actions** 添加：
   - **Secrets** 标签页：`CF_API_TOKEN`（zone id 会用 token 自动查询）
   - **Variables** 标签页（可选）：`CF_DOMAIN`（zone 域名，默认 `<domain>`）、`UPDATE_INTERVAL_MINUTES`（实际执行间隔分钟数，默认 30）
3. **Actions → Update EasyTier DNS records → Run workflow** 手动触发一次（可勾选 force 忽略间隔立即执行），看运行摘要；之后按配置的间隔自动执行。

## 本地运行

```bash
# 只探测和打印将要写入的记录，不连接 Cloudflare
node update_records.mjs --dry-run

# 真实更新
CF_API_TOKEN=xxxx node update_records.mjs

# 只用手动节点、纯自测延迟排序
node update_records.mjs --skip-kuma --rank-by probe
```

常用参数（`--help` 看全部）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--max N` | 5 | 入选节点数（= SRV 条数） |
| `--txt-count N` | 3 | TXT 记录条数 |
| `--rank-by auto\|probe` | auto | auto=状态页延迟优先；probe=纯自测延迟 |
| `--probe-penalty-ms N` | 120 | auto 模式下无状态页数据节点的跨洋探测补偿，0 关闭 |
| `--min-uptime 0.8` | 0.8 | 状态页节点 24h 在线率门槛 |
| `--no-probe-require` | - | 自测失败不剔除（默认剔除） |
| `--peers FILE` | peers.txt | 手动节点列表 |

环境变量：`CF_API_TOKEN`、`CF_DOMAIN`、`KUMA_BASE`、`KUMA_SLUG`。

## 节点来源

**peers.txt** 手动维护，每行一个节点，支持注释：

```
# 纯 host:port 等价于 tcp://
public.easytier.top:11010
# 也支持完整 URI（tcp/udp/ws/wss/quic）
udp://et.basd1.de:11010
wss://et.chinokou.cn
# 行内注释
et.gbc.moe:11011 # 手动添加
```

**状态页** 自动抓取，`KUMA_BASE` / `KUMA_SLUG` 可换成其他 Uptime Kuma 实例；`KUMA_GROUP_RE` 控制只抓哪些分组。抓不到状态页时自动降级为只用 peers.txt，不影响运行。

## 文件说明

- `update_records.mjs` — 主脚本（零依赖 Node ≥ 18）
- `peers.txt` — 手动节点列表
- `last_run.json` — 每次运行的结果快照（节点明细、入选名单、DNS 变更），由 workflow 自动提交，也是定时任务的保活提交
- `legacy/update_records.sh` — 旧版 bash 脚本（NAS cron 时代），已被本方案取代，仅留档
