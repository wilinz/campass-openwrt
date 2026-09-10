// Campass - 路由器校园网自动登录 (speaks Dr.COM/eportal) (OpenWrt, 多账号)
// 子命令:
//   campass login          读取当前 active 账号并登录(已在线则跳过)
//   campass switch <sec>   切换到账号 <sec>: 注销旧号 -> 登录新号 -> 探测验证,
//                          验证窗口内 ping/URL 探测看门狗地址失败则自动回滚旧账号
//   campass switchstatus   输出上次/当前切换任务的进度 JSON
//   campass auth           输出保存的认证(登录/注销/解绑)响应记录 JSON
//   campass status         输出 JSON 状态(供 rpcd/LuCI 调用)
//   campass daemon         内置定时器循环, 按 global.interval 保活(procd 拉起, 不用 cron)
//
// 配置来自 UCI /etc/config/campass:
//   config campass 'global'  { enabled, active(账号section名), interval, gateway, switch_timeout }
//   config account 'xxx'   { name, student_id, isp, password }

use serde_json::{json, Value};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const TIMEOUT_SECS: u64 = 5;
/// 登录单独给更长的超时: 实测网关在线时 0s 就回, 但登出后的离线状态下
/// /drcom/login 会明显变慢, 5s 不够, 会被误判成"登录失败"。
const LOGIN_TIMEOUT_SECS: u64 = 15;
/// 注销后等一会儿再登录, 给网关一点状态收敛时间
const POST_LOGOUT_SETTLE: u64 = 3;
/// 登录失败(含空响应)后的重试间隔
const LOGIN_RETRY_GAP: u64 = 3;
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) campass-rs/1.0";
const LAST_LOGIN_FILE: &str = "/tmp/campass.lastlogin";
const LOG_FILE: &str = "/tmp/campass.log";
const LOG_MAX_LINES_DEFAULT: usize = 2000;
/// 上限的上限: 日志要整份经 ubus 送给 LuCI, 太大传不动也没法看
const LOG_MAX_LINES_CAP: usize = 10000;

/// 认证响应存档(登录/注销/解绑的原始返回), 供 LuCI 查看
const AUTH_FILE: &str = "/tmp/campass.auth.json";
const AUTH_MAX: usize = 30;
/// 切换任务的进度文件与互斥锁
const SWITCH_STATE: &str = "/tmp/campass.switch.json";
const SWITCH_LOCK: &str = "/tmp/campass.switch.lock";
/// 锁最长有效期(秒), 超过认为是残留锁
const SWITCH_LOCK_TTL: u64 = 900;
/// 验证阶段两次探测之间的间隔(秒)
const PROBE_INTERVAL: u64 = 5;
/// 登录后先等几秒再探测, 给网络一点建立时间
const PROBE_GRACE: u64 = 3;
/// 看门狗恢复后, 验证连通性的时间窗(秒)
const WATCHDOG_VERIFY_WINDOW: u64 = 20;
/// 单个地址的 TCP 连接超时(秒)。一个域名可能解析出多个 v4/v6 地址,
/// 挨个试, 所以这里给得比整体超时短。
const CONNECT_TIMEOUT: u64 = 3;

struct Global {
    enabled: bool,
    active: String,
    interval: u64,
    gateway: String,
    watchdog: bool,
    watchdog_fails: u64,
    watchdog_interval: u64,
    switch_timeout: u64,
    watchdog_failover: bool,
    probe_urls: Vec<String>,
    probe_family: Family,
}

struct Account {
    name: String,
    student_id: String,
    isp: String,
    password: String,
}

impl Account {
    /// 完整账号 = 学号 + 运营商后缀
    fn full(&self) -> String {
        let suffix = match self.isp.trim() {
            "" | "校园网" | "campus" => String::new(),
            x if x.starts_with('@') => x.to_string(),
            x => format!("@{x}"),
        };
        format!("{}{}", self.student_id.trim(), suffix)
    }

    /// 展示用名字: 备注名优先, 否则用学号
    fn label(&self) -> String {
        if self.name.trim().is_empty() {
            self.full()
        } else {
            self.name.trim().to_string()
        }
    }
}

// ---------------- UCI ----------------
fn uci_get(section: &str, key: &str) -> String {
    Command::new("uci")
        .args(["-q", "get", &format!("campass.{section}.{key}")])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn uci_set(section: &str, key: &str, value: &str) -> bool {
    Command::new("uci")
        .args(["set", &format!("campass.{section}.{key}={value}")])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn uci_commit() {
    let _ = Command::new("uci").args(["commit", "campass"]).status();
}

/// 切换 active 账号并落盘
fn set_active(section: &str) -> bool {
    let ok = uci_set("global", "active", section);
    uci_commit();
    ok
}

fn load_global() -> Global {
    let gw = uci_get("global", "gateway");
    Global {
        enabled: uci_get("global", "enabled") == "1",
        active: uci_get("global", "active"),
        interval: uci_get("global", "interval")
            .parse::<u64>()
            .unwrap_or(300)
            .max(30),
        gateway: if gw.is_empty() { "10.0.1.5".into() } else { gw },
        watchdog: uci_get("global", "watchdog") == "1",
        watchdog_fails: uci_get("global", "watchdog_fails")
            .parse::<u64>()
            .unwrap_or(3)
            .clamp(1, 100),
        watchdog_interval: uci_get("global", "watchdog_interval")
            .parse::<u64>()
            .unwrap_or(120)
            .max(20),
        switch_timeout: uci_get("global", "switch_timeout")
            .parse::<u64>()
            .unwrap_or(120)
            .clamp(30, 600),
        // UCI list: uci get 会把多个值用空格连起来; URL 里不会有空格, 直接切
        // 看门狗恢复时, 当前账号登录/探测都不行就换列表里其他账号(封号/欠费自救)
        watchdog_failover: uci_get("global", "watchdog_failover") != "0",
        probe_urls: {
            let raw = uci_get("global", "probe_url");
            let list: Vec<String> = raw.split_whitespace().map(str::to_string).collect();
            if list.is_empty() {
                // 默认 https + http 各一条: https 防门户劫持,
                // http 兜底(有些网络会把 443 直接掐掉)
                vec![
                    "https://www.baidu.com".to_string(),
                    "https://www.qq.com".to_string(),
                ]
            } else {
                list
            }
        },
        probe_family: Family::from_uci(&uci_get("global", "probe_family")),
    }
}

fn load_account(section: &str) -> Option<Account> {
    if section.is_empty() {
        return None;
    }
    let student_id = uci_get(section, "student_id");
    if student_id.is_empty() {
        return None;
    }
    Some(Account {
        name: uci_get(section, "name"),
        student_id,
        isp: uci_get(section, "isp"),
        password: uci_get(section, "password"),
    })
}

// ---------------- HTTP ----------------
fn http_get_timeout(url: &str, timeout: u64) -> String {
    minreq::get(url)
        .with_header("User-Agent", UA)
        .with_timeout(timeout)
        .send()
        .ok()
        // 用 lossy 而不是 as_str(): 网关的错误页可能是 GBK, as_str() 会直接
        // 判失败返回空串, 那样记录里看到的"空响应"就分不清是网络挂了还是编码问题
        .map(|r| String::from_utf8_lossy(r.as_bytes()).into_owned())
        .unwrap_or_default()
}

fn http_get(url: &str) -> String {
    http_get_timeout(url, TIMEOUT_SECS)
}

/// 解析 JSONP: `dr1004({...})` -> serde_json::Value
fn parse_jsonp(body: &str) -> Option<Value> {
    let start = body.find('(')? + 1;
    let end = body.rfind(')')?;
    if start > end {
        return None;
    }
    serde_json::from_str(body[start..end].trim()).ok()
}

fn is_result1(v: &Value) -> bool {
    v.get("result").and_then(|x| x.as_i64()) == Some(1)
}

// ---------------- 工具 ----------------
fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn write_last_login(ts: u64) {
    let _ = std::fs::write(LAST_LOGIN_FILE, ts.to_string());
}

fn read_last_login() -> u64 {
    std::fs::read_to_string(LAST_LOGIN_FILE)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// 人类可读时间戳(借 date 命令, 跟随系统时区)
fn ts_human() -> String {
    Command::new("date")
        .arg("+%F %T")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| now_ts().to_string())
}

/// 日志上限(行), 取自 UCI, 进程内只读一次。
/// log_line 调用频繁, 每写一行都 fork 一次 uci 太浪费; 改了配置会触发 procd
/// reload(init 里 reload_service 是 stop+start), 新值随守护进程重启生效。
fn log_max_lines() -> usize {
    static CACHE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| {
        uci_get("global", "log_max_lines")
            .parse::<usize>()
            .unwrap_or(LOG_MAX_LINES_DEFAULT)
            .clamp(50, LOG_MAX_LINES_CAP)
    })
}

/// 追加一行日志到 LOG_FILE(限长 log_max_lines), 同时打到 stdout(procd->syslog)
fn log_line(msg: &str) {
    let line = format!("[{}] {}", ts_human(), msg);
    println!("{line}");
    let mut all = std::fs::read_to_string(LOG_FILE).unwrap_or_default();
    all.push_str(&line);
    all.push('\n');
    let max = log_max_lines();
    let lines: Vec<&str> = all.lines().collect();
    let out = if lines.len() > max {
        let mut s = lines[lines.len() - max..].join("\n");
        s.push('\n');
        s
    } else {
        all
    };
    let _ = std::fs::write(LOG_FILE, out);
}

/// best-effort 取第一个 global IPv6, 冒号 URL 编码
fn get_v6ip() -> String {
    Command::new("ip")
        .args(["-6", "addr", "show", "scope", "global"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .and_then(|t| {
            t.lines()
                .filter_map(|l| l.trim().strip_prefix("inet6 ").map(str::to_string))
                .find_map(|r| r.split('/').next().map(str::to_string))
        })
        .map(|ip| urlencoding::encode(&ip).into_owned())
        .unwrap_or_default()
}

// ---------------- 认证响应存档 ----------------
/// 保存一条认证交互的原始响应(不含密码: 只存返回体, 不存请求 URL)
fn record_auth(action: &str, section: &str, account: &str, ok: bool, message: &str, raw: &str) {
    let mut arr: Vec<Value> = std::fs::read_to_string(AUTH_FILE)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
        .unwrap_or_default();
    let raw = raw.trim();
    arr.insert(
        0,
        json!({
            "ts": now_ts(),
            "time": ts_human(),
            "action": action,
            "section": section,
            "account": account,
            "ok": ok,
            "message": message,
            "raw": raw,
            "parsed": parse_jsonp(raw)
                .or_else(|| serde_json::from_str::<Value>(raw).ok())
                .unwrap_or(Value::Null),
        }),
    );
    arr.truncate(AUTH_MAX);
    let _ = std::fs::write(AUTH_FILE, serde_json::to_string(&arr).unwrap_or_default());
}

// ---------------- 登录 ----------------
struct LoginResult {
    online: bool,
    message: String,
    skipped: bool,
    raw: String,
}

fn chkstatus(gw: &str) -> Option<Value> {
    parse_jsonp(&http_get(&format!("http://{gw}/drcom/chkstatus?callback=cb")))
}

/// force=true 时跳过"已在线"检测, 强制发登录请求(切换账号必须强制,
/// 否则旧账号残留在线会让新账号的登录被跳过)
fn do_login(g: &Global, a: &Account, force: bool) -> LoginResult {
    let gw = &g.gateway;

    // 1) 在线检测
    if !force {
        if let Some(st) = chkstatus(gw) {
            if is_result1(&st) {
                return LoginResult {
                    online: true,
                    message: "已在线, 跳过登录".into(),
                    skipped: true,
                    raw: String::new(),
                };
            }
        }
    }

    // 2) v4ip + v6ip
    let v4ip = current_v4ip(gw);
    let v6ip = get_v6ip();

    // 3) 登录, 仅 Auth Server 超时重试 3 次
    let acc = urlencoding::encode(&a.full()).into_owned();
    let pwd = urlencoding::encode(&a.password).into_owned();
    let mut resp = Value::Null;
    let mut raw = String::new();
    for attempt in 0..3 {
        let url = format!(
            "http://{gw}/drcom/login?callback=dr1004&DDDDD={acc}&upass={pwd}&0MKKey=123456\
&R1=0&R2=&R3=0&R6=0&para=00&v4ip={v4ip}&v6ip={v6ip}\
&terminal_type=1&lang=zh-cn&jsVersion=4.2"
        );
        let body = http_get_timeout(&url, LOGIN_TIMEOUT_SECS);
        resp = parse_jsonp(&body).unwrap_or(Value::Null);
        raw = body.clone();
        let msg = resp.get("msga").and_then(Value::as_str).unwrap_or("");
        if is_result1(&resp) || body.contains("clientip online") {
            break;
        }
        // 空响应 = 请求超时/连不上, 恰恰最该重试:
        // 实测登出后网关会短暂不响应 /drcom/login, 不重试就会误判成账号有问题
        let transient = body.trim().is_empty() || msg.to_lowercase().contains("imeout");
        if transient && attempt < 2 {
            log_line(&format!(
                "登录无响应或超时, {}s 后重试 ({}/3)",
                LOGIN_RETRY_GAP,
                attempt + 2
            ));
            std::thread::sleep(Duration::from_secs(LOGIN_RETRY_GAP));
            continue;
        }
        break;
    }

    let ok = is_result1(&resp);
    let msg = resp
        .get("msga")
        .or_else(|| resp.get("msg"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let message = if ok {
        format!("登录成功 ({})", a.name)
    } else if !msg.is_empty() {
        format!("登录失败: {msg}")
    } else if raw.trim().is_empty() {
        "登录失败: 网关无响应(重试 3 次仍超时)".into()
    } else {
        format!("登录失败: 网关返回 {}", raw.trim())
    };

    LoginResult {
        online: ok,
        message,
        skipped: false,
        raw,
    }
}

/// 登录并按需存档 + 记日志 + 更新 last_login
fn login_and_record(g: &Global, section: &str, a: &Account, action: &str, force: bool) -> LoginResult {
    let r = do_login(g, a, force);
    if r.online && !r.skipped {
        write_last_login(now_ts());
    }
    if !r.skipped {
        record_auth(action, section, &a.full(), r.online, &r.message, &r.raw);
    }
    log_line(&r.message);
    r
}

/// 取当前 v4ip: chkstatus 的 ss5, 取不到再从门户首页抠
fn current_v4ip(gw: &str) -> String {
    let mut v4ip = chkstatus(gw)
        .and_then(|st| st.get("ss5").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    if v4ip.is_empty() {
        let home = http_get(&format!("http://{gw}/"));
        if let Some(i) = home.find("ss5=\"") {
            let rest = &home[i + 5..];
            if let Some(j) = rest.find('"') {
                v4ip = rest[..j].to_string();
            }
        }
    }
    v4ip
}

/// 点分 IPv4 -> 大端整数(mac/unbind 的 wlan_user_ip 要整数)
fn ip_to_int(ip: &str) -> u32 {
    let mut n: u32 = 0;
    for part in ip.split('.') {
        n = (n << 8) | part.parse::<u32>().unwrap_or(0);
    }
    n
}

// ---------------- 动作 ----------------
struct ActionResult {
    ok: bool,
    message: String,
    raw: String,
}

/// portal/logout: ac_logout=1 按 IP 强制下线
fn logout_action(g: &Global) -> ActionResult {
    let v4ip = current_v4ip(&g.gateway);
    let url = format!(
        "http://{gw}:801/eportal/portal/logout?callback=dr1003&login_method=0\
&user_account=drcom&user_password=123&ac_logout=1&register_mode=1\
&wlan_user_ip={v4ip}&wlan_vlan_id=1&wlan_user_mac=000000000000&jsVersion=4.2&v=1000&lang=zh",
        gw = g.gateway
    );
    let body = http_get(&url);
    let ok = parse_jsonp(&body).map(|v| is_result1(&v)).unwrap_or(false)
        || body.contains("\"result\":1");
    let msg = if ok {
        "登出成功".to_string()
    } else {
        format!("登出结果: {}", body.trim())
    };
    log_line(&msg);
    ActionResult {
        ok,
        message: msg,
        raw: body,
    }
}

/// mac/unbind: 针对当前账号解绑, wlan_user_ip 用整数
fn unbind_action(g: &Global) -> ActionResult {
    let account = load_account(&g.active).map(|a| a.full()).unwrap_or_default();
    let v4ip = current_v4ip(&g.gateway);
    let url = format!(
        "http://{gw}:801/eportal/portal/mac/unbind?callback=dr1002\
&user_account={acc}&wlan_user_mac=000000000000&wlan_user_ip={ipint}&jsVersion=4.2&v=1000&lang=zh",
        gw = g.gateway,
        acc = urlencoding::encode(&account),
        ipint = ip_to_int(&v4ip)
    );
    let body = http_get(&url);
    let ok = parse_jsonp(&body).map(|v| is_result1(&v)).unwrap_or(false)
        || body.contains("\"result\":1");
    let msg = if ok {
        format!("解绑成功 ({account})")
    } else {
        format!("解绑结果: {}", body.trim())
    };
    log_line(&msg);
    ActionResult {
        ok,
        message: msg,
        raw: body,
    }
}

// ---------------- 连通性探测 ----------------
/// 上次连通的地址缓存(host:port -> addr), 避免每次都从头试
const ADDR_CACHE: &str = "/tmp/campass.addr";

fn cached_addr(key: &str) -> Option<String> {
    std::fs::read_to_string(ADDR_CACHE).ok()?.lines().find_map(|l| {
        l.split_once('\t')
            .filter(|(k, _)| *k == key)
            .map(|(_, v)| v.to_string())
    })
}

fn cache_addr(key: &str, addr: &str) {
    let mut out: Vec<String> = std::fs::read_to_string(ADDR_CACHE)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.starts_with(&format!("{key}\t")))
        .map(str::to_string)
        .collect();
    out.push(format!("{key}\t{addr}"));
    // 只留最近若干条, 免得 /tmp 里越积越多
    let start = out.len().saturating_sub(16);
    let _ = std::fs::write(ADDR_CACHE, out[start..].join("\n"));
}

/// 解析出所有候选地址, 上次探测成功的那个排最前。
/// 必须逐个试到"整条探测走通"为止, 而不是"连上就算":
/// 实测校园网的 IPv6 出口是黑洞——TCP 握手能成, 数据却发不出去,
/// 只要连上就返回的话, TLS 会卡到超时, 后面能用的 v4 地址根本轮不到。
/// 而 DNS 每次返回的地址顺序还会轮换, 于是表现为时好时坏。
fn candidate_addrs(host: &str, port: u16) -> Vec<std::net::SocketAddr> {
    use std::net::ToSocketAddrs;
    let mut addrs: Vec<std::net::SocketAddr> = (host, port)
        .to_socket_addrs()
        .map(|it| it.collect())
        .unwrap_or_default();
    if let Some(p) = cached_addr(&format!("{host}:{port}")) {
        if let Some(i) = addrs.iter().position(|a| a.to_string() == p) {
            addrs.swap(0, i);
        }
    }
    addrs
}

/// 探测限定的地址族: 全都试 / 只试 v4 / 只试 v6
#[derive(Clone, Copy, PartialEq)]
enum Family {
    Any,
    V4,
    V6,
}

impl Family {
    fn accepts(&self, a: &std::net::SocketAddr) -> bool {
        match self {
            Family::Any => true,
            Family::V4 => a.is_ipv4(),
            Family::V6 => a.is_ipv6(),
        }
    }

    /// UCI 值 -> Family; 认不出的一律当 any(别因为配置写错就判成断网)
    fn from_uci(s: &str) -> Family {
        match s.trim() {
            "v4" => Family::V4,
            "v6" => Family::V6,
            _ => Family::Any,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Family::Any => "any",
            Family::V4 => "v4",
            Family::V6 => "v6",
        }
    }

    /// 展示文案, 进日志和 LuCI
    fn label(&self) -> &'static str {
        match self {
            Family::Any => "IPv4/IPv6",
            Family::V4 => "仅 IPv4",
            Family::V6 => "仅 IPv6",
        }
    }
}

fn connect_addr(addr: &std::net::SocketAddr) -> Option<std::net::TcpStream> {
    std::net::TcpStream::connect_timeout(addr, Duration::from_secs(CONNECT_TIMEOUT)).ok()
}

/// 拆 probe_url -> (是否 https, host, port, path)。没写协议时按 https 处理。
fn parse_probe_url(u: &str) -> (bool, String, u16, String) {
    let (https, rest) = match (u.strip_prefix("https://"), u.strip_prefix("http://")) {
        (Some(r), _) => (true, r),
        (_, Some(r)) => (false, r),
        _ => (true, u),
    };
    let (hostport, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let default_port = if https { 443 } else { 80 };
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            (h.to_string(), p.parse().unwrap_or(default_port))
        }
        _ => (hostport.to_string(), default_port),
    };
    (https, host, port, path.to_string())
}

/// 未认证时网关会劫持 http 把页面换成门户, 这种"有响应"不算通
fn looks_hijacked(body: &str, gw: &str) -> bool {
    let low = body.to_lowercase();
    // 网关配置里可能带端口(host:port), 比对时只用主机部分
    let gw_host = gw.split(':').next().unwrap_or(gw);
    (!gw_host.is_empty() && body.contains(gw_host))
        || low.contains("drcom")
        || low.contains("eportal")
}

// ---- 回退实现: 手写 TLS ClientHello, 只验证对端真会说 TLS ----
// 编译时开了 tls feature 就用 rustls 做完整证书校验(见下面 tls_verified_probe);
// 没开时(比如 aws-lc 编不过的架构)退到这里: 门户只能回明文 http,
// 伪造不出合法 ServerHello, 所以仍挡得住 http 劫持, 但挡不住 TLS 中间人。
#[cfg(not(feature = "tls"))]
fn push_ext(out: &mut Vec<u8>, kind: u16, data: &[u8]) {
    out.extend_from_slice(&kind.to_be_bytes());
    out.extend_from_slice(&(data.len() as u16).to_be_bytes());
    out.extend_from_slice(data);
}

#[cfg(not(feature = "tls"))]
fn tls_client_hello(sni: &str) -> Vec<u8> {
    let mut ext = Vec::new();

    // server_name: 门户若想冒充, SNI 对不上就露馅
    let host = sni.as_bytes();
    let mut sni_data = Vec::new();
    sni_data.extend_from_slice(&((host.len() + 3) as u16).to_be_bytes());
    sni_data.push(0x00); // host_name
    sni_data.extend_from_slice(&(host.len() as u16).to_be_bytes());
    sni_data.extend_from_slice(host);
    push_ext(&mut ext, 0x0000, &sni_data);
    // supported_groups: x25519, secp256r1, secp384r1
    push_ext(&mut ext, 0x000a, &[0x00, 0x06, 0x00, 0x1d, 0x00, 0x17, 0x00, 0x18]);
    // ec_point_formats: uncompressed
    push_ext(&mut ext, 0x000b, &[0x01, 0x00]);
    // signature_algorithms
    push_ext(
        &mut ext,
        0x000d,
        &[0x00, 0x08, 0x04, 0x03, 0x04, 0x01, 0x08, 0x04, 0x02, 0x01],
    );

    let mut body = Vec::new();
    body.extend_from_slice(&[0x03, 0x03]); // client_version = TLS 1.2
    // random: 不做真握手, 拿时间戳凑够 32 字节即可
    let seed = now_ts();
    for i in 0..32u64 {
        body.push(((seed >> (i % 8 * 8)) as u8) ^ (i as u8).wrapping_mul(31));
    }
    body.push(0x00); // session_id 长度 0
    let suites: [u16; 6] = [0xc02f, 0xc02b, 0xc030, 0xc02c, 0x009c, 0x002f];
    body.extend_from_slice(&((suites.len() * 2) as u16).to_be_bytes());
    for c in suites {
        body.extend_from_slice(&c.to_be_bytes());
    }
    body.extend_from_slice(&[0x01, 0x00]); // 压缩方法: null
    body.extend_from_slice(&(ext.len() as u16).to_be_bytes());
    body.extend_from_slice(&ext);

    let mut hs = vec![0x01]; // handshake type: client_hello
    hs.extend_from_slice(&(body.len() as u32).to_be_bytes()[1..]); // 3 字节长度
    hs.extend_from_slice(&body);

    let mut rec = vec![0x16, 0x03, 0x01]; // handshake record, legacy version
    rec.extend_from_slice(&(hs.len() as u16).to_be_bytes());
    rec.extend_from_slice(&hs);
    rec
}

/// https 探测(无 tls feature 时): 发 ClientHello, 看对面是否回 TLS 记录
#[cfg(not(feature = "tls"))]
fn tls_probe(host: &str, port: u16, fam: Family) -> bool {
    use std::io::{Read, Write};

    let hello = tls_client_hello(host);
    for addr in candidate_addrs(host, port) {
        if !fam.accepts(&addr) {
            continue;
        }
        let mut sock = match connect_addr(&addr) {
            Some(s) => s,
            None => continue,
        };
        let _ = sock.set_read_timeout(Some(Duration::from_secs(TIMEOUT_SECS)));
        let _ = sock.set_write_timeout(Some(Duration::from_secs(TIMEOUT_SECS)));
        if sock.write_all(&hello).is_err() {
            continue;
        }
        let mut buf = [0u8; 8];
        let mut got = 0;
        while got < buf.len() {
            match sock.read(&mut buf[got..]) {
                Ok(0) => break,
                Ok(n) => got += n,
                Err(_) => break,
            }
        }
        if got < 6 {
            continue;
        }
        // 0x16=handshake(ServerHello 即 buf[5]==0x02), 0x15=alert;
        // 两者都证明对端真在说 TLS, 而不是门户塞回来的 http 页面
        let tls_ver_ok = buf[1] == 0x03;
        if (buf[0] == 0x16 && tls_ver_ok && buf[5] == 0x02) || (buf[0] == 0x15 && tls_ver_ok) {
            cache_addr(&format!("{host}:{port}"), &addr.to_string());
            return true;
        }
    }
    false
}

/// https 探测(开了 tls feature): rustls 完整握手 + 证书链校验(webpki 根证书),
/// 再发一个 GET 确认拿到的是真 HTTP 响应。门户即使劫持 443, 也过不了证书校验。
#[cfg(feature = "tls")]
fn tls_verified_probe(host: &str, port: u16, path: &str, fam: Family) -> bool {
    use std::io::{Read, Write};
    use std::sync::Arc;

    let server_name = match rustls_pki_types::ServerName::try_from(host.to_string()) {
        Ok(n) => n,
        Err(_) => return false,
    };
    // 配置只建一次并常驻: rustls 默认带内存会话缓存, 复用配置才复用得上 TLS 会话。
    // 每次重建等于每次都走全握手 —— 要重新下整条证书链再验一遍, 实测占了单次探测
    // 流量的大头(HEAD 之后仍有 ~13.8KB)。daemon 是长驻进程, 后续探测可走简化握手。
    // 顺带省掉每次克隆整个根证书表和重复的链校验开销。
    static TLS_CFG: std::sync::OnceLock<Arc<rustls::ClientConfig>> = std::sync::OnceLock::new();
    let config = TLS_CFG
        .get_or_init(|| {
            let roots = rustls::RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };
            Arc::new(
                rustls::ClientConfig::builder()
                    .with_root_certificates(roots)
                    .with_no_client_auth(),
            )
        })
        .clone();

    // 用 HEAD 而不是 GET: 判据只看回没回一行 "HTTP/..." 状态行, body 一个字节都不需要。
    // 发 GET 的话服务器会照常推首页, 虽然我们读满 16 字节就断开, 但在断开前已经有
    // 一整个初始拥塞窗口的数据发出来了 —— 实测每次探测白下 ~16KB, 换成 HEAD 只剩握手。
    // 即便某些服务器对 HEAD 回 405 也无妨: 判据是"有没有合法 HTTP 响应", 不看状态码。
    let req = format!(
        "HEAD {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: {UA}\r\nConnection: close\r\n\r\n"
    );
    for addr in candidate_addrs(host, port) {
        if !fam.accepts(&addr) {
            continue;
        }
        let mut sock = match connect_addr(&addr) {
            Some(s) => s,
            None => continue,
        };
        let _ = sock.set_read_timeout(Some(Duration::from_secs(TIMEOUT_SECS)));
        let _ = sock.set_write_timeout(Some(Duration::from_secs(TIMEOUT_SECS)));

        // 每个地址要用全新的 ClientConnection
        let mut conn = match rustls::ClientConnection::new(config.clone(), server_name.clone()) {
            Ok(c) => c,
            Err(_) => return false,
        };
        let mut tls = rustls::Stream::new(&mut conn, &mut sock);
        // 写入即触发握手; 证书校验不过这里就会报错
        if tls.write_all(req.as_bytes()).is_err() || tls.flush().is_err() {
            continue;
        }
        let mut buf = [0u8; 16];
        let mut got = 0;
        while got < buf.len() {
            match tls.read(&mut buf[got..]) {
                Ok(0) => break,
                Ok(n) => got += n,
                Err(_) => break,
            }
        }
        if buf[..got].starts_with(b"HTTP/") {
            cache_addr(&format!("{host}:{port}"), &addr.to_string());
            return true;
        }
    }
    false
}

/// http 探测: 内建 HTTP 请求(不调 curl/wget), 还要排除门户劫持
fn http_probe(url: &str, gw: &str) -> bool {
    match minreq::get(url)
        .with_header("User-Agent", UA)
        .with_timeout(TIMEOUT_SECS)
        .send()
    {
        Ok(r) => {
            let body = r.as_str().unwrap_or("");
            let loc = r.headers.get("location").map(String::as_str).unwrap_or("");
            !looks_hijacked(body, gw) && !looks_hijacked(loc, gw)
        }
        Err(_) => false,
    }
}

/// URL 探测: https 走 TLS 校验, http 只能退回内容特征判断(弱, 可被门户伪造)
fn url_ok(probe: &str, gw: &str, fam: Family) -> bool {
    let (https, host, port, path) = parse_probe_url(probe);
    if host.is_empty() {
        return false;
    }
    if !https {
        let _ = fam;
        return http_probe(probe, gw);
    }
    #[cfg(feature = "tls")]
    {
        let _ = gw;
        tls_verified_probe(&host, port, &path, fam)
    }
    #[cfg(not(feature = "tls"))]
    {
        let _ = path;
        tls_probe(&host, port, fam)
    }
}

/// 这个二进制是否带完整证书校验(编译期决定), 供状态展示
fn tls_verify_enabled() -> bool {
    cfg!(feature = "tls")
}

/// 探测目标的展示文案; 限定了地址族就标出来, 免得日志里看不出
/// "不通"是真断网还是只因为限死了一族
fn probe_desc(g: &Global) -> String {
    let urls = g.probe_urls.join(" / ");
    match g.probe_family {
        Family::Any => urls,
        f => format!("{urls} ({})", f.label()),
    }
}

/// 单次探测: 只认 https。
/// 为什么不用 ping / http: 认证网关会代答 ICMP(实测 ping 保留地址 192.0.2.1
/// 都能通), 也会劫持明文 http 返回门户页 —— 两者都能伪造出"网络正常"的假象,
/// 一旦被骗过, 账号切换失败时就不会回滚。只有带证书校验的 https 伪造不了。
fn probe_once(g: &Global) -> (bool, String) {
    for u in &g.probe_urls {
        if !u.trim_start().starts_with("https://") {
            continue; // 非 https 条目一律不算数
        }
        // 默认 v4 / v6 都在候选里, 任一地址整条走通即算连通;
        // probe_family 限定后只试那一族(另一族不可用时能少等一轮超时)
        if url_ok(u, &g.gateway, g.probe_family) {
            return (true, u.clone());
        }
    }
    (false, String::new())
}

/// 按地址族分别探测每个 URL, 供 `campass probe` 展示(定位 v4/v6 单边故障)。
/// 并发跑: 串行的话, 每个走不通的地址族都要耗掉一次连接/读超时,
/// 目标一多就要十几秒, LuCI 上点一下等太久。
fn probe_report(g: &Global) -> Vec<Value> {
    // 限定了地址族就只探那一族: 报告要跟看门狗的判据一致, 否则这里显示
    // "v4 通"而实际判定是不通, 反倒误导; 顺带省掉另一族那次注定失败的超时。
    // 没探的那族输出 null, 跟"探了, 不通"(false)区分开。
    let want4 = g.probe_family != Family::V6;
    let want6 = g.probe_family != Family::V4;
    std::thread::scope(|scope| {
        let jobs: Vec<_> = g
            .probe_urls
            .iter()
            .map(|u| {
                if !u.trim_start().starts_with("https://") {
                    return (u, None);
                }
                let v4 = want4.then(|| scope.spawn(move || url_ok(u, &g.gateway, Family::V4)));
                let v6 = want6.then(|| scope.spawn(move || url_ok(u, &g.gateway, Family::V6)));
                (u, Some((v4, v6)))
            })
            .collect();

        jobs.into_iter()
            .map(|(u, handles)| match handles {
                None => json!({ "url": u, "skipped": "非 https, 不计入判定" }),
                Some((h4, h6)) => {
                    let v4 = h4.map(|h| h.join().unwrap_or(false));
                    let v6 = h6.map(|h| h.join().unwrap_or(false));
                    let ok = v4.unwrap_or(false) || v6.unwrap_or(false);
                    json!({ "url": u, "v4": v4, "v6": v6, "ok": ok })
                }
            })
            .collect()
    })
}



// ---------------- 账号切换 ----------------
fn switch_running() -> bool {
    std::fs::read_to_string(SWITCH_LOCK)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|ts| now_ts().saturating_sub(ts) < SWITCH_LOCK_TTL)
        .unwrap_or(false)
}

fn write_switch_state(v: Value) {
    let _ = std::fs::write(SWITCH_STATE, v.to_string());
}

fn read_switch_state() -> Value {
    std::fs::read_to_string(SWITCH_STATE)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({ "state": "idle" }))
}

/// 切到 `to` 账号, 并在 switch_timeout 秒内反复探测看门狗地址;
/// 探测始终失败(或新账号登录失败)则回滚到 `from` 账号。
fn do_switch(to: &str) {
    let g = load_global();
    let from = g.active.clone();
    let from_acc = load_account(&from);
    let from_name = from_acc.as_ref().map(|a| a.label()).unwrap_or_else(|| from.clone());
    let from_full = from_acc.as_ref().map(|a| a.full()).unwrap_or_default();

    let to_acc = match load_account(to) {
        Some(a) => a,
        None => {
            write_switch_state(json!({
                "state": "failed",
                "from": from, "from_name": from_name,
                "to": to, "to_name": to,
                "started": now_ts(), "updated": now_ts(), "elapsed": 0,
                "message": format!("目标账号无效或未填学号: {to}"),
            }));
            log_line(&format!("切换失败: 目标账号无效 ({to})"));
            return;
        }
    };

    let started = now_ts();
    let deadline = started + g.switch_timeout;
    let base = json!({
        "from": from,
        "from_name": from_name,
        "to": to,
        "to_name": to_acc.label(),
        "account": to_acc.full(),
        "started": started,
        "deadline": deadline,
        "timeout": g.switch_timeout,
        "probe_urls": g.probe_urls,
        "probe_desc": probe_desc(&g),
    });
    let put = |state: &str, msg: &str| {
        let mut v = base.clone();
        v["state"] = json!(state);
        v["message"] = json!(msg);
        v["updated"] = json!(now_ts());
        v["elapsed"] = json!(now_ts().saturating_sub(started));
        write_switch_state(v);
    };

    if from == to {
        put("ok", "目标账号即当前账号, 无需切换");
        return;
    }

    log_line(&format!(
        "切换账号: {from_name} ({from}) -> {} ({to})",
        to_acc.label()
    ));

    // 1) 旧账号下线: 解绑 -> 注销
    put("running", "正在注销旧账号");
    let r = unbind_action(&g);
    record_auth("switch-unbind", &from, &from_full, r.ok, &r.message, &r.raw);
    let r = logout_action(&g);
    record_auth("switch-logout", &from, &from_full, r.ok, &r.message, &r.raw);
    std::thread::sleep(Duration::from_secs(POST_LOGOUT_SETTLE));

    // 2) 切 active 并登录新账号(强制, 不因残留在线而跳过)
    if !set_active(to) {
        put("failed", "写入 UCI active 失败");
        log_line("切换失败: 写入 UCI active 失败");
        return;
    }
    let g2 = load_global();
    put("running", &format!("正在登录新账号 {}", to_acc.full()));
    let lr = login_and_record(&g2, to, &to_acc, "switch-login", true);
    if !lr.online {
        rollback(&g2, &from, &from_name, &format!("新账号登录失败: {}", lr.message), &put);
        return;
    }

    // 3) 验证窗口内反复探测看门狗地址
    put(
        "verifying",
        &format!(
            "登录成功, {}s 内探测 {} 验证连通性",
            g2.switch_timeout,
            probe_desc(&g2)
        ),
    );
    std::thread::sleep(Duration::from_secs(PROBE_GRACE));

    let mut how = String::new();
    while now_ts() < deadline {
        let (ok, method) = probe_once(&g2);
        if ok {
            how = method;
            break;
        }
        let left = deadline.saturating_sub(now_ts());
        put(
            "verifying",
            &format!("探测 {} 均失败, 剩余 {}s", probe_desc(&g2), left),
        );
        if left == 0 {
            break;
        }
        std::thread::sleep(Duration::from_secs(PROBE_INTERVAL.min(left.max(1))));
    }

    if how.is_empty() {
        rollback(
            &g2,
            &from,
            &from_name,
            &format!(
                "切换后 {}s 内探测 {} 均失败",
                g2.switch_timeout,
                probe_desc(&g2)
            ),
            &put,
        );
    } else {
        let msg = format!(
            "切换成功: 已使用 {} ({}), {} 探测通过 ({})",
            to_acc.label(),
            to_acc.full(),
            probe_desc(&g2),
            how
        );
        put("ok", &msg);
        log_line(&msg);
    }
}

/// 回滚: 把 active 改回旧账号并重新登录, 结果写进切换状态
fn rollback<F: Fn(&str, &str)>(g: &Global, from: &str, from_name: &str, reason: &str, put: &F) {
    log_line(&format!("{reason}; 回滚到 {from_name} ({from})"));
    put("rolling_back", &format!("{reason}; 正在回滚到 {from_name}"));

    // 新账号下线, 避免两个号都挂着
    let cur_full = load_account(&g.active).map(|a| a.full()).unwrap_or_default();
    let r = unbind_action(g);
    record_auth("rollback-unbind", &g.active, &cur_full, r.ok, &r.message, &r.raw);
    let r = logout_action(g);
    record_auth("rollback-logout", &g.active, &cur_full, r.ok, &r.message, &r.raw);
    std::thread::sleep(Duration::from_secs(POST_LOGOUT_SETTLE));

    if !set_active(from) {
        let msg = format!("{reason}; 回滚失败: 写回 UCI active 出错");
        put("failed", &msg);
        log_line(&msg);
        return;
    }
    let g_old = load_global();
    match load_account(from) {
        Some(a) => {
            let lr = login_and_record(&g_old, from, &a, "rollback-login", true);
            let (net_ok, how) = probe_once(&g_old);
            let msg = format!(
                "{reason}; 已回滚到 {from_name} ({}): {}; 回滚后探测 {} {}",
                a.full(),
                lr.message,
                probe_desc(&g_old),
                if net_ok {
                    format!("通过 ({how})")
                } else {
                    "仍不通".to_string()
                }
            );
            put("rolled_back", &msg);
            log_line(&msg);
        }
        None => {
            let msg = format!("{reason}; 已把 active 改回 {from}, 但该账号无效, 未能登录");
            put("rolled_back", &msg);
            log_line(&msg);
        }
    }
}

// ---------------- 子命令 ----------------
fn cmd_logout() {
    let g = load_global();
    let r = logout_action(&g);
    let acc = load_account(&g.active).map(|a| a.full()).unwrap_or_default();
    record_auth("logout", &g.active, &acc, r.ok, &r.message, &r.raw);
}

fn cmd_unbind() {
    let g = load_global();
    let r = unbind_action(&g);
    let acc = load_account(&g.active).map(|a| a.full()).unwrap_or_default();
    record_auth("unbind", &g.active, &acc, r.ok, &r.message, &r.raw);
}

fn cmd_login() {
    let g = load_global();
    match load_account(&g.active) {
        Some(a) => {
            login_and_record(&g, &g.active, &a, "login", false);
        }
        None => log_line(&format!("无有效 active 账号 (global.active={})", g.active)),
    }
}

fn cmd_switch(to: &str) {
    if switch_running() {
        eprintln!("{}", json!({ "error": "另一个切换任务正在进行" }));
        std::process::exit(1);
    }
    let _ = std::fs::write(SWITCH_LOCK, now_ts().to_string());
    do_switch(to);
    let _ = std::fs::remove_file(SWITCH_LOCK);
    println!("{}", cmd_switchstatus_value());
}

/// 手动跑一次连通性探测, 排查探测目标配得对不对
/// 会话信息: chkstatus 的完整解析结果 + 当前账号, 供 LuCI"会话"页显示。
/// 换算(字节->MB、分->元、秒->时)放到界面做, 引擎只负责取数与透传原始字段。
fn cmd_session() {
    let g = load_global();
    let raw = http_get(&format!("http://{}/drcom/chkstatus?callback=cb", g.gateway));
    let fields = parse_jsonp(&raw).unwrap_or(Value::Null);
    let online = fields.as_object().map(|_| is_result1(&fields)).unwrap_or(false);
    let (name, full) = load_account(&g.active)
        .map(|a| (a.label(), a.full()))
        .unwrap_or_default();
    println!(
        "{}",
        json!({
            "online": online,
            "active": g.active,
            "account_name": name,
            "account": full,
            "fields": fields,
        })
    );
}

fn cmd_probe() {
    let g = load_global();
    let (ok, how) = probe_once(&g);
    println!(
        "{}",
        json!({
            "ok": ok,
            "method": how,
            "probe_urls": g.probe_urls,
            // detail 始终分族报, 便于定位单边故障; family 说明判定实际认哪族
            "family": g.probe_family.as_str(),
            "family_label": g.probe_family.label(),
            "detail": probe_report(&g),
            "tls_verify": tls_verify_enabled(),
        })
    );
}

fn cmd_switchstatus_value() -> Value {
    let mut v = read_switch_state();
    if let Some(o) = v.as_object_mut() {
        o.insert("running".into(), json!(switch_running()));
        o.insert("now".into(), json!(now_ts()));
    }
    v
}

fn cmd_switchstatus() {
    println!("{}", cmd_switchstatus_value());
}

fn cmd_auth() {
    let arr: Value = std::fs::read_to_string(AUTH_FILE)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!([]));
    println!("{}", json!({ "records": arr }));
}

fn cmd_clearauth() {
    let _ = std::fs::write(AUTH_FILE, "[]");
    println!("{}", json!({ "records": [] }));
}

/// 按配置顺序列出所有有效账号的 section 名
fn account_sections() -> Vec<String> {
    let out = Command::new("uci")
        .args(["-q", "show", "campass"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    out.lines()
        .filter_map(|line| {
            // campass.main=account
            let (lhs, rhs) = line.split_once('=')?;
            if rhs.trim().trim_matches('\'') != "account" {
                return None;
            }
            let sec = lhs.trim().strip_prefix("campass.")?.to_string();
            load_account(&sec).map(|_| sec)
        })
        .collect()
}

fn cmd_accounts() {
    let g = load_global();
    let list: Vec<Value> = account_sections()
        .into_iter()
        .filter_map(|sec| {
            let a = load_account(&sec)?;
            Some(json!({
                "section": sec,
                "name": a.name,
                "label": a.label(),
                "account": a.full(),
                "active": sec == g.active,
            }))
        })
        .collect();
    println!("{}", json!({ "accounts": list, "active": g.active }));
}

fn cmd_status() {
    let g = load_global();
    let acc = load_account(&g.active);
    let st = chkstatus(&g.gateway);
    let online = st.as_ref().map(is_result1).unwrap_or(false);
    let uid = st
        .as_ref()
        .and_then(|v| v.get("uid").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    let ip = st
        .as_ref()
        .and_then(|v| v.get("ss5").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    let (name, full) = acc
        .map(|a| (a.name.clone(), a.full()))
        .unwrap_or_default();

    let out = json!({
        "enabled": g.enabled,
        "active": g.active,
        "account_name": name,
        "account": full,
        "online": online,
        "uid": uid,
        "ip": ip,
        "last_login": read_last_login(),
        "switching": switch_running(),
        "tls_verify": tls_verify_enabled(),
        "message": if online { "在线" } else { "离线" },
    });
    println!("{out}");
}

/// 连续探测失败次数; 探测一通即清零
const WATCHDOG_STATE: &str = "/tmp/campass-watchdog-fails";

fn read_fail_count() -> u64 {
    std::fs::read_to_string(WATCHDOG_STATE)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}
fn write_fail_count(n: u64) {
    let _ = std::fs::write(WATCHDOG_STATE, n.to_string());
}

/// 登录后在 window 秒内反复探测, 确认真的能上网
/// 从登录响应里嗅探"明确欠费"。只用于快速否决(跳过 20s 探测直接换下一个号),
/// 绝不用于放行 —— 判据不命中时仍老老实实探测。
///
/// 权威依据(见 10.0.1.5 门户 a41.js): 官方客户端判"在线"只看 result==1,
/// 根本不解析 ufee/oltime 这些字段 —— 它们只是成功页/注销页上给人看的显示项,
/// 所以"能不能上网"的地面真值只能靠探测。这里唯一敢做否决的是 ufee: 它是
/// 欠费金额(分), 语义无歧义(在线好号的页面 fee='0'), 命中即确定欠费。
/// oltime/olflow 之类不敢用来否决 —— 样本太少, 万一误判会把好号也跳过。
fn arrears_reason(raw: &str) -> Option<String> {
    let v = parse_jsonp(raw)?;
    match v.get("ufee").and_then(Value::as_i64) {
        Some(fee) if fee > 0 => Some(format!("欠费 {:.2} 元 (ufee={fee})", fee as f64 / 100.0)),
        _ => None,
    }
}

fn verify_connectivity(g: &Global, window: u64) -> bool {
    std::thread::sleep(Duration::from_secs(PROBE_GRACE));
    let deadline = now_ts() + window;
    loop {
        if probe_once(g).0 {
            return true;
        }
        if now_ts() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_secs(PROBE_INTERVAL));
    }
}

/// 用指定账号登录并验证是否真能上网
fn try_account(g: &Global, sec: &str, action: &str) -> bool {
    match load_account(sec) {
        Some(a) => {
            let r = login_and_record(g, sec, &a, action, true);
            if !r.online {
                return false;
            }
            // 登录成功不等于能上网: 欠费/封号常照样返回 result=1。
            // 响应里若有明确欠费特征, 快速否决(不等 20s 探测); 否则仍探测。
            if let Some(why) = arrears_reason(&r.raw) {
                log_line(&format!("{} ({}) 登录成功但{}, 判为不可用", a.label(), sec, why));
                return false;
            }
            verify_connectivity(g, WATCHDOG_VERIFY_WINDOW)
        }
        None => false,
    }
}

/// 网络看门狗: 连续 watchdog_fails 次探测都不通 -> 解绑->注销->登录。
/// 按次数而不是按秒计: 探测本来就是按周期跑的, 用秒还要跟探测间隔做除法取整,
/// 间隔一旦大于阈值, 阈值就形同虚设 —— 按次数则所见即所得。
fn watchdog_tick(g: &Global) {
    if probe_once(g).0 {
        write_fail_count(0);
        return;
    }
    let n = read_fail_count() + 1;
    write_fail_count(n);
    if n < g.watchdog_fails {
        log_line(&format!(
            "{} 不通 (连续第 {} 次, 满 {} 次才恢复)",
            probe_desc(g),
            n,
            g.watchdog_fails
        ));
        return;
    }
    log_line(&format!(
        "{} 连续 {} 次探测失败, 执行 解绑->注销->登录",
        probe_desc(g),
        n
    ));
    let cur_full = load_account(&g.active).map(|a| a.full()).unwrap_or_default();
    let r = unbind_action(g);
    record_auth("watchdog-unbind", &g.active, &cur_full, r.ok, &r.message, &r.raw);
    let r = logout_action(g);
    record_auth("watchdog-logout", &g.active, &cur_full, r.ok, &r.message, &r.raw);
    std::thread::sleep(Duration::from_secs(POST_LOGOUT_SETTLE));

    // 1) 先用当前账号恢复
    if try_account(g, &g.active, "watchdog-login") {
        log_line("看门狗: 当前账号恢复成功");
        write_fail_count(0);
        return;
    }

    if !g.watchdog_failover {
        log_line("看门狗: 当前账号恢复失败(未开启账号故障转移)");
        write_fail_count(0);
        return;
    }

    // 2) 当前账号登录不上或登了也上不了网(封号/欠费/改密码), 依次试其他账号
    let original = g.active.clone();
    for sec in account_sections() {
        if sec == original {
            continue;
        }
        let label = load_account(&sec).map(|a| a.label()).unwrap_or_else(|| sec.clone());
        log_line(&format!("看门狗: 当前账号恢复失败, 改用 {label} ({sec}) 重试"));
        if !set_active(&sec) {
            continue;
        }
        let g2 = load_global();
        if try_account(&g2, &sec, "failover-login") {
            log_line(&format!("看门狗: 已自动切换到 {label} ({sec}) 并恢复联网"));
            write_fail_count(0);
            return;
        }
    }

    // 3) 全都不行, 把 active 还原, 免得配置停在一个随机账号上
    set_active(&original);
    log_line("看门狗: 所有账号均无法恢复联网, 已还原为原账号");
    write_fail_count(0); // 重置计数
}

fn cmd_daemon() {
    // 看门狗: 独立频率(watchdog_interval), 与保活解耦
    std::thread::spawn(|| loop {
        let g = load_global();
        // 切换任务进行中时让路: 它自己会注销/登录/回滚
        if g.enabled && g.watchdog && !switch_running() {
            watchdog_tick(&g);
        }
        std::thread::sleep(Duration::from_secs(load_global().watchdog_interval));
    });

    // 保活: 按 interval, 未在线则登录
    loop {
        let g = load_global();
        if g.enabled && !switch_running() {
            match load_account(&g.active) {
                Some(a) => {
                    login_and_record(&g, &g.active, &a, "keepalive", false);
                }
                None => log_line("无有效 active 账号, 跳过"),
            }
        }
        std::thread::sleep(Duration::from_secs(load_global().interval));
    }
}

fn cmd_log() {
    let content = std::fs::read_to_string(LOG_FILE).unwrap_or_default();
    // max 一并给出去: LuCI 那句"最多 N 行"的提示照着它写, 免得两边各写一个数
    println!(
        "{}",
        json!({ "log": content, "max": log_max_lines() })
    );
}

fn cmd_clearlog() {
    let _ = std::fs::write(LOG_FILE, "");
    println!("{}", json!({ "log": "" }));
}

fn main() {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_else(|| "status".into());
    match cmd.as_str() {
        "login" => cmd_login(),
        "logout" => cmd_logout(),
        "unbind" => cmd_unbind(),
        "status" => cmd_status(),
        "daemon" => cmd_daemon(),
        "log" => cmd_log(),
        "clearlog" => cmd_clearlog(),
        "accounts" => cmd_accounts(),
        "auth" => cmd_auth(),
        "clearauth" => cmd_clearauth(),
        "switchstatus" => cmd_switchstatus(),
        "probe" => cmd_probe(),
        "session" => cmd_session(),
        // 手动跑一次看门狗检查(平时由 daemon 按 watchdog_interval 调度)
        "watchdog" => {
            let g = load_global();
            watchdog_tick(&g);
            cmd_switchstatus();
        }
        "switch" => match args.next() {
            Some(sec) if !sec.is_empty() => cmd_switch(&sec),
            _ => {
                eprintln!("usage: campass switch <account-section>");
                std::process::exit(1);
            }
        },
        other => {
            eprintln!(
                "usage: campass [login|logout|unbind|switch <sec>|switchstatus|probe|session|watchdog|status|accounts|auth|clearauth|daemon|log|clearlog]  (unknown: {other})"
            );
            std::process::exit(1);
        }
    }
}
