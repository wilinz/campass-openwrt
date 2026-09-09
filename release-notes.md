Campass — OpenWrt 校园网自动登录 & 保活。

## 本版改动

v1.8.0: 自定义运营商后缀 + mips/mips64 大小端全部带证书校验

## 安装

按路由器架构下载对应的 `campass_*_<arch>.ipk`，再配一份架构无关的
`luci-app-campass_*_all.ipk` 一起安装：

```sh
opkg install campass_*_<你的架构>.ipk luci-app-campass_*_all.ipk
```

用 `opkg print-architecture` 查看架构；若架构名不完全匹配可加
`--force-architecture`（二进制为静态 musl，兼容同 CPU 家族）。

> mips / mips64（MT7621、ath79、Octeon 等）为 Rust tier-3 目标，
> 用 nightly + `-Z build-std` 交叉编译，属实验性构建，可能缺席。
