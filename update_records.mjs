#!/usr/bin/env node
/**
 * EasyTier 公共节点 → Cloudflare DNS 发现记录自动更新
 *
 * 流程：手动节点(peers.txt) + Uptime Kuma 状态页 → 合并去重 → TCP 探测(可用性+延迟)
 *      → 过滤排序 → 取前 N → diff 式更新 Cloudflare SRV/TXT 记录 → 输出 last_run.json
 *
 * 零依赖，Node >= 18（CI 用 Node 20）。本地手动运行：CF_DOMAIN=<你的域名> node update_records.mjs --dry-run
 *
 * EasyTier 消费端语义（来自 easytier-core/src/connectivity/manual/discovery/implementation.rs）：
 *  - srv://et.<domain>  查询 _easytier._tcp.et.<domain>（以及 _udp，查不到忽略），
 *    priority 字段被直接当作加权随机的权重，数值越大越容易被选中；
 *  - txt://et-N.<domain> 只读取该域名下第一条 TXT 记录，内容按空格分隔、随机选一个；
 *  - 因此这里用 et-1..et-N 分名发布多个节点，SRV 的 priority 按延迟名次降序。
 */

import net, { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CF_API = "https://api.cloudflare.com/client/v4";
const UA = "easytier-cf-records-updater/2.0";
const CONNECTABLE_SCHEMES = ["tcp", "udp", "ws", "wss", "quic"];
const DEFAULT_PORTS = { tcp: 11010, udp: 11010, ws: 80, wss: 443, quic: 11010 };

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    max: 5,
    txtCount: 3,
    minUptime: 0.8,
    rankBy: "auto", // auto: 状态页延迟优先，缺失时用自测延迟+跨洋补偿；probe: 纯自测
    probePenaltyMs: 120, // auto 模式下，无状态页数据的节点对自测延迟的补偿（跨国探测点偏差）
    probeRequire: true,
    probeTimeout: 2000,
    retries: 3,
    concurrency: 20,
    ttl: 60,
    weight: 10,
    srvPriorityStep: 10,
    peersFile: "peers.txt",
    outFile: "last_run.json",
    domain: process.env.CF_DOMAIN || null, // 必填，无默认值：未设置时直接报错退出
    srvName: "_easytier._tcp.et",
    txtPrefix: "et",
    kumaBase: process.env.KUMA_BASE || "https://ruixuan.online/uptime",
    kumaSlug: process.env.KUMA_SLUG || "easytier",
    kumaGroupRe: process.env.KUMA_GROUP_RE || "公共节点",
    skipKuma: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq > 2 ? arg.slice(0, eq) : arg;
    const inline = eq > 2 ? arg.slice(eq + 1) : undefined;
    const val = (name) => inline ?? argv[++i];
    switch (flag) {
      case "--dry-run": opts.dryRun = true; break;
      case "--max": opts.max = Number(val()); break;
      case "--txt-count": opts.txtCount = Number(val()); break;
      case "--min-uptime": opts.minUptime = Number(val()); break;
      case "--rank-by": opts.rankBy = val(); break;
      case "--probe-penalty-ms": opts.probePenaltyMs = Number(val()); break;
      case "--no-probe-require": opts.probeRequire = false; break;
      case "--probe-timeout": opts.probeTimeout = Number(val()); break;
      case "--retries": opts.retries = Number(val()); break;
      case "--concurrency": opts.concurrency = Number(val()); break;
      case "--ttl": opts.ttl = Number(val()); break;
      case "--weight": opts.weight = Number(val()); break;
      case "--srv-priority-step": opts.srvPriorityStep = Number(val()); break;
      case "--peers": opts.peersFile = val(); break;
      case "--out": opts.outFile = val(); break;
      case "--domain": opts.domain = val(); break;
      case "--srv-name": opts.srvName = val(); break;
      case "--txt-prefix": opts.txtPrefix = val(); break;
      case "--kuma-base": opts.kumaBase = val(); break;
      case "--kuma-slug": opts.kumaSlug = val(); break;
      case "--skip-kuma": opts.skipKuma = true; break;
      case "--help":
        console.log(`用法: node update_records.mjs [选项]
  --dry-run            只探测和打印，不写 Cloudflare
  --max N              入选节点数（SRV 条数），默认 5
  --txt-count N        TXT 记录条数 et-1..et-N，默认 3（需 <= max）
  --min-uptime 0.8     状态页节点 24h 在线率门槛
  --rank-by auto|probe 排序策略，默认 auto
  --probe-penalty-ms N auto 模式下无状态页节点的自测延迟补偿，默认 120，0 关闭
  --no-probe-require   自测失败不剔除（默认剔除）
  --probe-timeout MS   单次 TCP 连接超时，默认 2000
  --retries N          每节点探测次数（取最小值），默认 3
  --concurrency N      探测并发数，默认 20
  --ttl SECONDS        DNS 记录 TTL，默认 60
  --peers FILE         手动节点列表，默认 peers.txt
  --domain NAME        Cloudflare zone 域名（或环境变量 CF_DOMAIN），必填，无默认值
  --srv-name NAME      SRV 记录名主体，默认 _easytier._tcp.et
  --txt-prefix NAME    TXT 记录名前缀，默认 et
  --kuma-base URL      Uptime Kuma 地址（或环境变量 KUMA_BASE）
  --kuma-slug NAME     状态页 slug（或环境变量 KUMA_SLUG）
  --skip-kuma          不抓取状态页，只用 peers.txt
  --out FILE           运行结果 JSON 路径，默认 last_run.json`);
        process.exit(0);
      default:
        throw new Error(`未知参数: ${arg}（--help 查看用法）`);
    }
  }
  if (!Number.isInteger(opts.max) || opts.max < 1) throw new Error("--max 必须 >= 1");
  if (!Number.isInteger(opts.txtCount) || opts.txtCount < 0) throw new Error("--txt-count 必须 >= 0");
  if (opts.txtCount > opts.max) throw new Error("--txt-count 不能大于 --max");
  if (!["auto", "probe"].includes(opts.rankBy)) throw new Error("--rank-by 只支持 auto|probe");
  return opts;
}

// ---------- 节点解析 ----------

function normHost(host) {
  const ascii = domainToASCII(host);
  return (ascii && ascii !== "null" ? ascii : host).toLowerCase();
}

// 接受 host:port、proto://host:port、[v6]:port，行内 # 注释
function parsePeerLine(raw) {
  const line = raw.split("#")[0].trim();
  if (!line) return null;
  let proto = "tcp";
  let rest = line;
  const schemeMatch = line.match(/^([a-z0-9]+):\/\//i);
  if (schemeMatch) {
    proto = schemeMatch[1].toLowerCase();
    if (!CONNECTABLE_SCHEMES.includes(proto)) return null;
    rest = line.slice(schemeMatch[0].length);
  }
  let host = rest;
  let port;
  const v6 = rest.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) {
    host = v6[1];
    port = v6[2];
  } else {
    const idx = rest.lastIndexOf(":");
    if (idx > 0 && /^\d+$/.test(rest.slice(idx + 1))) {
      host = rest.slice(0, idx);
      port = rest.slice(idx + 1);
    }
  }
  host = normHost(host);
  if (!host || host.includes("*") || host.includes("/")) return null;
  port = port === undefined ? DEFAULT_PORTS[proto] ?? 11010 : Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, proto };
}

function parsePeersFile(file) {
  if (!existsSync(file)) {
    console.warn(`[warn] 节点列表 ${file} 不存在，只用状态页来源`);
    return [];
  }
  const nodes = [];
  const seen = new Set();
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const parsed = parsePeerLine(raw);
    if (!parsed) continue;
    const key = `${parsed.host}:${parsed.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push({ ...parsed, sources: ["manual"], kumaId: null, kumaName: null });
  }
  console.log(`[peers] 手动节点 ${nodes.length} 个`);
  return nodes;
}

// ---------- Uptime Kuma 状态页 ----------

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 从监控项名称提取可连接的节点 URI，如 "tcp://1.2.3.4:11010（描述…）"
// 打码节点（地址带 *）无法使用，直接跳过
function parseKumaMonitorName(name) {
  const m = name.match(/\b(tcp|udp|ws|wss|quic):\/\/([^（(\s]+)/i);
  if (!m) return null;
  const proto = m[1].toLowerCase();
  const uri = m[2];
  if (uri.includes("*")) return null; // 打码
  const parsed = parsePeerLine(`${proto}://${uri}`);
  return parsed;
}

async function loadKuma(opts) {
  const base = opts.kumaBase.replace(/\/+$/, "");
  console.log(`[kuma] 抓取状态页 ${base}/api/status-page/${opts.kumaSlug}`);
  const config = await getJson(`${base}/api/status-page/${opts.kumaSlug}`);
  let heartbeat = { heartbeatList: {}, uptimeList: {} };
  try {
    heartbeat = await getJson(`${base}/api/status-page/heartbeat/${opts.kumaSlug}`);
  } catch (err) {
    console.warn(`[warn] 心跳数据获取失败（忽略，仅影响延迟排序）: ${err.message}`);
  }
  const groupRe = new RegExp(opts.kumaGroupRe);
  const health = {};
  for (const [id, list] of Object.entries(heartbeat.heartbeatList ?? {})) {
    const sorted = [...list].sort((a, b) => String(a.time).localeCompare(String(b.time)));
    const latest = sorted.at(-1);
    const pings = sorted.filter((h) => h.status === 1 && typeof h.ping === "number").slice(-5).map((h) => h.ping);
    health[id] = {
      up: latest?.status === 1,
      medianPing: median(pings),
      uptime24: heartbeat.uptimeList?.[`${id}_24`] ?? null,
    };
  }
  const nodes = [];
  for (const group of config.publicGroupList ?? []) {
    if (!groupRe.test(group.name ?? "")) continue;
    for (const monitor of group.monitorList ?? []) {
      const parsed = parseKumaMonitorName(monitor.name ?? "");
      if (!parsed) continue;
      nodes.push({
        ...parsed,
        sources: ["kuma"],
        kumaId: monitor.id,
        kumaName: monitor.name,
        kuma: health[monitor.id] ?? null,
      });
    }
  }
  console.log(`[kuma] 可用节点 ${nodes.length} 个（分组匹配 /${opts.kumaGroupRe}/，打码已跳过）`);
  return nodes;
}

// ---------- 合并 / 探测 / 排序 ----------

function mergeNodes(manual, kuma) {
  const byKey = new Map();
  const push = (node) => {
    const key = `${node.host}:${node.port}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...node });
      return;
    }
    // 同一 host:port 来自两个来源：合并协议与元数据
    for (const s of node.sources) if (!existing.sources.includes(s)) existing.sources.push(s);
    if (!existing.protos.includes(node.proto)) existing.protos.push(node.proto);
    if (!existing.kumaId && node.kumaId) {
      existing.kumaId = node.kumaId;
      existing.kumaName = node.kumaName;
      existing.kuma = node.kuma;
    }
  };
  for (const n of manual) push({ ...n, protos: [n.proto] });
  for (const n of kuma) push({ ...n, protos: [n.proto] });
  return [...byKey.values()];
}

// TCP 连接探测。EasyTier 默认 tcp/udp 同端口监听，状态页的 port 监控也是 TCP 探测，
// 因此对 udp:// 节点同样测 TCP 端口作为可达性与延迟依据。
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok ? performance.now() - t0 : null);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function probeAll(nodes, opts) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < nodes.length) {
      const node = nodes[cursor++];
      const samples = [];
      for (let i = 0; i < opts.retries; i++) {
        const ms = await tcpProbe(node.host, node.port, opts.probeTimeout);
        if (ms !== null) samples.push(ms);
      }
      node.probeMs = samples.length ? Math.min(...samples) : null;
      node.ok = node.probeMs !== null;
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, nodes.length) }, worker));
}

function rankScore(node, opts) {
  if (opts.rankBy === "probe") return node.probeMs ?? Infinity;
  if (node.kuma?.medianPing != null) return node.kuma.medianPing;
  if (node.probeMs == null) return Infinity;
  return node.probeMs + opts.probePenaltyMs;
}

function selectNodes(nodes, opts) {
  const passed = [];
  for (const node of nodes) {
    const reasons = [];
    if (opts.probeRequire && !node.ok) reasons.push("探测失败");
    if (node.kuma) {
      if (!node.kuma.up) reasons.push("状态页当前离线");
      if (node.kuma.uptime24 != null && node.kuma.uptime24 < opts.minUptime)
        reasons.push(`24h 在线率 ${(node.kuma.uptime24 * 100).toFixed(1)}% < ${(opts.minUptime * 100).toFixed(0)}%`);
    }
    if (reasons.length) {
      node.excluded = reasons.join("，");
      console.log(`[filter] 剔除 ${node.host}:${node.port} — ${node.excluded}`);
    } else {
      passed.push(node);
    }
  }
  passed.sort((a, b) => rankScore(a, opts) - rankScore(b, opts) || (b.kuma?.uptime24 ?? 0) - (a.kuma?.uptime24 ?? 0));
  return passed.slice(0, opts.max);
}

// 记录内容使用的协议：tcp 优先（探测就是 TCP），wss/ws 节点保留原协议
function preferredProto(node) {
  for (const p of ["tcp", "wss", "ws", "udp", "quic"]) if (node.protos.includes(p)) return p;
  return "tcp";
}

// ---------- Cloudflare ----------

class Cloudflare {
  constructor(token) {
    this.token = token;
    this.zoneCache = new Map();
  }
  async request(method, path, body) {
    const res = await fetch(CF_API + path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      throw new Error(`Cloudflare ${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
    }
    return json.result;
  }
  async zoneId(domain) {
    if (!this.zoneCache.has(domain)) {
      const zones = await this.request("GET", `/zones?name=${encodeURIComponent(domain)}&per_page=1`);
      if (!zones?.length) throw new Error(`找不到 zone: ${domain}（检查 token 权限与 CF_DOMAIN）`);
      this.zoneCache.set(domain, zones[0].id);
    }
    return this.zoneCache.get(domain);
  }
  async listRecords(zone, params) {
    const q = new URLSearchParams({ per_page: "100", ...params }).toString();
    return (await this.request("GET", `/zones/${zone}/dns_records?${q}`)) ?? [];
  }
}

// SRV 查询名固定为 _easytier._tcp/.udp，EasyTier 会按查询协议拼出 tcp:// 或 udp:// 地址，
// 因此只有裸 TCP 兼容的节点（tcp/udp，EasyTier 默认同端口双栈监听）能进 SRV；
// ws/wss/quic 节点只放 TXT（TXT 内容自带正确协议前缀）。
const srvEligible = (selected) => selected.filter((n) => n.protos.some((p) => p === "tcp" || p === "udp"));

function srvRecordsFor(selected, opts) {
  const eligible = srvEligible(selected);
  // EasyTier 把 SRV priority 当加权随机权重、数值越大越容易被选中，
  // 所以延迟名次越靠前 priority 越高（第 1 名 = N*step，最后一名 = 1*step）。
  return eligible.map((node, i) => {
    const priority = (eligible.length - i) * opts.srvPriorityStep;
    const isIp = isIP(node.host) !== 0;
    const target = isIp ? `${opts.txtPrefix}_${priority}.${opts.domain}` : node.host;
    return {
      node,
      priority,
      record: {
        type: "SRV",
        name: `${opts.srvName}.${opts.domain}`,
        ttl: opts.ttl,
        proxied: false,
        data: { priority, weight: opts.weight, port: node.port, target },
      },
      aRecord: isIp
        ? { type: "A", name: `${opts.txtPrefix}_${priority}.${opts.domain}`, content: node.host, ttl: opts.ttl, proxied: false }
        : null,
    };
  });
}

function txtRecordsFor(selected, opts) {
  // 主记录 et：全部入选节点空格分隔，EasyTier 每次解析随机选一、分摊流量。
  // EasyTier 只读 TXT 的第一个字符串段（≤255 字节），超长会被 DNS 切段截断，故限制在 240 字节内。
  const uris = [];
  for (const node of selected) {
    const uri = `${preferredProto(node)}://${node.host}:${node.port}`;
    if (Buffer.byteLength([...uris, uri].join(" "), "utf8") > 240) break;
    uris.push(uri);
  }
  const slots = [{ name: `${opts.txtPrefix}.${opts.domain}`, content: uris.join(" ") }];
  // et-1..et-N：确定性槽位，与 config.toml 的 txt://et-N 对应
  for (let i = 0; i < opts.txtCount; i++) {
    slots.push({
      name: `${opts.txtPrefix}-${i + 1}.${opts.domain}`,
      content: `${preferredProto(selected[i])}://${selected[i].host}:${selected[i].port}`,
    });
  }
  return slots.map((s) => ({ record: { type: "TXT", ...s, ttl: opts.ttl, proxied: false } }));
}

const stripDot = (s) => (s ?? "").replace(/\.$/, "").toLowerCase();
const srvKey = (data) => `${stripDot(data?.target)}:${data?.port}`;

async function syncCloudflare(cf, opts, selected) {
  const changes = [];
  const desiredSrv = srvRecordsFor(selected, opts);
  const desiredTxt = txtRecordsFor(selected, opts);
  const desiredA = desiredSrv.map((s) => s.aRecord).filter(Boolean);

  if (opts.dryRun) {
    console.log("\n[dry-run] 将写入以下记录（不连接 Cloudflare）:");
    for (const { record, aRecord } of desiredSrv) {
      const d = record.data;
      console.log(`  SRV ${record.name}  prio=${d.priority} weight=${d.weight} port=${d.port} target=${d.target}`);
      if (aRecord) console.log(`  A   ${aRecord.name} -> ${aRecord.content}`);
    }
    for (const { record } of desiredTxt) {
      console.log(`  TXT ${record.name}  "${record.content}"`);
    }
    return changes;
  }

  const zone = await cf.zoneId(opts.domain);

  // --- SRV ---
  const srvName = `${opts.srvName}.${opts.domain}`;
  const existingSrv = await cf.listRecords(zone, { type: "SRV", name: srvName });
  const existingByKey = new Map(existingSrv.map((r) => [srvKey(r.data), r]));
  for (const { record } of desiredSrv) {
    const match = existingByKey.get(srvKey(record.data));
    if (match) {
      existingByKey.delete(srvKey(record.data));
      if (match.data?.priority !== record.data.priority || match.data?.weight !== record.data.weight) {
        const updated = await cf.request("PUT", `/zones/${zone}/dns_records/${match.id}`, record);
        console.log(`[cf] PUT SRV ${record.name} ${record.data.target}:${record.data.port} -> id=${updated?.id}`);
        changes.push({ action: "UPDATE", detail: `SRV ${record.name} ${record.data.target}:${record.data.port} priority ${match.data.priority} -> ${record.data.priority}` });
      }
    } else {
      const created = await cf.request("POST", `/zones/${zone}/dns_records`, record);
      console.log(`[cf] POST SRV ${record.name} prio=${record.data.priority} ${record.data.target}:${record.data.port} -> id=${created?.id}`);
      changes.push({ action: "CREATE", detail: `SRV ${record.name} prio=${record.data.priority} ${record.data.target}:${record.data.port}` });
    }
  }
  for (const stale of existingByKey.values()) {
    await cf.request("DELETE", `/zones/${zone}/dns_records/${stale.id}`);
    console.log(`[cf] DELETE SRV ${stale.name} ${stale.data?.target}:${stale.data?.port} -> id=${stale.id}`);
    changes.push({ action: "DELETE", detail: `SRV ${stale.name} ${stale.data?.target}:${stale.data?.port}` });
  }

  // --- A（裸 IP 的 SRV target）---
  const aPrefix = `${opts.txtPrefix}_`;
  const existingA = (await cf.listRecords(zone, { type: "A" })).filter(
    (r) => r.name.startsWith(aPrefix) && r.name.endsWith(`.${opts.domain}`),
  );
  const desiredAByName = new Map(desiredA.map((r) => [r.name, r]));
  const existingAByName = new Map(existingA.map((r) => [r.name, r]));
  for (const [name, rec] of desiredAByName) {
    const match = existingAByName.get(name);
    if (match) {
      existingAByName.delete(name);
      if (match.content !== rec.content) {
        await cf.request("PUT", `/zones/${zone}/dns_records/${match.id}`, rec);
        changes.push({ action: "UPDATE", detail: `A ${name} ${match.content} -> ${rec.content}` });
      }
    } else {
      await cf.request("POST", `/zones/${zone}/dns_records`, rec);
      changes.push({ action: "CREATE", detail: `A ${name} -> ${rec.content}` });
    }
  }
  for (const stale of existingAByName.values()) {
    await cf.request("DELETE", `/zones/${zone}/dns_records/${stale.id}`);
    changes.push({ action: "DELETE", detail: `A ${stale.name}` });
  }

  // --- TXT 主记录 et + et-1..et-N ---
  const txtRe = txtReGlobal(opts);
  const existingTxt = (await cf.listRecords(zone, { type: "TXT" })).filter((r) => txtRe.test(r.name));
  for (const { record } of desiredTxt) {
    const atName = existingTxt.filter((r) => r.name.toLowerCase() === record.name.toLowerCase());
    const exact = atName.find((r) => r.content === record.content);
    if (exact) {
      for (const dup of atName.filter((r) => r.id !== exact.id)) {
        await cf.request("DELETE", `/zones/${zone}/dns_records/${dup.id}`);
        changes.push({ action: "DELETE", detail: `TXT ${dup.name}（重复）` });
      }
    } else if (atName.length) {
      await cf.request("PUT", `/zones/${zone}/dns_records/${atName[0].id}`, record);
      for (const extra of atName.slice(1)) {
        await cf.request("DELETE", `/zones/${zone}/dns_records/${extra.id}`);
        changes.push({ action: "DELETE", detail: `TXT ${extra.name}（多余）` });
      }
      changes.push({ action: "UPDATE", detail: `TXT ${record.name} -> "${record.content}"` });
    } else {
      await cf.request("POST", `/zones/${zone}/dns_records`, record);
      changes.push({ action: "CREATE", detail: `TXT ${record.name} "${record.content}"` });
    }
  }
  // 超出当前条数的旧 TXT（如 et-4 及以后）清理；主记录 et（无序号）不受条数影响
  for (const rec of existingTxt) {
    const idx = Number(rec.name.match(txtRe)?.[1]);
    if (Number.isInteger(idx) && idx > opts.txtCount) {
      await cf.request("DELETE", `/zones/${zone}/dns_records/${rec.id}`);
      changes.push({ action: "DELETE", detail: `TXT ${rec.name}（超出 --txt-count）` });
    }
  }

  await verifyZoneState(cf, zone, opts, desiredSrv, desiredTxt, desiredA);
  return changes;
}

// 写后校验：重新拉取 zone 现状，与期望状态逐条比对（API 自身读取是强一致的）
async function verifyZoneState(cf, zone, opts, desiredSrv, desiredTxt, desiredA) {
  const problems = [];

  const srvNow = await cf.listRecords(zone, { type: "SRV", name: `${opts.srvName}.${opts.domain}` });
  console.log(`[verify] zone 当前 SRV @${opts.srvName}.${opts.domain}: ${srvNow.length} 条`);
  for (const r of srvNow)
    console.log(`  id=${r.id} prio=${r.data?.priority} weight=${r.data?.weight} port=${r.data?.port} target=${r.data?.target}`);
  const wantSrv = new Map(desiredSrv.map(({ record }) => [srvKey(record.data), record.data.priority]));
  const gotSrv = new Map(srvNow.map((r) => [srvKey(r.data), r.data?.priority]));
  for (const [k, p] of wantSrv)
    if (!gotSrv.has(k)) problems.push(`缺少期望的 SRV ${k}`);
    else if (gotSrv.get(k) !== p) problems.push(`SRV ${k} priority=${gotSrv.get(k)}，期望 ${p}`);
  for (const k of gotSrv.keys()) if (!wantSrv.has(k)) problems.push(`存在多余的 SRV ${k}`);

  const txtNow = (await cf.listRecords(zone, { type: "TXT" })).filter((r) => txtReGlobal(opts).test(r.name));
  console.log(`[verify] zone 当前 TXT(et*): ${txtNow.map((r) => r.name).join(", ")}`);
  const wantTxt = new Map(desiredTxt.map(({ record }) => [record.name.toLowerCase(), record.content]));
  const gotTxt = new Map(txtNow.map((r) => [r.name.toLowerCase(), r.content]));
  for (const [name, content] of wantTxt)
    if (gotTxt.get(name) !== content) problems.push(`TXT ${name} 现为 "${gotTxt.get(name)}"，期望 "${content}"`);
  for (const name of gotTxt.keys()) if (!wantTxt.has(name)) problems.push(`存在多余的 TXT ${name}`);

  const aNow = (await cf.listRecords(zone, { type: "A" })).filter(
    (r) => r.name.startsWith(`${opts.txtPrefix}_`) && r.name.endsWith(`.${opts.domain}`),
  );
  const wantA = new Map(desiredA.map((r) => [r.name, r.content]));
  const gotA = new Map(aNow.map((r) => [r.name, r.content]));
  for (const [name, content] of wantA)
    if (gotA.get(name) !== content) problems.push(`A ${name} 现为 ${gotA.get(name)}，期望 ${content}`);
  for (const name of gotA.keys()) if (!wantA.has(name)) problems.push(`存在多余的 A ${name}`);

  if (problems.length) {
    throw new Error(`写后校验失败（API 报告成功但 zone 状态不符）：\n  ${problems.join("\n  ")}`);
  }
  console.log("[verify] 写后校验通过，zone 状态与期望一致");
}

function txtReGlobal(opts) {
  const escapedDomain = opts.domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${opts.txtPrefix}(?:-(\\d+))?\\.${escapedDomain}$`, "i");
}

// ---------- 输出 ----------

function writeSummary(selected, changes, opts, stats) {
  const rows = selected.map((n, i) => {
    const latency = n.kuma?.medianPing != null && opts.rankBy === "auto"
      ? `${n.kuma.medianPing} ms（上海）`
      : `${n.probeMs?.toFixed(1)} ms（自测）`;
    return `| ${i + 1} | ${n.host}:${n.port} | ${preferredProto(n)} | ${latency} | ${n.sources.join("+")} | ${(n.kuma?.uptime24 != null ? (n.kuma.uptime24 * 100).toFixed(1) + "%" : "-")} |`;
  });
  const md = `## EasyTier DNS 更新 ${new Date().toISOString()}

来源：手动 ${stats.manual} · 状态页 ${stats.kuma} · 合并 ${stats.merged} · 通过筛选 ${stats.passed} · 入选 ${selected.length}

| 名次 | 节点 | 协议 | 延迟 | 来源 | 24h 在线率 |
|---|---|---|---|---|---|
${rows.join("\n")}

**Cloudflare 变更 ${changes.length} 项**
${changes.map((c) => `- \`${c.action}\` ${c.detail}`).join("\n") || "- 无（记录已是最新）"}
`;
  const mask = (s) => String(s).split(opts.domain).join("<domain>");
  const safeMd = mask(md);
  console.log(`\n${safeMd}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, safeMd);
}

function writeLastRun(outFile, opts, selected, changes, allNodes, stats, dryRun) {
  const payload = {
    ranAt: new Date().toISOString(),
    dryRun,
    rankBy: opts.rankBy,
    stats,
    records: {
      srv: `${opts.srvName}.${opts.domain}`,
      primaryTxt: `${opts.txtPrefix}.${opts.domain}`,
      txtSlots: opts.txtCount,
    },
    selected: selected.map((n, i) => {
      const ei = srvEligible(selected).indexOf(n);
      return {
        rank: i + 1,
        host: n.host,
        port: n.port,
        proto: preferredProto(n),
        score: rankScore(n, opts),
        probeMs: n.probeMs,
        kumaPing: n.kuma?.medianPing ?? null,
        uptime24: n.kuma?.uptime24 ?? null,
        sources: n.sources,
        srvPriority: ei >= 0 ? (srvEligible(selected).length - ei) * opts.srvPriorityStep : null,
        txtRecord: i < opts.txtCount ? `${opts.txtPrefix}-${i + 1}.${opts.domain}` : null,
      };
    }),
    changes,
    nodes: allNodes.map((n) => ({
      host: n.host,
      port: n.port,
      protos: n.protos,
      sources: n.sources,
      probeMs: n.probeMs,
      kumaId: n.kumaId,
      kumaName: n.kumaName ?? null,
      uptime24: n.kuma?.uptime24 ?? null,
      excluded: n.excluded ?? null,
    })),
  };
  // 提交进公共仓库的内容同样脱敏（Actions 日志由 console 补丁处理）
  const json = JSON.stringify(payload, null, 2) + "\n";
  writeFileSync(outFile, json.split(opts.domain).join("<domain>"));
  console.log(`[out] 运行结果已写入 ${outFile}`);
}

// ---------- main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.domain) {
    throw new Error("未设置域名：请通过仓库变量/环境变量 CF_DOMAIN 或 --domain 参数指定（必填，无默认值）");
  }
  // 输出脱敏：所有日志（含 GitHub Actions 日志）与输出文件中不出现真实域名
  const rawLog = console.log.bind(console);
  const rawErr = console.error.bind(console);
  const variants = [...new Set([opts.domain, opts.domain.toLowerCase(), opts.domain.toUpperCase()])];
  const mask = (s) => variants.reduce((acc, d) => acc.split(d).join("<domain>"), String(s));
  console.log = (...a) => rawLog(...a.map((x) => (typeof x === "string" ? mask(x) : x)));
  console.error = (...a) => rawErr(...a.map((x) => (typeof x === "string" ? mask(x) : x)));
  console.log(`[run] rank-by=${opts.rankBy} max=${opts.max} txt-count=${opts.txtCount} min-uptime=${opts.minUptime} dry-run=${opts.dryRun}`);

  const manual = parsePeersFile(opts.peersFile);
  let kuma = [];
  if (!opts.skipKuma) {
    try {
      kuma = await loadKuma(opts);
    } catch (err) {
      console.warn(`[warn] 状态页抓取失败（忽略，只用手动节点）: ${err.message}`);
    }
  }
  const merged = mergeNodes(manual, kuma);
  if (!merged.length) throw new Error("没有任何候选节点（peers.txt 与状态页均为空），终止以保护现有 DNS 记录");

  console.log(`[probe] 探测 ${merged.length} 个节点（TCP ×${opts.retries}，超时 ${opts.probeTimeout}ms，并发 ${opts.concurrency}）`);
  await probeAll(merged, opts);
  const alive = merged.filter((n) => n.ok).length;
  console.log(`[probe] 可达 ${alive}/${merged.length}`);

  const selected = selectNodes(merged, opts);
  if (!selected.length) throw new Error("筛选后没有可用节点，终止以保护现有 DNS 记录");

  const token = process.env.CF_API_TOKEN;
  let changes = [];
  if (opts.dryRun) {
    changes = await syncCloudflare(null, opts, selected); // dry-run 内部只打印，不触碰 CF
  } else {
    if (!token) throw new Error("缺少环境变量 CF_API_TOKEN（--dry-run 可不带 token）");
    changes = await syncCloudflare(new Cloudflare(token), opts, selected);
  }
  const stats = { manual: manual.length, kuma: kuma.length, merged: merged.length, passed: merged.filter((n) => !n.excluded).length };
  writeSummary(selected, changes, opts, stats);
  writeLastRun(opts.outFile, opts, selected, changes, merged, stats, opts.dryRun);
  console.log(`[done] ${opts.dryRun ? "dry-run 结束（未写入）" : `Cloudflare 已更新，变更 ${changes.length} 项`}`);
}

main().catch((err) => {
  console.error(`[error] ${err.message}`);
  process.exit(1);
});
