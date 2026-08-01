/** 利息金額通常很小，金額小於 1 時多保留幾位小數才看得出變化 */
export function fmtInterest (n: number) {
  return Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(6)
}

/** 以本地時區把年月轉成 `YYYY-MM`，與紀錄的日期字串前綴對齊 */
export function monthKey (year: number, monthIndex: number) {
  const d = new Date(year, monthIndex, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
