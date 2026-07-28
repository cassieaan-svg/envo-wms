// Input validation middleware and helpers

export function validateRequiredFields(requiredFields) {
  return (req, res, next) => {
    const missing = requiredFields.filter(field => !req.body[field])
    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Missing required fields: ${missing.join(', ')}`,
        code: 'MISSING_FIELDS'
      })
    }
    next()
  }
}

export function validateQuery(requiredParams) {
  return (req, res, next) => {
    const missing = requiredParams.filter(param => !req.query[param])
    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Missing required query parameters: ${missing.join(', ')}`,
        code: 'MISSING_PARAMS'
      })
    }
    next()
  }
}

// Validation helpers
export const validators = {
  isUUID: (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),

  isPositiveNumber: (num) => !isNaN(num) && parseInt(num) > 0,

  isNonNegativeNumber: (num) => !isNaN(num) && parseInt(num) >= 0,

  isValidDate: (dateStr) => !isNaN(new Date(dateStr).getTime()),

  isValidISODate: (dateStr) => /^\d{4}-\d{2}-\d{2}$/.test(dateStr),

  // Expiry at intake must be a REAL FUTURE date — you can't receive already-expired
  // stock, and isValidISODate only checks the FORMAT so a fumbled "0001-01-01"
  // slips through. Valid when the date is today or later and within a sane ceiling
  // (rejects past dates and absurd far-future years like 9999).
  isPlausibleExpiry: (dateStr) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false
    const today = new Date().toISOString().slice(0, 10)
    const maxYear = new Date().getUTCFullYear() + 30
    return dateStr >= today && parseInt(dateStr.slice(0, 4), 10) <= maxYear
  },

  isValidLocationTypes: (type) => ['store', 'dispensary'].includes(type),

  isValidSection: (section) => ['pharmacy', 'lab'].includes(section),

  isValidTransferStatus: (status) =>
    ['pending', 'pending_approval', 'in_transit', 'accepted', 'disputed', 'cancelled'].includes(status),

  isValidTransferType: (type) =>
    ['request_for_redistribution', 'external_redistribution', 'internal', 'dsd', 'sdp'].includes(type),

  isValidLogEntry: (type) =>
    ['dispense', 'intake', 'adjustment', 'transfer'].includes(type),
}

// Validation error response
export function sendValidationError(res, message, field = null) {
  return res.status(400).json({
    success: false,
    error: message,
    field,
    code: 'VALIDATION_ERROR'
  })
}
