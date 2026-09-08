#!/usr/bin/env bash
# 构建 campass + luci-app-campass 两个 ipk
# 依赖: cargo-zigbuild + zig(交叉静态 musl), tar(ustar)
#
# 可用环境变量:
#   TARGET   rust 目标三元组   (默认 x86_64-unknown-linux-musl)
#   ARCH     opkg 架构名       (默认 x86_64)
#   VERSION  版本号            (默认取自 CONTROL/control)
#   BUILDSTD 1=用 nightly -Z build-std 编 tier-3 目标(如 mips) (默认 0)
#   BUILD_ENGINE 1/0  是否编译+打包引擎包 (默认 1)
#   BUILD_LUCI   1/0  是否打包 LuCI 包(架构无关) (默认 1)
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
OUT="$ROOT/out"
TARGET="${TARGET:-x86_64-unknown-linux-musl}"
ARCH="${ARCH:-x86_64}"
VERSION="${VERSION:-}"
BUILDSTD="${BUILDSTD:-0}"
BUILD_ENGINE="${BUILD_ENGINE:-1}"
BUILD_LUCI="${BUILD_LUCI:-1}"
export COPYFILE_DISABLE=1   # 禁 macOS AppleDouble (._*)

# 注入版本号到 control(CI 用 tag 覆盖)
if [ -n "$VERSION" ]; then
	for c in pkg/campass/CONTROL/control pkg/luci-app-campass/CONTROL/control; do
		sed -i.bak "s/^Version:.*/Version: $VERSION/" "$c" && rm -f "$c.bak"
	done
fi

# ustar 格式 + root 属主, 避免 opkg 读不了 pax 扩展头
tar_ustar() {  # <src_dir> <out.tar.gz>
	( cd "$1" && tar --format ustar --numeric-owner --uid 0 --gid 0 -czf "$2" ./* )
}

build_ipk() {  # <pkgdir> <arch>
	local pkgdir="$1" arch="$2"
	local name ver tmp ipk
	name="$(awk -F': ' '/^Package:/{print $2}' "$pkgdir/CONTROL/control")"
	ver="$(awk -F': ' '/^Version:/{print $2}' "$pkgdir/CONTROL/control")"
	tmp="$(mktemp -d)"

	printf '2.0\n' > "$tmp/debian-binary"
	chmod 0644 "$pkgdir/CONTROL/control"
	[ -f "$pkgdir/CONTROL/conffiles" ] && chmod 0644 "$pkgdir/CONTROL/conffiles"
	for s in preinst postinst prerm postrm; do
		[ -f "$pkgdir/CONTROL/$s" ] && chmod 0755 "$pkgdir/CONTROL/$s"
	done
	tar_ustar "$pkgdir/CONTROL" "$tmp/control.tar.gz"
	tar_ustar "$pkgdir/data"    "$tmp/data.tar.gz"

	mkdir -p "$OUT"
	ipk="$OUT/${name}_${ver}_${arch}.ipk"
	rm -f "$ipk"
	# OpenWrt 的 .ipk = 三个成员的 gzip tar (opkg-utils ipkg-build 的产物), 不是 ar!
	( cd "$tmp" && tar --format ustar --numeric-owner --uid 0 --gid 0 \
		-czf "$ipk" ./debian-binary ./control.tar.gz ./data.tar.gz )
	rm -rf "$tmp"
	echo "    -> $ipk"
}

if [ "$BUILD_ENGINE" = "1" ]; then
	echo "==> 交叉编译 rust 引擎 (target=$TARGET, arch=$ARCH, buildstd=$BUILDSTD)"
	if [ "$BUILDSTD" = "1" ]; then
		( cd campass-rs && cargo +nightly zigbuild --release \
			-Z build-std=std,panic_abort --target "$TARGET" )
	else
		( cd campass-rs && cargo zigbuild --release --target "$TARGET" )
	fi
	mkdir -p pkg/campass/data/usr/bin
	cp "campass-rs/target/$TARGET/release/campass" pkg/campass/data/usr/bin/campass
	chmod +x pkg/campass/data/usr/bin/campass \
		pkg/campass/data/etc/init.d/campass \
		pkg/campass/data/usr/libexec/rpcd/campass
	echo "==> 打包引擎"
	build_ipk pkg/campass "$ARCH"
fi

if [ "$BUILD_LUCI" = "1" ]; then
	echo "==> 打包 LuCI (all)"
	build_ipk pkg/luci-app-campass all
fi

echo "==> 完成"
ls -la "$OUT"
