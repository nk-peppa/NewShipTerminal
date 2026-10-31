# Vendor 记录：cocommand2d 2.0.0

本目录是**外部交付的算法代码**，不是本仓库原创。改动之前先读这一页。

## 来源

| 项 | 值 |
|---|---|
| 交付形式 | 微信 zip（文件 `Lidar-SLAM-v2-Source(1)`） |
| 交付日期 | 2026-10-28 |
| 导入日期 | 2026-10-30 |
| 基线 tag | `slam-drop-v2.0.0`（该提交只含原样导入，不含本仓库的任何改动） |
| 导入范围 | 算法包 + 回归测试 + 依赖声明 + 离线入口；两份交付文档保留原文 |

## 文件清单与 SHA256

| 文件 | SHA256 |
|---|---|
| `CHANGES_CN.md` | `15c2a1fb138d535dd2266c2ada45ec87fdf18fbc3dfd3b1aa6b11e14bbebe6e0` |
| `cocommand2d/__init__.py` | `f462d82189c4388143d9e6e6d453a68d7b1e56d0de0b2f1efbecbd034f159924` |
| `cocommand2d/batch_slam.py` | `18d6aa6c79001190b98841e1f7d3f4439d235b606b7a8082712631f4f94b8dff` |
| `cocommand2d/recording/__init__.py` | `5ffb5cec7aeea1cf110a4efaa2a900aee95bd0ce793d3f92029a04d1f36591bb` |
| `cocommand2d/recording/io.py` | `b0450145c0fe23b46f78f4524ea97ee929423c2abe1a40c8bb83d10d44056cf2` |
| `cocommand2d/scan.py` | `86d5c5eabda7985a66e67aee2d328d1a79a9347fe82c0e093a78cc2f399f3cd6` |
| `cocommand2d/slam/__init__.py` | `5386c2168a75b3ce2dba720daa382082494c0c90aead62b517a065bdf1969d36` |
| `cocommand2d/slam/core.py` | `4c2b429a37eb2d439dcdd4923f6354b192c8e881fec271b254633d6f295021e5` |
| `cocommand2d/slam/grid.py` | `7454b1c7f57908a89f1a265850819d94ec41485921ae6ea1e7dd21bfaabf8c85` |
| `cocommand2d/slam/preprocessing.py` | `48bccae70c8356bb4ffad797404ed59803c542f7943d4302cafc7cb0c7813f1a` |
| `README_CN.md` | `737b542096752c6f3cdd0aec0948e38565ae7d201947ae298b80bdea7354dc6c` |
| `requirements.txt` | `bbe7e0d48fd759d782cbcda080791a5af33842b74f2c08ad9730a700a9646fcd` |
| `run_slam.py` | `79312be3c5206ebb1cace250214b0870c1b7098520647686845aceb15b8f17f0` |
| `tests/test_preprocessing.py` | `b282b5045ed572b22f42683d272eb25f49ec3ed6839de614ed5f23257916d073` |
| `tests/test_robust_slam.py` | `13d2d587ffcee9f90b8538bad2a8e102866f65529b3b16ff51a6e0dbff43f65d` |

`README_CN.md` / `CHANGES_CN.md` 是**交付原文**：其中"压缩包""交付包"指上面的 zip，
不是本仓库的 `release` 分支；两份文档对"是否附带示例数据"的说法互相矛盾，以实际导入内容为准（无示例数据）。

## 目录映射

| 交付包 | 本仓库 |
|---|---|
| `Lidar-SLAM/cocommand2d/` | `desktop/algo/cocommand2d/` |
| `Lidar-SLAM/tests/` | `desktop/algo/tests/` |
| `Lidar-SLAM/requirements.txt` | `desktop/algo/requirements.txt` |
| `Lidar-SLAM/run_slam.py` | `desktop/algo/run_slam.py` |

## 边界规则

1. `cocommand2d/` 是 vendor 目录：**只整包替换，不在里面手改**。要改先和算法负责人确认；改动要么回流给他，要么放在目录外。
2. 目录外的部分（`tests/conftest.py`、`desktop/tools/algo-sidecar.py`）是**接缝**，归终端侧维护。
3. 算法只允许通过两个入口暴露给终端：
   - 进程内：`desktop/tools/algo-sidecar.py`（stdin/stdout 逐行 JSON，`api: 2`）
   - 离线：`python run_slam.py --input <Scan v1 JSONL> --output <新目录>`
   新增或变更字段必须先改契约，再改代码。

## 后续开发方式（2026-10-30 变更）

不再通过 zip 交付。算法负责人直接在 `slam-algorithm` 分支提交，经 PR 合入 `main`。
因此上面的 SHA256 表只用于核对**首次导入**（`git show slam-drop-v2.0.0`）；
之后判断"谁改了什么"用 `git log -- desktop/algo`，不再需要 zip 对比。

## 已知取舍（来自交付说明，本仓库尚未复核）

- 3 帧一致后才发布地图；`INITIALIZING` 阶段没有地图输出。
- 状态词表：`WAITING` / `INITIALIZING: n/3` / `TRACKING` / `LOST: …` / `DEGENERATE: …`（旧版是 `INITIALIZED`）。
- 更保守：墙面覆盖率 55.0% → 45.5%；500 点/帧耗时中位数约 36–71 ms。
- 无全局回环与重定位；`LOST` / `DEGENERATE` 时保留上次可信位姿，该位姿**不能当作当前定位结果**。
- 验证全部基于合成数据，**尚未**用现场原始序列复现。
- `batch_slam.py` 的"输出目录必须不存在"只是先检查后创建，两个并发回放用同一
  `--output` 时仍可能互相覆盖（上游行为，需要上游改为原子创建；终端侧不手改 vendor）。
  终端侧的 `tools/replay-session.py` 用 `O_CREAT|O_EXCL` 锁文件原子占住唯一目录名
  来规避；直接调用 `run_slam.py` 时仍需自行保证目录唯一。

## 测试

```powershell
cd desktop
npm run algo:test
```

或

```powershell
cd desktop/algo
python -m pytest tests -q
```

运行测试需要 `pytest`；运行算法本身只依赖 `numpy`、`scipy`（见 `requirements.txt`）。

## 算法负责人更新：v4 修订版（2026-10-31）

按算法负责人请求，在 `e15d1c684f5615078c70972ee00c09c0c1527d02` 之后导入新版，
保留终端的 `tests/conftest.py`、侧车、通信、UI 和船控代码。更新源为
`Lidar-SLAM-v4-Source.zip`（15 个文件，38,101 字节）；ZIP SHA256：
`efb8b9bd690aec69c263e2a35a5247b9acde42cbeec118f737d95ad538df47c9`。

这是算法所有者交付升级，不是终端侧绕过 vendor 边界手改算法。当前内容以本节为准，
上面的 v2 SHA256 表仅记录首次导入。各文件与交付包逐一核对；下表按 UTF-8 / LF
计算 SHA256，避免 Windows checkout 的 CRLF 差异。

| 文件 | SHA256（LF） |
|---|---|
| `CHANGES_CN.md` | `6bce41d9622508dca3ca229fe65405745fff1642611ba5cb6ca36de98bab32bc` |
| `README_CN.md` | `2003067ea259061265ae8b731c4a36f72aaeb32b5dd1c7af42690f542c7ba01b` |
| `cocommand2d/__init__.py` | `f462d82189c4388143d9e6e6d453a68d7b1e56d0de0b2f1efbecbd034f159924` |
| `cocommand2d/batch_slam.py` | `72a574cd61e85bbc66977ca3e9ce375985dc154142957f5d5516c60728d396d0` |
| `cocommand2d/recording/__init__.py` | `5ffb5cec7aeea1cf110a4efaa2a900aee95bd0ce793d3f92029a04d1f36591bb` |
| `cocommand2d/recording/io.py` | `b0450145c0fe23b46f78f4524ea97ee929423c2abe1a40c8bb83d10d44056cf2` |
| `cocommand2d/scan.py` | `86d5c5eabda7985a66e67aee2d328d1a79a9347fe82c0e093a78cc2f399f3cd6` |
| `cocommand2d/slam/__init__.py` | `5386c2168a75b3ce2dba720daa382082494c0c90aead62b517a065bdf1969d36` |
| `cocommand2d/slam/core.py` | `0e13f0b11275d50060dc1d1ceb1e23639f47c1c67062b2bec4b16f34bb358157` |
| `cocommand2d/slam/grid.py` | `17789dbbfab08945b57fafd7fc40f0e801517171a4e36830aa3cd8b87af22b86` |
| `cocommand2d/slam/preprocessing.py` | `ed7d7ff2126dfaa0b84009b6c167f90a52cc14b81b48ae3ad26814686ce712cd` |
| `requirements.txt` | `bbe7e0d48fd759d782cbcda080791a5af33842b74f2c08ad9730a700a9646fcd` |
| `run_slam.py` | `79312be3c5206ebb1cace250214b0870c1b7098520647686845aceb15b8f17f0` |
| `tests/test_preprocessing.py` | `4de6eac61413e22964a8c25d1cc3afdfd7937e3a35baaf52358b3ca2ff766e6e` |
| `tests/test_robust_slam.py` | `e9482f696a96a716fe6ebe8229a6b74b839ced62096ecf5fd8b50f4fef5d2d80` |

新增较长直线定位参考与非直线点的多帧、多视角确认；保留 5 秒恢复和连续 3 帧确认。
`RECOVERING` 状态及保留位姿语义见 `desktop/docs/slam-integration.md`。
四项仓库检查：算法 81 项、Node 12 项、实时接入 13 项、导出 24 项全部通过；
合成测试不等于实船验证。
