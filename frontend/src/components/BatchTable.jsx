import { Empty, ExpiryBadge, dateOnly, money, qty } from './ui.jsx';

// Shared batch list. Used on the batches page (with adjust actions) and read-only
// elsewhere, so expiry reads identically in both places.
export default function BatchTable({ batches, onAdjust, showCommodity = false }) {
  if (batches.length === 0) return <Empty>No batches.</Empty>;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {showCommodity && <th className="wrap">Commodity</th>}
            <th>Batch no.</th>
            <th>Expiry</th>
            <th />
            <th className="num">Received</th>
            <th className="num">Remaining</th>
            <th className="num">Unit cost</th>
            <th>Vendor</th>
            {onAdjust && <th />}
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => (
            <tr key={batch.id ?? batch.batch_id}>
              {showCommodity && <td className="wrap">{batch.commodity_name}</td>}
              <td>{batch.batch_number}</td>
              <td>{dateOnly(batch.expiry_date)}</td>
              <td>
                <ExpiryBadge daysToExpiry={batch.days_to_expiry} isExpired={batch.is_expired} />
              </td>
              <td className="num">{qty(batch.quantity_received)}</td>
              <td className="num">{qty(batch.quantity_remaining)}</td>
              <td className="num">{money(batch.unit_cost)}</td>
              <td>{batch.vendor_name || <span className="muted">—</span>}</td>
              {onAdjust && (
                <td>
                  <button className="btn small" onClick={() => onAdjust(batch)}>
                    adjust
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
