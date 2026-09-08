// Campass - 路由器校园网自动登录 (speaks Dr.COM/eportal) (OpenWrt, 多账号)
// 子命令:
//   campass login    读取当前 active 账号并登录(已在线则跳过)
//   campass status   输出 JSON 状态(供 rpcd/LuCI 调用)
//   campass daemon   内置定时器循环, 按 global.interval 保活(procd 拉起, 不用 cron)
//
// 配置来自 UCI /etc/config/campass:
//   config campass 'global'  { enabled, active(账号section名), interval, gateway }
//   config account 'xxx'   { name, student_id, isp, password }

use serde_json::{json, Value};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const TIMEOUT_SECS: u64 = 5;
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) campass-rs/1.0";
const LAST_LOGIN_FILE: &str = "/tmp/campass.lastlogin";
const LOG_FILE: &str = "/tmp/campass.log";
const LOG_MAX_LINES: usize = 300;

struct Global {
    enabled: bool,
    active: String,
    interval: u64,
    gateway: String,
    watchdog: bool,
    ping_host: String,
    watchdog_threshold: u64,
    watchdog_interval: u64,
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

fn load_global() -> Global {
    let gw = uci_get("global", "gateway");
    let ph = uci_get("global", "ping_host");
    Global {
        enabled: uci_get("global", "enabled") == "1",
        active: uci_get("global", "active"),
        interval: uci_get("global", "interval")
            .parse::<u64>()
            .unwrap_or(300)
            .max(30),
        gateway: if gw.is_empty() { "10.0.1.5".into() } else { gw },
        watchdog: uci_get("global", "watchdog") == "1",
        ping_host: if ph.is_empty() { "baidu.com".into() } else { ph },
        watchdog_threshold: uci_get("global", "watchdog_threshold")
            .parse::<u64>()
            .unwrap_or(300)
            .max(60),
        watchdog_interval: uci_get("global", "watchdog_interval")
            .parse::<u64>()
            .unwrap_or(60)
            .max(20),
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
fn http_get(url: &str) -> String {
    minreq::get(url)
        .with_header("User-Agent", UA)
        .with_timeout(TIMEOUT_SECS)
        .send()
        .ok()
        .and_then(|r| r.as_str().map(|s| s.to_string()).ok())
        .unwrap_or_default()
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

/// 追加一行日志到 LOG_FILE(限长 LOG_MAX_LINES), 同时打到 stdout(procd->syslog)
fn log_line(msg: &str) {
    let line = format!("[{}] {}", ts_human(), msg);
    println!("{line}");
    let mut all = std::fs::read_to_string(LOG_FILE).unwrap_or_default();
    all.push_str(&line);
    all.push('\n');
    let lines: Vec<&str> = all.lines().collect();
    let out = if lines.len() > LOG_MAX_LINES {
        let mut s = lines[lines.len() - LOG_MAX_LINES..].join("\n");
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

// ---------------- 登录 ----------------
struct LoginResult {
    online: bool,
    message: String,
    skipped: bool,
}

fn chkstatus(gw: &str) -> Option<Value> {
    parse_jsonp(&http_get(&format!("http://{gw}/drcom/chkstatus?callback=cb")))
}

fn do_login(g: &Global, a: &Account) -> LoginResult {
    let gw = &g.gateway;

    // 1) 在线检测
    if let Some(st) = chkstatus(gw) {
        if is_result1(&st) {
            return LoginResult {
                online: true,
                message: "已在线, 跳过登录".into(),
                skipped: true,
            };
        }
    }

    // 2) v4ip + v6ip
    let v4ip = current_v4ip(gw);
    let v6ip = get_v6ip();

    // 3) 登录, 仅 Auth Server 超时重试 3 次
    let acc = urlencoding::encode(&a.full()).into_owned();
    let pwd = urlencoding::encode(&a.password).into_owned();
    let mut resp = Value::Null;
    for attempt in 0..3 {
        let url = format!(
            "http://{gw}/drcom/login?callback=dr1004&DDDDD={acc}&upass={pwd}&0MKKey=123456\
&R1=0&R2=&R3=0&R6=0&para=00&v4ip={v4ip}&v6ip={v6ip}\
&terminal_type=1&lang=zh-cn&jsVersion=4.2"
        );
        let body = http_get(&url);
        resp = parse_jsonp(&body).unwrap_or(Value::Null);
        let msg = resp.get("msga").and_then(Value::as_str).unwrap_or("");
        if is_result1(&resp) || body.contains("clientip online") {
            break;
        }
        if msg.to_lowercase().contains("imeout") && attempt < 2 {
            std::thread::sleep(Duration::from_secs(3));
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
    } else if msg.is_empty() {
        "登录失败".into()
    } else {
        format!("登录失败: {msg}")
    };

    LoginResult {
        online: ok,
        message,
        skipped: false,
    }
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
/// portal/logout: ac_logout=1 按 IP 强制下线
fn logout_action(g: &Global) {
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
}

/// mac/unbind: 针对当前账号解绑, wlan_user_ip 用整数
fn unbind_action(g: &Global) {
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
}

/// 真实连通性探测: 连打 3 次 ping, 全部成功才算通(同 watchdog.sh)
fn ping_ok(host: &str) -> bool {
    for _ in 0..3 {
        let ok = Command::new("ping")
            .args(["-c", "1", "-W", "2", host])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            return false;
        }
    }
    true
}

// ---------------- 子命令 ----------------
fn cmd_logout() {
    logout_action(&load_global());
}

fn cmd_unbind() {
    unbind_action(&load_global());
}

fn cmd_login() {
    let g = load_global();
    match load_account(&g.active) {
        Some(a) => {
            let r = do_login(&g, &a);
            if r.online && !r.skipped {
                write_last_login(now_ts());
            }
            log_line(&r.message);
        }
        None => log_line(&format!("无有效 active 账号 (global.active={})", g.active)),
    }
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
        "message": if online { "在线" } else { "离线" },
    });
    println!("{out}");
}

const WATCHDOG_STATE: &str = "/tmp/campass-watchdog-ok";

fn read_watchdog_ok() -> u64 {
    std::fs::read_to_string(WATCHDOG_STATE)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}
fn write_watchdog_ok(ts: u64) {
    let _ = std::fs::write(WATCHDOG_STATE, ts.to_string());
}

/// 网络看门狗: 真实连通性持续不通 >= threshold 秒 -> 解绑->注销->登录
/// (移植 watchdog.sh: 5 分钟内一直 ping 不通才恢复, 避免抖动误触)
fn watchdog_tick(g: &Global) {
    let now = now_ts();
    if ping_ok(&g.ping_host) {
        write_watchdog_ok(now);
        return;
    }
    let last_ok = read_watchdog_ok();
    if last_ok == 0 {
        write_watchdog_ok(now); // 首次记录, 开始计时
        return;
    }
    let down = now.saturating_sub(last_ok);
    if down < g.watchdog_threshold {
        log_line(&format!("{} 不通 {}s (<阈值), 继续观察", g.ping_host, down));
        return;
    }
    log_line(&format!(
        "{} 持续不通 {}s, 执行 解绑->注销->登录",
        g.ping_host, down
    ));
    unbind_action(g);
    logout_action(g);
    if let Some(a) = load_account(&g.active) {
        let r = do_login(g, &a);
        if r.online && !r.skipped {
            write_last_login(now_ts());
        }
        log_line(&r.message);
    }
    write_watchdog_ok(now_ts()); // 恢复后重置计时
}

fn cmd_daemon() {
    // 看门狗: 独立频率(watchdog_interval), 与保活解耦
    std::thread::spawn(|| loop {
        let g = load_global();
        if g.enabled && g.watchdog {
            watchdog_tick(&g);
        }
        std::thread::sleep(Duration::from_secs(load_global().watchdog_interval));
    });

    // 保活: 按 interval, 未在线则登录
    loop {
        let g = load_global();
        if g.enabled {
            match load_account(&g.active) {
                Some(a) => {
                    let r = do_login(&g, &a);
                    if r.online && !r.skipped {
                        write_last_login(now_ts());
                    }
                    log_line(&r.message);
                }
                None => log_line("无有效 active 账号, 跳过"),
            }
        }
        std::thread::sleep(Duration::from_secs(load_global().interval));
    }
}

fn cmd_log() {
    let content = std::fs::read_to_string(LOG_FILE).unwrap_or_default();
    println!("{}", json!({ "log": content }));
}

fn cmd_clearlog() {
    let _ = std::fs::write(LOG_FILE, "");
    println!("{}", json!({ "log": "" }));
}

fn main() {
    match std::env::args().nth(1).as_deref().unwrap_or("status") {
        "login" => cmd_login(),
        "logout" => cmd_logout(),
        "unbind" => cmd_unbind(),
        "status" => cmd_status(),
        "daemon" => cmd_daemon(),
        "log" => cmd_log(),
        "clearlog" => cmd_clearlog(),
        other => {
            eprintln!(
                "usage: campass [login|logout|unbind|status|daemon|log|clearlog]  (unknown: {other})"
            );
            std::process::exit(1);
        }
    }
}
