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
'.cps-bar .cps-spacer { flex:1 1 auto; min-width:0 }' +
'.cps-note { margin:0; opacity:.7; font-size:12px }' +
'.cps-progress { padding:8px 12px; border-radius:4px; border-left:3px solid #2563eb;' +
	' background:rgba(128,128,128,.08) }' +
'.cps-progress.is-warn { border-left-color:#b45309 }' +
'.cps-progress.is-bad { border-left-color:#dc2626 }' +
'.cps-progress.is-good { border-left-color:#16a34a }' +
'.cps-tabs { display:flex; gap:4px; border-bottom:1px solid rgba(128,128,128,.3) }' +
'.cps-tab { padding:6px 14px; cursor:pointer; border:none; background:transparent; color:inherit;' +
	' font-size:13px; border-bottom:2px solid transparent; opacity:.65 }' +
'.cps-tab.is-active { opacity:1; font-weight:600; border-bottom-color:#2563eb }' +
'.cps-pane { max-height:340px; overflow:auto; border:1px solid rgba(128,128,128,.3);' +
	' border-radius:0 0 4px 4px; border-top:none }' +
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
function renderSwitchState(box, sw) {
	sw = sw || {};
	var s = SWITCH_STATES[sw.state];
	if (!s) {
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
		function refreshLog() {
			return callLog().then(function (r) {
				dom.content(logBox, (r && r.log ? r.log.trim() : '') || _('(暂无日志)'));
			}).catch(function () {});
		}
		function refreshAuth() {
			return callAuth().then(function (r) {
				dom.content(authBox, renderAuth((r && r.records) || []));
			}).catch(function () {});
		}

		function refreshSwitch() {
			return callSwitchStatus().then(function (r) {
				renderSwitchState(switchBox, r || {});
				return r || {};
			}).catch(function () { return {}; });
		}

		// type=button: 免得在 form 里被当成提交按钮
		// 连通性自检: 逐个 URL 分别报 v4 / v6, 便于定位单边故障
		function runProbe() {
			ui.showModal(_('测试连通性'), [
				E('p', { 'class': 'spinning' }, _('探测中... (v6 不通时要等超时, 可能十几秒)'))
			]);
			return callProbe().then(function (r) {
				r = r || {};
				var rows = (r.detail || []).map(function (d) {
					if (d.skipped)
						return E('tr', { 'class': 'tr' }, [
							E('td', { 'class': 'td left' }, d.url),
							E('td', { 'class': 'td left', 'colspan': 2 }, E('em', {}, d.skipped))
						]);
					function cell(v) {
						return E('td', { 'class': 'td left' },
							badge(v ? _('通') : _('不通'), v ? '#16a34a' : '#dc2626'));
					}
					return E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td left' }, d.url), cell(d.v4), cell(d.v6)
					]);
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
							E('th', { 'class': 'th left' }, _('探测地址')),
							E('th', { 'class': 'th left' }, 'IPv4'),
							E('th', { 'class': 'th left' }, 'IPv6')
						])
					].concat(rows)),
					E('p', { 'class': 'cps-note', 'style': 'margin-top:8px' },
						_('任一地址族通过即算连通; 只有 https 条目计入判定。')),
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
			  note: _('当前账号的欠费、剩余时长/流量、本次与累计用量, 来自网关实时返回') },
			{ id: 'log', label: _('运行日志'), box: logBox, refresh: refreshLog,
			  clear: callClearLog, note: _('引擎运行日志, 最多 300 行') },
			{ id: 'auth', label: _('认证响应'), box: authBox, refresh: refreshAuth,
			  clear: callClearAuth,
			  note: _('最近 30 条登录/注销/解绑的原始返回(含切换与回滚全过程), 点条目展开') }
		];
		var curTab = TABS[0];
		var paneWrap = E('div', {});
		var noteEl = E('span', { 'class': 'cps-note' }, curTab.note);
		var clearBtn = E('button', { 'class': 'btn cbi-button cbi-button-remove' }, _('清空'));
		var tabBtns = TABS.map(function (t) {
			t.btn = E('button', { 'type': 'button',
				'class': 'cps-tab' + (t === curTab ? ' is-active' : '') }, t.label);
			t.pane = E('div', { 'class': 'cps-pane', 'hidden': t !== curTab }, t.box);
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

		poll.add(function () {
			return Promise.all([
				callStatus().then(function (r) {
					dom.content(statusBox, renderStatus(r || {}));
					if (r && r.active) curActive = r.active;
				}).catch(function () {}),
				refreshSwitch(),
				curTab.refresh()
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
					renderSwitchState(box, r);
					renderSwitchState(switchBox, r);
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
					_('切换过程中路由器会短暂断网; 验证窗口内探测不通会自动回滚到原账号, 请勿关闭页面。'))
			]);
			return callSwitch(section).then(function (r0) {
				r0 = r0 || {};
				if (r0.error)
					return Promise.reject(new Error(r0.error));
				var ref = (r0.running === true && r0.started)
					? parseInt(r0.started) : parseInt(r0.now || 0);
				renderSwitchState(progress, r0);
				return waitSwitch(ref, progress);
			}).then(function (r) {
				r = r || {};
				ui.hideModal();
				renderSwitchState(switchBox, r);
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
					'⚠ ' + _('切换会先注销当前账号, 期间会短暂断网。')),
				E('ol', { 'style': 'margin:8px 0 8px 20px' }, [
					E('li', {}, _('解绑并注销当前账号')),
					E('li', {}, _('切换到') + ' ' + target + ' ' + _('并登录')),
					E('li', {}, timeout + 's ' + _('内反复 https 探测') + ' ' + host),
					E('li', {}, _('若始终不通, 自动回滚到原账号并重新登录'))
				]),
				E('p', { 'class': 'cps-note' }, _('全过程的认证响应可在“认证响应”页签里查看。')),
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

		var m = new form.Map('campass', _('Campass · 校园网自动登录'),
			_('学号/运营商/密码分开填, 后缀自动拼接。启用后由内置定时器按间隔保活, 不使用 cron。'));

		// 运行状态 + 账号切换 + 动作(合成一张卡, 切换进度按需出现)
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
						_('切换账号会用 https 探测验证连通性, 探测不通自动回滚; 立即生效, 无需“保存并应用”。')),
					switchBox
				])
			]);
		};

		// 诊断: 运行日志 / 认证响应
		var ds = m.section(form.TypedSection, '_diag');
		ds.anonymous = true;
		ds.render = function () {
			return E('div', { 'class': 'cbi-section' }, [
				E('h3', _('诊断')),
				E('div', { 'class': 'cps-tabs' }, tabBtns),
				paneWrap, diagBar
			]);
		};

		// 全局设置
		var g = m.section(form.NamedSection, 'global', 'campass', _('全局设置'));
		g.addremove = false;
		var o;

		o = g.option(form.Flag, 'enabled', _('启用自动登录'),
			_('勾选并“保存并应用”后, 内置定时器开始按间隔保活'));
		o.rmempty = false;

		o = g.option(form.Value, 'interval', _('保活间隔(秒)'), _('内置定时器每隔多少秒检测并保活'));
		o.datatype = 'and(uinteger,min(30))';
		o.placeholder = '300';

		o = g.option(form.Value, 'gateway', _('网关地址'), _('留空则使用默认 10.0.1.5'));
		o.datatype = 'host';
		o.rmempty = true;
		o.placeholder = '10.0.1.5';

		o = g.option(form.Value, 'confirm_word', _('操作口令'),
			_('执行“登出/解绑”前需输入此口令二次确认, 防误触'));
		o.password = true;
		o.rmempty = false;

		o = g.option(form.Value, 'switch_timeout', _('切换验证窗口(秒)'),
			_('切换账号后, 在此时间内反复做 https 探测; 始终不通则回滚旧账号。默认 120'));
		o.datatype = 'and(uinteger,min(30),max(600))';
		o.placeholder = '120';

		o = g.option(form.Flag, 'block_lan', _('禁止 LAN 访问认证网关'),
			_('开启后局域网用户无法直接访问认证网关(登出/换绑/篡改认证), 但仍可正常上网; 路由器自身登录不受影响。保存应用后自动写入防火墙规则。'));
		o.rmempty = false;

		o = g.option(form.ListValue, 'block_zone', _('拦截来源区域'),
			_('要拦截的防火墙区域, 一般是 lan; 若你的内网口用了别的区域名请改这里'));
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

		o = g.option(form.Flag, 'watchdog', _('网络看门狗'),
			_('连通性(https 探测)持续不通超过阈值时, 自动执行 解绑→注销→登录 恢复'));
		o.rmempty = false;

		o = g.option(form.DynamicList, 'probe_url', _('连通性探测地址'),
			_('只认 https(完整证书校验)。不用 ping / http 判断, 是因为认证网关会代答 ICMP、' +
			  '也会劫持明文 http 返回门户页, 两者都能伪造出“网络正常”的假象; ' +
			  '带证书校验的 https 伪造不了。可写多条按序试, 任一通过即算连通, ' +
			  '建议放两个不同家的站点, 免得单站故障被误判成断网。'));
		o.placeholder = 'https://www.baidu.com';

		o = g.option(form.Value, 'watchdog_interval', _('探测间隔(秒)'),
			_('看门狗多久探测一次(独立于保活间隔)'));
		o.datatype = 'and(uinteger,min(20))';
		o.placeholder = '60';
		o.depends('watchdog', '1');

		o = g.option(form.Value, 'watchdog_threshold', _('恢复阈值(秒)'),
			_('持续不通多少秒才触发恢复, 防抖动误触'));
		o.datatype = 'and(uinteger,min(60))';
		o.placeholder = '300';
		o.depends('watchdog', '1');

		o = g.option(form.Flag, 'watchdog_failover', _('恢复失败时换账号'),
			_('当前账号重新登录后仍上不了网(封号/欠费/改了密码), 自动依次试账号列表里的其他账号; ' +
			  '成功的那个会被设为当前账号。全都不行则还原为原账号。'));
		o.default = '1';
		o.rmempty = false;
		o.depends('watchdog', '1');

		// 账号列表
		var a = m.section(form.GridSection, 'account', _('账号列表'),
			_('学号/运营商/密码分开填, 运营商后缀由脚本自动拼接。切换当前账号请用上面的“切换到”。'));
		a.addremove = true;
		a.anonymous = false;
		a.nodescriptions = true;

		o = a.option(form.Value, 'name', _('备注名'));
		o.placeholder = _('如: 主号');

		o = a.option(form.Value, 'student_id', _('学号'));
		o.rmempty = false;

		// Value(而非 ListValue) + 建议值 => 可编辑下拉: 既能选预设, 也能自己填。
		// 引擎按此拼后缀: 空/校园网/campus => 无后缀; 以 @ 开头 => 原样; 否则补 @。
		// 自定义时填后缀本身, 如 @abc 或 abc(都会得到 @abc), 校园网留空。
		o = a.option(form.Value, 'isp', _('运营商'),
			_('可选预设或直接填自定义后缀(如 @abc); 校园网留空'));
		o.value('telecom', _('电信'));
		o.value('cmcc', _('移动'));
		o.value('unicom', _('联通'));
		o.value('glgd', _('桂林广电'));
		o.value('', _('校园网'));

		o = a.option(form.Value, 'password', _('密码'));
		o.password = true;
		o.rmempty = false;
		o.modalonly = true;   // 仅在编辑弹窗显示, 表格里不明文列出密码

		return m.render();
	}
});
