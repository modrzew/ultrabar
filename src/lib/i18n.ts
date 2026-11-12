// The bar's catalogs mix English and Simplified Chinese. Translate the labels
// we know; anything else is shown as the bar sent it.

const TEXT: Record<string, string> = {
  设备状态: "Device state",
  profile变化: "Profile changes",
  应用监听: "App opens or closes",
  数值状态: "Value crosses a threshold",
  设备: "Device",
  状态属性: "Property",
  从: "From",
  变为: "To",
  目标值: "Value",
  应用: "App",
  在: "State",
  大于: "Above",
  小于: "Below",
  前台: "Foreground",
  后台: "Background",
  定时器: "Timer",
  动作: "Action",
  启动: "Start",
  暂停: "Pause",
  恢复暂停: "Resume",
  取消: "Cancel",
  重启: "Restart",
  倒计时: "Countdown",
  Corebar: "Bar",
  "当某个设备（或属性）的状态发生变化时触发。": "When a device (or one of its properties) changes state.",
  "当profile的切换时触发。": "When the bar switches from one profile to another.",
  当应用启动时触发: "When an app on the bar starts.",
  "当某个设备的状态（或属性值）的数值超过给定阈值时触发。": "When a device value goes above or below a threshold.",
};

const TRIGGER_TITLES: Record<string, string> = {
  DEVICE_STATE: "Device state changes",
  PROFILE: "Profile changes",
  APP_STATE: "App opens or closes",
  NUMERIC: "Value crosses a threshold",
};

export function tr(s: string | undefined | null): string {
  if (!s) return "";
  return TEXT[s] ?? TEXT[s.trim()] ?? s;
}

export function triggerTitle(type: string, fallback?: string) {
  return TRIGGER_TITLES[type] ?? tr(fallback) ?? type;
}
