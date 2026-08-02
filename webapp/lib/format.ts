/** 利息金額通常很小，金額小於 1 時多保留幾位小數才看得出變化 */
export function fmtInterest (n: number) {
  return Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(6)
}

/** 台幣約當金額，金額大時取整數即可，小額才留小數 */
export function fmtTwd (n: number) {
  const digits = Math.abs(n) >= 100 ? 0 : 2
  return `NT$${n.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

/** 以本地時區把年月轉成 `YYYY-MM`，與紀錄的日期字串前綴對齊 */
export function monthKey (year: number, monthIndex: number) {
  const d = new Date(year, monthIndex, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
