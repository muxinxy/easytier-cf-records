<div align="center">
  <h1 align="center">EasyTier CF Records</h1>
  <p align="center">
    EasyTier 更新 Cloudflare TXT/SRV 记录
  </p>
</div>

## 用法

更新 SRV 记录

```bash
./update_records.sh -y SRV -m 1 -t "DNS Edit API TOKEN" -z "DNS Zone ID" -n _easytier._tcp.et -d example.com -f "peers.txt"
```

更新 TXT 记录

```bash
./update_records.sh -y TXT -m 3 -t "DNS Edit API TOKEN" -z "DNS Zone ID" -n _easytier._tcp.et -d example.com -f "peers.txt"
```

可以配合[cron](https://www.runoob.com/linux/linux-comm-crontab.html)或计划任务等定时更新

## 配置

- EasyTier SRV 记录

```toml
[[peer]]

uri = "srv://et.example.com"
```

- EasyTier TXT 记录

```toml
[[peer]]

uri = "txt://et-1.example.com"

[[peer]]

uri = "txt://et-2.example.com"

[[peer]]

uri = "txt://et-3.example.com"
```
