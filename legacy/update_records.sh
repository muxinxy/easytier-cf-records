#!/bin/bash

## EasyTier SRV 记录用法
# [[peer]]
# uri = "srv://et.example.com"
## EasyTier TXT 记录用法
# [[peer]]
# uri = "txt://et-1.example.com"
# [[peer]]
# uri = "txt://et-2.example.com"
# [[peer]]
# uri = "txt://et-3.example.com"

# --- 默认值 ---
CONNECT_TIMEOUT=1
DEFAULT_TTL=60
DEFAULT_WEIGHT=10 # SRV 记录的默认权重
PRIORITY_START=10 # 起始优先级
PRIORITY_STEP=10  # 优先级递增步长
TEST_RETRIES=3    # 端口测试重试次数
DOMAIN_PREFIX="et" # 为 IP 地址创建的 A 记录前缀
MAX_RECORDS=0     # 默认不限制记录数量
RECORD_TYPE="SRV" # 默认记录类型

# --- 函数定义 ---
usage() {
  echo "用法: $0 -t <API_TOKEN> -z <ZONE_ID> -n <RECORD_NAME> -f <PEERS_FILE> -d <DOMAIN> [-y <RECORD_TYPE>] [-m <MAX_RECORDS>] [-c <TIMEOUT>] [-l <TTL>] [-w <WEIGHT>] [-r <RETRIES>]"
  echo ""
  echo "参数:"
  echo "  -t API_TOKEN     Cloudflare API 令牌"
  echo "  -z ZONE_ID       Cloudflare 区域 ID"
  echo "  -n RECORD_NAME   记录名称 (例如: _minecraft._tcp.et 用于SRV记录)"
  echo "  -f PEERS_FILE    包含服务器列表的文件 (每行 host:port 格式)"
  echo "  -d DOMAIN        主域名 (例如: example.com)"
  echo "  -y RECORD_TYPE   记录类型: SRV 或 TXT (默认: $RECORD_TYPE)"
  echo "  -m MAX_RECORDS   最大记录数量 (默认: $MAX_RECORDS, 0表示不限制)"
  echo "  -c TIMEOUT       连接超时秒数 (默认: $CONNECT_TIMEOUT)"
  echo "  -l TTL           DNS 记录 TTL (默认: $DEFAULT_TTL)"
  echo "  -w WEIGHT        SRV 记录权重 (默认: $DEFAULT_WEIGHT)"
  echo "  -r RETRIES       端口测试重试次数 (默认: $TEST_RETRIES)"
  echo "  -v               启用调试模式"
  echo ""
  echo "示例:"
  echo "  $0 -t YOUR_API_TOKEN -z YOUR_ZONE_ID -n _minecraft._tcp -d example.com -f servers.txt"
  echo "  $0 -t YOUR_API_TOKEN -z YOUR_ZONE_ID -n $DOMAIN_PREFIX -d example.com -f servers.txt -y TXT -m 5"
  exit 1
}

log_info() {
  echo "[INFO] $1" >&2
}

log_warn() {
  echo "[WARNING] $1" >&2
}

log_error() {
  echo "[ERROR] $1" >&2
}

log_debug() {
  if [ "$DEBUG" = "true" ]; then
    echo "[DEBUG] $1" >&2
  fi
}

check_dependency() {
  command -v "$1" >/dev/null 2>&1 || { log_error "缺少依赖: $1 未安装"; exit 1; }
}

# 检查字符串是否为 IP 地址
is_ip_address() {
  local ip="$1"
  # 简单的 IPv4 验证
  if [[ $ip =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
    return 0  # 是 IP 地址
  else
    return 1  # 不是 IP 地址
  fi
}

# 执行 API 请求的函数
cf_api_request() {
  local method="$1"
  local endpoint="$2"
  local data="$3"
  local full_url="https://api.cloudflare.com/client/v4${endpoint}"
  
  if [ -n "$data" ]; then
    curl -s -X "$method" "$full_url" \
      -H "Authorization: Bearer $CF_API_TOKEN" \
      -H "Content-Type: application/json" \
      --data-raw "$data" \
      --write-out "\nHTTP_STATUS_CODE:%{http_code}"
  else
    curl -s -X "$method" "$full_url" \
      -H "Authorization: Bearer $CF_API_TOKEN" \
      -H "Content-Type: application/json" \
      --write-out "\nHTTP_STATUS_CODE:%{http_code}"
  fi
}

# 测试 TCP 端口连接并获取延迟
test_tcp_connection() {
  local host="$1"
  local port="$2"
  local timeout="$3"
  local retries="$4"
  
  local best_latency=999999
  local success=false
  
  for ((attempt=1; attempt<=retries; attempt++)); do
    # 使用 nc (netcat) 测试端口连接
    if command -v nc >/dev/null 2>&1; then
      start_time=$(date +%s.%N)
      if nc -z -w "$timeout" "$host" "$port" &>/dev/null; then
        end_time=$(date +%s.%N)
        current_latency=$(echo "$end_time - $start_time" | bc -l)
        success=true
        # 记录最佳延迟
        if (( $(echo "$current_latency < $best_latency" | bc -l) )); then
          best_latency=$current_latency
        fi
      fi
    else
      # 如果没有 nc，回退到 /dev/tcp
      start_time=$(date +%s.%N)
      { timeout "$timeout" bash -c "exec 3<> /dev/tcp/$host/$port" 2>/dev/null && exec 3>&- 2>/dev/null; } &>/dev/null
      if [ $? -eq 0 ]; then
        end_time=$(date +%s.%N)
        current_latency=$(echo "$end_time - $start_time" | bc -l)
        success=true
        # 记录最佳延迟
        if (( $(echo "$current_latency < $best_latency" | bc -l) )); then
          best_latency=$current_latency
        fi
      fi
    fi
    
    # 如果成功且不是最后一次尝试，等待短暂时间再重试
    if $success && [ $attempt -lt $retries ]; then
      sleep 0.1
    fi
  done
  
  if $success; then
    # 确保延迟非负数
    if (( $(echo "$best_latency < 0" | bc -l) )); then 
      best_latency=0.0
    fi
    echo "$best_latency"
    return 0
  else
    return 1
  fi
}

# 创建 A 记录用于 IP 地址
create_a_record() {
  local zone_id="$1"
  local ip="$2"
  local priority="$3"
  local domain="$4"
  
  local record_name="${DOMAIN_PREFIX}_${priority}.${domain}"
  
  # 检查是否已存在相同的 A 记录
  log_debug "检查 A 记录是否已存在: $record_name -> $ip"
  response=$(cf_api_request "GET" "/zones/$zone_id/dns_records?type=A&name=$record_name")
  status=$(echo "$response" | grep -o "HTTP_STATUS_CODE:[0-9]*" | cut -d':' -f2)
  
  if [ "$status" -ne 200 ]; then
    log_error "检查 A 记录失败 (HTTP 状态: $status)"
    return 1
  fi
  
  # 提取状态码前的 JSON
  json_response=$(echo "$response" | sed '$d')
  record_count=$(echo "$json_response" | jq '.result | length')
  
  # 如果已存在记录，检查是否指向相同 IP
  if [ "$record_count" -gt 0 ]; then
    existing_ip=$(echo "$json_response" | jq -r '.result[0].content')
    record_id=$(echo "$json_response" | jq -r '.result[0].id')
    
    if [ "$existing_ip" = "$ip" ]; then
      log_debug "A 记录已存在且 IP 相同，无需修改: $record_name -> $ip"
      # 只返回记录名称，避免混入调试输出
      echo "$record_name"
      return 0
    else
      # IP 不同，更新记录
      log_debug "更新现有 A 记录: $record_name -> $ip (原 IP: $existing_ip)"
      data=$(jq -n \
        --arg name "$record_name" \
        --arg ip "$ip" \
        --arg ttl "$TTL" \
        '{
          type: "A",
          name: $name,
          content: $ip,
          ttl: ($ttl|tonumber),
          proxied: false
        }')
      
      update_response=$(cf_api_request "PUT" "/zones/$zone_id/dns_records/$record_id" "$data")
      update_status=$(echo "$update_response" | grep -o "HTTP_STATUS_CODE:[0-9]*" | cut -d':' -f2)
      
      if [ "$update_status" -ne 200 ]; then
        log_error "更新 A 记录失败 (HTTP 状态: $update_status)"
        return 1
      fi
      
      # 返回记录名称
      echo "$record_name"
      return 0
    fi
  fi
  
  # 创建新的 A 记录
  log_debug "创建新的 A 记录: $record_name -> $ip"
  data=$(jq -n \
    --arg name "$record_name" \
    --arg ip "$ip" \
    --arg ttl "$TTL" \
    '{
      type: "A",
      name: $name,
      content: $ip,
      ttl: ($ttl|tonumber),
      proxied: false
    }')
  
  create_response=$(cf_api_request "POST" "/zones/$zone_id/dns_records" "$data")
  create_status=$(echo "$create_response" | grep -o "HTTP_STATUS_CODE:[0-9]*" | cut -d':' -f2)
  create_json=$(echo "$create_response" | sed '$d')
  
  if [ "$create_status" -ne 200 ]; then
    error_msg=$(echo "$create_json" | jq -r '.errors[0].message // "未知错误"')
    log_error "创建 A 记录失败 (HTTP 状态: $create_status, 错误: $error_msg)"
    return 1
  fi
  
  # 返回记录名称
  echo "$record_name"
  return 0
}

# 清理不需要的 A 记录
cleanup_a_records() {
  local zone_id="$1"
  local domain="$2"
  local prefix="${DOMAIN_PREFIX}_"
  
  log_info "清理不需要的 A 记录 (前缀: $prefix)..."
  
  # 获取所有可能的 A 记录
  response=$(cf_api_request "GET" "/zones/$zone_id/dns_records?type=A&per_page=100")
  status=$(echo "$response" | grep -o "HTTP_STATUS_CODE:[0-9]*" | cut -d':' -f2)
  
  if [ "$status" -ne 200 ]; then
    log_error "获取 A 记录列表失败 (HTTP 状态: $status)"
    return 1
  fi
  
  # 提取状态码前的 JSON
  json_response=$(echo "$response" | sed '$d')
  
  # 提取所有以特定前缀开头的记录
  # 使用临时文件存储结果，避免复杂的数组处理
  local tmp_file=$(mktemp)
  echo "$json_response" | jq -r --arg prefix "$prefix" --arg domain "$domain" \
    '.result[] | select(.name | contains($prefix) and endswith($domain)) | [.id, .name] | @tsv' > "$tmp_file"
  
  # 检查是否有需要保留的记录
  local to_delete_count=0
  while IFS=$'\t' read -r record_id record_name; do
    # 检查这个记录是否在活跃记录列表中
    if [[ ! " ${ACTIVE_A_RECORDS[*]} " =~ " ${record_name} " ]]; then
      log_debug "将删除无用的 A 记录: $record_name (ID: $record_id)"
      delete_response=$(cf_api_request "DELETE" "/zones/$zone_id/dns_records/$record_id")
      delete_status=$(echo "$delete_response" | grep -o "HTTP_STATUS_CODE:[0-9]*" | cut -d':' -f2)
      
      if [ "$delete_status" -ne 200 ]; then
        log_warn "删除 A 记录 $record_id ($record_name) 失败 (HTTP 状态: $delete_status)"
      else
        ((to_delete_count++))
      fi
    fi
  done < "$tmp_file"
  
  rm -f "$tmp_file"
  
  log_info "清理完成，共删除 $to_delete_count 条无用的 A 记录"
}

# 清理旧备份
cleanup_old_backups() {
  local backup_prefix="cf_dns_backup_"
  local keep_count=7
  
  log_info "清理旧的 DNS 备份记录，保留最新的 $keep_count 份..."
  
  # 列出所有备份文件并按时间排序
  backups=( $(ls -t ${backup_prefix}*.json 2>/dev/null) )
  
  # 如果备份数量超过要保留的数量，则删除旧的备份
  if [ ${#backups[@]} -gt $keep_count ]; then
    log_debug "找到 ${#backups[@]} 个备份文件，将删除 $((${#backups[@]} - keep_count)) 个旧备份"
    for (( i=keep_count; i<${#backups[@]}; i++ )); do
      log_debug "删除旧备份: ${backups[$i]}"
      rm -f "${backups[$i]}"
    done
  else
    log_debug "备份文件数量 (${#backups[@]}) 未超过保留限制 ($keep_count)，无需清理"
  fi
}

# 备份现有 DNS 记录
backup_dns_records() {
  local zone_id="$1"
  local record_name="$2"
  local domain="$3"
  local record_type="$4"
  local backup_file="cf_dns_backup_$(date +%Y%m%d_%H%M%S).json"
  
  log_info "备份当前 DNS 记录到 $backup_file..."
  
  if [ "$record_type" = "SRV" ]; then
    # 备份 SRV 记录
    response=$(cf_api_request "GET" "/zones/$zone_id/dns_records?type=SRV&name=${record_name}.${domain}&per_page=100")
  else # TXT
    # 备份 TXT 记录
    local pattern="${DOMAIN_PREFIX}-"
    response=$(cf_api_request "GET" "/zones/$zone_id/dns_records?type=TXT&per_page=100")
  fi
  
  status=$(echo "$response" | grep -o "HTTP_STATUS_CODE:[0-9]*" | cut -d':' -f2)
  
  if [ "$status" -eq 200 ]; then
    # 去除状态码行并保存 JSON
    echo "$response" | sed '$d' > "$backup_file"
    log_info "成功备份 $record_type 记录。"
    
    # 备份相关的 A 记录
    response=$(cf_api_request "GET" "/zones/$zone_id/dns_records?type=A&per_page=100")
    status=$(echo "$response" | grep -o "HTTP_STATUS_CODE:[0-9]*" | cut -d':' -f2)
    
    if [ "$status" -eq 200 ]; then
      # 提取以特定前缀开头的 A 记录
      echo "$response" | sed '$d' | jq --arg prefix "${DOMAIN_PREFIX}_" --arg domain "$domain" '.result |= map(select(.name | contains($prefix) and endswith($domain)))' >> "$backup_file"
      log_info "成功备份相关 A 记录。"
    else
      log_warn "无法备份相关 A 记录 (HTTP 状态: $status)"
    fi

    # 清理旧备份，仅保留最新的7份
    cleanup_old_backups
    
    return 0
  else
    log_error "无法备份现有记录 (HTTP 状态: $status)"
    return 1
  fi
}

# --- 解析命令行参数 ---
while getopts ":t:z:n:f:d:c:l:w:r:m:y:v" opt; do
  case $opt in
    t) CF_API_TOKEN="$OPTARG" ;;
    z) ZONE_ID="$OPTARG" ;;
    n) RECORD_NAME="$OPTARG" ;;
    f) PEERS_FILE="$OPTARG" ;;
    d) DOMAIN="$OPTARG" ;;
    c) CONNECT_TIMEOUT="$OPTARG" ;;
    l) TTL="$OPTARG" ;;
    w) SRV_WEIGHT="$OPTARG" ;;
    r) TEST_RETRIES="$OPTARG" ;;
    m) MAX_RECORDS="$OPTARG" ;;
    y) RECORD_TYPE="$OPTARG" ;;
    v) DEBUG="true" ;;
    \?) log_error "无效选项: -$OPTARG"; usage ;;
    :) log_error "选项 -$OPTARG 需要参数"; usage ;;
  esac
done

# 验证记录类型
if [ "$RECORD_TYPE" != "SRV" ] && [ "$RECORD_TYPE" != "TXT" ]; then
  log_error "无效的记录类型: $RECORD_TYPE，必须是 SRV 或 TXT"
  usage
fi

# --- 验证必需的参数 ---
if [ -z "$CF_API_TOKEN" ] || [ -z "$ZONE_ID" ] || [ -z "$RECORD_NAME" ] || [ -z "$PEERS_FILE" ] || [ -z "$DOMAIN" ]; then
  log_error "缺少必需参数"
  usage
fi

# 确保最大记录数为整数
if ! [[ "$MAX_RECORDS" =~ ^[0-9]+$ ]]; then
  log_error "最大记录数必须是整数"
  usage
fi

# 设置默认值
TTL=${TTL:-$DEFAULT_TTL}
SRV_WEIGHT=${SRV_WEIGHT:-$DEFAULT_WEIGHT}

# 如果是SRV记录，确保记录名包含前缀下划线
if [ "$RECORD_TYPE" = "SRV" ] && [[ ! "$RECORD_NAME" = _* ]]; then
  log_warn "SRV 记录名称应该以下划线开头，已自动添加"
  RECORD_NAME="_$RECORD_NAME"
fi

# 构建完整的记录名
if [ "$RECORD_TYPE" = "SRV" ]; then
  FULL_RECORD_NAME="${RECORD_NAME}.${DOMAIN}"
else
  FULL_RECORD_NAME="${RECORD_NAME}" # TXT记录的基础名称，后面会添加序号
fi

# --- 检查依赖项 ---
check_dependency "curl"
check_dependency "bc"
check_dependency "jq"
check_dependency "awk"
check_dependency "sort"
check_dependency "timeout"
# 检查 netcat 是否可用（可选）
if command -v nc >/dev/null 2>&1; then
  log_info "将使用 netcat (nc) 进行端口连接测试"
else
  log_info "未检测到 netcat，将使用 /dev/tcp 进行端口连接测试"
fi

# --- 从文件读取服务器列表 ---
if [ ! -f "$PEERS_FILE" ]; then
  log_error "找不到服务器列表文件: $PEERS_FILE"
  exit 1
fi

# 将服务器从文件加载到关联数组
declare -A valid_servers
while IFS=: read -r host port || [[ -n "$host" ]]; do
  # 忽略注释行和空行
  if [[ "$host" =~ ^[[:space:]]*# ]] || [[ -z "$host" ]]; then
    continue
  fi
  
  # 移除前后空格
  host=$(echo "$host" | xargs)
  port=$(echo "$port" | xargs)
  
  # 验证主机和端口
  if [[ -z "$host" ]] || [[ -z "$port" ]]; then
    log_warn "忽略无效行: $host:$port"
    continue
  fi
  
  # 验证端口是数字且在有效范围内
  if ! [[ "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    log_warn "忽略无效端口: $host:$port"
    continue
  fi
  
  valid_servers["$host"]="$port"
done < "$PEERS_FILE"

if [ ${#valid_servers[@]} -eq 0 ]; then
  log_error "服务器列表为空或所有条目无效"
  exit 1
fi

log_info "从文件加载了 ${#valid_servers[@]} 个有效服务器"

# --- 测试延迟并收集结果 ---
log_info "开始测试服务器延迟 (超时: ${CONNECT_TIMEOUT}s, 重试: ${TEST_RETRIES}次)..."

# 使用数组存储成功的结果
declare -a successful_results=()

for host in "${!valid_servers[@]}"; do
    port=${valid_servers[$host]}
    addr="$host:$port"

    echo -n "测试 $addr ... "

    latency=$(test_tcp_connection "$host" "$port" "$CONNECT_TIMEOUT" "$TEST_RETRIES")
    status=$?

    if [ $status -eq 0 ]; then
        latency_ms=$(printf "%.3f" "$(echo "$latency * 1000" | bc -l)")
        echo "成功，延迟: ${latency_ms} ms"
        # 添加结果到数组，确保数据格式一致
        successful_results+=("$(printf "%.9f|%s|%s" "$latency" "$host" "$port")")
    else
        echo "连接失败"
    fi
done

# --- 处理和排序结果 ---
if [ ${#successful_results[@]} -eq 0 ]; then
    log_error "未能成功连接到任何服务器。无法更新 DNS 记录。"
    exit 1
fi

log_debug "成功连接的结果 (${#successful_results[@]} 个):"
if [ "$DEBUG" = "true" ]; then
    printf "  %s\n" "${successful_results[@]}"
fi

# 使用进程替换进行排序
# shellcheck disable=SC2207
sorted_results=($(printf "%s\n" "${successful_results[@]}" | sort -t'|' -k1,1n))

log_debug "排序后的结果:"
if [ "$DEBUG" = "true" ]; then
    printf "  %s\n" "${sorted_results[@]}"
fi

reachable_count=${#sorted_results[@]}
log_info "找到 $reachable_count 个可达服务器，将根据延迟设置优先级。"

# 如果设置了最大记录数，则限制结果数量
if [ "$MAX_RECORDS" -gt 0 ] && [ "$reachable_count" -gt "$MAX_RECORDS" ]; then
    log_info "限制记录数量为 $MAX_RECORDS (原始数量: $reachable_count)"
    # 创建一个新数组仅包含前 MAX_RECORDS 个元素
    declare -a limited_results=()
    for ((i=0; i<MAX_RECORDS; i++)); do
        limited_results+=("${sorted_results[$i]}")
    done
    sorted_results=("${limited_results[@]}")
    reachable_count=$MAX_RECORDS
fi

# --- 更新 Cloudflare 记录 ---

# 1. 备份现有记录
backup_dns_records "$ZONE_ID" "$RECORD_NAME" "$DOMAIN" "$RECORD_TYPE"

# 2. 获取现有的记录并删除
if [ "$RECORD_TYPE" = "SRV" ]; then
    log_info "正在查询并删除现有 SRV 记录..."
    response=$(cf_api_request "GET" "/zones/$ZONE_ID/dns_records?type=SRV&name=$FULL_RECORD_NAME&per_page=100")
else
    log_info "正在查询并删除现有 TXT 记录..."
    # 对于TXT记录，我们需要找到所有et-*.domain.com格式的记录
    response=$(cf_api_request "GET" "/zones/$ZONE_ID/dns_records?type=TXT&per_page=100")
fi

status=$(echo "$response" | grep -o "HTTP_STATUS_CODE:[0-9]*" | cut -d':' -f2)

if [ "$status" -ne 200 ]; then
    log_error "无法获取现有记录 (HTTP 状态: $status)"
    exit 1
fi

# 提取状态码前的 JSON
json_response=$(echo "$response" | sed '$d')

# 处理不同类型的记录
if [ "$RECORD_TYPE" = "SRV" ]; then
    # 使用 jq 检查是否有现有 SRV 记录
    record_count=$(echo "$json_response" | jq '.result | length')
    log_info "找到 $record_count 条现有 SRV 记录"

    # 删除现有的 SRV 记录
    if [ "$record_count" -gt 0 ]; then
        record_ids=($(echo "$json_response" | jq -r '.result[].id'))
        
        for id in "${record_ids[@]}"; do
            log_debug "删除 SRV 记录 ID: $id"
            delete_response=$(cf_api_request "DELETE" "/zones/$ZONE_ID/dns_records/$id")
            delete_status=$(echo "$delete_response" | grep -o "HTTP_STATUS_CODE:[0-9]*" | cut -d':' -f2)
            
            if [ "$delete_status" -ne 200 ]; then
                log_error "删除 SRV 记录 $id 失败 (HTTP 状态: $delete_status)"
                # 继续尝试删除其他记录
            fi
        done
    fi
else
    # 处理 TXT 记录
    # 使用 jq 查找所有以 'et-' 开头并以 domain 结尾的 TXT 记录
    local txt_pattern="${DOMAIN_PREFIX}-"
    txt_records=$(echo "$json_response" | jq -r --arg pattern "$txt_pattern" --arg domain "$DOMAIN" \
                '.result[] | select(.type=="TXT" and .name | startswith($pattern) and endswith($domain)) | [.id, .name] | @tsv')
    
    # 计算记录数量并删除
    record_count=$(echo "$txt_records" | grep -v "^$" | wc -l)
    log_info "找到 $record_count 条现有 TXT 记录"
    
    if [ "$record_count" -gt 0 ]; then
        echo "$txt_records" | while IFS=$'\t' read -r id name; do
            if [ -n "$id" ]; then
                log_debug "删除 TXT 记录: $name (ID: $id)"
                delete_response=$(cf_api_request "DELETE" "/zones/$ZONE_ID/dns_records/$id")
                delete_status=$(echo "$delete_response" | grep -o "HTTP_STATUS_CODE:[0-9]*" | cut -d':' -f2)
                
                if [ "$delete_status" -ne 200 ]; then
                    log_error "删除 TXT 记录 $id ($name) 失败 (HTTP 状态: $delete_status)"
                fi
            fi
        done
    fi
fi

# 3. 存储活跃的 A 记录
declare -a ACTIVE_A_RECORDS=()

# 4. 创建新的记录
if [ "$RECORD_TYPE" = "SRV" ]; then
    log_info "正在创建 $reachable_count 条新的 SRV 记录..."
else
    log_info "正在创建 $reachable_count 条新的 TXT 记录..."
fi

create_failed=0
for ((i=0; i<reachable_count; i++)); do
    result=${sorted_results[$i]}
    latency=$(echo "$result" | cut -d'|' -f1)
    target_host=$(echo "$result" | cut -d'|' -f2)
    target_port=$(echo "$result" | cut -d'|' -f3)
    
    if [ "$RECORD_TYPE" = "SRV" ]; then
        current_prio=$((PRIORITY_START + i * PRIORITY_STEP))
        
        # 检查 target_host 是否为 IP 地址
        if is_ip_address "$target_host"; then
            echo -n "  处理 IP 地址 $target_host ... "
            # 为 IP 地址创建 A 记录，使用命令替换捕获输出避免调试信息混入
            hostname=$(create_a_record "$ZONE_ID" "$target_host" "$current_prio" "$DOMAIN")
            create_status=$?
            if [ $create_status -eq 0 ]; then
                echo "创建 A 记录: $hostname"
                ACTIVE_A_RECORDS+=("$hostname")
                # 将 SRV 目标设置为 A 记录的主机名
                target_host="$hostname"
            else
                echo "创建 A 记录失败，跳过该服务器"
                ((create_failed++))
                continue
            fi
        fi
        
        echo -n "  创建 SRV 记录 $((i+1))/$reachable_count: 优先级 $current_prio, 权重 $SRV_WEIGHT, 端口 $target_port, 目标 $target_host ... "
        
        # 使用 jq 构建 JSON 数据
        data=$(jq -n \
            --arg name "$RECORD_NAME" \
            --arg target "$target_host" \
            --arg ttl "$TTL" \
            --arg weight "$SRV_WEIGHT" \
            --arg port "$target_port" \
            --arg prio "$current_prio" \
            '{
                type: "SRV",
                name: $name,
                data: {
                    priority: ($prio|tonumber),
                    weight: ($weight|tonumber),
                    port: ($port|tonumber),
                    target: $target
                },
                ttl: ($ttl|tonumber)
            }')
    else
        # 创建 TXT 记录
        record_number=$((i + 1))
        txt_record_name="${DOMAIN_PREFIX}-${record_number}.${DOMAIN}"
        txt_content="tcp://${target_host}:${target_port}"
        
        echo -n "  创建 TXT 记录 $record_number/$reachable_count: $txt_record_name 内容: \"$txt_content\" ... "
        
        # 使用 jq 构建 JSON 数据
        data=$(jq -n \
            --arg name "$txt_record_name" \
            --arg content "$txt_content" \
            --arg ttl "$TTL" \
            '{
                type: "TXT",
                name: $name,
                content: $content,
                ttl: ($ttl|tonumber)
            }')
    fi
    
    create_response=$(cf_api_request "POST" "/zones/$ZONE_ID/dns_records" "$data")
    create_status=$(echo "$create_response" | grep -o "HTTP_STATUS_CODE:[0-9]*" | cut -d':' -f2)
    
    # 提取状态码前的 JSON
    create_json=$(echo "$create_response" | sed '$d')
    
    if [ "$create_status" -eq 200 ] && [ "$(echo "$create_json" | jq -r '.success')" = "true" ]; then
        echo "成功"
    else
        echo "失败 (HTTP 状态: $create_status)"
        error_msg=$(echo "$create_json" | jq -r '.errors[0].message // "未知错误"')
        log_error "创建记录错误: $error_msg"
        log_debug "请求数据: $data"
        ((create_failed++))
    fi
done

# 5. 如果是SRV记录，清理不需要的 A 记录
if [ "$RECORD_TYPE" = "SRV" ]; then
    cleanup_a_records "$ZONE_ID" "$DOMAIN"
fi

# --- 总结 ---
log_info "DNS 记录更新处理流程结束。"
if [ $create_failed -gt 0 ]; then
    log_error "有 $create_failed 条记录创建失败。"
    exit 1
else
    log_info "成功：所有 $reachable_count 条可达服务器的记录已创建。"
    exit 0
fi
