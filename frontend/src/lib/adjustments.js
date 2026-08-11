// Adjustment reason codes as stored in batch_movements.reason. Served by
// GET /api/batches/adjustment-reasons too; this map is only for rendering a stored code.
export const ADJUSTMENT_REASON_LABELS = {
  expired: 'Expired',
  loss: 'Loss',
  damaged: 'Damaged',
  count_correction: 'Physical count correction',
  facility_return: 'Returned from facility',
};

export function reasonLabel(code) {
  return code ? ADJUSTMENT_REASON_LABELS[code] || code : null;
}
