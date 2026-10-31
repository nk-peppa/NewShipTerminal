//! SoC 温度读取（sysfs thermal zone），供 SYS 遥测帧使用。
//!
//! 船端内核在 `/sys/class/thermal/thermal_zone*/temp` 暴露毫摄氏度。
//! 实机（Orange Pi Zero2W / H618）有 cpu/ddr/gpu/ve 四个 zone，取最高值代表整颗 SoC；
//! 降频点见 `thermal_zone0/trip_point_*`：70 °C、90 °C passive，115 °C critical。
//!
//! 只在 TCP 写线程里每秒调用一次（不是 50Hz 控制线程），所以直接读文件即可，
//! 不需要常驻线程或缓存。

use std::path::Path;

/// sysfs 里 thermal zone 的根目录
pub const SYSFS_THERMAL_ROOT: &str = "/sys/class/thermal";

/// 合理温度范围（毫摄氏度）：过滤未校准 zone 报出的 0 / 极端值
const VALID_MILLI_C: std::ops::RangeInclusive<i64> = 1_000..=200_000;

/// 读取所有 thermal zone 的最高温度，单位 0.1 °C；一个都读不到时返回 `None`。
pub fn soc_temp_c_x10() -> Option<i16> {
    soc_temp_c_x10_at(Path::new(SYSFS_THERMAL_ROOT))
}

/// 可注入根目录的版本，便于测试。
pub fn soc_temp_c_x10_at(root: &Path) -> Option<i16> {
    let entries = std::fs::read_dir(root).ok()?;
    let mut max_milli: Option<i64> = None;
    for entry in entries.flatten() {
        let text = match std::fs::read_to_string(entry.path().join("temp")) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let milli = match text.trim().parse::<i64>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !VALID_MILLI_C.contains(&milli) {
            continue;
        }
        max_milli = Some(max_milli.map_or(milli, |m| m.max(milli)));
    }
    let milli = max_milli?;
    // 毫摄氏度 → 0.1 °C，四舍五入；避开 i16::MIN（SYS 帧里是「未知」哨兵）
    let deci = ((milli + 50) / 100).clamp(i64::from(i16::MIN) + 1, i64::from(i16::MAX));
    Some(deci as i16)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("usv-thermal-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn add_zone(root: &Path, name: &str, milli_c: i64) {
        let zone = root.join(name);
        std::fs::create_dir_all(&zone).expect("创建 zone");
        std::fs::write(zone.join("temp"), format!("{milli_c}\n")).expect("写 temp");
    }

    #[test]
    fn picks_hottest_valid_zone() {
        let root = temp_root("hot");
        add_zone(&root, "thermal_zone0", 48_419);
        add_zone(&root, "thermal_zone1", 51_092);
        add_zone(&root, "thermal_zone2", 0); // 未校准，应被过滤
        assert_eq!(soc_temp_c_x10_at(&root), Some(511));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_or_unreadable_root_is_none() {
        assert_eq!(soc_temp_c_x10_at(Path::new("/nonexistent-usv-thermal")), None);

        let root = temp_root("empty");
        assert_eq!(soc_temp_c_x10_at(&root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rounds_to_one_decimal() {
        let root = temp_root("round");
        add_zone(&root, "thermal_zone0", 48_460); // 48.46 °C → 48.5 °C
        assert_eq!(soc_temp_c_x10_at(&root), Some(485));
        let _ = std::fs::remove_dir_all(&root);
    }
}
