'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require poll';
'require dom';
'require ui';

var callStatus   = rpc.declare({ object: 'campass', method: 'status' });
var callLogin    = rpc.declare({ object: 'campass', method: 'login' });
var callLogout   = rpc.declare({ object: 'campass', method: 'logout' });
var callUnbind   = rpc.declare({ object: 'campass', method: 'unbind' });
var callLog      = rpc.declare({ object: 'campass', method: 'log' });
var callClearLog = rpc.declare({ object: 'campass', method: 'clearlog' });

function fmtTs(ts) {
	ts = parseInt(ts || 0);
	return ts ? new Date(ts * 1000).toLocaleString() : '-';
}

function renderStatus(st) {
	st = st || {};
	var online = (st.online === true || st.online === 1);
	function row(k, v) {
		return E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td left', 'style': 'width:30%;font-weight:bold' }, k),
			E('td', { 'class': 'td left' }, [v])
		]);
	}
	return E('table', { 'class': 'table' }, [
		row(_('状态'), E('span', {
			'style': 'padding:2px 12px;border-radius:12px;color:#fff;font-weight:bold;background:' +
				(online ? '#16a34a' : '#dc2626')
		}, online ? _('在线') : _('离线'))),
		row(_('当前账号'), document.createTextNode(
			(st.account_name ? st.account_name + ' · ' : '') + (st.account || '-'))),
		row(_('服务器 uid'), document.createTextNode(st.uid || '-')),
		row(_('公网 IP'), document.createTextNode(st.ip || '-')),
		row(_('上次登录'), document.createTextNode(fmtTs(st.last_login))),
		row(_('自动登录'), document.createTextNode(
			(st.enabled === true || st.enabled === 1) ? _('已启用') : _('已停用')))
	]);
}

return view.extend({
	load: function () {
		return Promise.all([
			uci.load('campass'),
			uci.load('firewall').catch(function () {}),
			callStatus().catch(function () { return {}; }),
			callLog().catch(function () { return {}; })
		]);
	},

	render: function (data) {
		var self = this;
		var st = (data && data[2]) || {};
		var logText = (data && data[3] && data[3].log) || '';

		var statusBox = E('div', {}, renderStatus(st));
		var logBox = E('pre', {
			'style': 'max-height:320px;overflow:auto;margin:0;padding:10px;' +
				'border:1px solid rgba(128,128,128,.35);border-radius:4px;' +
				'background:transparent;color:inherit;' +
				'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
				'font-size:12px;line-height:1.5;white-space:pre-wrap'
		}, logText.trim() || _('(暂无日志)'));

		function refreshLog() {
			return callLog().then(function (r) {
				dom.content(logBox, (r && r.log ? r.log.trim() : '') || _('(暂无日志)'));
			}).catch(function () {});
		}

		poll.add(function () {
			return Promise.all([
				callStatus().then(function (r) {
					dom.content(statusBox, renderStatus(r || {}));
				}).catch(function () {}),
				refreshLog()
			]);
		}, 10);

		function applyResult(res) {
			dom.content(statusBox, renderStatus(res || {}));
			refreshLog();
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

		var actionBar = E('div', { 'style': 'margin-top:12px;display:flex;gap:8px;flex-wrap:wrap' }, [
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

		var logBar = E('div', { 'style': 'margin-top:8px;display:flex;gap:8px' }, [
			E('button', { 'class': 'btn cbi-button',
				'click': ui.createHandlerFn(self, function () { return refreshLog(); }) }, _('刷新')),
			E('button', { 'class': 'btn cbi-button cbi-button-remove',
				'click': ui.createHandlerFn(self, function () {
					return callClearLog().then(function () { return refreshLog(); }); }) }, _('清空日志'))
		]);

		var m = new form.Map('campass', _('Campass · 校园网自动登录'),
			_('学号/运营商/密码分开填, 后缀自动拼接。启用后由内置定时器按间隔保活, 不使用 cron。'));

		// 运行状态 + 动作栏
		var ss = m.section(form.TypedSection, '_status');
		ss.anonymous = true;
		ss.render = function () {
			return E('div', { 'class': 'cbi-section' }, [
				E('h3', _('运行状态')), statusBox, actionBar
			]);
		};

		// 运行日志
		var ls = m.section(form.TypedSection, '_log');
		ls.anonymous = true;
		ls.render = function () {
			return E('div', { 'class': 'cbi-section' }, [
				E('h3', _('运行日志')), logBox, logBar
			]);
		};

		// 全局设置
		var g = m.section(form.NamedSection, 'global', 'campass', _('全局设置'));
		g.addremove = false;
		var o;

		o = g.option(form.Flag, 'enabled', _('启用自动登录'),
			_('勾选并“保存并应用”后, 内置定时器开始按间隔保活'));
		o.rmempty = false;

		o = g.option(form.ListValue, 'active', _('当前账号'),
			_('选择用哪个账号上网; 切换后点“保存并应用”生效'));
		uci.sections('campass', 'account').forEach(function (s) {
			var label = (s.name ? s.name + ' (' : '') + (s.student_id || s['.name']) + (s.name ? ')' : '');
			o.value(s['.name'], label);
		});

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
			_('真实连通性(ping)持续不通超过阈值时, 自动执行 解绑→注销→登录 恢复'));
		o.rmempty = false;

		o = g.option(form.Value, 'ping_host', _('探测主机'), _('看门狗 ping 的目标'));
		o.placeholder = 'baidu.com';
		o.depends('watchdog', '1');

		o = g.option(form.Value, 'watchdog_interval', _('探测间隔(秒)'),
			_('看门狗多久 ping 一次(独立于保活间隔)'));
		o.datatype = 'and(uinteger,min(20))';
		o.placeholder = '60';
		o.depends('watchdog', '1');

		o = g.option(form.Value, 'watchdog_threshold', _('恢复阈值(秒)'),
			_('持续不通多少秒才触发恢复, 防抖动误触'));
		o.datatype = 'and(uinteger,min(60))';
		o.placeholder = '300';
		o.depends('watchdog', '1');

		// 账号列表
		var a = m.section(form.GridSection, 'account', _('账号列表'),
			_('学号/运营商/密码分开填, 后缀由脚本自动拼接, 不要把 @ 加进密码。'));
		a.addremove = true;
		a.anonymous = false;
		a.nodescriptions = true;

		o = a.option(form.Value, 'name', _('备注名'));
		o.placeholder = _('如: 主号');

		o = a.option(form.Value, 'student_id', _('学号'));
		o.rmempty = false;

		o = a.option(form.ListValue, 'isp', _('运营商'));
		o.value('telecom', _('电信'));
		o.value('cmcc', _('移动'));
		o.value('unicom', _('联通'));
		o.value('glgd', _('广电'));
		o.value('', _('校园网'));

		o = a.option(form.Value, 'password', _('密码'));
		o.password = true;
		o.rmempty = false;
		o.modalonly = true;   // 仅在编辑弹窗显示, 表格里不明文列出密码

		return m.render();
	}
});
