# NewShipTerminal — 无人船操作终端

| 目录 | 内容 |
|---|---|
| [desktop/](desktop/) | 上位机终端（Electron + TypeScript），开发中 |
| [firmware/](firmware/) | 船端固件（Rust），协议 v1/v2 + OTA |
| [spec/](spec/) | 协议与契约的唯一真相源 |
| [docs/](docs/) | 架构与规格文档、器件手册 |

## 定位（不变）

- **本机 PC = 主机 / 运算中心**：手柄解析、指令生成、界面渲染，以及视频、SLAM、避障、航迹规划、数据记录全部在本机完成。
- **船上 = 薄执行端**：只做「收指令 → 驱动电机 / 舵机」，外加最小本地安全兜底（看门狗、失联停车）。
- **船端协议 v1**：TCP 9527，`AA 55` 帧 + CRC16-CCITT-FALSE，CMD/STATUS 50Hz，SCAN 每圈一帧（点云，可 zlib）。

## 入口

- 上位机程序：双击 `run-usv-terminal.cmd`（首次会自动装依赖并构建）
- 架构说明：[desktop/docs/architecture.md](desktop/docs/architecture.md)
- 固件说明：[firmware/README.md](firmware/README.md)
- 船端协议：[spec/protocol-v1.md](spec/protocol-v1.md)
- 船端交接资料：[spec/handover-v1.md](spec/handover-v1.md)
- 雷达数据手册：[docs/datasheets/SLAMTEC_rplidar_C1_v1.2_en.pdf](docs/datasheets/SLAMTEC_rplidar_C1_v1.2_en.pdf)
