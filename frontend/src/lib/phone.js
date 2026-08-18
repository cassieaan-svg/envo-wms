// A Nigerian phone number is 11 digits beginning 0 (e.g. 08031234567). A +234… or 234…
// form is normalised to that, and spaces / dashes are stripped first. normalizeNgPhone
// returns the canonical 0-leading form, or null when the input isn't a valid number —
// so both validation ("is it null?") and storage ("keep the 0-leading form") come from
// one place, and every store keeps phone numbers in the same shape.
export function normalizeNgPhone(raw) {
  let d = String(raw ?? '').replace(/[^\d+]/g, '')
  if (d.startsWith('+234')) d = '0' + d.slice(4)
  else if (d.startsWith('234')) d = '0' + d.slice(3)
  return /^0\d{10}$/.test(d) ? d : null
}

export const isValidNgPhone = (raw) => normalizeNgPhone(raw) !== null
