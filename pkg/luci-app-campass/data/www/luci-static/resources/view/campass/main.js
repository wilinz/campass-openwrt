'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require poll';
'require dom';
'require ui';

var callStatus       = rpc.declare({ object: 'campass', method: 'status' });
var callLogin        = rpc.declare({ object: 'campass', method: 'login' });
var callLogout       = rpc.declare({ object: 'campass', method: 'logout' });
var callUnbind       = rpc.declare({ object: 'campass', method: 'unbind' });
var callLog          = rpc.declare({ object: 'campass', method: 'log' });
var callClearLog     = rpc.declare({ object: 'campass', method: 'clearlog' });
var callSwitch       = rpc.declare({ object: 'campass', method: 'switch', params: [ 'section' ] });
var callSwitchStatus = rpc.declare({ object: 'campass', method: 'switchstatus' });
var callProbe        = rpc.declare({ object: 'campass', method: 'probe' });
var callSession      = rpc.declare({ object: 'campass', method: 'session' });
var callAuth         = rpc.declare({ object: 'campass', method: 'auth' });
var callClearAuth    = rpc.declare({ object: 'campass', method: 'clearauth' });

// 页面私有样式: 集中在这里, 避免每个元素都挂一长串 inline style
var CSS = '' +
'.cps-card { display:flex; flex-direction:column; gap:10px }' +
'.cps-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:15px }' +
'.cps-badge { padding:2px 10px; border-radius:12px; color:#fff; font-weight:600; font-size:12px;' +
	' white-space:nowrap }' +
'.cps-meta { display:flex; gap:16px; flex-wrap:wrap; opacity:.72; font-size:12px }' +
'.cps-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap }' +
// 主题给 button 定了 display:block, 优先级高过浏览器默认的 [hidden]{display:none},
// 于是 .hidden=true 的按钮照样显示(会话信息页签下的"清空"就是这么冒出来的)
'.cps-bar button[hidden] { display:none }' +
'.cps-bar .cps-spacer { flex:1 1 auto; min-width:0 }' +
'.cps-note { margin:0; opacity:.7; font-size:12px }' +
'.cps-progress { padding:8px 12px; border-radius:4px; border-left:3px solid #2563eb;' +
	' background:rgba(128,128,128,.08) }' +
'.cps-progress.is-warn { border-left-color:#b45309 }' +
'.cps-progress.is-bad { border-left-color:#dc2626 }' +
'.cps-progress.is-good { border-left-color:#16a34a }' +
// 三个页签的内容都是直接顶到 section 底边的, 紧贴着"保存并应用"那条页脚, 补一点空隙
'.cps-top-pane { padding-bottom:16px }' +
// 主题给 .cbi-section 定了 display, 会盖掉浏览器默认的 [hidden]{display:none}
'.cps-top-pane[hidden] { display:none }' +
'.cps-tabs { display:flex; gap:4px; border-bottom:1px solid rgba(128,128,128,.3) }' +
'.cps-tab { padding:6px 14px; cursor:pointer; border:none; background:transparent; color:inherit;' +
	' font-size:13px; border-bottom:2px solid transparent; opacity:.65 }' +
'.cps-tab.is-active { opacity:1; font-weight:600; border-bottom-color:#2563eb }' +
'.cps-pane { max-height:340px; overflow:auto; border:1px solid rgba(128,128,128,.3);' +
	' border-radius:0 0 4px 4px; border-top:none }' +
// 会话信息是定长的十几行, 全部铺开也就一屏, 套个内滚动区反而要滚两层
'.cps-pane.is-full { max-height:none; overflow:visible }' +
'.cps-mono { margin:0; padding:10px; background:transparent; color:inherit; white-space:pre-wrap;' +
	' font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; line-height:1.5 }' +
'.cps-empty { display:block; padding:12px; opacity:.6; font-size:13px }' +
'.cps-rec { border-bottom:1px solid rgba(128,128,128,.2) }' +
'.cps-rec > summary { display:flex; align-items:center; gap:8px; flex-wrap:wrap;' +
	' padding:7px 10px; cursor:pointer; font-size:13px }' +
'.cps-rec > summary::-webkit-details-marker { display:none }' +
'.cps-rec[open] > summary { font-weight:600 }' +
'.cps-dot { width:7px; height:7px; border-radius:50%; flex:none }' +
'.cps-rec-body { padding:0 10px 10px 25px }' +
'.cps-kv { display:grid; grid-template-columns:auto 1fr; gap:0; padding:10px }' +
'.cps-kv > div { padding:6px 12px; border-bottom:1px solid rgba(128,128,128,.15) }' +
'.cps-kv > div:nth-child(4n+1), .cps-kv > div:nth-child(4n+2) { background:rgba(128,128,128,.05) }' +
'.cps-kv .k { font-weight:600; white-space:nowrap; opacity:.85 }';

// 顶部页签, 顺序必须跟 form.Map 里 section 的声明顺序一致。
// 诊断并在"运行状态"里(同一个 section), 所以 TOP_DIAG 就是第 0 页。
var TOP_TABS = [ _('运行状态'), _('全局设置'), _('账号列表') ];
var TOP_DIAG = 0;

function fmtTs(ts) {
	ts = parseInt(ts || 0);
	return ts ? new Date(ts * 1000).toLocaleString() : '-';
}

function badge(text, color) {
	return E('span', { 'class': 'cps-badge', 'style': 'background:' + color }, text);
}

function accountLabel(s) {
	return (s.name ? s.name + ' (' : '') + (s.student_id || s['.name']) + (s.name ? ')' : '');
}

// 运行状态: 一行标题(在线徽章 + 当前账号) + 一行次要信息, 不再用 6 行表格
function renderStatus(st) {
	st = st || {};
	var online  = (st.online === true || st.online === 1);
	var enabled = (st.enabled === true || st.enabled === 1);
	var meta = [
		[ _('公网 IP'), st.ip || '-' ],
		[ _('uid'), st.uid || '-' ],
		[ _('上次登录'), fmtTs(st.last_login) ],
		[ _('自动登录'), enabled ? _('已启用') : _('已停用') ],
		// 编译期决定: 引擎是否带完整证书校验的 URL 探测
		[ _('证书校验'), st.tls_verify ? _('已启用') : _('未编入(回退握手校验)') ]
	];
	return E('div', {}, [
		E('div', { 'class': 'cps-head' }, [
			badge(online ? _('在线') : _('离线'), online ? '#16a34a' : '#dc2626'),
			E('strong', {}, st.account_name || _('未配置')),
			E('span', { 'style': 'opacity:.7' }, st.account || '-')
		]),
		E('div', { 'class': 'cps-meta', 'style': 'margin-top:6px' }, meta.map(function (m) {
			return E('span', {}, m[0] + ': ' + m[1]);
		}))
	]);
}

// 切换任务状态 -> [文案, 颜色, 进度条修饰类]
var SWITCH_STATES = {
	running:      [ '切换中',     '#2563eb', '' ],
	verifying:    [ '验证连通性', '#2563eb', '' ],
	rolling_back: [ '回滚中',     '#b45309', 'is-warn' ],
	ok:           [ '切换成功',   '#16a34a', 'is-good' ],
	rolled_back:  [ '已回滚',     '#b45309', 'is-warn' ],
	failed:       [ '切换失败',   '#dc2626', 'is-bad' ]
};

function isBusy(state) {
	return state === 'running' || state === 'verifying' || state === 'rolling_back';
}

/// 切换进度: 空闲时整块隐藏, 不占版面
///
/// showDone=true 才显示终态(成功/已回滚/失败)。switch.json 会一直留着上次
/// 任务的结果, 页面一打开就贴一条几天前的"已回滚 ... 探测仍不通", 看着像刚
/// 刚失败。所以终态只给本次页面会话自己发起的切换看; 进行中的状态不受限制,
/// 别的终端(或刷新前)发起的切换仍要显示出来。
function renderSwitchState(box, sw, showDone) {
	sw = sw || {};
	var s = SWITCH_STATES[sw.state];
	if (!s || (!isBusy(sw.state) && !showDone)) {
		box.hidden = true;
		return;
	}
	box.hidden = false;
	box.className = 'cps-progress ' + s[2];
	dom.content(box, [
		E('div', { 'class': 'cps-head', 'style': 'font-size:13px' }, [
			badge(_(s[0]), s[1]),
			E('span', {}, (sw.from_name || sw.from || '?') + ' → ' + (sw.to_name || sw.to || '?')),
			E('span', { 'class': 'cps-meta' }, [
				E('span', {}, _('用时') + ' ' + parseInt(sw.elapsed || 0) + 's'),
				sw.probe_host ? E('span', {}, _('探测') + ' ' + sw.probe_host) : ''
			])
		]),
		E('p', { 'class': 'cps-note', 'style': 'margin-top:6px' },
			(isBusy(sw.state) ? '⏳ ' : '') + (sw.message || ''))
	]);
}

var AUTH_ACTIONS = {
	'login':            '登录',
	'keepalive':        '保活登录',
	'logout':           '注销',
	'unbind':           '解绑',
	'switch-login':     '切换·新账号登录',
	'switch-logout':    '切换·注销旧号',
	'switch-unbind':    '切换·解绑旧号',
	'rollback-login':   '回滚·旧账号登录',
	'rollback-logout':  '回滚·注销',
	'rollback-unbind':  '回滚·解绑',
	'watchdog-login':   '看门狗·登录',
	'failover-login':   '看门狗·换账号登录',
	'watchdog-logout':  '看门狗·注销',
	'watchdog-unbind':  '看门狗·解绑'
};

// 认证响应: 一条一行(点开才展开原始响应), 用小圆点表示成败, 比整块彩色徽章安静
function renderAuth(records) {
	records = records || [];
	if (!records.length)
		return E('em', { 'class': 'cps-empty' }, _('(暂无认证响应记录)'));

	return E('div', {}, records.map(function (r) {
		var ok = (r.ok === true || r.ok === 1);
		var parsed = '';
		try { parsed = r.parsed ? JSON.stringify(r.parsed, null, 2) : ''; } catch (e) {}
		return E('details', { 'class': 'cps-rec' }, [
			E('summary', {}, [
				E('span', { 'class': 'cps-dot', 'style': 'background:' + (ok ? '#16a34a' : '#dc2626') }),
				E('span', {}, _(AUTH_ACTIONS[r.action] || r.action || '-')),
				E('span', { 'class': 'cps-meta' }, [
					E('span', {}, r.time || fmtTs(r.ts)),
					r.account ? E('span', {}, r.account) : ''
				])
			]),
			E('div', { 'class': 'cps-rec-body' }, [
				E('p', { 'class': 'cps-note', 'style': 'margin-bottom:4px' }, r.message || ''),
				E('pre', { 'class': 'cps-mono', 'style': 'padding:8px;border:1px solid rgba(128,128,128,.3);border-radius:4px' },
					(r.raw || _('(空响应)')) + (parsed ? '\n\n' + _('解析后') + ':\n' + parsed : ''))
			])
		]);
	}));
}

// ---- 会话信息换算(纯展示) ----
var U32_MAX = 4294967295;  // 0xFFFFFFFF, drcom 里表示"不限/无上限"

function fmtBytes(n) {
	n = Number(n);
	if (!isFinite(n) || n < 0) return '-';
	if (n === U32_MAX) return _('不限');
	var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
	while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
	return (i === 0 ? n : n.toFixed(2)) + ' ' + u[i];
}

function fmtDuration(sec) {
	sec = Number(sec);
	if (!isFinite(sec) || sec < 0) return '-';
	if (sec === U32_MAX) return _('不限');
	var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600),
	    m = Math.floor(sec % 3600 / 60);
	var out = [];
	if (d) out.push(d + _('天'));
	if (h) out.push(h + _('小时'));
	if (m || !out.length) out.push(m + _('分'));
	return out.join('');
}

var ISP = { '0': _('校园网/未分配'), '1': _('电信'), '2': _('移动'), '3': _('联通'), '4': _('桂林广电') };
var ZXOPT = {
	'1': _('普通'), '2': _('专线(不可用)'), '4': _('专线(不可用)'),
	'5': _('专线(不可用)'), '6': _('专线(可用)'), '9': _('专线(可用)')
};

function renderSession(sess) {
	sess = sess || {};
	var f = sess.fields || {};
	var online = (sess.online === true || sess.online === 1);
	if (!online || !f || typeof f !== 'object')
		return E('em', { 'class': 'cps-empty' },
			online ? _('(网关未返回会话信息)') : _('(当前离线, 无会话信息)'));

	var fee = Number(f.fee);
	var feeStr = isFinite(fee) ? (fee / 100).toFixed(2) + ' ' + _('元') : '-';
	// 累计上下行: nd1/nu1 优先, 退回 actdf/actuf
	var down = (f.nd1 != null ? f.nd1 : f.actdf);
	var up   = (f.nu1 != null ? f.nu1 : f.actuf);

	var rows = [
		[_('账号'),        sess.account || f.uid || '-'],
		[_('欠费'),        feeStr, isFinite(fee) && fee > 0 ? '#dc2626' : ''],
		[_('运营商'),      ISP[String(f.ispid)] || ('ispid=' + f.ispid)],
		[_('剩余时长'),    fmtDuration(f.oltime)],
		[_('剩余流量'),    fmtBytes(f.olflow)],
		[_('本次在线'),    fmtDuration(f.actt)],
		[_('本次/累计下行'), fmtBytes(f.actdf) + ' / ' + fmtBytes(down)],
		[_('本次/累计上行'), fmtBytes(f.actuf) + ' / ' + fmtBytes(up)],
		[_('套餐(NID)'),   (f.NID === '' || f.NID == null) ? _('(空)') : String(f.NID)],
		[_('专线状态'),    ZXOPT[String(f.zxopt)] || ('zxopt=' + f.zxopt)],
		[_('IPv4'),        f.v4ip || f.ss5 || '-'],
		[_('IPv6'),        (f.v6ip && f.v6ip !== '0000:0000:0000:0000:0000:0000:0000:0000') ? f.v6ip : '-'],
		[_('在线序号'),    f.aolno != null ? String(f.aolno) : '-']
	];
	var grid = E('div', { 'class': 'cps-kv' });
	rows.forEach(function (r) {
		grid.appendChild(E('div', { 'class': 'k' }, r[0]));
		grid.appendChild(E('div', r[2] ? { 'style': 'color:' + r[2] + ';font-weight:600' } : {},
			'' + r[1]));
	});
	return grid;
}

return view.extend({
	load: function () {
		return Promise.all([
			uci.load('campass'),
			uci.load('firewall').catch(function () {}),
			callStatus().catch(function () { return {}; }),
			callLog().catch(function () { return {}; }),
			callSwitchStatus().catch(function () { return {}; }),
			callAuth().catch(function () { return {}; }),
			callSession().catch(function () { return {}; })
		]);
	},

	render: function (data) {
		var self = this;
		var st = (data && data[2]) || {};
		var logText = (data && data[3] && data[3].log) || '';
		var sw0 = (data && data[4]) || {};
		var auth0 = (data && data[5] && data[5].records) || [];
		var sess0 = (data && data[6]) || {};
		var curActive = st.active || '';   // 引擎侧的当前账号(切换后由 status 刷新)

		var statusBox = E('div', {}, renderStatus(st));
		var switchBox = E('div', { 'hidden': true });
		// 本次页面会话有没有亲自发起过切换; 决定终态结果要不要留在页面上
		var ownSwitch = false;
		renderSwitchState(switchBox, sw0);

		// ---------------- 诊断面板: 会话 / 日志 / 认证响应 三个页签 ----------------
		var sessBox = E('div', {}, renderSession(sess0));
		var logBox  = E('pre', { 'class': 'cps-mono' }, logText.trim() || _('(暂无日志)'));
		var authBox = E('div', {}, renderAuth(auth0));

		function refreshSession() {
			return callSession().then(function (r) {
				dom.content(sessBox, renderSession(r || {}));
			}).catch(function () {});
		}
		var logSeen = false;   // 日志面板是否已经露过面(决定要不要强制拉到底)
		function refreshLog() {
			return callLog().then(function (r) {
				// 日志是追加的, 最新一行在最底下。贴着底就跟着滚,
				// 用户往上翻查旧记录时别把视图抢回去(每 10s 一次 poll)。
				var pane = logBox.parentNode;
				// 第一次显示要强制落到底: 此时 scrollTop 还是 0, 按"贴底"判会得 false,
				// 于是停在几百行之前的开头, 最新的反而要手动滚下去找。
				var atBottom = !pane || !logSeen ||
					pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 4;
				dom.content(logBox, (r && r.log ? r.log.trim() : '') || _('(暂无日志)'));
				if (pane && atBottom) pane.scrollTop = pane.scrollHeight;
				if (pane && pane.clientHeight) logSeen = true;   // 隐藏时高度为 0, 不算露面
			}).catch(function () {});
		}
		function refreshAuth() {
			return callAuth().then(function (r) {
				dom.content(authBox, renderAuth((r && r.records) || []));
			}).catch(function () {});
		}

		function refreshSwitch() {
			return callSwitchStatus().then(function (r) {
				renderSwitchState(switchBox, r || {}, ownSwitch);
				return r || {};
			}).catch(function () { return {}; });
		}

		// type=button: 免得在 form 里被当成提交按钮
		// 连通性自检: 跑的就是看门狗那套判据(含 probe_family 限定), 逐个 URL 分族报,
		// 便于定位单边故障
		function runProbe() {
			ui.showModal(_('测试连通性'), [
				E('p', { 'class': 'spinning' }, _('探测中... (有地址族不通时要等超时, 可能十几秒)'))
			]);
			return callProbe().then(function (r) {
				r = r || {};
				// 限定了地址族时引擎只探那一族, 另一族回 null; 列表跟着只列探过的
				var fams = [
					{ key: 'v4', label: 'IPv4' },
					{ key: 'v6', label: 'IPv6' }
				].filter(function (f) {
					return !r.family || r.family === 'any' || r.family === f.key;
				});
				var rows = (r.detail || []).map(function (d) {
					if (d.skipped)
						return E('tr', { 'class': 'tr' }, [
							E('td', { 'class': 'td left' }, d.url),
							E('td', { 'class': 'td left', 'colspan': fams.length },
								E('em', {}, d.skipped))
						]);
					return E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td left' }, d.url)
					].concat(fams.map(function (f) {
						var v = d[f.key];
						return E('td', { 'class': 'td left' }, (v === null || v === undefined)
							? E('em', { 'style': 'opacity:.6' }, _('未探测'))
							: badge(v ? _('通') : _('不通'), v ? '#16a34a' : '#dc2626'));
					})));
				});
				ui.showModal(_('测试连通性'), [
					E('p', { 'class': 'cps-head' }, [
						badge(r.ok ? _('连通') : _('不通'), r.ok ? '#16a34a' : '#dc2626'),
						E('span', {}, r.ok ? (_('命中') + ' ' + (r.method || '')) : _('所有目标均不通')),
						E('span', { 'class': 'cps-note' },
							r.tls_verify ? _('已启用证书校验') : _('未编入证书校验(回退握手校验)'))
					]),
					E('table', { 'class': 'table', 'style': 'margin-top:10px' }, [
						E('tr', { 'class': 'tr table-titles' }, [
							E('th', { 'class': 'th left' }, _('探测地址'))
						].concat(fams.map(function (f) {
							return E('th', { 'class': 'th left' }, f.label);
						})))
					].concat(rows)),
					E('p', { 'class': 'cps-note', 'style': 'margin-top:8px' },
						// 这里跑的就是看门狗那套判据, 限定了地址族就只探那一族
						(r.family && r.family !== 'any')
							? _('已按“探测地址族”限定为') + ' ' + (r.family_label || r.family) +
							  ', ' + _('仅探测该族; 仅 https 条目计入判定。')
							: _('任一地址族通过即判定为连通; 仅 https 条目计入判定。')),
					E('div', { 'class': 'right', 'style': 'margin-top:12px' },
						E('button', { 'class': 'btn', 'click': ui.hideModal }, _('关闭')))
				]);
			}).catch(function (e) {
				ui.hideModal();
				ui.addNotification(null, E('p', '' + e), 'error');
			});
		}

		// 数据驱动的页签: id / 标题 / 面板 / 刷新函数 / 可选清空 / 提示
		var TABS = [
			{ id: 'session', label: _('会话信息'), box: sessBox, refresh: refreshSession,
			  full: true,
			  note: _('当前账号的欠费、剩余时长与流量、本次及累计用量, 均来自网关实时返回。') },
			{ id: 'log', label: _('运行日志'), box: logBox, refresh: refreshLog,
			  clear: callClearLog,
			  // 行数上限是可配的, 提示照 uci 的值写, 别写死一个数
			  note: _('引擎运行日志, 最多') + ' ' +
			        (uci.get('campass', 'global', 'log_max_lines') || '2000') + ' ' + _('行') },
			{ id: 'auth', label: _('认证响应'), box: authBox, refresh: refreshAuth,
			  clear: callClearAuth,
			  note: _('最近 30 条登录 / 注销 / 解绑的原始返回(含切换与回滚全过程), 点击条目展开。') }
		];
		var curTab = TABS[0];
		var paneWrap = E('div', {});
		var noteEl = E('span', { 'class': 'cps-note' }, curTab.note);
		var clearBtn = E('button', { 'class': 'btn cbi-button cbi-button-remove' }, _('清空'));
		var tabBtns = TABS.map(function (t) {
			t.btn = E('button', { 'type': 'button',
				'class': 'cps-tab' + (t === curTab ? ' is-active' : '') }, t.label);
			t.pane = E('div', { 'class': 'cps-pane' + (t.full ? ' is-full' : '') }, t.box);
			// 必须走 DOM 属性: E() 是 setAttribute, hidden 又是布尔属性,
			// 传 false 会渲染成 hidden="false" —— 照样隐藏, 默认选中的那个
			// 页签就一直是空白的, 得手点一下(selectTab 里赋的是属性)才出来。
			t.pane.hidden = (t !== curTab);
			t.btn.addEventListener('click', function () { selectTab(t); });
			paneWrap.appendChild(t.pane);
			return t.btn;
		});

		function selectTab(t) {
			curTab = t;
			TABS.forEach(function (x) {
				x.btn.className = 'cps-tab' + (x === t ? ' is-active' : '');
				x.pane.hidden = (x !== t);
			});
			clearBtn.hidden = !t.clear;
			dom.content(noteEl, t.note);
			return t.refresh();
		}
		clearBtn.hidden = !curTab.clear;
		clearBtn.addEventListener('click', ui.createHandlerFn(self, function () {
			if (curTab.clear) return curTab.clear().then(curTab.refresh);
		}));

		var diagBar = E('div', { 'class': 'cps-bar', 'style': 'margin-top:8px' }, [
			E('button', { 'class': 'btn cbi-button',
				'click': ui.createHandlerFn(self, function () { return curTab.refresh(); }) }, _('刷新')),
			clearBtn,
			E('button', { 'class': 'btn cbi-button',
				'click': ui.createHandlerFn(self, function () { return runProbe(); }) }, _('测试连通性')),
			E('span', { 'class': 'cps-spacer' }),
			noteEl
		]);

		// 顶部页签当前停在哪一页(索引对应 TOP_TABS); 诊断没露面时就别白跑它的 rpc
		var topIdx = 0;

		poll.add(function () {
			return Promise.all([
				callStatus().then(function (r) {
					dom.content(statusBox, renderStatus(r || {}));
					if (r && r.active) curActive = r.active;
				}).catch(function () {}),
				refreshSwitch(),
				topIdx === TOP_DIAG ? curTab.refresh() : Promise.resolve()
			]);
		}, 10);

		function applyResult(res) {
			dom.content(statusBox, renderStatus(res || {}));
			refreshLog();
			refreshAuth();
			refreshSession();
			ui.addNotification(null, E('p', (res && res.message) || _('已执行')), 'info');
		}

		// 直接执行(立即登录)
		function runDirect(title, rpcFn) {
			ui.showModal(title, [ E('p', { 'class': 'spinning' }, _('执行中...')) ]);
			return rpcFn().then(function (res) { ui.hideModal(); applyResult(res); })
				.catch(function (e) { ui.hideModal(); ui.addNotification(null, E('p', '' + e), 'error'); });
		}

		// 危险操作: 输入口令二次确认(登出/解绑)
		function confirmAction(title, warn, rpcFn) {
			var input = E('input', { 'type': 'password', 'class': 'cbi-input-text',
				'style': 'width:100%', 'placeholder': _('请输入操作口令') });
			ui.showModal(title, [
				E('p', { 'style': 'color:#dc2626;font-weight:bold' },
					'⚠ ' + _('危险: 此操作可能断开路由器的互联网连接。如果你不在现场, 请谨慎操作!')),
				E('p', { 'style': 'color:#b45309' }, warn),
				E('p', {}, _('输入设置里的“操作口令”以确认:')),
				input,
				E('div', { 'class': 'right', 'style': 'margin-top:12px' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('取消')),
					' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-negative',
						'click': ui.createHandlerFn(self, function () {
							var expect = uci.get('campass', 'global', 'confirm_word') || '';
							if (input.value !== expect) {
								ui.addNotification(null, E('p', _('口令错误')), 'error');
								return;
							}
							ui.hideModal();
							return runDirect(title, rpcFn);
						})
					}, _('确认执行'))
				])
			]);
			input.focus();
		}

		// ---------------- 账号切换 ----------------
		var accSelect = E('select', { 'class': 'cbi-input-select', 'style': 'min-width:180px' });
		uci.sections('campass', 'account').forEach(function (s) {
			accSelect.appendChild(E('option', { 'value': s['.name'] }, accountLabel(s)));
		});
		if (curActive) accSelect.value = curActive;

		// 轮询切换进度直到结束(切换最长 switch_timeout + 登录/回滚耗时)
		// ref 是路由器侧的时间基准, 用来区分本次任务与上次遗留的状态,
		// 不用浏览器时钟, 免得两边时间不同步导致误判。
		function waitSwitch(ref, box) {
			var timeout = parseInt(uci.get('campass', 'global', 'switch_timeout') || 120);
			var hardStop = Date.now() / 1000 + timeout + 180;
			function tick() {
				return callSwitchStatus().then(function (r) {
					r = r || {};
					renderSwitchState(box, r, true);
					renderSwitchState(switchBox, r, ownSwitch);
					var fresh = (parseInt(r.started || 0) >= ref - 2);
					var done  = fresh && r.running !== true && !isBusy(r.state);
					if (done || Date.now() / 1000 > hardStop)
						return r;
					return new Promise(function (res) { window.setTimeout(res, 3000); }).then(tick);
				}).catch(function () {
					// 切换过程中会短暂断网, 请求失败属正常, 继续等
					if (Date.now() / 1000 > hardStop) return {};
					return new Promise(function (res) { window.setTimeout(res, 3000); }).then(tick);
				});
			}
			return tick();
		}

		function doSwitch(section) {
			var progress = E('div', { 'class': 'cps-progress' },
				E('p', { 'class': 'spinning' }, _('正在提交切换请求...')));
			ui.showModal(_('切换账号'), [
				progress,
				E('p', { 'class': 'cps-note', 'style': 'margin-top:10px' },
					_('切换过程中路由器会短暂断网; 验证窗口内探测不通将自动回滚至原账号, 请勿关闭页面。'))
			]);
			ownSwitch = true;
			return callSwitch(section).then(function (r0) {
				r0 = r0 || {};
				if (r0.error)
					return Promise.reject(new Error(r0.error));
				var ref = (r0.running === true && r0.started)
					? parseInt(r0.started) : parseInt(r0.now || 0);
				renderSwitchState(progress, r0, true);
				return waitSwitch(ref, progress);
			}).then(function (r) {
				r = r || {};
				ui.hideModal();
				renderSwitchState(switchBox, r, true);
				refreshLog();
				refreshAuth();
				refreshSession();
				ui.addNotification(null, E('p', r.message || _('切换已结束')),
					r.state === 'ok' ? 'info' : 'warning');
				// active 已由引擎写入 UCI, 重新载入, 免得页面上的旧值把它盖回去
				uci.unload('campass');
				return uci.load('campass');
			}).then(function () {
				return callStatus().then(function (r) {
					dom.content(statusBox, renderStatus(r || {}));
					if (r && r.active) {
						curActive = r.active;
						accSelect.value = r.active;
					}
				}).catch(function () {});
			}).catch(function (e) {
				ui.hideModal();
				ui.addNotification(null, E('p', '' + e), 'error');
			});
		}

		function confirmSwitch() {
			var section = accSelect.value;
			if (!section) {
				ui.addNotification(null, E('p', _('请先选择一个账号')), 'error');
				return;
			}
			if (section === curActive) {
				ui.addNotification(null, E('p', _('该账号已经是当前账号')), 'info');
				return;
			}
			var timeout = parseInt(uci.get('campass', 'global', 'switch_timeout') || 120);
			var host = [].concat(uci.get('campass', 'global', 'probe_url') || 'https://www.baidu.com').join(', ');
			var target = accSelect.options[accSelect.selectedIndex].text;
			ui.showModal(_('切换账号'), [
				E('p', { 'style': 'color:#b45309' },
					'⚠ ' + _('切换将先注销当前账号, 期间会短暂断网。')),
				E('ol', { 'style': 'margin:8px 0 8px 20px' }, [
					E('li', {}, _('解绑并注销当前账号')),
					E('li', {}, _('切换到') + ' ' + target + ' ' + _('并登录')),
					E('li', {}, timeout + 's ' + _('内反复 https 探测') + ' ' + host),
					E('li', {}, _('若始终不通, 自动回滚到原账号并重新登录'))
				]),
				E('p', { 'class': 'cps-note' }, _('全过程的认证响应可在“认证响应”页签中查看。')),
				E('div', { 'class': 'right', 'style': 'margin-top:12px' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('取消')),
					' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-action important',
						'click': ui.createHandlerFn(self, function () {
							ui.hideModal();
							return doSwitch(section);
						})
					}, _('开始切换'))
				])
			]);
		}

		// 一条工具栏: 左边切换账号, 右边即时动作
		var toolBar = E('div', { 'class': 'cps-bar' }, [
			E('label', {}, _('切换到')),
			accSelect,
			E('button', { 'class': 'btn cbi-button cbi-button-action',
				'click': ui.createHandlerFn(self, confirmSwitch) }, _('切换')),
			E('span', { 'class': 'cps-spacer' }),
			E('button', { 'class': 'btn cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(self, function () { return runDirect(_('立即登录'), callLogin); })
			}, _('立即登录')),
			E('button', { 'class': 'btn cbi-button',
				'click': ui.createHandlerFn(self, function () {
					return confirmAction(_('登出'), _('将使本机下线, 需重新登录才能上网。'), callLogout);
				})
			}, _('登出')),
			E('button', { 'class': 'btn cbi-button cbi-button-negative',
				'click': ui.createHandlerFn(self, function () {
					return confirmAction(_('解绑设备'), _('将解除当前账号在本机的 MAC 绑定。'), callUnbind);
				})
			}, _('解绑'))
		]);

		var m = new form.Map('campass', _('Campass · 校园网认证管理'),
			_('学号、运营商与密码分开填写, 后缀自动拼接。启用后由内置定时器按间隔保活。'));

		// 运行状态 + 账号切换 + 动作(合成一张卡, 切换进度按需出现)
		// 状态与诊断合成一个 section: 都是"现在怎么样"的只读信息, 一个页签装得下,
		// 也省得为了看日志再切一次页签
		var ss = m.section(form.TypedSection, '_status');
		ss.anonymous = true;
		ss.render = function () {
			return E('div', { 'class': 'cbi-section' }, [
				E('style', { 'type': 'text/css' }, CSS),
				E('h3', _('运行状态')),
				E('div', { 'class': 'cps-card' }, [
					statusBox,
					toolBar,
					E('p', { 'class': 'cps-note' },
						_('切换账号将通过 https 探测验证连通性, 探测不通则自动回滚; 立即生效, 无需“保存并应用”。')),
					switchBox
				]),
				E('h3', { 'style': 'margin-top:18px' }, _('诊断')),
				E('div', { 'class': 'cps-tabs' }, tabBtns),
				paneWrap, diagBar
			]);
		};

		// 全局设置: 十几个选项铺一页太长, 按用途分三个页签
		var g = m.section(form.NamedSection, 'global', 'campass', _('全局设置'));
		g.addremove = false;
		g.tab('base', _('基本'));
		g.tab('probe', _('探测与看门狗'));
		g.tab('security', _('安全'));
		var o;

		// ---- 基本 ----
		o = g.taboption('base', form.Flag, 'enabled', _('启用'),
			_('勾选并“保存并应用”后, 内置定时器将按间隔执行保活。'));
		o.rmempty = false;

		o = g.taboption('base', form.Value, 'interval', _('保活间隔(秒)'),
			_('按此周期向网关查询登录状态, 显示未登录则立即重新认证。' +
			  '此项仅负责恢复掉线, 不检测网络是否实际可用 —— 网关返回在线即跳过。' +
			  '实际连通性由「探测与看门狗」页签中的看门狗负责。默认 300'));
		o.datatype = 'and(uinteger,min(30))';
		o.placeholder = '300';

		o = g.taboption('base', form.Value, 'gateway', _('网关地址'),
			_('留空则使用默认 10.0.1.5'));
		o.datatype = 'host';
		o.rmempty = true;
		o.placeholder = '10.0.1.5';

		o = g.taboption('base', form.Value, 'log_max_lines', _('运行日志上限(行)'),
			_('超出后自最旧的行开始丢弃。日志存于 /tmp, 重启即清空。' +
			  '整份日志需经 ubus 传回本页面显示, 故上限为 10000 行, 不宜设置过大。默认 2000'));
		o.datatype = 'and(uinteger,min(50),max(10000))';
		o.placeholder = '2000';

		o = g.taboption('base', form.Value, 'switch_timeout', _('切换验证窗口(秒)'),
			_('切换账号后, 在此时间内反复进行 https 探测; 始终不通则回滚至原账号。默认 120'));
		o.datatype = 'and(uinteger,min(30),max(600))';
		o.placeholder = '120';

		// ---- 探测与看门狗 ----
		o = g.taboption('probe', form.Flag, 'watchdog', _('网络看门狗'),
			_('启用后按下方周期探测真实连通性; 连续失败达到设定次数即自动执行 解绑→注销→登录 恢复'));
		o.rmempty = false;

		o = g.taboption('probe', form.DynamicList, 'probe_url', _('连通性探测地址'),
			_('仅接受 https(含完整证书校验)。不采用 ping 与明文 http 作为判据: ' +
			  '认证网关会代答 ICMP, 亦会劫持明文 http 返回门户页, 二者均可伪造“网络正常”的假象, ' +
			  '而带证书校验的 https 无法伪造。可填写多条, 按顺序尝试, 任一通过即判定为连通; ' +
			  '建议配置两个不同厂商的站点, 以免单站故障被误判为断网。'));
		o.placeholder = 'https://www.baidu.com';

		o = g.taboption('probe', form.ListValue, 'probe_family', _('探测地址族'),
			_('探测时仅连接指定地址族。默认两族均尝试, 任一通过即算连通; ' +
			  '若本机某一族不可用(如无 IPv6 出口), 限定为另一族可省去每轮一次必然失败的连接超时。' +
			  '注意: 限定后该族一旦中断即判为断网, 看门狗将随之执行恢复。'));
		o.value('any', _('IPv4 / IPv6 (默认, 任一通过)'));
		o.value('v4', _('仅 IPv4'));
		o.value('v6', _('仅 IPv6'));
		o.default = 'any';

		o = g.taboption('probe', form.Value, 'watchdog_interval', _('探测间隔(秒)'),
			_('看门狗执行 https 连通性探测的周期, 用于判定网络是否实际可用。' +
			  '与「基本」页签的保活间隔相互独立: 保活仅依据网关返回的登录状态, ' +
			  '此项检测真实连通性, 可发现网关显示在线但实际无法访问外网的情形。' +
			  '单次探测失败不会立即触发恢复, 需连续失败达到下方的“连续失败次数”。默认 120'));
		o.datatype = 'and(uinteger,min(20))';
		o.placeholder = '120';
		o.depends('watchdog', '1');

		o = g.taboption('probe', form.Value, 'watchdog_fails', _('连续失败次数'),
			_('连续失败达到此次数后, 才执行 解绑→注销→登录 的恢复流程; ' +
			  '其间任意一次探测通过即清零重新计数。' +
			  '设置过小易被网络瞬时波动误触发, 过大则故障后恢复迟缓。默认 3'));
		o.datatype = 'and(uinteger,min(1),max(100))';
		o.placeholder = '3';
		o.depends('watchdog', '1');

		o = g.taboption('probe', form.Flag, 'watchdog_failover', _('恢复失败时换账号'),
			_('当前账号重新登录后仍无法访问外网(封号、欠费或密码变更), ' +
			  '则依次尝试账号列表中的其他账号; 成功者将被设为当前账号, 全部失败则还原为原账号。'));
		o.default = '1';
		o.rmempty = false;
		o.depends('watchdog', '1');

		// ---- 安全 ----
		o = g.taboption('security', form.Value, 'confirm_word', _('操作口令'),
			_('执行“登出 / 解绑”前需输入此口令二次确认, 以防误触。'));
		o.password = true;
		o.rmempty = false;

		o = g.taboption('security', form.Flag, 'block_lan', _('禁止 LAN 访问认证网关'),
			_('开启后局域网用户无法直接访问认证网关(登出、换绑或篡改认证), 但仍可正常上网; 路由器自身登录不受影响。保存并应用后将自动写入防火墙规则。'));
		o.rmempty = false;

		o = g.taboption('security', form.ListValue, 'block_zone', _('拦截来源区域'),
			_('需要拦截的防火墙区域, 通常为 lan; 若内网接口使用其他区域名称, 请在此修改。'));
		var zones = uci.sections('firewall', 'zone');
		if (zones.length) {
			zones.forEach(function (z) {
				if (z.name) o.value(z.name, z.name);
			});
		} else {
			o.value('lan', 'lan');
		}
		o.default = 'lan';
		o.depends('block_lan', '1');

		// 账号列表
		var a = m.section(form.GridSection, 'account', _('账号列表'),
			_('学号、运营商与密码分开填写, 运营商后缀由引擎自动拼接。切换当前账号请使用上方的“切换到”。'));
		a.addremove = true;
		// 匿名 section: 点"添加"直接建, 不再先让用户起一个 UCI section 名 ——
		// 那个名字只是内部标识, 对着填毫无意义。引擎按 type=account 枚举账号,
		// 名字取自动生成的即可; 已有的 main / uXXXX 等命名 section 照常显示。
		a.anonymous = true;
		a.nodescriptions = true;
		// 不设的话弹窗标题会沿用整页的标题, 看不出自己在编辑什么
		a.modaltitle = function () { return _('账号'); };

		o = a.option(form.Value, 'name', _('备注名'));
		o.placeholder = _('如: 主号');

		o = a.option(form.Value, 'student_id', _('学号'));
		o.rmempty = false;

		// Value(而非 ListValue) + 建议值 => 可编辑下拉: 既能选预设, 也能自己填。
		// 引擎按此拼后缀: 空/校园网/campus => 无后缀; 以 @ 开头 => 原样; 否则补 @。
		// 自定义时填后缀本身, 如 @abc 或 abc(都会得到 @abc), 校园网留空。
		o = a.option(form.Value, 'isp', _('运营商'),
			_('可选择预设, 或直接填写自定义后缀(如 @abc); 校园网留空。'));
		o.value('telecom', _('电信'));
		o.value('cmcc', _('移动'));
		o.value('unicom', _('联通'));
		o.value('glgd', _('桂林广电'));
		o.value('', _('校园网'));

		o = a.option(form.Value, 'password', _('密码'));
		o.password = true;
		o.rmempty = false;
		o.modalonly = true;   // 仅在编辑弹窗显示, 表格里不明文列出密码

		// 四个 section 摞一页要滚好几屏, 渲染完再套一层顶部页签。
		// form.Map 没有跨 section 的页签, 所以在产出的 DOM 上做: .cbi-map 下
		// 的 .cbi-section 按顺序就是这四块, 逐个收进页签轮流显示。
		return m.render().then(function (mapNode) {
			var secs = Array.prototype.filter.call(mapNode.children, function (c) {
				return c.classList.contains('cbi-section');
			});
			// 结构和预期对不上就原样返回, 宁可页面长一点也别渲染出个残页
			if (secs.length !== TOP_TABS.length)
				return mapNode;

			// 用 LuCI 原生的 cbi-tabmenu 结构(ul > li.cbi-tab / li.cbi-tab-disabled),
			// 样式交给主题, 跟系统里其他页面的页签长得一样
			var btns = TOP_TABS.map(function (label, i) {
				var a = E('a', { 'href': '#' }, label);
				a.addEventListener('click', function (ev) {
					ev.preventDefault();      // 否则会跳到 '#' 把页面滚到顶
					selectTop(i);
				});
				return E('li', { 'class': 'cbi-tab-disabled' }, a);
			});

			function selectTop(i) {
				topIdx = i;
				secs.forEach(function (s, k) { s.hidden = (k !== i); });
				btns.forEach(function (b, k) {
					b.className = (k === i) ? 'cbi-tab' : 'cbi-tab-disabled';
				});
				// 诊断平时不轮询, 切过来先补一次, 免得看到十秒前的旧数据
				if (i === TOP_DIAG) curTab.refresh();
			}

			secs.forEach(function (s) {
				s.classList.add('cps-top-pane');
				// 页签已经标了名字, 里面的标题再写一遍就重复了
				var h = s.querySelector('h3');
				if (h) h.hidden = true;
			});
			mapNode.insertBefore(E('ul', { 'class': 'cbi-tabmenu' }, btns), secs[0]);
			selectTop(0);
			return mapNode;
		});
	}
});
