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
